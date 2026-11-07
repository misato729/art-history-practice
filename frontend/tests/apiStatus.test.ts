import assert from 'node:assert/strict'
import test from 'node:test'
import { ofetch } from 'ofetch'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { useApiStatus } from '../app/composables/useApiStatus.ts'

const globals = globalThis as any
globals.computed = computed
globals.defineNuxtPlugin = (setup: unknown) => setup
globals.useApiStatus = useApiStatus
globals.useRuntimeConfig = () => ({ public: { apiBase: 'https://api.example.invalid' } })
globals.useRoute = () => ({ fullPath: '/favorites', meta: { middleware: 'auth' } })
const { default: setupApi } = await import('../app/plugins/api.ts')

const createClient = (fetch: typeof globalThis.fetch) => {
  const states = new Map()
  globals.useState = (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  }
  const user = ref<{ id: number } | null>({ id: 1 })
  const sessionVersion = ref(0)
  const authResolved = ref(true)
  let clearCalls = 0
  globals.useAuth = () => ({ user, authResolved, sessionVersion, clearCurrentUser: () => { user.value = null; authResolved.value = true; sessionVersion.value += 1; clearCalls += 1 } })
  globals.$fetch = ofetch.create({}, { fetch })
  const result = (setupApi as any)({ runWithContext: (fn: () => unknown) => fn() })
  return { api: result.provide.api, status: useApiStatus().apiStatus, user, authResolved, sessionVersion, clearCalls: () => clearCalls }
}

test('API state starts idle and counts simultaneous requests', async () => {
  const resolvers: Array<(response: Response) => void> = []
  const client = createClient(async () => await new Promise<Response>(resolve => { resolvers.push(resolve) }))
  assert.equal(client.status.value, 'idle')
  const first = client.api('/first')
  const second = client.api('/second')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(client.status.value, 'checking')
  resolvers[0]!(new Response('{}', { status: 200 }))
  await first
  assert.equal(client.status.value, 'checking')
  resolvers[1]!(new Response('{}', { status: 200 }))
  await second
  assert.equal(client.status.value, 'connected')
})

test('HTTP 4xx is reachable while server and network failures are failed', async () => {
  const reachable = createClient(async () => new Response('{}', { status: 422 }))
  await assert.rejects(reachable.api('/validation', { retry: 0 }))
  assert.equal(reachable.status.value, 'connected')

  const server = createClient(async () => new Response('{}', { status: 503 }))
  await assert.rejects(server.api('/unavailable', { retry: 0 }))
  assert.equal(server.status.value, 'failed')

  const network = createClient(async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(network.api('/offline', { retry: 0 }))
  assert.equal(network.status.value, 'failed')
})

test('rate-limited actions preserve the session and expose the server retry advice without retrying', async () => {
  let calls = 0
  const client = createClient(async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Please wait before retrying' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    })
  })
  await assert.rejects(client.api('/api/v1/questions/1/answer', { method: 'POST' }), (error: any) => {
    assert.equal(error.data.error.code, 'rate_limit_exceeded')
    assert.equal(error.data.error.message, 'Please wait before retrying')
    assert.equal(error.response.headers.get('Retry-After'), '30')
    return true
  })
  assert.equal(calls, 1)
  assert.deepEqual(client.user.value, { id: 1 })
  assert.equal(client.clearCalls(), 0)
  assert.equal(client.status.value, 'connected')
})

test('navigation cancellation does not report a connection failure', async () => {
  const controller = new AbortController()
  const client = createClient(async (_input, options) => {
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return new Response('{}', { status: 200 })
  })
  await client.api('/success')
  controller.abort()
  await assert.rejects(client.api('/canceled', { signal: controller.signal, retry: 0 }))
  assert.equal(client.status.value, 'connected')
})

test('an application 401 clears local identity without issuing a sign-out request', async () => {
  let calls = 0
  const client = createClient(async () => { calls += 1; return new Response('{}', { status: 401 }) })
  await assert.rejects(client.api('/api/auth/sign-in/email', { retry: 0 }))
  assert.equal(client.clearCalls(), 0)
  await assert.rejects(client.api('/api/v1/me', { retry: 0 }))
  assert.equal(client.clearCalls(), 1)
  assert.equal(client.user.value, null)
  assert.equal(calls, 2)
  assert.equal(client.status.value, 'connected')
})

test('a stale application 401 cannot clear a replacement session', async () => {
  let resolve!: (response: Response) => void
  const client = createClient(async () => new Promise<Response>(done => { resolve = done }))
  const request = client.api('/api/v1/favorites', { retry: 0 })
  await new Promise(done => setTimeout(done, 0))
  client.sessionVersion.value += 1
  client.user.value = { id: 2 }
  resolve(new Response('{}', { status: 401 }))
  await assert.rejects(request)
  assert.deepEqual(client.user.value, { id: 2 })
  assert.equal(client.clearCalls(), 0)
})

test('application requests include cookies without a JavaScript authorization token', async () => {
  let credentials: RequestCredentials | undefined
  let authorization: string | null = null
  const client = createClient(async (_input, options) => {
    credentials = options?.credentials
    authorization = new Headers(options?.headers).get('Authorization')
    return new Response('{}', { status: 200 })
  })
  await client.api('/api/v1/me')
  assert.equal(credentials, 'include')
  assert.equal(authorization, null)
})


test('SSR forwards the incoming HttpOnly session cookie with each request-scoped API client', async () => {
  const source = readFileSync(new URL('../app/plugins/api.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.server', 'true').replaceAll('import.meta.client', 'false')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText
  const { default: setupServerApi } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
  const requests: { cookie: string | null, target: string }[] = []
  globals.useRuntimeConfig = () => ({ apiBaseInternal: 'http://internal.example.invalid', public: { apiBase: 'https://public.example.invalid' } })
  const fetcher = async (input: RequestInfo | URL, options?: RequestInit) => {
    requests.push({ cookie: new Headers(options?.headers).get('cookie'), target: String(input) })
    return new Response('{}', { status: 200 })
  }
  globals.useRequestHeaders = () => ({ cookie: 'session-first' })
  createClient(fetcher)
  const first = setupServerApi({}).provide.api
  globals.useRequestHeaders = () => ({ cookie: 'session-second' })
  createClient(fetcher)
  const second = setupServerApi({}).provide.api
  await first('/api/v1/me'); await second('/api/v1/me')
  assert.deepEqual(requests, [
    { cookie: 'session-first', target: 'http://internal.example.invalid/api/v1/me' },
    { cookie: 'session-second', target: 'http://internal.example.invalid/api/v1/me' },
  ])
})


test('an anonymous paid-question 401 does not restart catalog ownership or create a refetch loop', async () => {
  const client = createClient(async () => new Response('{}', { status: 401 }))
  client.user.value = null
  for (let i = 0; i < 2; i++) await assert.rejects(client.api('/api/v1/questions/next?exam_number=3&question_number=1', { retry: 0 }))
  assert.equal(client.sessionVersion.value, 0)
  assert.equal(client.clearCalls(), 0)
})
