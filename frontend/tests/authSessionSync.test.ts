import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, ref, watch } from 'vue'
import { useAuth, type AuthUser } from '../app/composables/useAuth.ts'
import { useFavorites } from '../app/composables/useFavorites.ts'

const globals = globalThis as any
globals.computed = computed
globals.watch = watch
globals.useAuth = useAuth
globals.defineNuxtPlugin = (plugin: any) => plugin.setup
globals.defineNuxtRouteMiddleware = (middleware: unknown) => middleware
globals.navigateTo = (target: unknown) => target
const { default: observeSession } = await import('../app/plugins/auth-session.client.ts')
const { default: protectRoute } = await import('../app/middleware/auth.ts')
const flush = () => new Promise<void>(done => setImmediate(done))
const member = (id: number): AuthUser => ({ id, name: `Member ${id}`, email: `member-${id}@example.invalid`, role: 'user',
  paid_content_access: true, favorite_questions: [{ id, exam_number: 1, question_number: 1 }],
  membership: { status: 'active', purchased_at: null, expires_at: null } })
const sessionFor = (id: number | null, sessionId = 'session-one') => ({
  data: id === null ? null : { user: { id: String(id) }, session: { id: sessionId } },
  isPending: false, isRefetching: false, error: null as null | { status: number },
})
function harness(initial: AuthUser | null, fetchUser: () => Promise<unknown>, nativeIdentity = initial?.id ?? null, resolvedAnonymous = false) {
  const native = ref(sessionFor(nativeIdentity))
  const states = new Map()
  const app = { $api: fetchUser, $authClient: {
    useSession: () => native,
    signIn: { email: async () => ({ data: {} }) },
    signUp: { email: async () => ({ data: {} }) },
    signOut: async () => ({ data: {} }),
  } }
  globals.useNuxtApp = () => app
  globals.useState = (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  }
  const auth = useAuth()
  auth.user.value = initial
  auth.authResolved.value = initial !== null || resolvedAnonymous
  ;(observeSession as any)(app)
  return { auth, native }
}

test('the initial native session reuses matching SSR application identity', () => {
  let reads = 0
  const { auth } = harness(member(1), async () => { reads += 1; return { data: member(1) } })
  assert.equal(auth.user.value?.id, 1)
  assert.equal(reads, 0)
})

test('a library cross-tab identity change hides old favorites before loading the replacement member', async () => {
  let resolve!: (value: unknown) => void
  const { auth, native } = harness(member(1), async () => new Promise(done => { resolve = done }))
  const favorites = useFavorites()
  native.value = sessionFor(2, 'session-two')
  assert.equal(auth.user.value, null)
  assert.deepEqual(favorites.favoriteIds.value, [])
  resolve({ data: member(2) }); await flush()
  assert.equal(auth.user.value?.id, 2)
  assert.deepEqual(favorites.favoriteIds.value, [2])
})

test('library cross-tab sign-out clears identity and prevents pending me from restoring it', async () => {
  let resolve!: (value: unknown) => void
  let reads = 0
  const { auth, native } = harness(member(1), async () => { reads += 1; return new Promise(done => { resolve = done }) })
  const stale = auth.ensureCurrentUser(true)
  native.value = sessionFor(null)
  assert.equal(auth.user.value, null)
  assert.deepEqual(useFavorites().favoriteIds.value, [])
  resolve({ data: member(1) })
  assert.equal(await stale, null)
  assert.equal(auth.user.value, null)
  assert.equal(reads, 1)
})

test('native session errors do not pretend a valid application session signed out', () => {
  const { auth, native } = harness(member(1), async () => ({ data: member(1) }))
  native.value = { ...sessionFor(null), error: { status: 503 } }
  assert.equal(auth.user.value?.id, 1)
})

test('native notifications wait for local auth mutations instead of superseding their hydration', async () => {
  let reads = 0
  const { auth, native } = harness(member(1), async () => { reads += 1; return { data: member(2) } })
  const login = auth.login({ email: 'member-2@example.invalid', password: 'test-password' })
  assert.equal(auth.authMutationPending.value, 1)
  native.value = sessionFor(2, 'session-two')
  assert.equal(auth.user.value?.id, 1)
  assert.equal(reads, 0)
  assert.equal((await login).id, 2)
  await flush()
  assert.equal(auth.user.value?.id, 2)
  assert.equal(auth.authMutationPending.value, 0)
  assert.equal(reads, 2)
})

test('a deep-link guard waits for app me despite a first empty native snapshot', async () => {
  let resolve!: (value: unknown) => void
  let reads = 0
  const { auth, native } = harness(null, async () => {
    if (++reads === 1) return new Promise(done => { resolve = done })
    return { data: member(1) }
  })
  let settled = false
  const navigation = (protectRoute as any)({ fullPath: '/favorites' }).then((result: unknown) => { settled = true; return result })
  await flush()
  const earlyRedirect = settled
  native.value = sessionFor(1)
  resolve({ data: member(1) })
  assert.equal(await navigation, undefined)
  assert.equal(earlyRedirect, false)
  assert.equal(auth.user.value?.id, 1)
  assert.ok(reads >= 1)
})

test('a first valid native snapshot joins the initial guard lookup without superseding it', async () => {
  let resolve!: (value: unknown) => void
  let reads = 0
  const { auth } = harness(null, async () => { reads += 1; return new Promise(done => { resolve = done }) }, 1)
  const navigation = (protectRoute as any)({ fullPath: '/favorites' })
  assert.equal(reads, 1)
  resolve({ data: member(1) })
  assert.equal(await navigation, undefined)
  assert.equal(auth.user.value?.id, 1)
  assert.equal(reads, 1)
})

test('a guard follows a newer native identity instead of returning an obsolete anonymous result', async () => {
  const responses: ((value: unknown) => void)[] = []
  const { auth, native } = harness(null, async () => new Promise(done => { responses.push(done) }), 1)
  const navigation = (protectRoute as any)({ fullPath: '/favorites' })
  native.value = sessionFor(2, 'session-two')
  responses[0]!({ data: member(1) })
  await flush()
  responses[1]!({ data: member(2) })
  assert.equal(await navigation, undefined)
  assert.equal(auth.user.value?.id, 2)
})


test('a delayed initial anonymous snapshot reuses an already resolved anonymous me', () => {
  let reads = 0
  const { auth } = harness(null, async () => { reads += 1; throw { status: 401 } }, null, true)
  assert.equal(reads, 0)
  assert.equal(auth.sessionVersion.value, 0)
  assert.equal(auth.authResolved.value, true)
})

test('a resolved anonymous application still hydrates an initial native logged-in identity', async () => {
  let reads = 0
  const { auth } = harness(null, async () => { reads += 1; return { data: member(2) } }, 2, true)
  await flush()
  assert.equal(reads, 1)
  assert.equal(auth.user.value?.id, 2)
})
