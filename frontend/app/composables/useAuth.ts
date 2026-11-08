import { signupFormSchema } from '../../shared/schemas/auth.ts'
import type { AuthUser } from '../../shared/types/auth.ts'
export type { AuthUser, FavoriteQuestion } from '../../shared/types/auth.ts'

type ApiResponse<T> = { data: T }
const currentUserRequests = new WeakMap<object, { version: number, promise: Promise<AuthUser | null> }>()
const logoutRequests = new WeakMap<object, Promise<void>>()
const authMutationQueues = new WeakMap<object, Promise<void>>()

function authFailure(error: { status?: number, code?: string }, action: 'login' | 'signup' | 'logout') {
  let message: string | undefined
  let code = 'authentication_failed'
  if (error.status === 429 || ['TOO_MANY_REQUESTS', 'RATE_LIMITED'].includes(error.code || '')) {
    message = '操作が集中しています。しばらく待ってからお試しください'
    code = 'rate_limit_exceeded'
  } else if (action === 'login' && (error.status === 401 || ['INVALID_EMAIL_OR_PASSWORD', 'INVALID_PASSWORD', 'USER_NOT_FOUND', 'INVALID_EMAIL'].includes(error.code || ''))) {
    message = 'メールアドレスまたはパスワードが正しくありません'
    code = 'unauthorized'
  } else if (action === 'signup' && ([400, 409, 422].includes(error.status || 0) || ['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'PASSWORD_TOO_SHORT', 'PASSWORD_TOO_LONG', 'INVALID_EMAIL'].includes(error.code || ''))) {
    message = '入力内容を確認してください'
    code = 'validation_error'
  }
  return Object.assign(new Error(message || 'Authentication request failed'), {
    statusCode: error.status,
    ...(message ? { data: { error: { code, message } } } : {}),
  })
}

function serializeAuthMutation<T>(app: object, action: () => Promise<T>): Promise<T> {
  const result = (authMutationQueues.get(app) ?? Promise.resolve()).then(action)
  // Failed operations release the queue too; they must not block a later login.
  const settled = result.then(() => {}, () => {})
  authMutationQueues.set(app, settled)
  void settled.then(() => {
    if (authMutationQueues.get(app) === settled) authMutationQueues.delete(app)
  })
  return result
}

export const useAuth = () => {
  const nuxtApp = useNuxtApp()
  const user = useState<AuthUser | null>('auth-user', () => null)
  const authResolved = useState<boolean>('auth-resolved', () => false)
  // This is only a local request generation, never a session ID or credential.
  const sessionVersion = useState<number>('auth-request-version', () => 0)
  const authMutationPending = useState<number>('auth-mutation-pending', () => 0)
  const isLoggedIn = computed(() => user.value !== null)
  // Keep existing useFetch callers compatible; credentials are handled by $api.
  const authHeaders = computed<Record<string, string>>(() => ({}))
  const queueMutation = <T>(action: () => Promise<T>): Promise<T> => {
    authMutationPending.value += 1
    return serializeAuthMutation(nuxtApp, action).finally(() => { authMutationPending.value -= 1 })
  }

  const clearCurrentUser = () => {
    sessionVersion.value += 1
    user.value = null
    authResolved.value = true
  }

  const loadCurrentUser = async (force = false): Promise<AuthUser | null> => {
    const version = sessionVersion.value
    const pending = currentUserRequests.get(nuxtApp)
    if (pending?.version === version) return pending.promise
    if (!force && (user.value || authResolved.value)) return user.value

    const promise: Promise<AuthUser | null> = nuxtApp.$api<ApiResponse<AuthUser>>('/api/v1/me', {
      credentials: 'include', retry: 0,
    }).then((response) => {
      if (sessionVersion.value !== version) return null
      user.value = response.data
      authResolved.value = true
      return user.value
    }).catch((error: any) => {
      if (sessionVersion.value === version && (error?.statusCode ?? error?.status) === 401 && (!authResolved.value || user.value !== null)) clearCurrentUser()
      return null
    }).finally(() => {
      if (currentUserRequests.get(nuxtApp)?.promise === promise) currentUserRequests.delete(nuxtApp)
    })
    currentUserRequests.set(nuxtApp, { version, promise })
    return promise
  }

  const ensureCurrentUser = async (force = false): Promise<AuthUser | null> => {
    // Components can react to authResolved changing before the native action
    // has written its cookie. Let that action and its own hydration finish.
    while (true) {
      let mutation = authMutationQueues.get(nuxtApp)
      while (mutation) {
        await mutation
        mutation = authMutationQueues.get(nuxtApp)
      }
      const version = sessionVersion.value
      const current = await loadCurrentUser(force)
      if (sessionVersion.value === version) return current
      // A newer native identity may have replaced this lookup while a route
      // guard was waiting. Join that identity instead of returning stale null.
      force = false
    }
  }

  const completeSignIn = async (operationVersion: number) => {
    if (sessionVersion.value !== operationVersion) throw new Error('Authentication operation was superseded')
    // Invalidate checks made with the old cookie while the native action ran.
    const hydrationVersion = ++sessionVersion.value
    user.value = null
    authResolved.value = false
    const current = await loadCurrentUser(true)
    if (sessionVersion.value !== hydrationVersion || !current) throw new Error('Session could not be confirmed')
    return current
  }
  const login = (credentials: { email: string, password: string }) => queueMutation(async () => {
    const version = ++sessionVersion.value
    authResolved.value = false
    const result = await nuxtApp.$authClient.signIn.email(credentials)
    if (result.error) throw authFailure(result.error, 'login')
    return completeSignIn(version)
  })
  const signup = async (attributes: { name: string, email: string, password: string, password_confirmation: string }) => {
    const input = signupFormSchema.parse(attributes)
    return queueMutation(async () => {
      const version = ++sessionVersion.value
      authResolved.value = false
      const { name, email, password } = input
      const result = await nuxtApp.$authClient.signUp.email({ name, email, password })
      if (result.error) throw authFailure(result.error, 'signup')
      return completeSignIn(version)
    })
  }
  const logout = async (): Promise<void> => {
    const pending = logoutRequests.get(nuxtApp)
    if (pending) return pending
    const promise = queueMutation(async () => {
      const version = ++sessionVersion.value
      const result = await nuxtApp.$authClient.signOut()
      if (result.error) throw authFailure(result.error, 'logout')
      if (sessionVersion.value === version) clearCurrentUser()
    }).finally(() => {
      if (logoutRequests.get(nuxtApp) === promise) logoutRequests.delete(nuxtApp)
    })
    logoutRequests.set(nuxtApp, promise)
    return promise
  }

  const deleteAccount = (currentPassword: string): Promise<void> => queueMutation(async () => {
    const version = ++sessionVersion.value
    await nuxtApp.$api('/api/v1/me', {
      method: 'DELETE', credentials: 'include', retry: 0,
      body: { current_password: currentPassword },
    })
    // Deletion already revoked the DB sessions. Let Better Auth notify its
    // other tabs too, without turning a completed deletion into an error.
    try { await nuxtApp.$authClient.signOut({ fetchOptions: { timeout: 3000 } }) } catch {}
    if (sessionVersion.value === version) clearCurrentUser()
  })

  return { user, isLoggedIn, authResolved, sessionVersion, authMutationPending, authHeaders, clearCurrentUser, login, signup, logout, deleteAccount, ensureCurrentUser }
}
