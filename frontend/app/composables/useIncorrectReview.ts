import {
  createPracticeSeed,
  shufflePracticeSequence,
  type PracticePosition,
} from '../utils/practiceSequence.ts'

export type IncorrectReviewQuestion = {
  question_id: number
  exam_number: number
  question_number: number
}

type IncorrectReviewResponse = {
  data: IncorrectReviewQuestion[]
  meta: { total_count: number }
}

type LoadIncorrectReviewOptions = {
  force?: boolean
}

type PendingIncorrectReviewRequest = {
  sessionKey: string
  promise: Promise<PracticePosition[]>
}

const pendingRequests = new WeakMap<object, PendingIncorrectReviewRequest>()

const normalizeQuestions = (data: unknown): IncorrectReviewQuestion[] => {
  if (!Array.isArray(data)) return []

  const seen = new Set<string>()
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Partial<IncorrectReviewQuestion>
    const questionId = record.question_id
    const examNumber = record.exam_number
    const questionNumber = record.question_number
    if (
      typeof questionId !== 'number' || !Number.isInteger(questionId) || questionId <= 0
      || typeof examNumber !== 'number' || !Number.isInteger(examNumber) || examNumber <= 0
      || typeof questionNumber !== 'number' || !Number.isInteger(questionNumber) || questionNumber <= 0
    ) return []

    const key = `${examNumber}:${questionNumber}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{
      question_id: questionId,
      exam_number: examNumber,
      question_number: questionNumber,
    }]
  }).sort((left, right) => (
    left.exam_number - right.exam_number
    || left.question_number - right.question_number
    || left.question_id - right.question_id
  ))
}

export const useIncorrectReview = () => {
  const nuxtApp = useNuxtApp()
  const { $api: api } = nuxtApp
  const { user, isLoggedIn, sessionVersion, authHeaders, ensureCurrentUser } = useAuth()
  const questions = useState<IncorrectReviewQuestion[]>('incorrect-review-questions', () => [])
  const loadedFor = useState<string | null>('incorrect-review-loaded-for', () => null)
  const ownerKey = useState<string | null>('incorrect-review-owner-key', () => null)
  const requestVersion = useState<number>('incorrect-review-request-version', () => 0)
  const loading = useState<boolean>('incorrect-review-loading', () => false)
  const loadError = useState<string>('incorrect-review-error', () => '')
  const sessionKey = computed(() => JSON.stringify([
    user.value?.id ?? null,
    sessionVersion.value,
    user.value?.paid_content_access ?? false,
    user.value?.role ?? null,
  ]))

  const round = useState<{ seed: number; positions: PracticePosition[] } | null>('incorrect-review-round', () => null)
  const starting = ref(false)
  let active = true
  onScopeDispose(() => { active = false })

  const resetForSession = (nextOwnerKey: string) => {
    requestVersion.value += 1
    round.value = null
    questions.value = []
    loadedFor.value = null
    ownerKey.value = nextOwnerKey
    loading.value = false
    loadError.value = ''
    pendingRequests.delete(nuxtApp)
  }

  if (ownerKey.value !== sessionKey.value) resetForSession(sessionKey.value)
  watch(sessionKey, key => resetForSession(key), { flush: 'sync' })

  const positions = computed<PracticePosition[]>(() => questions.value.map(question => ({
    examNumber: question.exam_number,
    questionNumber: question.question_number,
  })))
  const totalCount = computed(() => positions.value.length)
  const loaded = computed(() => (
    isLoggedIn.value && loadedFor.value === sessionKey.value
  ))

  const invalidate = () => {
    requestVersion.value++
    questions.value = []
    loadedFor.value = null
    loading.value = false
    loadError.value = ''
    pendingRequests.delete(nuxtApp)
  }
  const clear = () => { invalidate(); round.value = null }
  const prepareRound = async (seed: number): Promise<PracticePosition[] | null> => {
    if (round.value?.seed === seed) return round.value.positions
    const session = sessionKey.value
    const available = await load({ force: true })
    if (!active || session !== sessionKey.value || !loaded.value || loadError.value) return null
    const positions = shufflePracticeSequence(available, seed)
    round.value = { seed, positions }
    return positions
  }

  const load = (options: LoadIncorrectReviewOptions = {}): Promise<PracticePosition[]> => {
    const requestedSession = sessionKey.value
    if (!isLoggedIn.value) {
      resetForSession(requestedSession)
      return Promise.resolve([])
    }

    const pending = pendingRequests.get(nuxtApp)
    if (pending?.sessionKey === requestedSession) return pending.promise
    if (!options.force && loadedFor.value === requestedSession) return Promise.resolve(positions.value)

    const version = ++requestVersion.value
    loading.value = true
    loadError.value = ''

    const promise = api<IncorrectReviewResponse>('/api/v1/review_questions/incorrect', {
      headers: authHeaders.value,
    }).then((response) => {
      if (
        version !== requestVersion.value
        || requestedSession !== sessionKey.value
        || !isLoggedIn.value
      ) return positions.value

      questions.value = normalizeQuestions(response.data)
      loadedFor.value = requestedSession
      return positions.value
    }).catch((requestError: any) => {
      if (version !== requestVersion.value || requestedSession !== sessionKey.value) return positions.value
      if (requestError?.statusCode === 401 || requestError?.status === 401) { loadError.value = 'ログイン状態を確認できません。もう一度ログインしてください。'; return [] }
      loadError.value = '間違えた問題を読み込めませんでした。もう一度お試しください。'
      return []
    }).finally(() => {
      if (version === requestVersion.value) loading.value = false
      if (pendingRequests.get(nuxtApp)?.promise === promise) pendingRequests.delete(nuxtApp)
    })

    pendingRequests.set(nuxtApp, { sessionKey: requestedSession, promise })
    return promise
  }

  const createSequence = (seed: number) => (
    shufflePracticeSequence(positions.value, seed)
  )

  const start = async () => {
    if (starting.value || !isLoggedIn.value) return false
    starting.value = true
    loadError.value = ''
    try {
      if (!await ensureCurrentUser(true) || !active) { if (active) loadError.value = 'ログイン状態を確認できませんでした。もう一度お試しください。'; return false }
      const session = sessionKey.value
      round.value = null
      const seed = createPracticeSeed()
      const sequence = await prepareRound(seed)
      if (!sequence?.length || session !== sessionKey.value || !active) return false
      const first = sequence[0]!
      await navigateTo({ path: `/practice/${first.examNumber}/${first.questionNumber}`, query: { review: 'incorrect', seed: String(seed) } })
      return true
    } catch {
      if (active) loadError.value = '復習を開始できませんでした。もう一度お試しください。'
      return false
    } finally { starting.value = false }
  }

  return {
    questions,
    round,
    positions,
    totalCount,
    loading,
    error: loadError,
    loaded,
    load,
    clear,
    invalidate,
    prepareRound,
    starting,
    sessionKey,
    createSequence,
    start,
  }
}
