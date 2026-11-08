<script setup lang="ts">
import { filterStudyQuestionCatalog } from '~/utils/studyQuestionCatalog'
import type { LocationQueryRaw } from 'vue-router'
import { EXAM_CONFIG } from '~/utils/examConfig'
import { MATERIAL_RANDOM_UNIT, artQuestionSection, isApplicationQuestion, applicationPeerNumbers, shuffleArtPracticeSequence } from '~/utils/artPracticeFormat'
import type { PassageReference } from '../../../../shared/types/learning'
import { EXAM_CATALOG, QUESTIONS_PER_EXAM, FREE_EXAM_MAX } from '~/utils/examCatalog'
import {
  createPracticeSequence,
  shufflePracticeSequence,
  type PracticeOrder,
  type PracticePosition,
} from '~/utils/practiceSequence'

type ContentBlock = import('../../../../shared/types/learning').LearningBlock

type Choice = {
  id: number
  choice_label: string
  content_blocks: ContentBlock[]
  display_order: number
}

type Question = {
  shared_passages?: { id: number; label: string; display_order?: number; content_blocks: ContentBlock[] }[]
  passage_references?: PassageReference[]
  group?: { id: number; group_number: number; title: string; question_numbers: number[] } | null
  question_version?: number
  id: number
  exam_number: number
  question_number: number
  content_blocks: ContentBlock[]
  study_categories?: { code: string; scheme: string; label: string; parent_label: string | null }[]
  major_category_code: string
  category_code: string
  choices: Choice[]
  is_favorite?: boolean
}

type AnswerResult = {
  question_id: number
  selected_choice_id: number
  is_correct: boolean
  correct_choice: Choice
  explanation_blocks: ContentBlock[]
  source_text: string | null
  answer_history_id: number | null
}

type AnswerHistoryDetail = {
  id: number
  question: { id: number }
  selected_choice: { id: number }
  is_correct: boolean
  correct_choice: Choice
  explanation_blocks: ContentBlock[]
  source_text: string | null
}

type ApiResponse<T> = { data: T }

type SourceReference = {
  label: string
  url: string | null
}

const route = useRoute()
const { $api: api } = useNuxtApp()
const { isLoggedIn, user, authHeaders, sessionVersion, ensureCurrentUser } = useAuth()
const { canUseFavorites, isFavorite, setFavorite, toggleFavorite } = useFavorites()
const updatingFavorite = ref(false)

const incorrectReview = useIncorrectReview()
const isIncorrectReview = computed(() => route.query.review === 'incorrect' && route.query.answer_history_id === undefined)
const reviewReady = ref(false)
const reviewPositions = ref<PracticePosition[]>([])
const reviewError = ref('')
let pageActive = true
let reviewGeneration = 0
onScopeDispose(() => { pageActive = false; reviewGeneration++ })

const { data: publicPracticeCatalog, status: practiceCatalogStatus, refresh: refreshPracticeCatalog } = usePracticeCatalog(computed(() => true))

const allExamNumbers = EXAM_CATALOG.map(exam => exam.exam_number)
const allQuestionNumbers = Object.freeze(Array.from({ length: QUESTIONS_PER_EXAM }, (_, index) => index + 1))

const parseNumberSelection = (value: unknown, allowedNumbers: readonly number[]) => {
  const serialized = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : ''
  return [...new Set(
    serialized
      .split(',')
      .map(part => Number(part))
      .filter(number => Number.isInteger(number) && allowedNumbers.includes(number)),
  )].sort((left, right) => left - right)
}

const examNumber = computed(() => Number(route.params.examNumber))
const questionNumber = computed(() => Number(route.params.questionNumber))
const hasConditionSelection = computed(() => (
  route.query.exams !== undefined || route.query.questions !== undefined
))
const practiceOrder = computed<PracticeOrder>(() => (
  route.query.order === 'random' ? 'random' : 'sequential'
))
const practiceSeed = computed(() => {
  const value = Array.isArray(route.query.seed) ? route.query.seed[0] : route.query.seed
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null

  const seed = Number(value)
  return Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF ? seed : null
})
const selectedPracticeExamNumbers = computed(() => {
  const selected = parseNumberSelection(route.query.exams, allExamNumbers)
  return selected.length > 0 ? selected : [examNumber.value]
})
const selectedPracticeQuestionNumbers = computed(() => {
  const selected = parseNumberSelection(route.query.questions, allQuestionNumbers)
  if (selected.length > 0) return selected
  return [...allQuestionNumbers]
})
const basePracticeSequence = computed<PracticePosition[]>(() => createPracticeSequence(
  selectedPracticeExamNumbers.value,
  selectedPracticeQuestionNumbers.value,
  filterStudyQuestionCatalog(publicPracticeCatalog.value ?? [], studyRouteQuery.value),
))
const isRandomPractice = computed(() => (
  hasConditionSelection.value
  && practiceOrder.value === 'random'
  && practiceSeed.value !== null
))
const practiceSequence = computed<PracticePosition[]>(() => (
  isIncorrectReview.value ? (reviewReady.value ? reviewPositions.value : []) : isRandomPractice.value
    ? (route.query.random_unit === MATERIAL_RANDOM_UNIT
      ? shuffleArtPracticeSequence(basePracticeSequence.value, practiceSeed.value!, publicPracticeCatalog.value ?? [], EXAM_CONFIG)
      : shufflePracticeSequence(basePracticeSequence.value, practiceSeed.value!))
    : basePracticeSequence.value
))
const currentPracticeIndex = computed(() => practiceSequence.value.findIndex(position => (
  position.examNumber === examNumber.value && position.questionNumber === questionNumber.value
)))
const nextPracticePosition = computed(() => (
  currentPracticeIndex.value >= 0
    ? practiceSequence.value[currentPracticeIndex.value + 1] ?? null
    : null
))
const studyRouteQuery = computed(() => Object.fromEntries(['study_category_codes', 'study_part_code', 'study_section_code', 'study_scope_codes'].filter(key => route.query[key] !== undefined).map(key => [key, route.query[key]])))
const practiceNavigationQuery = computed(() => {
  if (isIncorrectReview.value) return { review: 'incorrect', seed: String(practiceSeed.value) }
  if (hasConditionSelection.value) {
    const query: LocationQueryRaw = {
      ...studyRouteQuery.value,
      exams: selectedPracticeExamNumbers.value.join(','),
      questions: selectedPracticeQuestionNumbers.value.join(','),
    }
    if (isRandomPractice.value) {
      query.order = 'random'
      query.seed = String(practiceSeed.value)
      if (route.query.random_unit === MATERIAL_RANDOM_UNIT) query.random_unit = MATERIAL_RANDOM_UNIT
    }
    return query
  }
  return { ...studyRouteQuery.value }
})
const validPosition = computed(() => (
  Number.isInteger(examNumber.value)
  && allExamNumbers.includes(examNumber.value)
  && Number.isInteger(questionNumber.value)
  && allQuestionNumbers.includes(questionNumber.value)
  // Locked published positions must reach API authorization rather than an invalid sentinel request.
  && (currentPracticeIndex.value >= 0 || publicPracticeCatalog.value?.some(exam => exam.exam_number === examNumber.value && exam.access === 'paid_membership_required'))
))

const requestQuery = computed(() => ({
  ...studyRouteQuery.value,
  exam_number: validPosition.value ? examNumber.value : 0,
  question_number: validPosition.value ? questionNumber.value : -1,
}))

const {
  data: questionResponse,
  status,
  error: questionError,
  refresh,
  clear: clearQuestion,
} = await useFetch<ApiResponse<Question>>('/api/v1/questions/next', {
  $fetch: api,
  query: requestQuery,
  headers: authHeaders,
  immediate: false,
  watch: false,
  server: false,
  // 画面遷移をAPIの応答待ちで止めず、起動待ち中も読み込み表示を出す。
  lazy: true,
})

// Do not issue a sentinel request while catalog/review positions are still resolving.
// Include the auth generation so a changed session cannot reuse another user's question.
const questionRequestKey = computed(() => (
  practiceCatalogStatus.value === 'success' && (!isIncorrectReview.value || reviewReady.value)
    ? JSON.stringify([requestQuery.value, sessionVersion.value])
    : null
))
watch(questionRequestKey, key => {
  if (key === null) { clearQuestion(); return }
  void refresh()
}, { immediate: true, flush: 'post' })

const retryQuestion = async () => {
  if (practiceCatalogStatus.value === 'error') { await refreshPracticeCatalog(); return }
  if (practiceCatalogStatus.value === 'success') await refresh()
}

const question = computed(() => {
  if (isIncorrectReview.value && (!reviewReady.value || !isLoggedIn.value)) return null
  const loaded = questionResponse.value?.data
  if (!loaded || loaded.exam_number !== examNumber.value || loaded.question_number !== questionNumber.value) return null
  return loaded
})

const currentSection = computed(() => artQuestionSection(EXAM_CONFIG, examNumber.value, questionNumber.value))
const applicationQuestion = computed(() => isApplicationQuestion(EXAM_CONFIG, examNumber.value, questionNumber.value))
const relatedApplicationNumbers = computed(() => applicationPeerNumbers(question.value, practiceSequence.value, EXAM_CONFIG))
const materialScopeKey = computed(() => {
  const context = applicationQuestion.value && question.value?.group
    ? `group:${question.value.group.id}` : `question:${question.value?.id ?? questionNumber.value}`
  return `${sessionVersion.value}:${examNumber.value}:${context}`
})

const selectedChoiceId = ref<number | null>(null)
const answerResult = ref<AnswerResult | null>(null)
const answerError = ref('')
const submitting = ref(false)
const loadingNext = ref(false)
const completed = ref(false)
const favoriteModalOpen = ref(false)
const favoriteModalCloseButton = ref<HTMLButtonElement | null>(null)
const restoredHistoryId = ref<number | null>(null)

const majorCategoryLabel = computed(() => (
  MAJOR_CATEGORIES.find(item => item.value === question.value?.major_category_code)?.label
  ?? question.value?.major_category_code
  ?? ''
))
const categoryLabel = computed(() => getCategoryLabel(question.value?.category_code ?? ''))
const questionIsFavorite = computed(() => (
  isLoggedIn.value && question.value ? isFavorite(question.value.id) : false
))
const sourceReferences = computed<SourceReference[]>(() => (
  (answerResult.value?.source_text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.lastIndexOf('|')
      if (separatorIndex === -1) return { label: line, url: null }

      const label = line.slice(0, separatorIndex).trim()
      const url = line.slice(separatorIndex + 1).trim()
      if (!/^https:\/\/[^\s]+$/.test(url)) return { label: line, url: null }

      return { label: label || url, url }
    })
))

const questionErrorStatus = computed(() => {
  const error = questionError.value as any
  return error?.statusCode ?? error?.status
})
const questionErrorCode = computed(() => (questionError.value as any)?.data?.error?.code)
const paywallRequired = computed(() => (
  PAYMENTS_ENABLED && examNumber.value > FREE_EXAM_MAX
  && (questionErrorStatus.value === 401 || questionErrorCode.value === 'paid_membership_required')
))
const paywallNeedsLogin = computed(() => questionErrorStatus.value === 401)

const loadErrorMessage = computed(() => {
  if (!validPosition.value) return '試験ナンバーまたは問番号が正しくありません。'
  if (paywallRequired.value) return ''
  if (questionError.value || (questionResponse.value && !question.value)) return '指定された公開問題が見つかりませんでした。'
  return ''
})
const practiceProgress = computed(() => (
  isIncorrectReview.value && currentPracticeIndex.value >= 0 ? `復習 ${currentPracticeIndex.value + 1} / ${practiceSequence.value.length}` : hasConditionSelection.value && currentPracticeIndex.value >= 0
    ? `${isRandomPractice.value ? 'ランダム ' : ''}${currentPracticeIndex.value + 1} / ${practiceSequence.value.length}`
    : ''
))
const completionHeading = computed(() => (
  hasConditionSelection.value
    ? '選択した問題をすべて解き終えました'
    : '公開中の問題はここまでです'
))
const completionMessage = computed(() => {
  if (hasConditionSelection.value) {
    return `${selectedPracticeExamNumbers.value.length}模試、全${practiceSequence.value.length}問の演習が完了しました。`
  }
  return `模擬試験 ${examNumber.value} の公開問題をすべて解き終えました。`
})

watch(
  () => [
    examNumber.value,
    questionNumber.value,
    route.query.exams,
    route.query.questions,
    route.query.order,
    route.query.seed,
    route.query.random_unit,
    route.query.review,
    sessionVersion.value,
    incorrectReview.sessionKey.value,
  ],
  () => {
    selectedChoiceId.value = null
    answerResult.value = null
    answerError.value = ''
    completed.value = false
    restoredHistoryId.value = null
  },
)

watch(question, (loaded) => {
  if (loaded && typeof loaded.is_favorite === 'boolean') setFavorite(loaded, loaded.is_favorite)
}, { immediate: true })

const choiceState = (choice: Choice) => {
  if (!answerResult.value) return { selected: selectedChoiceId.value === choice.id }

  return {
    selected: selectedChoiceId.value === choice.id,
    correct: answerResult.value.correct_choice.id === choice.id,
    incorrect: selectedChoiceId.value === choice.id && !answerResult.value.is_correct,
  }
}

const submitAnswer = async () => {
  if (!question.value || selectedChoiceId.value === null || submitting.value) return

  const context = { path: route.fullPath, version: sessionVersion.value, id: question.value.id, owner: incorrectReview.sessionKey.value }
  const current = () => pageActive && context.path === route.fullPath && context.version === sessionVersion.value && context.id === question.value?.id && context.owner === incorrectReview.sessionKey.value
  submitting.value = true
  answerError.value = ''

  try {
    const response = await api<ApiResponse<AnswerResult>>(
      isIncorrectReview.value ? `/api/v1/review_questions/${question.value.id}/answer` : `/api/v1/questions/${question.value.id}/answer`,
      {
        method: 'POST',
        headers: authHeaders.value,
        body: { selected_choice_id: selectedChoiceId.value, question_version: question.value?.question_version },
      },
    )
    if (!current()) return
    answerResult.value = response.data
    if (context.owner === incorrectReview.sessionKey.value) incorrectReview.invalidate()
  }
  catch (error: any) {
    if (!current()) return
    if (error?.statusCode === 401 || error?.status === 401) {
      answerError.value = 'ログインの有効期限が切れました。もう一度ログインしてください。'
      return
    }
    if (error?.data?.error?.code === 'paid_membership_required') {
      answerError.value = 'プレミアム会員資格を確認できません。プレミアム会員ページをご確認ください。'
      return
    }
    answerError.value = '回答を送信できませんでした。通信状況を確認して、もう一度お試しください。'
  }
  finally {
    submitting.value = false
  }
}

const answerHistoryId = computed(() => {
  const value = Number(route.query.answer_history_id)
  return Number.isInteger(value) && value > 0 ? value : null
})

const restoreAnswerHistory = async () => {
  if (!question.value || !isLoggedIn.value || !answerHistoryId.value || isIncorrectReview.value) return
  if (restoredHistoryId.value === answerHistoryId.value) return
  const context = { path: route.fullPath, history: answerHistoryId.value, owner: incorrectReview.sessionKey.value, id: question.value.id }
  const current = () => pageActive && !isIncorrectReview.value && context.path === route.fullPath && context.history === answerHistoryId.value && context.owner === incorrectReview.sessionKey.value && context.id === question.value?.id

  try {
    const response = await api<ApiResponse<AnswerHistoryDetail>>(
      `/api/v1/answer_histories/${answerHistoryId.value}`,
      {
        headers: authHeaders.value,
      },
    )
    if (!current()) return
    const history = response.data
    if (history.question.id !== question.value!.id) {
      answerError.value = 'この解答履歴は表示中の問題と一致しません。'
      return
    }

    selectedChoiceId.value = history.selected_choice.id
    answerResult.value = {
      question_id: history.question.id,
      selected_choice_id: history.selected_choice.id,
      is_correct: history.is_correct,
      correct_choice: history.correct_choice,
      explanation_blocks: history.explanation_blocks,
      source_text: history.source_text,
      answer_history_id: history.id,
    }
    restoredHistoryId.value = history.id
  }
  catch (error: any) {
    if (current() && error?.statusCode !== 401 && error?.status !== 401) answerError.value = '解答履歴を読み込めませんでした。'
  }
}

watch(
  [question, answerHistoryId, isLoggedIn],
  restoreAnswerHistory,
  { immediate: true },
)

const prepareReview = async () => {
  const generation = ++reviewGeneration
  if (!isIncorrectReview.value) { reviewReady.value = false; reviewError.value = ''; return }
  reviewReady.value = false
  reviewPositions.value = []
  reviewError.value = ''
  await ensureCurrentUser()
  if (!pageActive || generation !== reviewGeneration) return
  if (!isLoggedIn.value) { reviewError.value = 'ログインしてから復習を始めてください。'; return }
  if (practiceSeed.value === null) { reviewError.value = '復習の指定が正しくありません。新しく復習を始めてください。'; return }
  const owner = incorrectReview.sessionKey.value
  const positions = await incorrectReview.prepareRound(practiceSeed.value)
  if (!pageActive || generation !== reviewGeneration || owner !== incorrectReview.sessionKey.value) return
  if (!positions?.some(item => item.examNumber === examNumber.value && item.questionNumber === questionNumber.value)) {
    reviewError.value = 'この問題は現在の復習対象に含まれていません。新しく復習を始めてください。'
    return
  }
  reviewPositions.value = [...positions]
  reviewReady.value = true
}
onMounted(() => { void prepareReview() })
watch([() => route.query.review, practiceSeed, incorrectReview.sessionKey], () => { void prepareReview() }, { flush: 'sync' })

const goToNextQuestion = async () => {
  if (!question.value || loadingNext.value) return

  if (!nextPracticePosition.value) {
    completed.value = true
    return
  }

  loadingNext.value = true
  answerError.value = ''

  try {
    await navigateTo({
      path: `/practice/${nextPracticePosition.value.examNumber}/${nextPracticePosition.value.questionNumber}`,
      query: practiceNavigationQuery.value,
    })
  }
  catch (error: any) {
    answerError.value = '次の問題へ移動できませんでした。もう一度お試しください。'
  }
  finally {
    loadingNext.value = false
  }
}

const closeFavoriteModal = () => {
  favoriteModalOpen.value = false
}

const handleFavoriteClick = async () => {
  if (!question.value || updatingFavorite.value || (isLoggedIn.value && !user.value)) return

  if (!canUseFavorites.value) {
    favoriteModalOpen.value = true
    await nextTick()
    favoriteModalCloseButton.value?.focus()
    return
  }

  updatingFavorite.value = true
  try {
    await toggleFavorite(question.value)
  }
  catch (error: any) {
    answerError.value = error?.data?.error?.message ?? 'お気に入りを更新できませんでした。'
  }
  finally {
    updatingFavorite.value = false
  }
}

const handleFavoriteModalKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && favoriteModalOpen.value) closeFavoriteModal()
}

onMounted(() => window.addEventListener('keydown', handleFavoriteModalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleFavoriteModalKeydown))
</script>

<style scoped>
.practice-section-label { margin: 8px 0 0; color: var(--teal-dark); font-size: .875rem; line-height: 1.6; }
.shared-question-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 20px; }
.shared-question-nav > span { width: 100%; font-weight: 700; }
.shared-question-nav a { min-height: 44px; display: inline-flex; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); text-decoration: none; }
.shared-question-nav a[aria-current='page'] { border-color: var(--teal); background: var(--surface-tint); font-weight: 700; }
.shared-question-nav a:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
</style>

<template>
  <div class="page-wrap practice-wrap">
    <div v-if="isIncorrectReview && (!reviewReady || reviewError)" class="state-panel" aria-live="polite">
      <p v-if="!reviewError" role="status">復習する問題を確認しています。</p>
      <template v-else><h1>復習を再開してください</h1><p role="alert">{{ reviewError }}</p><IncorrectReviewPanel /></template>
    </div>
    <div v-else-if="(status === 'idle' && practiceCatalogStatus !== 'error') || status === 'pending' || (!isIncorrectReview && (practiceCatalogStatus === 'idle' || practiceCatalogStatus === 'pending'))" class="state-panel" role="status" aria-live="polite" aria-busy="true">
      <UIcon class="spin" name="i-lucide-loader-circle" aria-hidden="true" />
      <p>問題を読み込んでいます</p>
    </div>

    <div v-else-if="paywallRequired" class="state-panel paywall-panel">
      <UIcon name="i-lucide-lock-keyhole" />
      <h1>模擬試験{{ examNumber }}はプレミアム会員向けです</h1>
      <p v-if="paywallNeedsLogin">模擬試験{{ FREE_EXAM_MAX + 1 }}以降を利用するには、ログインしてプレミアム会員資格を確認してください。</p>
      <p v-else>{{ PRICE_LABEL }}の買い切りで、模擬試験{{ FREE_EXAM_MAX + 1 }}以降の公開問題を利用できます。</p>
      <div class="state-actions">
        <NuxtLink v-if="paywallNeedsLogin" class="secondary-link" :to="{ path: '/login', query: { redirect: route.fullPath } }">ログイン</NuxtLink>
        <NuxtLink class="primary-link" to="/premium">プレミアム会員について確認する</NuxtLink>
      </div>
    </div>

    <div v-else-if="practiceCatalogStatus === 'error'" class="state-panel error-panel" role="alert"><h1>模擬試験を読み込めません</h1><p>通信状況を確認して、もう一度お試しください。</p><button class="secondary-link" type="button" @click="retryQuestion">再読み込み</button></div>
    <div v-else-if="loadErrorMessage || !question" class="state-panel error-panel">
      <UIcon name="i-lucide-circle-alert" />
      <h1>問題を表示できません</h1>
      <p>{{ loadErrorMessage || '指定された公開問題が見つかりませんでした。' }}</p>
      <div class="state-actions">
        <button class="secondary-link" type="button" @click="retryQuestion">再読み込み</button>
        <NuxtLink class="primary-link" to="/practice/1/1">問1から始める</NuxtLink>
      </div>
    </div>

    <template v-else>
      <header class="practice-head">
        <div>
          <div class="practice-context">
            <span class="exam-label">模擬試験 {{ question.exam_number }}</span>
            <span v-if="practiceProgress" class="practice-progress">{{ practiceProgress }}</span>
          </div>
          <h1>問{{ question.question_number }}</h1>
          <p v-if="currentSection" class="practice-section-label">{{ currentSection.title }}</p>
        </div>
        <div class="practice-meta">
          <button
            class="favorite-button"
            :class="{ active: questionIsFavorite }"
            type="button"
            :disabled="updatingFavorite || (isLoggedIn && !user)"
            :aria-pressed="isLoggedIn ? questionIsFavorite : false"
            :aria-label="questionIsFavorite ? 'お気に入りから解除する' : 'お気に入りに登録する'"
            :title="questionIsFavorite ? 'お気に入りから解除' : 'お気に入りに登録'"
            @click="handleFavoriteClick"
          >
            <FavoriteStarIcon :filled="questionIsFavorite" :size="34" />
          </button>
          <p v-if="question.study_categories?.length">{{ question.study_categories.filter(c => c.scheme === 'study_outline').map(c => [c.parent_label, c.label].filter(Boolean).join(' / ')).join('・') }}</p>
          <p v-else>{{ majorCategoryLabel }} / {{ categoryLabel }}</p>
        </div>
      </header>

      <nav v-if="relatedApplicationNumbers.length > 1" class="shared-question-nav" aria-label="同じ問題群の設問">
        <span>同じ問題群の設問</span>
        <NuxtLink v-for="number in relatedApplicationNumbers" :key="number" :to="{ path: `/practice/${examNumber}/${number}`, query: practiceNavigationQuery }" :aria-current="number === questionNumber ? 'page' : undefined">問{{ number }}</NuxtLink>
      </nav>
      <PracticeMaterials
        v-if="applicationQuestion && question.shared_passages?.length"
        :passages="question.shared_passages"
        :references="question.passage_references || []"
        :scope-key="`application-${examNumber}-${question.group?.id}`"
        shared
      />
      <section class="question-panel">
        <div class="question-text">
          <QuestionContentBlocks :blocks="question.content_blocks" />
        </div>

        <div class="choices" role="radiogroup" aria-label="選択肢">
          <label
            v-for="choice in question.choices"
            :key="choice.id"
            :class="choiceState(choice)"
          >
            <input
              v-model="selectedChoiceId"
              type="radio"
              name="answer"
              :value="choice.id"
              :disabled="Boolean(answerResult) || submitting"
            >
            <span class="choice-label">{{ choice.choice_label }}</span>
            <QuestionContentBlocks class="choice-content" :blocks="choice.content_blocks" />
            <UIcon v-if="answerResult?.correct_choice.id === choice.id" class="choice-mark correct-mark" name="i-lucide-circle-check" />
            <UIcon
              v-else-if="answerResult && selectedChoiceId === choice.id"
              class="choice-mark incorrect-mark"
              name="i-lucide-circle-x"
            />
          </label>
        </div>

        <button
          v-if="!answerResult"
          class="primary-link answer-button"
          type="button"
          :disabled="selectedChoiceId === null || submitting"
          @click="submitAnswer"
        >
          <UIcon v-if="submitting" class="spin" name="i-lucide-loader-circle" />
          {{ submitting ? '採点中です' : '回答する' }}
        </button>

        <p v-if="answerError" class="inline-error" role="alert">{{ answerError }}</p>

        <section
          v-if="answerResult"
          class="answer-result"
          :class="{ correct: answerResult.is_correct }"
          aria-live="polite"
        >
          <div class="result-heading">
            <UIcon :name="answerResult.is_correct ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" />
            <strong>{{ answerResult.is_correct ? '正解です' : '不正解です' }}</strong>
          </div>

          <div class="result-section">
            <h2>正答</h2>
            <div class="correct-answer">
              <span>{{ answerResult.correct_choice.choice_label }}</span>
              <QuestionContentBlocks :blocks="answerResult.correct_choice.content_blocks" />
            </div>
          </div>

          <div class="result-section">
            <h2>解答解説</h2>
            <QuestionContentBlocks :blocks="answerResult.explanation_blocks" />
          </div>

          <div v-if="answerResult.source_text" class="result-section source-section">
            <h2>根拠資料</h2>
            <ul>
              <li v-for="(source, index) in sourceReferences" :key="`${source.url ?? source.label}-${index}`">
                <a
                  v-if="source.url"
                  :href="source.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ source.label }}</a>
                <span v-else>{{ source.label }}</span>
              </li>
            </ul>
          </div>

          <div v-if="completed" class="completed-message">
            <IncorrectReviewCompletion v-if="isIncorrectReview" />
            <template v-else><strong>{{ completionHeading }}</strong>
            <p>{{ completionMessage }}</p></template>
            <NuxtLink class="secondary-link" to="/">トップへ戻る</NuxtLink>
          </div>
          <button v-else class="primary-link next-button" type="button" :disabled="loadingNext" @click="goToNextQuestion">
            {{ loadingNext ? '読み込み中です' : isIncorrectReview && !nextPracticePosition ? '復習結果を見る' : '次の問題' }}
            <UIcon name="i-lucide-arrow-right" />
          </button>
        </section>
      </section>
    </template>

    <Teleport to="body">
      <Transition name="favorite-modal">
        <div
          v-if="favoriteModalOpen"
          class="favorite-modal-backdrop"
          @click.self="closeFavoriteModal"
        >
          <section
            class="favorite-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="favorite-modal-title"
          >
            <button
              ref="favoriteModalCloseButton"
              class="favorite-modal-close"
              type="button"
              aria-label="閉じる"
              @click="closeFavoriteModal"
            >
              <UIcon name="i-lucide-x" />
            </button>
            <span class="favorite-modal-icon" aria-hidden="true">
              <UIcon name="i-lucide-star" />
            </span>
            <h2 id="favorite-modal-title">お気に入り機能について</h2>
            <p>{{ PAYMENTS_ENABLED ? 'お気に入り登録は、プレミアム会員向けの機能です。' : 'お気に入り登録にはログインが必要です。' }}</p>
            <div class="favorite-modal-actions">
              <NuxtLink v-if="PAYMENTS_ENABLED" class="primary-link" to="/premium" @click="closeFavoriteModal">プレミアム会員について</NuxtLink>
              <NuxtLink v-if="!isLoggedIn" class="secondary-link" :to="{ path: '/login', query: { redirect: route.fullPath } }" @click="closeFavoriteModal">ログインへ</NuxtLink>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.shared-reading { margin-bottom: 22px; }
.shared-reading h2 { margin-top: 0; }
.practice-wrap { max-width: 900px; }
.practice-head { padding: 46px 0 22px; display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; }
.practice-context { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.practice-head .exam-label { color: var(--teal); font-size: 14px; font-weight: 800; }
.practice-progress { padding-left: 12px; border-left: 1px solid #bdcbcd; color: var(--muted); font-size: 13px; font-weight: 800; }
.practice-head h1 { margin: 5px 0 0; font-size: 36px; }
.practice-head p { margin: 0; color: var(--muted); }
.practice-meta { display: flex; align-items: center; gap: 10px; }
.favorite-button {
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: #72838a;
  cursor: pointer;
  transition: color .15s, transform .15s;
}
.favorite-button:hover { color: #c78b00; transform: scale(1.08); }
.favorite-button.active { color: #f0b323; }
.favorite-button:disabled { opacity: .6; cursor: wait; }
.question-panel { padding: 32px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.question-text { margin: 0; font-size: 19px; font-weight: 700; line-height: 1.8; }
.choices { display: grid; gap: 10px; margin-top: 28px; }
.choices label { position: relative; min-width: 0; min-height: 62px; display: grid; grid-template-columns: 20px 34px minmax(0, 1fr) 24px; align-items: start; gap: 10px; padding: 16px; border: 1px solid #c8d4d7; border-radius: 6px; cursor: pointer; transition: border-color .15s, background .15s; }
.choices label:hover:not(:has(input:disabled)) { border-color: var(--teal); }
.choices input,
.choice-label { margin-top: 3px; }
.choices label.selected { border-color: var(--teal); background: var(--surface-selected); }
.choices label.correct { border-color: var(--teal); background: var(--surface-selected); }
.choices label.incorrect { border-color: var(--coral); background: #fff4f1; }
.choice-label { min-width: 0; overflow-wrap: anywhere; color: var(--teal-dark); font-weight: 900; }
.choice-content { min-width: 0; line-height: 1.65; }
.choice-mark { width: 22px; height: 22px; margin-top: 1px; }
.correct-mark { color: var(--teal); }
.incorrect-mark { color: var(--coral); }
.answer-button { width: 180px; margin-top: 24px; }
.answer-button:disabled,
.next-button:disabled { opacity: .45; cursor: not-allowed; }
.inline-error { margin: 16px 0 0; color: #a23b2a; font-weight: 700; }
.answer-result { margin-top: 28px; padding: 24px; border-left: 4px solid var(--coral); background: #fff8f6; }
.answer-result.correct { border-color: var(--teal); background: var(--surface-tint); }
.result-heading { display: flex; align-items: center; gap: 10px; color: var(--coral); }
.correct .result-heading { color: var(--teal-dark); }
.result-heading :deep(svg) { width: 26px; height: 26px; }
.result-heading strong { font-size: 22px; }
.result-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--line); }
.result-section h2 { margin: 0 0 12px; color: #30464d; font-size: 16px; }
.correct-answer { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; align-items: start; }
.correct-answer > span { color: var(--teal-dark); font-weight: 900; }
.source-section ul { display: grid; gap: 8px; margin: 0; padding-left: 1.2em; color: #506168; line-height: 1.7; }
.source-section a { color: var(--teal-dark); font-weight: 700; text-underline-offset: 3px; }
.next-button { margin-top: 24px; }
.completed-message { margin-top: 24px; padding: 18px; border: 1px solid var(--line); background: #fff; }
.completed-message p { color: var(--muted); }
.state-panel { min-height: 360px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; text-align: center; }
.state-panel :deep(svg) { width: 34px; height: 34px; color: var(--teal); }
.state-panel p { margin: 0; color: var(--muted); }
.error-panel h1 { margin: 4px 0 0; font-size: 26px; }
.error-panel :deep(svg) { color: var(--coral); }
.paywall-panel h1 { margin: 4px 0 0; font-size: 26px; }
.paywall-panel :deep(svg) { color: #64787e; }
.state-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 12px; }
.spin { animation: spin 1s linear infinite; }
.favorite-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(13, 34, 39, .55);
}
.favorite-modal {
  position: relative;
  width: min(460px, 100%);
  padding: 34px;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 22px 60px rgba(13, 34, 39, .24);
  text-align: center;
}
.favorite-modal-close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: var(--surface-tint);
  color: #41555c;
  cursor: pointer;
}
.favorite-modal-icon {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  margin: 0 auto 18px;
  border-radius: 50%;
  background: #fff4cf;
  color: #c78b00;
}
.favorite-modal-icon :deep(svg) { width: 29px; height: 29px; fill: currentColor; }
.favorite-modal h2 { margin: 0; font-size: 24px; }
.favorite-modal p { margin: 14px 0 0; color: var(--muted); line-height: 1.8; }
.favorite-modal-actions { display: flex; justify-content: center; gap: 10px; margin-top: 26px; }
.favorite-modal-enter-active,
.favorite-modal-leave-active { transition: opacity .16s ease; }
.favorite-modal-enter-active .favorite-modal,
.favorite-modal-leave-active .favorite-modal { transition: transform .18s ease; }
.favorite-modal-enter-from,
.favorite-modal-leave-to { opacity: 0; }
.favorite-modal-enter-from .favorite-modal,
.favorite-modal-leave-to .favorite-modal { transform: translateY(8px) scale(.98); }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .practice-head { align-items: flex-start; flex-direction: column; }
  .question-panel { padding: 22px; }
  .question-text { font-size: 18px; }
  .choices label { grid-template-columns: 18px 28px minmax(0, 1fr) 22px; padding: 11px; }
  .answer-result { padding: 20px 16px; }
  .favorite-modal { padding: 30px 20px 24px; }
  .favorite-modal-actions { flex-direction: column; }
  .favorite-modal-actions a { width: 100%; }
}
</style>
