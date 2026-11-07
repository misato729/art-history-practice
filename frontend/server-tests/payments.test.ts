import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { after, test } from 'node:test'
import { createEvent } from 'h3'
import Stripe from 'stripe'
import { EXAM_CONFIG } from '../app/utils/examConfig.ts'
import type { User } from '../server/core/auth.ts'
import { closeDatabase, isolatedTransaction, query, type Database } from '../server/core/db.ts'
import { authorizeExam } from '../server/services/learning.ts'
import { ApiError } from '../server/core/errors.ts'
import { createCheckoutSession, expirePendingCheckouts } from '../server/services/payment-checkout.ts'
import { verifyStripeWebhook, type PaymentStripeClient, type StripeObject } from '../server/services/payment-client.ts'
import { paymentSettings, publicPaymentConfiguration, validFrontendOrigin } from '../server/services/payment-settings.ts'
import { PaymentEventMismatchError, PaymentNotReadyError, processStripeEvent } from '../server/services/payment-webhooks.ts'
import { checkoutPayment, getPaymentConfiguration, receiveStripeWebhook } from '../server/services/payments.ts'

const config = structuredClone(EXAM_CONFIG)
config.payments.enabled = true
const env = {
  PAID_MEMBERSHIP_ENABLED: 'true', STRIPE_LIVEMODE: 'false', STRIPE_SECRET_KEY: 'sk_test_synthetic',
  STRIPE_WEBHOOK_SECRET: 'whsec_synthetic', STRIPE_PRICE_ID: 'price_synthetic', FRONTEND_URL: 'https://example.invalid',
  NUXT_PUBLIC_SELLER_NAME: 'Synthetic seller', NUXT_PUBLIC_SELLER_REPRESENTATIVE: 'Synthetic representative',
  NUXT_PUBLIC_SELLER_EMAIL: 'seller@example.invalid', NUXT_PUBLIC_SELLER_ADDRESS: 'synthetic-address', NUXT_PUBLIC_SELLER_PHONE: 'synthetic-phone',
  SELLER_CONTACT_DISCLOSURE_MODE: 'public', SELLER_CONTACT_DISCLOSURE_READY: 'false',
}
const settings = paymentSettings(env, config, 'test')

test('sales require feature flag, launch flag, seller identity, disclosure readiness and matching execution mode', () => {
  assert.equal(settings.enabled, true)
  assert.equal(paymentSettings({ ...env, PAID_MEMBERSHIP_ENABLED: 'false' }, config, 'test').enabled, false)
  assert.equal(paymentSettings(env, { ...config, payments: { ...config.payments, enabled: false } }, 'test').enabled, false)
  for (const key of ['NUXT_PUBLIC_SELLER_NAME', 'NUXT_PUBLIC_SELLER_REPRESENTATIVE', 'NUXT_PUBLIC_SELLER_EMAIL', 'NUXT_PUBLIC_SELLER_ADDRESS', 'NUXT_PUBLIC_SELLER_PHONE']) {
    assert.equal(paymentSettings({ ...env, [key]: '' }, config, 'test').enabled, false)
  }
  assert.equal(paymentSettings({ ...env, STRIPE_SECRET_KEY: 'sk_live_synthetic' }, config, 'test').enabled, false)
  assert.equal(paymentSettings(env, config, 'production').enabled, false)
  assert.equal(paymentSettings({ ...env, STRIPE_LIVEMODE: 'true', STRIPE_SECRET_KEY: 'sk_live_synthetic' }, config, 'production').enabled, true)
})

test('on-request seller disclosure never exposes private contacts and requires explicit readiness', () => {
  for (const ready of [undefined, 'false', 'TRUE', '1']) assert.equal(paymentSettings({ ...env, SELLER_CONTACT_DISCLOSURE_MODE: 'on_request', SELLER_CONTACT_DISCLOSURE_READY: ready }, config, 'test').enabled, false)
  const state = paymentSettings({ ...env, SELLER_CONTACT_DISCLOSURE_MODE: 'on_request', SELLER_CONTACT_DISCLOSURE_READY: 'true' }, config, 'test')
  assert.equal(state.enabled, true)
  assert.equal(state.seller.address, '')
  assert.equal(state.seller.phone, '')
  const serialized = JSON.stringify(publicPaymentConfiguration(state))
  for (const hidden of ['synthetic-address', 'synthetic-phone', 'sk_test_', 'whsec_', 'price_synthetic']) assert.ok(!serialized.includes(hidden))
  const invalid = paymentSettings({ ...env, SELLER_CONTACT_DISCLOSURE_MODE: 'private-unknown' }, config, 'test')
  assert.equal(invalid.enabled, false)
  assert.equal(invalid.seller.contact_disclosure_mode, 'unconfigured')
  assert.equal(paymentSettings({ ...env, SELLER_CONTACT_DISCLOSURE_MODE: '' }, config, 'test').enabled, false)
})

test('Checkout origin accepts a root HTTPS origin and permits local HTTP only outside production', () => {
  assert.equal(validFrontendOrigin('https://exam.example.invalid/', 'production'), true)
  assert.equal(validFrontendOrigin('http://localhost:3100', 'test'), true)
  for (const origin of ['https://user:password@example.invalid', 'https://example.invalid/path', 'https://example.invalid/?token=x', 'https://example.invalid/#x', 'http://example.invalid', 'http://localhost:3100']) {
    assert.equal(validFrontendOrigin(origin, 'production'), false)
  }
})

test('raw Stripe signature verification rejects whitespace changes, invalid JSON, stale signatures and wrong secrets', () => {
  const body = '{ "id": "evt_synthetic", "type": "unhandled", "livemode": false }'
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: env.STRIPE_WEBHOOK_SECRET })
  assert.equal(verifyStripeWebhook(Buffer.from(body), header, env.STRIPE_WEBHOOK_SECRET).id, 'evt_synthetic')
  assert.throws(() => verifyStripeWebhook(JSON.stringify(JSON.parse(body)), header, env.STRIPE_WEBHOOK_SECRET))
  assert.throws(() => verifyStripeWebhook(body, header, 'whsec_wrong_synthetic'))
  assert.throws(() => verifyStripeWebhook(body, Stripe.webhooks.generateTestHeaderString({ payload: body, secret: env.STRIPE_WEBHOOK_SECRET, timestamp: 1 }), env.STRIPE_WEBHOOK_SECRET))
  const malformed = '{bad-json'
  assert.throws(() => verifyStripeWebhook(malformed, Stripe.webhooks.generateTestHeaderString({ payload: malformed, secret: env.STRIPE_WEBHOOK_SECRET }), env.STRIPE_WEBHOOK_SECRET))
})

function fakeStripe() {
  const state = {
    price: { active: true, currency: 'jpy', unit_amount: 500, type: 'one_time', tax_behavior: 'inclusive', livemode: false } as StripeObject,
    session: { id: 'cs_existing', url: 'https://checkout.stripe.com/synthetic', status: 'open', livemode: false } as StripeObject,
    charge: { id: 'ch_synthetic', currency: 'jpy', amount: 500, amount_refunded: 500, payment_intent: 'pi_synthetic', disputed: false } as StripeObject,
    intent: { id: 'pi_synthetic', currency: 'jpy', amount: 500, metadata: { purchase_type: 'paid_membership', user_id: '1', stripe_price_id: 'price_synthetic' } } as StripeObject,
    requests: [] as { params: StripeObject, options: { idempotencyKey: string } }[], expired: [] as string[],
    newSession: null as StripeObject | null, failCharge: false,
  }
  const client: PaymentStripeClient = {
    prices: { retrieve: async () => state.price },
    checkout: { sessions: {
      create: async (params, options) => { state.requests.push({ params, options }); return state.newSession || { id: `cs_${randomUUID()}`, url: 'https://checkout.stripe.com/new-synthetic', status: 'open', livemode: false } },
      retrieve: async () => state.session,
      expire: async id => { state.expired.push(id); return { id, status: 'expired' } },
    } },
    charges: { retrieve: async () => { if (state.failCharge) throw Object.assign(new Error('synthetic transport failure'), { type: 'StripeConnectionError' }); return state.charge } },
    paymentIntents: { retrieve: async () => state.intent },
  }
  return { state, client }
}

test('disabled sales stop before contacting Stripe or the database', async () => {
  const { state, client } = fakeStripe()
  await assert.rejects(createCheckoutSession({ id: 1 } as User, { client, settings: paymentSettings({ ...env, PAID_MEMBERSHIP_ENABLED: 'false' }, config, 'test') }), (error: unknown) => error instanceof ApiError && error.code === 'payment_unavailable' && error.expectedUnavailability)
  assert.equal(state.requests.length, 0)
})

function paymentEvent(path: string, method: 'GET' | 'POST', body?: string, signature?: string) {
  const request = new IncomingMessage(new Socket())
  request.method = method; request.url = path
  request.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body || '')), 'stripe-signature': signature }
  request.push(body || ''); request.push(null)
  return createEvent(request, new ServerResponse(request))
}

test('HTTP contracts expose public settings, require Checkout authentication and reject invalid webhook signatures before DB access', async () => {
  const previous = process.env.STRIPE_WEBHOOK_SECRET
  process.env.STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET
  try {
    const response = getPaymentConfiguration() as { data: { purchase_type: string } }
    assert.equal(response.data.purchase_type, 'one_time')
    await assert.rejects(checkoutPayment(paymentEvent('/payments/checkout_sessions', 'POST'), null), (error: unknown) => error instanceof ApiError && error.status === 401)
    await assert.rejects(receiveStripeWebhook(paymentEvent('/webhooks/stripe', 'POST', '{ "id": "evt_synthetic" }', 'invalid')), (error: unknown) => error instanceof ApiError && error.code === 'invalid_webhook' && error.status === 400)
  } finally {
    if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
    else process.env.STRIPE_WEBHOOK_SECRET = previous
  }
})

// An explicit test database avoids touching the source service or developer data.
const testUrl = process.env.TEST_DATABASE_URL
if (testUrl) process.env.DATABASE_URL = testUrl
after(closeDatabase)
type Fixture = { db: Database, user: User, payment: StripeObject, stripe: ReturnType<typeof fakeStripe> }
async function fixture(run: (fixture: Fixture) => Promise<void>) {
  await isolatedTransaction(async db => {
    const [user] = await query<User>(`INSERT INTO users(name,email,role,created_at,updated_at) VALUES('Payment test',$1,'user',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`, [`${randomUUID()}@example.invalid`], db)
    const [payment] = await query(`INSERT INTO payments(user_id,stripe_checkout_session_id,stripe_price_id,amount,currency,status,created_at,updated_at) VALUES($1,$2,'price_synthetic',500,'jpy','pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`, [user!.id, `cs_${randomUUID()}`], db)
    await run({ db, user: user!, payment: payment!, stripe: fakeStripe() })
  })
}
const dbTest = (name: string, run: (fixture: Fixture) => Promise<void>) => test(name, { skip: !testUrl }, () => fixture(run))
const event = (type: string, object: StripeObject, id = `evt_${randomUUID()}`) => ({ id, type, livemode: false, created: 1780000000, data: { object } })
function checkout(f: Fixture, overrides: StripeObject = {}) {
  return event('checkout.session.completed', { id: f.payment.stripe_checkout_session_id, mode: 'payment', payment_status: 'paid', amount_total: 500, currency: 'jpy', client_reference_id: String(f.user.id), metadata: { user_id: String(f.user.id), purchase_type: 'paid_membership', stripe_price_id: 'price_synthetic' }, payment_intent: 'pi_synthetic', livemode: false, ...overrides })
}
const processEvent = (f: Fixture, e: StripeObject) => processStripeEvent(e, { db: f.db, settings, client: f.stripe.client })
const records = async (f: Fixture) => ({ payment: (await query('SELECT * FROM payments WHERE id=$1', [f.payment.id], f.db))[0]!, membership: (await query('SELECT * FROM memberships WHERE user_id=$1', [f.user.id], f.db))[0] })

dbTest('Checkout creates a fixed one-time Price with consent, origin, metadata and unique idempotency key', async f => {
  await query('DELETE FROM payments WHERE id=$1', [f.payment.id], f.db)
  const result = await createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client })
  const { params, options } = f.stripe.state.requests[0]!
  assert.equal(params.mode, 'payment'); assert.equal(params.ui_mode, 'hosted_page')
  assert.deepEqual(params.allowed_payment_method_types, ['card'])
  assert.deepEqual(params.line_items, [{ price: 'price_synthetic', quantity: 1 }])
  assert.equal(params.consent_collection.terms_of_service, 'required')
  assert.deepEqual(params.automatic_tax, { enabled: true })
  assert.match(params.custom_text.terms_of_service_acceptance.message, /https:\/\/example\.invalid\/terms/)
  assert.equal(params.metadata.user_id, String(f.user.id))
  assert.deepEqual(params.metadata, params.payment_intent_data.metadata)
  assert.equal(params.success_url, 'https://example.invalid/premium/complete')
  assert.equal(params.cancel_url, 'https://example.invalid/premium?canceled=1')
  assert.match(options.idempotencyKey, new RegExp(`^paid-membership-user-${f.user.id}-[a-f0-9-]{36}$`))
  const [payment] = await query('SELECT * FROM payments WHERE stripe_checkout_session_id=$1', [result.checkout_session_id], f.db)
  assert.equal(payment!.status, 'pending')
})

dbTest('open pending Checkout is reused and completed pending Checkout blocks another purchase', async f => {
  const reused = await createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client })
  assert.equal(reused.checkout_session_id, 'cs_existing')
  assert.equal(f.stripe.state.requests.length, 0)
  f.stripe.state.session.status = 'complete'
  await assert.rejects(createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client }), (e: unknown) => e instanceof ApiError && e.code === 'checkout_session_in_progress')
})

dbTest('expired pending Checkout permits a new purchase; wrong Price and session modes never save a new payment', async f => {
  f.stripe.state.price.unit_amount = 499
  await assert.rejects(createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client }), ApiError)
  f.stripe.state.price.unit_amount = 500
  for (const behavior of ['exclusive', 'unspecified']) {
    f.stripe.state.price.tax_behavior = behavior
    await assert.rejects(createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client }), ApiError)
  }
  f.stripe.state.price.tax_behavior = 'inclusive'
  f.stripe.state.session.livemode = true
  await assert.rejects(createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client }), ApiError)
  f.stripe.state.session.livemode = false; f.stripe.state.session.status = 'expired'
  await createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client })
  assert.equal((await records(f)).payment.status, 'expired')
  assert.equal(f.stripe.state.requests.length, 1)
})

dbTest('active membership prevents duplicate purchases before contacting Stripe', async f => {
  await processEvent(f, checkout(f))
  await assert.rejects(createCheckoutSession(f.user, { db: f.db, settings, client: f.stripe.client }), (e: unknown) => e instanceof ApiError && e.code === 'membership_already_active')
  assert.equal(f.stripe.state.requests.length, 0)
})

dbTest('verified completion activates only the correct purchase and duplicate notifications are idempotent', async f => {
  const e = checkout(f)
  assert.equal(await processEvent(f, e), 'processed')
  assert.equal(await processEvent(f, e), 'duplicate')
  const rows = await records(f)
  assert.equal(rows.payment.status, 'paid'); assert.equal(rows.payment.stripe_payment_intent_id, 'pi_synthetic')
  assert.equal(rows.membership!.status, 'active'); assert.equal(rows.membership!.source_payment_id, f.payment.id)
  assert.equal(new Date(rows.payment.paid_at).getTime(), e.created * 1000)
})

dbTest('amount, currency, owner, price, payment status and livemode mismatches do not grant entitlement or acknowledge receipt', async f => {
  for (const overrides of [{ amount_total: 499 }, { currency: 'usd' }, { client_reference_id: 'other' }, { payment_status: 'unpaid' }, { livemode: true }, { metadata: { user_id: String(f.user.id), purchase_type: 'paid_membership', stripe_price_id: 'other' } }]) {
    const e = checkout(f, overrides)
    await assert.rejects(processEvent(f, e), PaymentEventMismatchError)
    assert.equal((await query('SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id=$1', [e.id], f.db)).length, 0)
  }
  assert.equal((await records(f)).payment.status, 'pending')
  assert.equal((await records(f)).membership, undefined)
})

dbTest('partial refunds keep access and full refunds revoke only their source membership', async f => {
  await assert.rejects(authorizeExam(3, f.user, f.db), (e: unknown) => e instanceof ApiError && e.status === 403)
  await processEvent(f, checkout(f))
  await authorizeExam(3, f.user, f.db)
  f.stripe.state.charge.amount_refunded = 100
  await processEvent(f, event('refund.updated', { status: 'succeeded', payment_intent: 'pi_synthetic', charge: 'ch_synthetic' }))
  assert.equal((await records(f)).payment.status, 'partially_refunded'); assert.equal((await records(f)).membership!.status, 'active')
  await authorizeExam(3, f.user, f.db)
  f.stripe.state.charge.amount_refunded = 500
  await processEvent(f, event('refund.created', { status: 'succeeded', payment_intent: 'pi_synthetic', charge: 'ch_synthetic' }))
  assert.equal((await records(f)).payment.status, 'refunded'); assert.equal((await records(f)).membership!.revocation_reason, 'refund')
  await assert.rejects(authorizeExam(3, f.user, f.db), (e: unknown) => e instanceof ApiError && e.status === 403)
})

dbTest('failed refund reconciles current charge amount and restores only refund-revoked access', async f => {
  await processEvent(f, checkout(f))
  await processEvent(f, event('refund.updated', { status: 'succeeded', payment_intent: 'pi_synthetic', charge: 'ch_synthetic' }))
  const activated = (await records(f)).membership!.activated_at
  f.stripe.state.charge.amount_refunded = 100
  await processEvent(f, event('refund.failed', { status: 'failed', payment_intent: 'pi_synthetic', charge: 'ch_synthetic', failure_reason: 'expired_or_canceled_card' }))
  const rows = await records(f)
  assert.equal(rows.payment.status, 'partially_refunded'); assert.equal(rows.payment.refunded_amount, 100)
  assert.equal(rows.payment.refunded_at, null); assert.equal(rows.membership!.status, 'active')
  assert.deepEqual(rows.membership!.activated_at, activated)
  assert.equal(rows.payment.last_refund_failure_reason, 'expired_or_canceled_card')
})

dbTest('failed refund never restores access if another full refund or a provider dispute remains', async f => {
  await processEvent(f, checkout(f))
  const refund = { status: 'succeeded', payment_intent: 'pi_synthetic', charge: 'ch_synthetic' }
  await processEvent(f, event('refund.updated', refund))
  const failed = { ...refund, status: 'failed' }
  await processEvent(f, event('refund.failed', failed))
  assert.equal((await records(f)).membership!.status, 'revoked')
  f.stripe.state.charge.amount_refunded = 0; f.stripe.state.charge.disputed = true
  await processEvent(f, event('refund.failed', failed))
  assert.equal((await records(f)).payment.status, 'disputed')
  assert.equal((await records(f)).membership!.revocation_reason, 'dispute')
})

dbTest('failed refund cannot restore a disputed purchase or replace membership belonging to another purchase', async f => {
  await processEvent(f, checkout(f))
  await processEvent(f, event('charge.dispute.created', { id: 'du_synthetic', payment_intent: 'pi_synthetic', charge: 'ch_synthetic', currency: 'jpy', amount: 500, status: 'needs_response' }))
  await query(`UPDATE payments SET status='refunded',refunded_amount=500 WHERE id=$1`, [f.payment.id], f.db)
  await query(`UPDATE memberships SET revocation_reason='refund' WHERE user_id=$1`, [f.user.id], f.db)
  f.stripe.state.charge.amount_refunded = 0
  const failed = { status: 'failed', payment_intent: 'pi_synthetic', charge: 'ch_synthetic' }
  await processEvent(f, event('refund.failed', failed))
  assert.equal((await records(f)).payment.status, 'disputed')
  assert.equal((await records(f)).membership!.revocation_reason, 'dispute')
  const [other] = await query(`INSERT INTO payments(user_id,stripe_checkout_session_id,stripe_price_id,amount,currency,status,created_at,updated_at) VALUES($1,$2,'price_synthetic',500,'jpy','paid',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`, [f.user.id, `cs_${randomUUID()}`], f.db)
  await query(`UPDATE memberships SET source_payment_id=$2,status='revoked',revocation_reason='refund' WHERE user_id=$1`, [f.user.id, other!.id], f.db)
  await processEvent(f, event('refund.failed', failed))
  assert.equal((await records(f)).membership!.source_payment_id, other!.id)
  assert.equal((await records(f)).membership!.status, 'revoked')
})

dbTest('closed dispute and a late created event retain closure and never automatically restore access', async f => {
  await processEvent(f, checkout(f))
  const dispute = { id: 'du_synthetic', payment_intent: null, charge: 'ch_synthetic', currency: 'jpy', amount: 500, status: 'won' }
  const closed = event('charge.dispute.closed', dispute)
  await processEvent(f, closed)
  await processEvent(f, event('charge.dispute.created', { ...dispute, status: 'needs_response' }))
  const rows = await records(f)
  assert.equal(rows.payment.status, 'disputed'); assert.equal(rows.payment.dispute_status, 'won')
  assert.equal(new Date(rows.payment.dispute_closed_at).getTime(), closed.created * 1000)
  assert.equal(rows.membership!.revocation_reason, 'dispute')
})

dbTest('early refunds remain retryable while events for another product are safely acknowledged', async f => {
  const e = event('refund.updated', { status: 'succeeded', payment_intent: 'pi_synthetic', charge: 'ch_synthetic' })
  await assert.rejects(processEvent(f, e), PaymentNotReadyError)
  assert.equal((await query('SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id=$1', [e.id], f.db)).length, 0)
  f.stripe.state.intent.metadata.purchase_type = 'other_product'
  assert.equal(await processEvent(f, e), 'processed')
  assert.equal((await records(f)).payment.status, 'pending')
})

dbTest('refund verification mismatch or provider outage remains retryable with no membership changes', async f => {
  await processEvent(f, checkout(f))
  const e = event('refund.failed', { status: 'failed', payment_intent: 'pi_synthetic', charge: 'ch_synthetic' })
  f.stripe.state.charge.payment_intent = 'pi_other'
  await assert.rejects(processEvent(f, e), PaymentEventMismatchError)
  f.stripe.state.charge.payment_intent = 'pi_synthetic'; f.stripe.state.failCharge = true
  await assert.rejects(processEvent(f, e))
  assert.equal((await query('SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id=$1', [e.id], f.db)).length, 0)
  assert.equal((await records(f)).membership!.status, 'active')
  f.stripe.state.failCharge = false; f.stripe.state.charge.amount_refunded = 0
  assert.equal(await processEvent(f, e), 'processed')
})

dbTest('account deletion expires an open checkout and blocks a completed checkout awaiting webhook', async f => {
  f.stripe.state.session.id = f.payment.stripe_checkout_session_id; f.stripe.state.session.status = 'complete'
  await assert.rejects(expirePendingCheckouts(f.user, f.db, f.stripe.client), (e: unknown) => e instanceof ApiError && e.status === 409)
  assert.equal((await records(f)).payment.status, 'pending')
  f.stripe.state.session.status = 'open'
  await expirePendingCheckouts(f.user, f.db, f.stripe.client)
  assert.deepEqual(f.stripe.state.expired, [f.payment.stripe_checkout_session_id])
  assert.equal((await records(f)).payment.status, 'expired')
})

test('concurrent signed raw-body HTTP webhooks commit exactly one receipt and entitlement even with sales disabled', { skip: !testUrl }, async () => {
  const [user] = await query<User>(`INSERT INTO users(name,email,role,created_at,updated_at) VALUES('Concurrent payment test',$1,'user',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`, [`${randomUUID()}@example.invalid`])
  const [payment] = await query(`INSERT INTO payments(user_id,stripe_checkout_session_id,stripe_price_id,amount,currency,status,created_at,updated_at) VALUES($1,$2,'price_synthetic',500,'jpy','pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`, [user!.id, `cs_${randomUUID()}`])
  const f = { user: user!, payment: payment! } as Fixture
  const e = checkout(f, { payment_intent: `pi_${randomUUID()}` })
  const previous = { secret: process.env.STRIPE_WEBHOOK_SECRET, mode: process.env.STRIPE_LIVEMODE, sales: process.env.PAID_MEMBERSHIP_ENABLED }
  process.env.STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET
  process.env.STRIPE_LIVEMODE = 'false'; process.env.PAID_MEMBERSHIP_ENABLED = 'false'
  try {
    const raw = JSON.stringify(e, null, 2)
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: env.STRIPE_WEBHOOK_SECRET })
    const deliver = () => receiveStripeWebhook(paymentEvent('/webhooks/stripe', 'POST', raw, signature))
    assert.deepEqual(await Promise.all([deliver(), deliver()]), ['', ''])
    assert.equal((await query('SELECT 1 FROM memberships WHERE user_id=$1 AND source_payment_id=$2 AND status=$3', [user!.id, payment!.id, 'active'])).length, 1)
    assert.equal((await query('SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id=$1', [e.id])).length, 1)
  } finally {
    for (const [key, value] of [['STRIPE_WEBHOOK_SECRET', previous.secret], ['STRIPE_LIVEMODE', previous.mode], ['PAID_MEMBERSHIP_ENABLED', previous.sales]]) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
    await query('DELETE FROM memberships WHERE user_id=$1', [user!.id])
    await query('DELETE FROM payments WHERE id=$1', [payment!.id])
    await query('DELETE FROM users WHERE id=$1', [user!.id])
    await query('DELETE FROM stripe_webhook_events WHERE stripe_event_id=$1', [e.id])
  }
})
