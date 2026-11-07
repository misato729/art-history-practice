import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { after, before, beforeEach, test } from 'node:test'
import { toNodeListener } from 'h3'
import { createApiTestApp } from './helpers/api-app.ts'
import { configuration, setConfigurationForTesting } from '../server/core/config.ts'
import { query, closeDatabase } from '../server/core/db.ts'
import { allowedOrigins } from '../server/core/http.ts'
import { closeRateLimitStore, consumeRateLimit } from '../server/core/rate-limit.ts'
import { migrate } from '../server/database/migrate.ts'
import { saveQuestion } from '../server/services/learning-writer.ts'

process.env.APP_ENV = 'test'
process.env.BETTER_AUTH_SECRET = 'synthetic-api-test-' + randomUUID() + randomUUID()
process.env.BETTER_AUTH_URL ||= 'http://localhost:3100'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const databaseAvailable = Boolean(process.env.TEST_DATABASE_URL)
const integration = { skip: !databaseAvailable }
const original = structuredClone(configuration)
const password = 'Synthetic-password-123'
let server: Server
let base: string
const emails: string[] = []
const questionIds: number[] = []

before(async () => {
  if (!databaseAvailable) return
  assert.match(new URL(process.env.TEST_DATABASE_URL!).pathname, /_test$/)
  await migrate()
  const app = await createApiTestApp()
  server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const content = JSON.parse(await readFile(new URL('../../content/questions.json', import.meta.url), 'utf8'))
  for (const input of content.questions) {
    // This suite exercises authentication/transport using independent standalone fixtures.
    const { group_id: _group, group_question_number: _number, passage_references: _refs, ...standalone } = input
    questionIds.push((await saveQuestion(standalone)).id)
  }
})
beforeEach(async () => {
  // Transport, identity and CSRF cases use an explicitly free fixture; paid cases opt in below.
  setConfigurationForTesting({ ...original, payments: { ...original.payments, enabled: false } })
  if (databaseAvailable) await query('DELETE FROM rate_limiter_flexible')
})

after(async () => {
  setConfigurationForTesting(original)
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (databaseAvailable) {
    await query('DELETE FROM users WHERE email=ANY($1)', [emails])
    await query('DELETE FROM questions WHERE id=ANY($1)', [questionIds])
  }
  await closeRateLimitStore()
  await closeDatabase()
})

async function request(path: string, options: {
  method?: string, body?: unknown, cookie?: string, headers?: Record<string, string>, omitOrigin?: boolean,
} = {}) {
  const headers: Record<string, string> = {
    ...(options.omitOrigin ? {} : { Origin: process.env.BETTER_AUTH_URL! }),
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers,
  }
  const response = await fetch(base + (path.startsWith('/api/') ? path : '/api/v1' + path), {
    method: options.method || 'GET', headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  const cookies = response.headers.getSetCookie()
  return { status: response.status, headers: response.headers, cookies,
    cookie: cookies.map(value => value.split(';')[0]).join('; '), body: text ? JSON.parse(text) : null }
}
async function account() {
  const email = `api-${randomUUID()}@example.invalid`
  emails.push(email)
  const response = await request('/api/auth/sign-up/email', { method: 'POST', body: { name: 'API synthetic test', email, password, role: 'admin' } })
  assert.equal(response.status, 200)
  assert.ok(response.cookie)
  const me = await request('/me', { cookie: response.cookie })
  assert.equal(me.status, 200)
  return { email, cookie: response.cookie, cookies: response.cookies, user: me.body.data }
}

test('CORS only allows exact configured origins and requires HTTPS for production', () => {
  assert.deepEqual(allowedOrigins('https://example.invalid', 'production'), ['https://example.invalid'])
  for (const value of ['*', 'https://example.invalid/path', 'https://user:secret@example.invalid', 'http://example.invalid', 'https://example.invalid/']) assert.throws(() => allowedOrigins(value, 'production'))
})

test('HTTP health, response envelope, no-store and credentialed preflight remain available', integration, async () => {
  const health = await request('/health')
  assert.equal(health.status, 200)
  assert.deepEqual(health.body, { status: 'ok', app: `${configuration.site.name} API` })
  assert.equal(health.headers.get('cache-control'), 'no-store')
  const origin = process.env.BETTER_AUTH_URL!
  const preflight = await request('/me', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
  assert.equal((await request('/missing')).body.error.code, 'not_found')
  assert.equal((await request('/me')).status, 401)
  assert.equal((await request('/exams', { method: 'HEAD' })).body, null)
  assert.equal((await request('/health/')).status, 200)
  for (const path of ['/exams/extra', '/questions/next/extra', '/questions//next']) {
    const missing = await request(path)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'not_found')
  }
  assert.equal((await request('/exams', { method: 'POST', body: {} })).status, 404)
})

test('Better Auth signup uses HttpOnly sessions, filters role input, hashes credentials and handles login failures', integration, async () => {
  const session = await account()
  assert.equal(session.user.role, 'user')
  assert.equal(session.user.email, session.email)
  assert.equal('password_digest' in session.user, false)
  assert.equal('password' in session.user, false)
  assert.ok(session.cookies.some(value => /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value)))
  const [credential] = await query('SELECT password FROM auth_accounts WHERE user_id=$1 AND provider_id=$2', [session.user.id, 'credential'])
  assert.ok(credential?.password)
  assert.notEqual(credential.password, password)
  const [saved] = await query('SELECT count(*)::integer AS total FROM auth_sessions WHERE user_id=$1 AND expires_at > NOW()', [session.user.id])
  assert.equal(saved!.total, 1)
  const login = await request('/api/auth/sign-in/email', { method: 'POST', body: { email: session.email.toUpperCase(), password } })
  assert.equal(login.status, 200)
  assert.equal((await request('/me', { cookie: login.cookie })).body.data.id, session.user.id)
  assert.equal((await request('/api/auth/sign-in/email', { method: 'POST', body: { email: session.email, password: 'wrong' } })).status, 401)
  assert.equal((await request('/api/auth/sign-up/email', { method: 'POST', body: { name: 'Duplicate', email: session.email, password } })).status, 422)
  assert.equal((await request('/api/auth/sign-up/email', { method: 'POST', body: { name: '', email: 'invalid', password: 'short' } })).status, 400)
})

test('native auth rejects foreign origins, arbitrary user deletion and legacy Bearer login routes', integration, async () => {
  const email = `cross-origin-${randomUUID()}@example.invalid`
  assert.equal((await request('/api/auth/sign-up/email', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, body: { name: 'Rejected', email, password } })).status, 403)
  assert.equal((await query('SELECT id FROM users WHERE email=$1', [email])).length, 0)
  const session = await account()
  assert.ok([400, 404].includes((await request('/api/auth/delete-user', { method: 'POST', cookie: session.cookie, body: { password } })).status))
  assert.equal((await request('/me', { cookie: session.cookie })).status, 200)
  assert.equal((await request('/me', { headers: { Authorization: 'Bearer retired-custom-token' } })).status, 401)
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: session.email, password } })).status, 404)
})

test('HTTP exercises hide answers, save authenticated history and preserve favorite ownership', integration, async () => {
  const session = await account()
  const question = await request('/questions/next?exam_number=1&after_question_number=0')
  assert.equal(question.status, 200)
  const item = question.body.data
  assert.equal('explanation_blocks' in item, false)
  assert.equal('is_correct' in item.choices[0], false)
  const answered = await request(`/questions/${item.id}/answer`, { method: 'POST', cookie: session.cookie, body: { selected_choice_id: item.choices[1].id } })
  assert.equal(answered.status, 200)
  assert.ok(answered.body.data.answer_history_id)
  assert.ok(answered.body.data.explanation_blocks.length)
  assert.equal((await request(`/questions/${item.id}/answer`, { method: 'POST', body: { selected_choice_id: item.choices[0].id } })).body.data.answer_history_id, null)
  assert.equal((await request(`/questions/${item.id}/favorite`, { method: 'PUT', cookie: session.cookie })).status, 201)
  assert.equal((await request(`/questions/${item.id}/favorite`, { method: 'PUT', cookie: session.cookie })).status, 200)
  assert.equal((await request('/favorites', { cookie: session.cookie })).body.meta.total_count, 1)
  assert.equal((await request('/answer_histories', { cookie: session.cookie })).body.meta.total_count, 1)
  assert.equal((await request(`/questions/${item.id}/favorite`, { method: 'DELETE', cookie: session.cookie })).status, 204)
  assert.equal((await request(`/questions/${item.id}/favorite`, { method: 'PUT' })).status, 401)
  const another = await account()
  assert.equal((await request('/favorites', { cookie: another.cookie })).body.meta.total_count, 0)
})

test('cookie-authenticated mutations reject CSRF origins and simple form submissions before changing data', integration, async () => {
  const session = await account()
  const question = await request('/questions/next?exam_number=1&after_question_number=0')
  const path = `/questions/${question.body.data.id}/favorite`
  const rejectedOrigins: { headers?: Record<string, string>, omitOrigin?: boolean }[] = [
    { headers: { Origin: 'https://untrusted.invalid' } },
    { omitOrigin: true },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  ]
  for (const options of rejectedOrigins) assert.equal((await request(path, { method: 'PUT', cookie: session.cookie, ...options })).status, 403)
  assert.equal((await request(path, { method: 'PUT', cookie: session.cookie, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415)
  assert.equal((await request('/favorites', { cookie: session.cookie })).body.meta.total_count, 0)
})

test('HTTP administrator checks read current roles while preserving the library session and question IDs', integration, async () => {
  const session = await account()
  assert.equal((await request('/admin/questions', { cookie: session.cookie })).status, 403)
  assert.equal((await request('/admin/questions/unknown/extra', { cookie: session.cookie })).status, 403)
  await query("UPDATE users SET role='admin' WHERE id=$1", [session.user.id])
  assert.equal((await request('/admin/questions', { cookie: session.cookie })).status, 200)
  const expanded = structuredClone(original)
  expanded.exam.set_count = original.exam.set_count + 1
  expanded.exam.upcoming_sets = []
  delete expanded.exam.sets
  setConfigurationForTesting(expanded)
  try {
  const content = JSON.parse(await readFile(new URL('../../content/questions.json', import.meta.url), 'utf8'))
  const { group_id: _group, group_question_number: _number, passage_references: _references, ...standalone } = content.questions[0]
  const created = await request('/admin/questions', { method: 'POST', cookie: session.cookie, body: { question: { ...standalone, exam_number: expanded.exam.set_count, publication_status: 'draft' } } })
  assert.equal(created.status, 201)
  const id = created.body.data.id
  questionIds.push(id)
  const updated = await request(`/admin/questions/${id}`, { method: 'PATCH', cookie: session.cookie, body: { question: { ...standalone, exam_number: expanded.exam.set_count, publication_status: 'draft' } } })
  assert.equal(updated.body.data.id, id)
  const replaced = await request(`/admin/questions/${id}`, { method: 'PUT', cookie: session.cookie, body: { question: { ...standalone, exam_number: expanded.exam.set_count, publication_status: 'draft' } } })
  assert.equal(replaced.status, 200)
  assert.equal(replaced.body.data.id, id)
  assert.equal((await request(`/admin/questions/${id}`, { method: 'DELETE', cookie: session.cookie })).status, 204)
  assert.equal((await query('SELECT id FROM question_choices WHERE question_id=$1', [id])).length, 0)
  await query("UPDATE users SET role='user' WHERE id=$1", [session.user.id])
  assert.equal((await request('/admin/questions', { cookie: session.cookie })).status, 403)
  } finally { setConfigurationForTesting(original) }
})

test('paid gates and expired or tampered database sessions preserve API status boundaries', integration, async () => {
  const session = await account()
  const paid = structuredClone(original)
  paid.payments.enabled = true
  paid.payments.free_exam_count = 0
  setConfigurationForTesting(paid)
  try {
    assert.equal((await request('/questions/next?exam_number=1&after_question_number=0')).status, 401)
    assert.equal((await request('/questions/next?exam_number=1&after_question_number=0', { cookie: session.cookie })).status, 403)
    assert.equal((await request('/favorites', { cookie: session.cookie })).status, 403)
    assert.equal((await request('/payments/config')).body.data.enabled, false)
    assert.equal((await request('/payments/checkout_sessions', { method: 'POST', cookie: session.cookie })).body.error.code, 'payment_unavailable')
    assert.equal((await request('/me', { cookie: session.cookie.replace(/session_token=([^;]+)/, 'session_token=$1tampered') })).status, 401)
    await query("UPDATE auth_sessions SET expires_at=NOW()-interval '1 second' WHERE user_id=$1", [session.user.id])
    assert.equal((await request('/me', { cookie: session.cookie })).status, 401)
  } finally { setConfigurationForTesting(original) }
})

test('logout revokes the server session so a copied cookie cannot be reused', integration, async () => {
  const session = await account()
  assert.equal((await request('/api/auth/sign-out', { method: 'POST', cookie: session.cookie, body: {} })).status, 200)
  assert.equal((await request('/me', { cookie: session.cookie })).status, 401)
  assert.equal((await query('SELECT id FROM auth_sessions WHERE user_id=$1', [session.user.id])).length, 0)
})

test('account deletion verifies the library password and cascades personal data and sessions', integration, async () => {
  const session = await account()
  assert.equal((await request('/me', { method: 'DELETE', cookie: session.cookie, body: { current_password: 'wrong' } })).status, 422)
  assert.equal((await request('/me', { method: 'DELETE', cookie: session.cookie, body: { current_password: password } })).status, 204)
  assert.equal((await request('/me', { cookie: session.cookie })).status, 401)
  assert.equal((await query('SELECT id FROM auth_accounts WHERE user_id=$1', [session.user.id])).length, 0)
  assert.equal((await query('SELECT id FROM auth_sessions WHERE user_id=$1', [session.user.id])).length, 0)
})

test('PostgreSQL rate increments are atomic across concurrent requests', integration, async () => {
  const subject = `synthetic-rate-${randomUUID()}`
  const results = await Promise.all(Array.from({ length: 45 }, () => consumeRateLimit('login', subject)))
  assert.equal(results.filter(result => result.allowed).length, 30)
  assert.ok(results.every(result => result.retryAfter > 0 && result.retryAfter <= 300))
})


test('native authentication throttling returns a retry interval without setting a session', integration, async () => {
  await Promise.all(Array.from({ length: 10 }, () => consumeRateLimit('signup', '127.0.0.1')))
  const response = await request('/api/auth/sign-up/email', { method: 'POST', body: { name: 'Limited', email: 'limited@example.invalid', password } })
  assert.equal(response.status, 429)
  assert.equal(response.body.code, 'rate_limit_exceeded')
  assert.ok(Number(response.headers.get('retry-after')) > 0)
  assert.equal(response.cookie, '')
})
