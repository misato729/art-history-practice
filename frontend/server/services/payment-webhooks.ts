import { query, transaction, type Database, type Prisma } from '../core/db.ts'
import { paymentStripeClient, stripeId, type PaymentStripeClient, type StripeObject } from './payment-client.ts'
import { paymentSettings, type PaymentSettings } from './payment-settings.ts'
import type { PaymentOptions } from './payment-checkout.ts'

export class PaymentEventMismatchError extends Error {}
export class PaymentNotReadyError extends Error {}
const supported = new Set(['checkout.session.completed', 'checkout.session.expired', 'refund.created', 'refund.updated', 'refund.failed', 'charge.dispute.created', 'charge.dispute.closed'])
const stripeTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : new Date()
function mismatch(): never { throw new PaymentEventMismatchError('Stripe payment information does not match') }
type Payment = Prisma.PaymentGetPayload<{}>

class EventProcessor {
  private injectedClient?: PaymentStripeClient
  private db: Database
  private settings: PaymentSettings
  constructor(db: Database, settings: PaymentSettings, client?: PaymentStripeClient) { this.db = db; this.settings = settings; this.injectedClient = client }
  private get client() { return this.injectedClient ||= paymentStripeClient(this.settings) }

  async process(type: string, object: StripeObject, created: unknown) {
    switch (type) {
      case 'checkout.session.completed': return this.complete(object, stripeTime(created))
      case 'checkout.session.expired':
        await this.db.payment.updateMany({ where: { stripe_checkout_session_id: object.id, status: 'pending' }, data: { status: 'expired', updated_at: new Date() } })
        return
      case 'refund.created': case 'refund.updated': return this.refund(object)
      case 'refund.failed': return this.failedRefund(object, stripeTime(created))
      case 'charge.dispute.created': return this.dispute(object)
      case 'charge.dispute.closed': return this.dispute(object, stripeTime(created))
    }
  }

  private async lockedPayment(column: 'stripe_checkout_session_id' | 'stripe_payment_intent_id' | 'stripe_charge_id', value: string): Promise<Payment | null> {
    const [locked] = await query<{ id: number }>(`SELECT id FROM payments WHERE ${column}=$1 FOR UPDATE`, [value], this.db)
    return locked ? this.db.payment.findUnique({ where: { id: BigInt(locked.id) } }) : null
  }

  private async complete(session: StripeObject, completedAt: Date) {
    const payment = await this.lockedPayment('stripe_checkout_session_id', session.id)
    if (!payment) {
      // Account-wide deliveries include other services; only retry this price's missing local purchase.
      if (session.metadata?.stripe_price_id !== this.settings.priceId) return
      throw new PaymentNotReadyError('Checkout payment record is unavailable')
    }
    if (payment.status !== 'pending') return
    const intent = stripeId(session.payment_intent)
    const metadata = session.metadata || {}
    if (!(session.mode === 'payment' && session.payment_status === 'paid' && session.amount_total === payment.amount && session.currency === payment.currency &&
      session.client_reference_id === String(payment.user_id) && metadata.user_id === String(payment.user_id) && metadata.purchase_type === 'paid_membership' &&
      metadata.stripe_price_id === payment.stripe_price_id && intent && session.livemode === this.settings.livemode)) mismatch()
    const userId = payment.user_id
    if (userId === null) mismatch()
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) mismatch()
    const now = new Date()
    await this.db.payment.update({ where: { id: payment.id }, data: { status: 'paid', stripe_payment_intent_id: intent, paid_at: completedAt, updated_at: now } })
    await this.db.membership.upsert({ where: { user_id: userId },
      create: { user_id: userId, source_payment_id: payment.id, status: 'active', activated_at: completedAt, created_at: now, updated_at: now },
      update: { source_payment_id: payment.id, status: 'active', activated_at: completedAt, revoked_at: null, revocation_reason: null, updated_at: now } })
  }

  private async findPayment(intentId: string | null, chargeId: string | null): Promise<Payment | null> {
    let payment: Payment | null = null
    if (intentId) payment = await this.lockedPayment('stripe_payment_intent_id', intentId)
    if (!payment && chargeId) payment = await this.lockedPayment('stripe_charge_id', chargeId)
    if (payment) return payment
    if (!intentId && chargeId) {
      const charge = await this.client.charges.retrieve(chargeId)
      intentId = stripeId(charge.payment_intent)
      if (intentId) payment = await this.lockedPayment('stripe_payment_intent_id', intentId)
      if (payment) return payment
    }
    if (!intentId) return null
    const intent = await this.client.paymentIntents.retrieve(intentId)
    const metadata = intent.metadata || {}
    if (metadata.purchase_type !== 'paid_membership' || metadata.stripe_price_id !== this.settings.priceId) return null
    if (!(intent.currency === this.settings.currency && intent.amount === this.settings.amount && metadata.user_id && metadata.stripe_price_id)) mismatch()
    // Do not acknowledge a refund/dispute that arrived before the completion event.
    throw new PaymentNotReadyError('Awaiting Checkout completion notification')
  }

  private async verifiedCharge(payment: Payment, chargeId: string) {
    const charge = await this.client.charges.retrieve(chargeId)
    if (!(charge.currency === payment.currency && charge.amount === payment.amount && Number.isInteger(charge.amount_refunded) &&
      charge.amount_refunded >= 0 && charge.amount_refunded <= payment.amount &&
      (!payment.stripe_payment_intent_id || stripeId(charge.payment_intent) === payment.stripe_payment_intent_id))) mismatch()
    return charge
  }

  private async revoke(payment: Payment, reason: 'refund' | 'dispute') {
    if (payment.user_id === null) return
    const now = new Date()
    await this.db.membership.updateMany({ where: { user_id: payment.user_id, source_payment_id: payment.id },
      data: { status: 'revoked', revoked_at: now, revocation_reason: reason, updated_at: now } })
  }

  private async refund(refund: StripeObject) {
    if (refund.status !== 'succeeded') return
    const payment = await this.findPayment(stripeId(refund.payment_intent), stripeId(refund.charge))
    if (!payment) return
    const chargeId = stripeId(refund.charge) || payment.stripe_charge_id
    if (!chargeId) mismatch()
    const charge = await this.verifiedCharge(payment, chargeId)
    if (charge.amount_refunded === 0) return
    const full = charge.amount_refunded === payment.amount
    const now = new Date()
    await this.db.payment.update({ where: { id: payment.id }, data: { stripe_charge_id: charge.id, refunded_amount: charge.amount_refunded,
      status: full ? 'refunded' : 'partially_refunded', refunded_at: full ? now : payment.refunded_at, updated_at: now } })
    if (full) await this.revoke(payment, 'refund')
  }

  private async failedRefund(refund: StripeObject, failedAt: Date) {
    if (refund.status !== 'failed') mismatch()
    const payment = await this.findPayment(stripeId(refund.payment_intent), stripeId(refund.charge))
    if (!payment) return
    const chargeId = stripeId(refund.charge) || payment.stripe_charge_id
    if (!chargeId) mismatch()
    // A succeeded refund can subsequently fail. Fetch the current charge, not the event's old amount.
    const charge = await this.verifiedCharge(payment, chargeId)
    const disputed = payment.status === 'disputed' || Boolean(payment.stripe_dispute_id) || charge.disputed === true
    const full = charge.amount_refunded === payment.amount
    const status = disputed ? 'disputed' : full ? 'refunded' : charge.amount_refunded > 0 ? 'partially_refunded' : 'paid'
    const now = new Date()
    await this.db.payment.update({ where: { id: payment.id }, data: { stripe_charge_id: charge.id, refunded_amount: charge.amount_refunded,
      status, refunded_at: full ? payment.refunded_at || now : null, last_refund_failure_reason: refund.failure_reason || null,
      last_refund_failed_at: failedAt, updated_at: now } })
    if (disputed) await this.revoke(payment, 'dispute')
    else if (full) await this.revoke(payment, 'refund')
    else if (payment.user_id !== null) await this.db.membership.updateMany({
      where: { user_id: payment.user_id, source_payment_id: payment.id, status: 'revoked', revocation_reason: 'refund' },
      data: { status: 'active', revoked_at: null, revocation_reason: null, updated_at: now } })
  }

  private async dispute(dispute: StripeObject, closedAt?: Date) {
    const payment = await this.findPayment(stripeId(dispute.payment_intent), stripeId(dispute.charge))
    if (!payment) return
    if (!(dispute.currency === payment.currency && Number.isInteger(dispute.amount) && dispute.amount > 0 && dispute.amount <= payment.amount && (!closedAt || dispute.status))) mismatch()
    const retainClosure = !closedAt && payment.stripe_dispute_id === dispute.id && payment.dispute_closed_at
    await this.db.payment.update({ where: { id: payment.id }, data: { status: 'disputed',
      stripe_charge_id: stripeId(dispute.charge) || payment.stripe_charge_id, stripe_dispute_id: dispute.id,
      dispute_status: retainClosure ? payment.dispute_status : dispute.status || null,
      dispute_closed_at: retainClosure ? payment.dispute_closed_at : closedAt || null, updated_at: new Date() } })
    // Even a won dispute requires an explicit operational decision before access resumes.
    await this.revoke(payment, 'dispute')
  }
}

/** All state changes and the event receipt commit together; failures remain retryable. */
export async function processStripeEvent(event: StripeObject, options: PaymentOptions = {}): Promise<'processed' | 'duplicate'> {
  const settings = options.settings || paymentSettings()
  if (event.livemode !== settings.livemode || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') mismatch()
  return transaction(async db => {
    // Serialize the same event before touching payment/membership rows, including concurrent delivery.
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', [`stripe-event:${event.id}`], db)
    const existing = await db.stripeWebhookEvent.findUnique({ where: { stripe_event_id: event.id }, select: { id: true } })
    if (existing) return 'duplicate'
    if (supported.has(event.type)) {
      if (!event.data?.object || typeof event.data.object !== 'object') mismatch()
      await new EventProcessor(db, settings, options.client).process(event.type, event.data.object, event.created)
    }
    const now = new Date()
    await db.stripeWebhookEvent.create({ data: { stripe_event_id: event.id, event_type: event.type, livemode: event.livemode,
      processed_at: now, created_at: now, updated_at: now } })
    return 'processed'
  }, options.db)
}
