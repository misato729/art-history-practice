import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createStaticExamNavigation, staticPracticePosition, type StaticExamDefinition } from '../app/utils/staticExamNavigation.ts'

const free = { paymentsEnabled: false, freeExamCount: 1, fullAccess: false }
const paid = { paymentsEnabled: true, freeExamCount: 1, fullAccess: false }
const catalog: readonly StaticExamDefinition[] = Object.freeze(Array.from({ length: 5 }, (_, i) => Object.freeze({
  exam_number: i + 1,
  title: `模擬試験${i + 1}`,
  question_numbers: Object.freeze(Array.from({ length: 85 }, (_, q) => q + 1)),
})))

test('all five configured exams are available immediately without an API result', () => {
  const entries = createStaticExamNavigation(catalog, free)
  assert.equal(entries.length, 5)
  assert.equal(entries.flatMap(entry => entry.questions).length, 425)
  assert.deepEqual(entries.map(entry => entry.title), ['模擬試験1', '模擬試験2', '模擬試験3', '模擬試験4', '模擬試験5'])
})
test('every configured position has the correct direct path', () => {
  for (const entry of createStaticExamNavigation(catalog, free)) {
    assert.equal(entry.to, `/practice/${entry.examNumber}/1`)
    assert.deepEqual(entry.questions.map(q => q.number), Array.from({ length: 85 }, (_, i) => i + 1))
    for (const question of entry.questions) assert.equal(question.to, `/practice/${entry.examNumber}/${question.number}`)
  }
})
test('the question list includes both sides of the 80/81 section boundary and the last question', () => {
  const entries = createStaticExamNavigation(catalog, free)
  for (const entry of entries) for (const number of [1, 80, 81, 85]) {
    assert.equal(entry.questions[number - 1]?.to, `/practice/${entry.examNumber}/${number}`)
  }
})
test('turning payments off never locks a question regardless of the free quota', () => {
  assert.ok(createStaticExamNavigation(catalog, { ...free, freeExamCount: 0 }).every(entry => !entry.locked))
})
test('paid rows and their question links retain the premium destination', () => {
  const entries = createStaticExamNavigation(catalog, paid)
  assert.equal(entries[0]?.to, '/practice/1/1')
  for (const entry of entries.slice(1)) {
    assert.equal(entry.locked, true)
    assert.equal(entry.to, '/premium')
    assert.equal(entry.questions.length, 85)
    assert.ok(entry.questions.every(question => question.to === '/premium'))
  }
})
test('full access unlocks static paid links', () => {
  const entries = createStaticExamNavigation(catalog, { ...paid, fullAccess: true })
  assert.ok(entries.every(entry => !entry.locked))
  assert.equal(entries[4]?.questions[84]?.to, '/practice/5/85')
})
test('a different number of exams or questions is read from the supplied catalog, not hardcoded', () => {
  const entries = createStaticExamNavigation([{ exam_number: 7, title: '追加セット', question_numbers: [1, 2, 3] }], free)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.questions.length, 3)
  assert.equal(entries[0]?.questions[2]?.to, '/practice/7/3')
})
test('configured question order is preserved', () => {
  const entries = createStaticExamNavigation([{ exam_number: 1, question_numbers: [3, 1, 2] }], free)
  assert.equal(entries[0]?.to, '/practice/1/3')
  assert.deepEqual(entries[0]?.questions.map(question => question.number), [3, 1, 2])
})
test('frozen source data is not mutated and repeated calls do not share mutable question rows', () => {
  const before = JSON.stringify(catalog)
  const first = createStaticExamNavigation(catalog, free)
  first[0]!.questions[0]!.to = '/changed'
  const second = createStaticExamNavigation(catalog, free)
  assert.equal(second[0]?.questions[0]?.to, '/practice/1/1')
  assert.equal(JSON.stringify(catalog), before)
})
test('missing or blank titles fall back to an exam number', () => {
  assert.equal(createStaticExamNavigation([{ exam_number: 2, title: ' ', question_numbers: [1] }], free)[0]?.title, '模擬試験2')
})
test('invalid empty or duplicated question positions fail rather than silently fabricate links', () => {
  for (const numbers of [[], [1, 1], [0], [-1], [1.5], [Infinity], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => createStaticExamNavigation([{ exam_number: 1, question_numbers: numbers }], free), TypeError)
  }
})
test('invalid exam positions fail', () => {
  for (const number of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createStaticExamNavigation([{ exam_number: number, question_numbers: [1] }], free), TypeError)
  }
})
test('normal and trailing slash question routes are parsed', () => {
  assert.deepEqual(staticPracticePosition('/practice/2/81'), { examNumber: 2, questionNumber: 81 })
  assert.deepEqual(staticPracticePosition('/practice/5/85/'), { examNumber: 5, questionNumber: 85 })
})
test('launcher, home and non-question routes do not select a question', () => {
  for (const path of ['/', '/practice/start', '/practice', '/history', '/practice/1', '/practice/1/1/edit', '/practice/1/1?x=1']) {
    assert.equal(staticPracticePosition(path), null)
  }
})
test('zero, negative, fractional and unsafe route positions do not select a question', () => {
  for (const path of ['/practice/0/1', '/practice/1/0', '/practice/-1/1', '/practice/1/1.5', '/practice/01/1', '/practice/9007199254740992/1']) {
    assert.equal(staticPracticePosition(path), null)
  }
})

const home = readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../app/components/ExamSidebar.vue', import.meta.url), 'utf8')

test('home enables its live catalog only after selecting conditions, not on login', () => {
  assert.match(home, /const catalogEnabled = computed\(\(\) => launcherMode.value === 'conditions'\)/)
  assert.doesNotMatch(home, /catalogEnabled = computed\(\(\) => isLoggedIn/)
  assert.match(home, /const staticExams: readonly ExamCatalogEntry\[\] = STATIC_EXAM_CATALOG/)
  assert.match(home, /v-for="exam in staticExams"/)
})
test('home exam cards go directly to question routes without prefetch', () => {
  assert.doesNotMatch(home, /path: '\/practice\/start'/)
  assert.match(home, /:to="examTarget\(exam\)"\s+no-prefetch/)
  assert.match(home, /catalogExamStartNumber\(exam\) \?\? 1/)
})
test('conditions retry and material-aware random practice remain wired', () => {
  assert.match(home, /出題条件を読み込んでいます/)
  assert.match(home, /@click="refreshCatalog\(\)"/)
  assert.match(home, /shuffleArtPracticeSequence\(/)
  assert.match(home, /query.random_unit = MATERIAL_RANDOM_UNIT/)
})
test('sidebar does not import any API catalog hook or fetch data on expansion', () => {
  assert.doesNotMatch(sidebar, /usePracticeCatalog\(|useFetch\(|useAsyncData\(|\$api|\$fetch/)
  const toggle = sidebar.match(/const toggleExam = [\s\S]*?\n\}/)?.[0]
  assert.ok(toggle)
  assert.match(toggle, /openExam.value = openExam.value === exam \? null : exam/)
  assert.doesNotMatch(toggle, /await|fetch|refresh|api/i)
})
test('only navigation metadata enters the static model', () => {
  const source = readFileSync(new URL('../app/utils/staticExamNavigation.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /content_blocks|explanation_blocks|is_correct|source_text|fetch\(/)
  assert.doesNotMatch(source, /^import /m)
})


test('planned exams have a preparation destination for every membership state and no fabricated questions', () => {
  const planned = [6, 7, 8].map(exam_number => ({ exam_number, title: `模擬試験${exam_number}`, comingSoon: true, question_numbers: [] }))
  for (const fullAccess of [false, true]) {
    const rows = createStaticExamNavigation([...catalog, ...planned], { paymentsEnabled: true, freeExamCount: 2, fullAccess })
    assert.equal(rows.length, 8)
    assert.equal(rows[1]!.to, '/practice/2/1')
    assert.equal(rows[2]!.to, fullAccess ? '/practice/3/1' : '/premium')
    for (const row of rows.slice(5)) {
      assert.equal(row.to, `/mock-exams/${row.examNumber}`)
      assert.equal(row.comingSoon, true)
      assert.deepEqual(row.questions, [])
    }
  }
})
