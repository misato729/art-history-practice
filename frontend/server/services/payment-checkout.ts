import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import type { User } from '../core/auth.ts'
import { isUniqueViolation, query, transaction, type Database } from '../core/db.ts'
import { ApiError, fail } from '../core/errors.ts'
import { paymentStripeClient, type PaymentStripeClient, type StripeObject } from './payment-client.ts'
import { paymentSettings, type PaymentSettings } from './payment-settings.ts'

export type PaymentOptions = { client?: PaymentStripeClient, settings?: PaymentSettings, db?: Database }
const unavailable = (settings: PaymentSettings): never => {
  const error = new ApiError(503, 'payment_unavailable', '現在、決済を開始できません')
  error.expectedUnavailability = !settings.salesEnabled
  throw error
}
const inProgress = (): never => fail(409, 'checkout_session_in_progress', '未完了の決済があります')

export function checkoutParameters(user: User, settings: PaymentSettings): Stripe.Checkout.SessionCreateParams {
  const metadata = { user_id: String(user.id), purchase_type: 'paid_membership', stripe_price_id: settings.priceId }
  return {
    ui_mode: 'hosted_page', mode: 'payment', locale: 'ja', billing_address_collection: 'auto',
    phone_number_collection: { enabled: false }, automatic_tax: { enabled: true }, allow_promotion_codes: false,
    allowed_payment_method_types: ['card'], submit_type: 'auto', integration_identifier: 'hosted_web_0001', origin_context: 'web',
    line_items: [{ price: settings.priceId, quantity: 1 }], client_reference_id: String(user.id), customer_email: user.email,
    consent_collection: { terms_of_service: 'required' },
    custom_text: { terms_of_service_acceptance: { message: `${settings.siteName}の[利用規約](${settings.frontendUrl}/terms)に同意します。` }, submit: { message: `「${settings.siteName}の有料コンテンツ利用資格」を${settings.amount} ${settings.currency.toUpperCase()}で買い切る契約です。月額課金や自動更新はありません。決済完了後に利用資格を提供し、提供開始後の利用者都合による返金は原則として受け付けません。` } },
    metadata, payment_intent_data: { metadata }, success_url: `${settings.frontendUrl}/premium/complete`, cancel_url: `${settings.frontendUrl}/premium?canceled=1`,
  }
}

export async function createCheckoutSession(user: User, options: PaymentOptions = {}) {
  const settings = options.settings || paymentSettings()
  if (!settings.enabled) unavailable(settings)
  const client = options.client || paymentStripeClient(settings)
  try {
    return await transaction(async db => {
      const [locked] = await query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id], db)
      if (!locked) fail(401, 'unauthorized', 'ログインが必要です')
      const [membership, verification] = await Promise.all([
        db.membership.findFirst({ where: { user_id: BigInt(user.id), status: 'active' }, select: { id: true } }),
        db.verificationAccessGrant.findFirst({ where: { user_id: BigInt(user.id), revoked_at: null, expires_at: { gt: new Date() } }, select: { id: true } }),
      ])
      if (locked.role === 'admin' || membership || verification) fail(409, 'membership_already_active', 'すでに有料コンテンツを利用できます')
      const price = await client.prices.retrieve(settings.priceId)
      if (!(price.active === true && price.currency === settings.currency && price.unit_amount === settings.amount && price.type === 'one_time' && price.tax_behavior === 'inclusive' && price.livemode === settings.livemode)) unavailable(settings)
      const [pendingLock] = await query<{ id: number }>(`SELECT id FROM payments WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [user.id], db)
      const pending = pendingLock ? await db.payment.findUnique({ where: { id: BigInt(pendingLock.id) } }) : null
      if (pending) {
        const session = await client.checkout.sessions.retrieve(pending.stripe_checkout_session_id)
        if (session.livemode !== settings.livemode) unavailable(settings)
        if (session.status === 'open' && session.url) return { checkout_session_id: session.id, checkout_url: session.url }
        if (session.status !== 'expired') inProgress()
        await db.payment.update({ where: { id: pending.id }, data: { status: 'expired', updated_at: new Date() } })
      }
      const session = await client.checkout.sessions.create(checkoutParameters(locked, settings), { idempotencyKey: `paid-membership-user-${user.id}-${randomUUID()}` })
      const expire = async () => {
        try { await client.checkout.sessions.expire(session.id) } catch { console.error('Failed to expire Stripe Checkout Session after local failure') }
      }
      if (!(session.status === 'open' && session.url && session.livemode === settings.livemode)) {
        if (session.status === 'open') await expire()
        unavailable(settings)
      }
      try {
        const now = new Date()
        await db.payment.create({ data: { user_id: BigInt(user.id), stripe_checkout_session_id: session.id, stripe_price_id: settings.priceId,
          amount: settings.amount, currency: settings.currency, status: 'pending', created_at: now, updated_at: now } })
      } catch (error) { await expire(); throw error }
      return { checkout_session_id: session.id, checkout_url: session.url }
    }, options.db)
  } catch (error) {
    if (isUniqueViolation(error)) inProgress()
    if (error instanceof ApiError) throw error
    if (isStripeError(error)) fail(502, 'payment_provider_error', '決済サービスへ接続できませんでした')
    throw error
  }
}

export const isStripeError = (error: unknown) => Boolean(error && typeof error === 'object' && typeof (error as StripeObject).type === 'string' && (error as StripeObject).type.startsWith('Stripe'))

/** Caller-provided db must already be inside a transaction and hold the user lock. */
export async function expirePendingCheckouts(user: User, db?: Database, injectedClient?: PaymentStripeClient): Promise<void> {
  return transaction(async connection => {
    if (!db) await query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id], connection)
    const paymentLocks = await query<{ id: number }>(`SELECT id FROM payments WHERE user_id=$1 AND status='pending' ORDER BY id FOR UPDATE`, [user.id], connection)
    if (!paymentLocks.length) return
    const payments = await connection.payment.findMany({ where: { id: { in: paymentLocks.map(payment => BigInt(payment.id)) } }, orderBy: { id: 'asc' } })
    const settings = paymentSettings()
    const unavailableMessage = '決済状態を確認できないため、アカウントを削除できません'
    if (!injectedClient && !settings.secretKey) fail(503, 'payment_unavailable', unavailableMessage)
    const client = injectedClient || paymentStripeClient(settings)
    try {
      for (const payment of payments) {
        const session = await client.checkout.sessions.retrieve(payment.stripe_checkout_session_id)
        if (session.livemode !== settings.livemode) fail(503, 'payment_unavailable', unavailableMessage)
        if (session.status === 'open') {
          const expired = await client.checkout.sessions.expire(session.id)
          if (expired.status !== 'expired') fail(409, 'checkout_session_in_progress', '決済完了通知を確認中のため、しばらく待ってから再度お試しください')
        } else if (session.status !== 'expired') fail(409, 'checkout_session_in_progress', '決済完了通知を確認中のため、しばらく待ってから再度お試しください')
        await connection.payment.update({ where: { id: payment.id }, data: { status: 'expired', updated_at: new Date() } })
      }
    } catch (error) {
      if (isStripeError(error)) fail(502, 'payment_provider_error', unavailableMessage)
      throw error
    }
  }, db)
}
