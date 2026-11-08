<script setup lang="ts">
import { filterStudyQuestionCatalog } from '~/utils/studyQuestionCatalog'
import { categoryLeafCodes, categorySelectionState, toggleCategoryCodes, presetCategoryCodes, presetSelectionState, toggleStudyPreset, type StudyPreset } from '~/utils/studyCategorySelection'
import type { StudyCategoryNode } from '../../shared/schemas/study-categories'
import { EXAM_CONFIG } from '~/utils/examConfig'
import { MATERIAL_RANDOM_UNIT, shuffleArtPracticeSequence } from '~/utils/artPracticeFormat'
import { EXAM_CATALOG, STATIC_EXAM_CATALOG, FREE_EXAM_MAX, QUESTIONS_PER_EXAM, catalogExamLabel, catalogExamStartNumber, type ExamCatalogEntry } from '~/utils/examCatalog'
import {
  createPracticeSeed,
  createPracticeSequence,
  type PracticeOrder,
} from '~/utils/practiceSequence'

type LauncherMode = 'exam' | 'conditions' | 'incorrect'

const title = SITE.name
const description = SITE.description

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
})

const questionNumbers = Object.freeze(Array.from({ length: QUESTIONS_PER_EXAM }, (_, index) => index + 1))

const { user } = useAuth()
const launcherMode = ref<LauncherMode>('exam')
const { $api: api } = useNuxtApp()
const { data: studyCatalog, error: studyError, refresh: refreshStudy } = await useAsyncData('study-categories', () => api<{ data: { exam_scope: StudyCategoryNode[], study_outline: StudyCategoryNode[] } }>('/api/v1/study_categories'), { server: false, immediate: false })
watch(launcherMode, mode => { if (mode === 'conditions' && !studyCatalog.value) void refreshStudy() })
// Only the explicit conditions tab needs the live catalog. Ordinary navigation is static.
const catalogEnabled = computed(() => launcherMode.value === 'conditions')
const { data: publicCatalog, status: catalogStatus, error: catalogError, refresh: refreshCatalog } = usePracticeCatalog(catalogEnabled)
const staticExams: readonly ExamCatalogEntry[] = STATIC_EXAM_CATALOG
const catalogExams = computed(() => catalogEnabled.value ? publicCatalog.value ?? [] : EXAM_CATALOG)
const selectedCategories = ref<string[]>([])
const parts = computed(() => studyCatalog.value?.data.study_outline ?? [])
const hasStudyFilter = computed(() => selectedCategories.value.length > 0)
const toggleGroup = (node: StudyCategoryNode, checked: boolean) => { selectedCategories.value = toggleCategoryCodes(selectedCategories.value, categoryLeafCodes(node), checked) }
const togglePreset = (preset: StudyPreset, checked: boolean) => { selectedCategories.value = toggleStudyPreset(parts.value, selectedCategories.value, preset, checked) }


const hasFullAccess = computed(() => (
  hasFullExamAccess(user.value)
))
const freeExams = computed(() => EXAM_CATALOG.filter(exam => exam.exam_number <= FREE_EXAM_MAX))
const availableExams = computed(() => (
  catalogExams.value.filter(exam => (hasFullAccess.value || exam.exam_number <= FREE_EXAM_MAX) && exam.access !== 'paid_membership_required')
))
const availableExamNumbers = computed(() => availableExams.value.map(exam => exam.exam_number))
const selectedExamNumbers = ref<number[]>([...availableExamNumbers.value])
const selectedQuestionNumbers = ref<number[]>([...questionNumbers])

const allExamsSelected = computed({
  get: () => (
    availableExamNumbers.value.length > 0
    && selectedExamNumbers.value.length === availableExamNumbers.value.length
    && availableExamNumbers.value.every(examNumber => selectedExamNumbers.value.includes(examNumber))
  ),
  set: (selected: boolean) => {
    selectedExamNumbers.value = selected ? [...availableExamNumbers.value] : []
  },
})
const someExamsSelected = computed(() => (
  selectedExamNumbers.value.length > 0 && !allExamsSelected.value
))
const allQuestionsSelected = computed({
  get: () => (
    selectedQuestionNumbers.value.length === questionNumbers.length
    && questionNumbers.every(questionNumber => selectedQuestionNumbers.value.includes(questionNumber))
  ),
  set: (selected: boolean) => {
    selectedQuestionNumbers.value = selected ? [...questionNumbers] : []
  },
})
const someQuestionsSelected = computed(() => (
  selectedQuestionNumbers.value.length > 0 && !allQuestionsSelected.value
))
const sortedSelectedExamNumbers = computed(() => (
  [...selectedExamNumbers.value].sort((left, right) => left - right)
))
const sortedSelectedQuestionNumbers = computed(() => (
  [...selectedQuestionNumbers.value].sort((left, right) => left - right)
))
const filteredCatalog = computed(() => filterStudyQuestionCatalog(publicCatalog.value ?? [], hasStudyFilter.value ? { study_category_codes: selectedCategories.value } : {}))
const selectedQuestionCount = computed(() => conditionSequence.value.length)
const conditionSequence = computed(() => createPracticeSequence(
  sortedSelectedExamNumbers.value,
  sortedSelectedQuestionNumbers.value,
  filteredCatalog.value,
))
const hasConditionSelection = computed(() => Boolean(studyCatalog.value) && !studyError.value && conditionSequence.value.length > 0)

const examIsLocked = (examNumber: number) => examNumber > FREE_EXAM_MAX && !hasFullAccess.value
const examTarget = (exam: ExamCatalogEntry) => (
  exam.comingSoon ? `/mock-exams/${exam.exam_number}` : examIsLocked(exam.exam_number) ? '/premium' : `/practice/${exam.exam_number}/${catalogExamStartNumber(exam) ?? 1}`
)
const startConditionalPractice = (order: PracticeOrder) => {
  if (!hasConditionSelection.value) return

  const query: Record<string, string> = {
    exams: sortedSelectedExamNumbers.value.join(','),
    questions: sortedSelectedQuestionNumbers.value.join(','),
  }
  if (hasStudyFilter.value) query.study_category_codes = [...selectedCategories.value].sort().join(',')
  let sequence = conditionSequence.value

  if (order === 'random') {
    const seed = createPracticeSeed()
    sequence = shuffleArtPracticeSequence(sequence, seed, filteredCatalog.value, EXAM_CONFIG)
    query.order = order
    query.seed = String(seed)
    query.random_unit = MATERIAL_RANDOM_UNIT
  }

  const firstPosition = sequence[0]
  if (!firstPosition) return

  navigateTo({
    path: `/practice/${firstPosition.examNumber}/${firstPosition.questionNumber}`,
    query,
  })
}

watch(availableExamNumbers, (examNumbers, previousExamNumbers) => {
  const previouslySelectedAll = (
    previousExamNumbers.length === 0 || (
    previousExamNumbers.length > 0
    && previousExamNumbers.every(examNumber => selectedExamNumbers.value.includes(examNumber))
    )
  )
  selectedExamNumbers.value = previouslySelectedAll
    ? [...examNumbers]
    : selectedExamNumbers.value.filter(examNumber => examNumbers.includes(examNumber))
})

</script>

<template>
  <div class="home-main">
    <section class="overview-section">
      <div class="overview-copy">
        <h1 class="section-heading">
          <span>{{ SITE.tagline }}</span>
        </h1>
        <p>
          {{ SITE.description }}
        </p>
        <div class="overview-actions">
          <NuxtLink class="secondary-link" to="/exam-overview">試験概要を見る</NuxtLink>
        </div>
      </div>
    </section>

    <section id="practice-launcher" class="practice-launcher" aria-labelledby="practice-launcher-title">
      <div class="launcher-heading">
        <div>
          <h2 id="practice-launcher-title" class="section-heading">
            <span>問題演習を始める</span>
          </h2>
        </div>
        <p>通常の美術史問題と、知識・情報の活用問題を1問ずつ演習できます。</p>
      </div>
      <p class="condition-help">通常問題の必要な資料は設問内に表示し、活用問題では共通資料を参照できます。別枠の実践問題は含みません。本試験の構成を完全に再現するものではありません。</p>
      <p class="condition-help">ランダム演習では、活用問題に登録された同じ問題群をまとめて出題します。</p>

      <div class="launcher-tabs" role="tablist" aria-label="問題演習の開始方法">
        <button
          id="exam-mode-tab"
          type="button"
          role="tab"
          :aria-selected="launcherMode === 'exam'"
          aria-controls="exam-mode-panel"
          :class="{ active: launcherMode === 'exam' }"
          @click="launcherMode = 'exam'"
        >
          <UIcon name="i-lucide-files" />
          模試を選ぶ
        </button>
        <button
          id="conditions-mode-tab"
          type="button"
          role="tab"
          :aria-selected="launcherMode === 'conditions'"
          aria-controls="conditions-mode-panel"
          :class="{ active: launcherMode === 'conditions' }"
          @click="launcherMode = 'conditions'"
        >
          <UIcon name="i-lucide-list-filter" />
          条件を指定
        </button>
        <button id="incorrect-mode-tab" type="button" role="tab" :aria-selected="launcherMode === 'incorrect'" aria-controls="incorrect-mode-panel" :class="{ active: launcherMode === 'incorrect' }" @click="launcherMode = 'incorrect'"><UIcon name="i-lucide-list-restart" />間違えた問題</button>
      </div>

      <div
        v-if="launcherMode === 'exam'"
        id="exam-mode-panel"
        class="launcher-panel"
        role="tabpanel"
        aria-labelledby="exam-mode-tab"
      >
        <div class="exam-grid-heading">
          <p><strong>模擬試験 公開{{ EXAM_CATALOG.length }}回</strong><span>模擬試験1・2は無料、3以降はプレミアム会員向け</span></p>
          <NuxtLink v-if="!hasFullAccess" class="premium-info-link" to="/premium">
            <UIcon name="i-lucide-lock-keyhole" />
            模擬試験{{ FREE_EXAM_MAX + 1 }}以降はプレミアム会員向けです
          </NuxtLink>
        </div>
        <div class="exam-grid">
          <NuxtLink
            v-for="exam in staticExams"
            :key="exam.exam_number"
            class="exam-card"
            :to="examTarget(exam)"
            no-prefetch
            :aria-label="exam.comingSoon ? `${catalogExamLabel(exam.exam_number)}は準備中です` : examIsLocked(exam.exam_number) ? `模擬試験${exam.exam_number}はプレミアム会員向けです` : `模擬試験${exam.exam_number}を始める`"
          >
            <span class="exam-card-copy"><strong>{{ catalogExamLabel(exam.exam_number) }}</strong><span>{{ exam.comingSoon ? '準備中' : `${exam.question_numbers.length}問収録` }}{{ examIsLocked(exam.exam_number) ? '・プレミアム会員向け' : '' }}</span></span>
            <UIcon :name="examIsLocked(exam.exam_number) ? 'i-lucide-lock-keyhole' : 'i-lucide-arrow-right'" aria-hidden="true" />
          </NuxtLink>
        </div>
      </div>

      <div
        v-else-if="launcherMode === 'conditions'"
        id="conditions-mode-panel"
        class="launcher-panel"
        role="tabpanel"
        aria-labelledby="conditions-mode-tab"
      >
        <p v-if="catalogStatus === 'pending' || catalogStatus === 'idle'" role="status">出題条件を読み込んでいます。</p>
        <p v-else-if="catalogError" role="alert">問題一覧を読み込めませんでした。<button type="button" @click="refreshCatalog()">再読み込み</button></p>
        <form class="condition-form" @submit.prevent="startConditionalPractice('sequential')">
          <div class="condition-fields">
            <fieldset class="condition-fieldset study-fieldset">
              <legend>出題ジャンル</legend>
              <p v-if="studyError" role="alert">出題ジャンルを読み込めませんでした。<button type="button" @click="() => refreshStudy()">再読み込み</button></p>
              <p v-else-if="!studyCatalog" role="status">出題ジャンルを読み込んでいます。</p>
              <template v-else>
                <p class="condition-help">大分類・小分類を選べます。未選択の場合は絞り込みません。</p>
                <div class="study-presets" role="group" aria-label="受験科目のプリセット">
                  <label><input type="checkbox" :checked="presetSelectionState(parts, selectedCategories, 'world').checked" :indeterminate="presetSelectionState(parts, selectedCategories, 'world').indeterminate" :disabled="!presetCategoryCodes(parts, 'world').length" @change="togglePreset('world', ($event.target as HTMLInputElement).checked)"><span>受験世界史</span></label>
                  <label><input type="checkbox" :checked="presetSelectionState(parts, selectedCategories, 'japanese').checked" :indeterminate="presetSelectionState(parts, selectedCategories, 'japanese').indeterminate" :disabled="!presetCategoryCodes(parts, 'japanese').length" @change="togglePreset('japanese', ($event.target as HTMLInputElement).checked)"><span>受験日本史</span></label>
                  <button class="secondary-link" type="button" @click="selectedCategories = []">絞り込みを解除</button>
                </div>
                <p class="condition-help">プリセットをオンにすると対象範囲に切り替わります。両方をオンにすると範囲を合わせて選べます。</p>
                <div class="genre-groups">
                  <section v-for="part in parts" :key="part.code" class="genre-group">
                    <label class="genre-parent"><input type="checkbox" :aria-label="part.label" :checked="categorySelectionState(selectedCategories, categoryLeafCodes(part)).checked" :indeterminate="categorySelectionState(selectedCategories, categoryLeafCodes(part)).indeterminate" @change="toggleGroup(part, ($event.target as HTMLInputElement).checked)"><strong>{{ part.label }}</strong></label>
                    <div v-if="part.children.length" class="genre-children">
                      <label v-for="section in part.children" :key="section.code" :class="{ selected: selectedCategories.includes(section.code) }"><input v-model="selectedCategories" type="checkbox" name="study-category-codes" :value="section.code"><span>{{ section.label }}<small v-if="section.subtitle">{{ section.subtitle }}</small></span></label>
                    </div>
                  </section>
                </div>
              </template>
            </fieldset>

            <fieldset class="condition-fieldset">
              <legend>対象模擬試験</legend>
              <div class="condition-field-heading">
                <p>複数選択できます</p>
                <label class="all-selector">
                  <input
                    v-model="allExamsSelected"
                    type="checkbox"
                    :indeterminate="someExamsSelected"
                  >
                  <span>全選択</span>
                </label>
              </div>
              <div class="number-checkbox-grid exam-number-grid">
                <label
                  v-for="exam in availableExams"
                  :key="exam.exam_number"
                  :class="{ selected: selectedExamNumbers.includes(exam.exam_number) }"
                >
                  <input
                    v-model="selectedExamNumbers"
                    type="checkbox"
                    name="exam-numbers"
                    :value="exam.exam_number"
                  >
                  <span>模擬試験{{ exam.exam_number }}</span>
                </label>
              </div>
            </fieldset>


          </div>

          <p v-if="hasStudyFilter && selectedQuestionCount === 0" class="practice-start-error" role="status">この条件に合う公開問題はまだありません。出題ジャンルや対象模擬試験を変更してください。</p>
          <div class="condition-submit">
            <p v-if="conditionSequence.length && studyCatalog && !studyError">
              <span>選択中</span>
              {{ sortedSelectedExamNumbers.length }}模試から
              <strong>全{{ selectedQuestionCount }}問</strong>
            </p>
            <p v-else class="selection-required">
              <span>選択内容を確認してください</span>
              対象模擬試験を1つ以上選択してください
            </p>
            <div class="condition-actions">
              <button class="primary-link" type="submit" :disabled="!hasConditionSelection">
                <UIcon name="i-lucide-list-ordered" />
                順番に始める
              </button>
              <button
                class="secondary-link"
                type="button"
                :disabled="!hasConditionSelection"
                @click="startConditionalPractice('random')"
              >
                <UIcon name="i-lucide-shuffle" />
                ランダムに始める
              </button>
            </div>
          </div>
        </form>
      </div>
      <div v-if="launcherMode === 'incorrect'" id="incorrect-mode-panel" class="launcher-panel" role="tabpanel" aria-labelledby="incorrect-mode-tab"><IncorrectReviewPanel /></div>
    </section>

    <section id="usage-guide" class="home-section policy-section" aria-labelledby="usage-guide-title">
      <div class="section-title">
        <h2 id="usage-guide-title" class="section-heading">
          <span>利用にあたって</span>
        </h2>
      </div>
      <dl class="usage-details">
        <div class="usage-row">
          <dt>{{ PAYMENTS_ENABLED ? (FREE_EXAM_MAX > 0 ? `模擬試験1〜${FREE_EXAM_MAX}は無料` : '会員資格に応じて演習') : 'すべての公開問題を無料で演習' }}</dt>
          <dd>
            <p>{{ PAYMENTS_ENABLED && FREE_EXAM_MAX === 0 ? '問題の演習にはプレミアム会員資格が必要です。' : '無料の公開問題はログインなしで利用できます。' }}解答履歴の保存にはログインが必要です。</p>
          </dd>
        </div>
        <div v-if="PAYMENTS_ENABLED" class="usage-row">
          <dt>{{ PRICE_LABEL }}の買い切り</dt>
          <dd>
            <p>プレミアム会員は模擬試験{{ FREE_EXAM_MAX + 1 }}以降も利用できます。月額料金や自動更新はありません。</p>
            <NuxtLink class="usage-premium-link" to="/premium">
              <span>プレミアム会員について</span>
              <UIcon name="i-lucide-arrow-right" aria-hidden="true" />
            </NuxtLink>
          </dd>
        </div>
        <div class="usage-row">
          <dt>根拠資料も確認</dt>
          <dd>
            <p>各問題の解説と、出題の根拠となる資料を確認できます。</p>
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.condition-fields > .condition-fieldset { grid-column: 1 / -1; }
.condition-help { margin: 0 0 14px; color: var(--muted); line-height: 1.7; }
.study-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 22px; margin-bottom: 12px; }
.study-presets label, .genre-parent { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.study-presets input, .genre-groups input { accent-color: var(--teal); width: 16px; height: 16px; flex: 0 0 16px; }
.genre-groups { display: grid; gap: 16px; }
.genre-group { min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.genre-parent { padding: 14px; background: var(--surface-tint); }
.genre-children { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 12px; }
.genre-children label { min-width: 0; display: flex; align-items: flex-start; gap: 8px; padding: 10px; border: 1px solid transparent; border-radius: 5px; cursor: pointer; }
.genre-children label.selected { background: var(--surface-selected); border-color: var(--line-strong); }
.genre-children input { margin-top: 4px; }
.genre-children span { min-width: 0; overflow-wrap: anywhere; }
.genre-children small { display: block; color: var(--muted); font-size: 12px; line-height: 1.6; }
.practice-start-error { margin: 0; padding: 16px 22px; color: var(--muted); }
.number-checkbox-grid.exam-number-grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.number-checkbox-grid.exam-number-grid label { flex-direction: row; justify-content: flex-start; gap: 8px; padding: 12px; }
@media (max-width: 640px) { .genre-children { grid-template-columns: minmax(0, 1fr); } }

.home-main { min-width: 0; background: var(--surface-soft); }
.practice-launcher {
  scroll-margin-top: calc(var(--site-navigation-height, var(--header-height)) + 20px);
  padding: 52px clamp(28px, 6vw, 86px) 58px;
  border-top: 1px solid #d4dfde;
  background: var(--surface-tint);
}
.launcher-heading { display: flex; align-items: end; justify-content: space-between; gap: 28px; }
.launcher-heading h2 { margin: 0; font-size: 30px; line-height: 1.3; }
.launcher-heading > p { max-width: 480px; margin: 0; color: var(--muted); line-height: 1.8; }
.section-heading { display: flex; align-items: center; gap: 10px; }
.section-heading::before { content: ''; flex: 0 0 4px; width: 4px; height: 26px; background: var(--teal-dark); }
.section-heading > span { min-width: 0; }
.launcher-tabs {
  width: min(660px, 100%);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 30px;
  border-bottom: 1px solid #bfcfd0;
}
.launcher-tabs button {
  min-height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: transparent;
  color: #52656c;
  font-weight: 800;
  cursor: pointer;
}
.launcher-tabs button.active { border-color: var(--teal); color: var(--teal-dark); }
.launcher-tabs :deep(svg) { width: 19px; height: 19px; }
.launcher-panel { padding-top: 28px; }
.exam-grid-heading {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 14px;
}
.exam-grid-heading p { display: flex; align-items: baseline; gap: 10px; margin: 0; }
.exam-grid-heading strong { font-size: 16px; }
.exam-grid-heading span { color: var(--muted); font-size: 13px; font-weight: 700; }
.exam-grid { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 8px; }
.exam-card {
  position: relative;
  height: 68px;
  display: grid;
  place-items: center;
  padding: 8px;
  border: 1px solid #bdccce;
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  text-decoration: none;
  transition: border-color .15s, background .15s, transform .15s;
}
.exam-card:hover { border-color: var(--teal); background: var(--surface-soft); transform: translateY(-1px); }
.exam-card strong { color: var(--teal-dark); font-size: 20px; line-height: 1; transform: translateY(-1px); }
.exam-card :deep(.iconify) { position: absolute; top: 7px; right: 7px; width: 13px; height: 13px; color: #677b81; }
.premium-info-link { display: inline-flex; align-items: center; gap: 5px; color: var(--teal-dark); font-size: 13px; font-weight: 800; }
.condition-form { border: 1px solid #c7d4d5; border-radius: 8px; background: #fff; }
.condition-fields { display: grid; gap: 28px; padding: 28px; }
.condition-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.condition-fieldset + .condition-fieldset { padding-top: 26px; border-top: 1px solid #dce4e4; }
.condition-fieldset legend { padding: 0; color: #253d45; font-size: 17px; font-weight: 900; }
.condition-field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 7px 0 13px;
}
.condition-field-heading p { margin: 0; color: var(--muted); font-size: 13px; }
.all-selector {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid #bdcbcd;
  border-radius: 5px;
  background: var(--surface-soft);
  color: #344951;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
}
.all-selector input { width: 17px; height: 17px; margin: 0; accent-color: var(--teal); }
.number-checkbox-grid { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 8px; }
.number-checkbox-grid label {
  min-width: 0;
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 6px;
  border: 1px solid #c5d1d3;
  border-radius: 5px;
  background: #fff;
  color: #3a5057;
  font-weight: 900;
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.number-checkbox-grid label:hover { border-color: var(--teal); }
.number-checkbox-grid label.selected { border-color: var(--teal); background: var(--surface-selected); color: var(--teal-dark); }
.number-checkbox-grid input { width: 16px; height: 16px; flex: 0 0 16px; margin: 0; accent-color: var(--teal); }
.question-number-grid label { gap: 4px; padding-inline: 4px; }
.question-number-grid label span { white-space: nowrap; }
.condition-submit {
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 26px;
  border-top: 1px solid #d8e1e2;
  background: var(--surface-soft);
}
.condition-submit p { margin: 0; color: #40545b; font-weight: 800; }
.condition-submit p span { display: block; margin-bottom: 3px; color: var(--muted); font-size: 11px; }
.condition-submit p strong { margin-left: 8px; color: var(--teal-dark); }
.condition-submit .selection-required { color: #a23b2a; }
.condition-actions { display: flex; flex: 0 0 auto; gap: 10px; }
.condition-actions button { white-space: nowrap; }
.condition-actions button:disabled { opacity: .45; cursor: not-allowed; }
.subject-label { white-space: nowrap; }
.overview-section {
  min-height: 280px;
  padding: 52px clamp(28px, 6vw, 86px);
  display: flex;
  align-items: center;
  background: #fff;
}
.overview-copy { max-width: 680px; }
.overview-copy h1 { margin: 0; font-size: 30px; line-height: 1.3; }
.overview-copy > p { margin: 22px 0 0; color: var(--muted); font-size: 16px; line-height: 1.9; }
.overview-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 30px; }
.home-section { padding: 62px clamp(28px, 6vw, 86px); }
.section-title { display: flex; align-items: baseline; gap: 14px; margin-bottom: 26px; }
.section-title h2 { margin: 0; font-size: 30px; }
.updates-section { background: var(--surface-soft); }
.update-list { border-top: 1px solid #cbd7d9; }
.update-list article { min-height: 68px; display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 18px; border-bottom: 1px solid #cbd7d9; }
.update-list time { color: var(--teal-dark); font-weight: 800; }
.update-list p { margin: 0; color: #4f6169; }
.policy-section {
  scroll-margin-top: calc(var(--site-navigation-height, var(--header-height)) + 20px);
  background: #fff;
}
.usage-details { margin: 0; border-top: 1px solid #dce4e4; }
.usage-row {
  display: grid;
  grid-template-columns: minmax(180px, .3fr) minmax(0, 1fr);
  gap: 32px;
  padding: 26px 0;
  border-bottom: 1px solid #dce4e4;
}
.usage-row dt { color: var(--ink); font-size: 16px; font-weight: 700; line-height: 1.9; }
.usage-row dd { min-width: 0; margin: 0; color: #51636c; font-size: 15px; line-height: 1.9; }
.usage-row p { margin: 0; }
.usage-premium-link {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  color: var(--teal-dark);
  font-size: 14px;
  font-weight: 700;
  text-decoration: underline;
  text-decoration-color: #a3c3c4;
  text-underline-offset: 4px;
}
.usage-premium-link:hover { text-decoration-color: currentColor; }
.usage-premium-link:focus-visible { outline: 2px solid var(--teal-dark); outline-offset: 4px; }
.usage-premium-link :deep(.iconify) { flex: 0 0 16px; width: 16px; height: 16px; }

@media (max-width: 1100px) {
  .exam-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
}

@media (max-width: 1200px) {
  .question-number-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
}

@media (max-width: 960px) {
  .number-checkbox-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .usage-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
}

@media (max-width: 640px) {
  .practice-launcher { padding: 32px 20px 38px; }
  .launcher-heading { align-items: flex-start; flex-direction: column; gap: 12px; }
  .launcher-heading h2 { font-size: 27px; }
  .launcher-heading > p { font-size: 14px; }
  .launcher-tabs { width: 100%; margin-top: 24px; }
  .exam-grid-heading { align-items: flex-start; flex-direction: column; gap: 8px; }
  .exam-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; }
  .exam-card { height: 68px; }
  .condition-fields { padding: 20px; }
  .condition-field-heading { align-items: flex-end; }
  .number-checkbox-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; }
  .number-checkbox-grid label { min-height: 46px; flex-direction: column; gap: 3px; padding: 5px 2px; }
  .number-checkbox-grid input { width: 15px; height: 15px; flex-basis: 15px; }
  .condition-submit { align-items: stretch; flex-direction: column; padding: 18px 20px 20px; }
  .condition-actions { width: 100%; flex-direction: column; }
  .condition-actions button { width: 100%; }
  .overview-section { min-height: auto; padding: 36px 20px; }
  .overview-actions { align-items: stretch; flex-direction: column; }
  .home-section { padding: 44px 20px; }
  .update-list article { grid-template-columns: 1fr; gap: 5px; padding: 15px 0; }
  .usage-row { padding: 22px 0; }
}
</style>

<style scoped>
.exam-grid { grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
.exam-card { min-height: 82px; height: auto; display: flex; justify-content: space-between; gap: 12px; padding: 18px; }
.exam-card-copy { min-width: 0; display: grid; gap: 10px; }
.exam-card-copy strong { font-size: 18px; }
.exam-card-copy > span { font-size: 13px; color: var(--muted); }
.exam-card :deep(.iconify) { position: static; width: 18px; height: 18px; flex-shrink: 0; }
@media (max-width:640px) { .launcher-tabs button { font-size:12px; gap:4px; } .launcher-tabs :deep(svg) { width:16px; } .exam-grid { grid-template-columns:minmax(0,1fr); } }
</style>
