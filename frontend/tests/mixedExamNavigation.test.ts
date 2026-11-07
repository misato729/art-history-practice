import assert from 'node:assert/strict'
import test from 'node:test'
import { EXAM_CONFIG, parseExamConfig } from '../app/utils/examConfig.ts'
import { createExamCatalog, questionNumbersForExams } from '../app/utils/examCatalog.ts'
import { createPracticeSequence, shufflePracticeSequence } from '../app/utils/practiceSequence.ts'
import { reconcileQuestionChoices } from '../app/utils/adminQuestionChoices.ts'
import type { AdminChoice } from '../app/types/adminQuestion.ts'

const mixedCatalog = () => {
  const config = structuredClone(EXAM_CONFIG)
  config.exam = {
    set_count: 2, questions_per_exam: 10, choice_labels: ['ア', 'イ', 'ウ', 'エ'],
    sets: [
      { exam_number: 1, title: 'テーマ別演習', question_count: 10 },
      { exam_number: 2, title: '模試第1回', question_count: 85, sections: [
        { title: '美術史問題', first: 1, last: 80, choice_labels: ['ア', 'イ', 'ウ', 'エ'] },
        { title: '活用問題', first: 81, last: 85, choice_labels: ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'] },
      ] },
    ],
  }
  return createExamCatalog(parseExamConfig(config))
}

test('unequal sets produce 95 valid positions and preserve their separate endings', () => {
  const catalog = mixedCatalog()
  assert.deepEqual(catalog.map(exam => [exam.title, exam.question_numbers.length]), [['テーマ別演習', 10], ['模試第1回', 85]])
  const numbers = questionNumbersForExams([1, 2], catalog)
  const all = createPracticeSequence([1, 2], numbers, catalog)
  assert.equal(all.length, 95)
  assert.deepEqual(all.slice(9, 11), [{ examNumber: 1, questionNumber: 10 }, { examNumber: 2, questionNumber: 1 }])
  assert.deepEqual(all.at(-1), { examNumber: 2, questionNumber: 85 })
  assert.equal(createPracticeSequence([1], numbers, catalog).length, 10)
  assert.deepEqual(questionNumbersForExams([1], catalog), Array.from({ length: 10 }, (_, index) => index + 1))
  assert.deepEqual(createPracticeSequence([1, 2], [81, 82, 83, 84, 85], catalog), [81, 82, 83, 84, 85].map(questionNumber => ({ examNumber: 2, questionNumber })))
  assert.deepEqual(createPracticeSequence([1], [81], catalog), [])
})

test('random practice retains every valid position exactly once for unequal sets', () => {
  const catalog = mixedCatalog()
  const all = createPracticeSequence([1, 2], questionNumbersForExams([1, 2], catalog), catalog)
  const shuffled = shufflePracticeSequence(all, 12345)
  const key = (position: { examNumber: number, questionNumber: number }) => `${position.examNumber}/${position.questionNumber}`
  assert.equal(shuffled.length, 95)
  assert.equal(new Set(shuffled.map(key)).size, 95)
  assert.deepEqual(shuffled.map(key).sort(), all.map(key).sort())
  assert.deepEqual(shuffled, shufflePracticeSequence(all, 12345))
})

test('four/six-choice transitions preserve shared IDs and content without moving a removed correct answer', () => {
  const initial: AdminChoice[] = ['ア', 'イ', 'ウ', 'エ'].map((choice_label, index) => ({
    id: index + 101, choice_label, content_blocks: [{ type: 'text', text: `編集内容${index + 1}` }],
    is_correct: index === 1, display_order: index + 1,
  }))
  const six = reconcileQuestionChoices(initial, ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'])
  assert.deepEqual(six.slice(0, 4), initial)
  assert.ok(six.slice(4).every(choice => choice.id === undefined && !choice.is_correct && choice.content_blocks[0]?.text === ''))
  six.forEach((choice, index) => { choice.is_correct = index === 5 })
  const four = reconcileQuestionChoices(six, ['ア', 'イ', 'ウ', 'エ'])
  assert.deepEqual(four.map(choice => [choice.id, choice.content_blocks]), initial.map(choice => [choice.id, choice.content_blocks]))
  assert.equal(four.filter(choice => choice.is_correct).length, 0)
  assert.equal(initial.filter(choice => choice.is_correct).length, 1)
})

test('editing existing six-choice records keeps all fields through an intermediate four-choice position', () => {
  const existing: AdminChoice[] = ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'].map((choice_label, index) => ({
    id: 201 + index, choice_label, content_blocks: [{ type: 'text', text: `保存済みの内容${index + 1}` }],
    is_correct: index === 5, display_order: index + 1,
  }))
  // Typing 81 → 82 can pass through 8, which belongs to a four-choice section.
  const intermediate = reconcileQuestionChoices(existing, ['ア', 'イ', 'ウ', 'エ'], { preserveExisting: true })
  const destination = reconcileQuestionChoices(intermediate, ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'], { preserveExisting: true })
  assert.deepEqual(intermediate, existing)
  assert.deepEqual(destination, existing)
})

test('new six-choice input restores hidden content without restoring a removed correct answer', () => {
  const six: AdminChoice[] = ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'].map((choice_label, index) => ({
    choice_label, content_blocks: [{ type: 'text', text: `未保存の内容${index + 1}` }],
    is_correct: index === 5, display_order: index + 1,
  }))
  const cachedChoices = structuredClone(six)
  const four = reconcileQuestionChoices(six, ['ア', 'イ', 'ウ', 'エ'], { cachedChoices })
  const restored = reconcileQuestionChoices(four, ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'], { cachedChoices })
  assert.deepEqual(restored.map(choice => choice.content_blocks), six.map(choice => choice.content_blocks))
  assert.equal(four.filter(choice => choice.is_correct).length, 0)
  assert.equal(restored.filter(choice => choice.is_correct).length, 0)
  four[1]!.is_correct = true
  const withExplicitAnswer = reconcileQuestionChoices(four, ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ'], { cachedChoices })
  assert.deepEqual(withExplicitAnswer.filter(choice => choice.is_correct).map(choice => choice.choice_label), ['イ'])
})


test('the real eight-set catalog preserves all 680 positions, every set boundary and the shuffled membership', () => {
  const catalog = createExamCatalog(EXAM_CONFIG)
  const exams = [1, 2, 3, 4, 5, 6, 7, 8]
  const positions = createPracticeSequence(exams, questionNumbersForExams(exams, catalog), catalog)
  const key = (position: { examNumber: number, questionNumber: number }) => `${position.examNumber}/${position.questionNumber}`
  assert.equal(positions.length, 680)
  assert.equal(new Set(positions.map(key)).size, 680)
  assert.deepEqual(positions[0], { examNumber: 1, questionNumber: 1 })
  assert.deepEqual(positions.at(-1), { examNumber: 8, questionNumber: 85 })
  for (const exam of [1, 2, 3, 4, 5, 6, 7]) assert.deepEqual(positions.slice(exam * 85 - 1, exam * 85 + 1), [
    { examNumber: exam, questionNumber: 85 }, { examNumber: exam + 1, questionNumber: 1 },
  ])
  const shuffled = shufflePracticeSequence(positions, 296420)
  assert.equal(new Set(shuffled.map(key)).size, 680)
  assert.deepEqual(shuffled.map(key).sort(), positions.map(key).sort())
})
