import type { ComputedRef } from 'vue'
import type { ExamCatalogEntry } from '../utils/examCatalog'

const pending = new WeakMap<object, { owner: string; promise: Promise<ExamCatalogEntry[] | null> }>()

/** Share the public catalog while discarding responses from a previous login. */
export const usePracticeCatalog = (enabled: ComputedRef<boolean>, options: { immediate?: boolean } = {}) => {
  const app = useNuxtApp()
  const { user, sessionVersion } = useAuth()
  const owner = computed(() => JSON.stringify([sessionVersion.value, user.value?.id, user.value?.role, user.value?.paid_content_access]))
  const state = useState<{ owner: string; generation: number; status: 'idle' | 'pending' | 'success' | 'error'; data: ExamCatalogEntry[] | null }>('practice-catalog', () => ({ owner: '', generation: 0, status: 'idle', data: null }))
  let mounted = false
  const invalidate = () => {
    if (state.value.owner === owner.value) return
    state.value = { owner: owner.value, generation: state.value.generation + 1, status: 'idle', data: null }
  }
  const refresh = (force = false): Promise<ExamCatalogEntry[] | null> => {
    invalidate()
    if (!mounted || !enabled.value) return Promise.resolve(null)
    const existing = pending.get(app)
    if (existing?.owner === owner.value) return existing.promise
    if (!force && state.value.status === 'success') return Promise.resolve(state.value.data)
    const requestedOwner = owner.value
    const generation = ++state.value.generation
    state.value.status = 'pending'
    const current = () => requestedOwner === owner.value && generation === state.value.generation
    const promise = app.$api<{ data: ExamCatalogEntry[] }>('/api/v1/exams').then(response => {
      if (!current()) return null
      state.value.data = response.data
      state.value.status = 'success'
      return response.data
    }).catch(() => {
      if (current()) { state.value.status = 'error'; state.value.data = null }
      return null
    }).finally(() => { if (pending.get(app)?.promise === promise) pending.delete(app) })
    pending.set(app, { owner: requestedOwner, promise })
    return promise
  }
  watch(owner, () => { invalidate(); if (mounted && enabled.value && options.immediate !== false) void refresh() }, { flush: 'sync' })
  watch(enabled, value => { if (mounted && value && options.immediate !== false) void refresh() })
  onMounted(() => { mounted = true; if (enabled.value && options.immediate !== false) void refresh() })
  onScopeDispose(() => { mounted = false })
  const data = computed(() => enabled.value && state.value.owner === owner.value ? state.value.data : null)
  const status = computed(() => enabled.value && state.value.owner === owner.value ? state.value.status : 'idle')
  return { data, status, error: computed(() => status.value === 'error'), load: () => refresh(), refresh: () => refresh(true) }
}
