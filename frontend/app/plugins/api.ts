export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const route = useRoute()
  const { user, authResolved, sessionVersion, clearCurrentUser } = useAuth()
  const { beginRequest, finishRequest } = useApiStatus()
  const requestVersions = new WeakMap<object, number>()

  const api = $fetch.create({
    baseURL: import.meta.server && config.apiBaseInternal ? config.apiBaseInternal : config.public.apiBase,
    credentials: 'include',
    headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
    onRequest({ options }) {
      requestVersions.set(options, sessionVersion.value)
      beginRequest()
    },
    onResponse({ response }) {
      finishRequest(response.status >= 500 ? 'failed' : 'connected')
    },
    onRequestError({ options }) {
      finishRequest(options.signal?.aborted ? undefined : 'failed')
    },
    async onResponseError({ request, response, options }) {
      const path = new URL(typeof request === 'string' ? request : request.url, 'http://api.local').pathname
      if (response.status !== 401 || !path.startsWith('/api/v1/') || requestVersions.get(options) !== sessionVersion.value) return
      const hadUser = user.value !== null
      // A failed session check invalidates local state; it must never call signOut.
      if (hadUser || !authResolved.value) clearCurrentUser()
      if (path !== '/api/v1/me' && hadUser && import.meta.client && [route.meta.middleware].flat().includes('auth')) {
        await nuxtApp.runWithContext(() => navigateTo({ path: '/login', query: { redirect: route.fullPath } }))
      }
    },
  })

  return { provide: { api } }
})
