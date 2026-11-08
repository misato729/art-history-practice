<script setup lang="ts">
import { createPracticeSequence, shufflePracticeSequence } from '~/utils/practiceSequence'
import type { ExamCatalogEntry } from '~/utils/examCatalog'
import { EXAM_CONFIG } from '~/utils/examConfig'
import { MATERIAL_RANDOM_UNIT, sectionQuestionNumbers, shuffleArtPracticeSequence } from '~/utils/artPracticeFormat'

useSeoMeta({ title: '演習を準備しています', robots: 'noindex' })
const route = useRoute()
const { $api: api } = useNuxtApp()
const { sessionVersion, authHeaders, user } = useAuth()
const { load: loadSharedCatalog } = usePracticeCatalog(computed(() => true), { immediate: false })
const error = ref('')
const owner = computed(() => JSON.stringify([sessionVersion.value, user.value?.id, user.value?.role, user.value?.paid_content_access]))
let generation = 0
let mounted = false
const prepare = async () => {
  const request = ++generation
  const path = route.fullPath
  const token = owner.value
  const current = () => mounted && request === generation && path === route.fullPath && token === owner.value
  error.value = ''
  try {
    if (!current()) return
    const keys = ['exams', 'group', 'section', 'random_unit', 'study_category_codes', 'study_part_code', 'study_section_code', 'study_scope_codes', 'order', 'seed']
    if (keys.some(key => route.query[key] !== undefined && (typeof route.query[key] !== 'string' || !route.query[key]?.trim()))) {
      error.value = '演習条件の指定が正しくありません。条件を選び直してください。'; return
    }
    const query = Object.fromEntries(keys
      .flatMap(key => typeof route.query[key] === 'string' ? [[key, route.query[key] as string]] : []))
    if (!/^\d+(?:,\d+)*$/.test(query.exams ?? '') || (query.order && !['sequential', 'random'].includes(query.order)) || (query.seed !== undefined && query.order !== 'random')) {
      error.value = '演習条件の指定が正しくありません。条件を選び直してください。'; return
    }
    if ((query.group && query.section) || (query.random_unit !== undefined
      && (query.random_unit !== MATERIAL_RANDOM_UNIT || query.order !== 'random'))) {
      error.value = '演習条件の指定が正しくありません。条件を選び直してください。'; return
    }
    const exams = [...new Set((query.exams ?? '').split(',').map(Number))].filter(value => Number.isSafeInteger(value) && value > 0)
    if (!exams.length) { error.value = '模擬試験を選択してください。'; return }
    const subjectQuery = Object.fromEntries(['study_category_codes', 'study_part_code', 'study_section_code', 'study_scope_codes'].flatMap(key => query[key] ? [[key, query[key]!]] : []))
    const response = Object.keys(subjectQuery).length
      ? await api<{ data: ExamCatalogEntry[] }>('/api/v1/exams', { query: subjectQuery, headers: authHeaders.value })
      : { data: await loadSharedCatalog() }
    if (!response.data) throw new Error('Catalog unavailable')
    if (!current()) return
    let available = response.data.filter(exam => exams.includes(exam.exam_number) && exam.access !== 'paid_membership_required')
    if (query.group) {
      const groupNumber = Number(query.group)
      if (!/^\d+$/.test(query.group) || !Number.isSafeInteger(groupNumber) || groupNumber < 1 || exams.length !== 1) { error.value = '大問の指定が正しくありません。'; return }
      const exam = available[0]
      const group = exam?.groups?.find(group => group.group_number === groupNumber)
      const first = group?.question_numbers.find(number => exam?.question_numbers.includes(number))
      if (!first) { error.value = 'この大問の公開問題はまだありません。'; return }
      await navigateTo(`/practice/${exam!.exam_number}/${first}`, { replace: true })
      return
    }
    if (query.section) {
      if (!/^\d+$/.test(query.section) || exams.length !== 1) {
        error.value = '出題区分の指定が正しくありません。'; return
      }
      const numbers = sectionQuestionNumbers(EXAM_CONFIG, exams[0]!, Number(query.section), available[0]?.question_numbers ?? [])
      if (numbers === null) { error.value = '出題区分の指定が正しくありません。'; return }
      if (!numbers.length) { error.value = 'この出題区分の公開問題はまだありません。'; return }
      available = available.map(exam => ({ ...exam, question_numbers: numbers }))
      // Preserve the resolved, published subset when subsequent questions build their sequence.
      query.questions = numbers.join(',')
      delete query.section
    }
    const numbers = [...new Set(available.flatMap(exam => [...exam.question_numbers]))]
    let sequence = createPracticeSequence(exams, numbers, available)
    if (query.order === 'random') {
      const seed = Number(query.seed)
      if (!query.seed || !/^\d+$/.test(query.seed) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) {
        error.value = 'ランダム演習の指定が正しくありません。条件を選び直してください。'
        return
      }
      sequence = query.random_unit === MATERIAL_RANDOM_UNIT
        ? shuffleArtPracticeSequence(sequence, seed, available, EXAM_CONFIG)
        : shufflePracticeSequence(sequence, seed)
    }
    const first = sequence[0]
    if (!first) { error.value = 'この条件に合う公開問題はまだありません。出題ジャンルや対象模擬試験を変更してください。'; return }
    await navigateTo({ path: `/practice/${first.examNumber}/${first.questionNumber}`, query }, { replace: true })
  }
  catch { if (current()) error.value = '演習を開始できませんでした。通信状況を確認して、もう一度お試しください。' }
}
onMounted(() => { mounted = true; void prepare() })
watch([() => route.fullPath, owner], () => { if (mounted) void prepare() }, { flush: 'sync' })
onScopeDispose(() => { mounted = false; generation++ })
</script>

<template>
  <section class="practice-start" aria-label="演習の開始">
    <h1>演習を準備しています</h1>
    <p v-if="!error" role="status">条件に合う公開問題を確認しています。</p>
    <div v-else role="alert"><p>{{ error }}</p><button type="button" @click="prepare">再確認</button></div>
    <NuxtLink to="/#practice-launcher">条件を選び直す</NuxtLink>
  </section>
</template>

<style scoped>
.practice-start { padding: 32px; max-width: 900px; margin: auto; overflow-wrap: anywhere; }
.practice-start h1 { font-size: 1.5rem; }
.practice-start p { margin: 20px 0; }
.practice-start button { min-height: 44px; margin: 0 16px 20px 0; }
</style>
