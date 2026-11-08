export default defineNuxtPlugin({
  name: 'auth-session',
  dependsOn: ['auth-client'],
  setup(nuxtApp) {
    // Mount the library subscription so its cross-tab and focus refreshes run.
    const session = nuxtApp.$authClient.useSession()
    const { user, authResolved, sessionVersion, authMutationPending, clearCurrentUser, ensureCurrentUser } = useAuth()
    let observed = false
    let previousKey: string | null = null

    watch([session, authMutationPending], ([current, mutations]) => {
      if (mutations || current.isPending || current.isRefetching || (current.error && current.error.status !== 401)) return
      const identity = current.data?.user?.id
      const nextKey = identity == null ? null : JSON.stringify([identity, current.data?.session?.id])
      if (observed && nextKey === previousKey) return
      const initial = !observed
      observed = true
      previousKey = nextKey

      const sameUser = identity != null && user.value != null && String(identity) === String(user.value.id)
      if (initial) {
        // The first native snapshot must not invalidate the application's
        // initial /me lookup that route guards may already be awaiting.
        const sameAnonymous = identity == null && user.value === null && authResolved.value
        if (!sameUser && !sameAnonymous) void ensureCurrentUser(true)
        return
      }
      // Hide another account's data before the asynchronous application fetch.
      if (!sameUser) clearCurrentUser()
      if (identity != null) {
        if (sameUser) sessionVersion.value += 1
        void ensureCurrentUser(true)
      }
    }, { immediate: true, flush: 'sync' })
  },
})
