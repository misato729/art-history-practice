import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { choiceLabelsForQuestion } from '../shared/schemas/exam.ts'
import { configuration, setConfigurationForTesting } from '../server/core/config.ts'
import { excerptFrom } from '../server/services/learning-validation.ts'
import { ApiError } from '../server/core/errors.ts'
import { closeDatabase, isolatedTransaction, query, type Database } from '../server/core/db.ts'
import type { User } from '../server/core/auth.ts'
import { saveQuestion, saveQuestionStructure, deleteQuestion, loadQuestion, type QuestionInput } from '../server/services/learning-writer.ts'
import { createQuestionGroup, loadQuestionGroup, loadExamSet, saveQuestionGroup, saveExamSet, deleteQuestionGroup, validateExamSet } from '../server/services/learning-structure.ts'
import { answerQuestion, getQuestion, getHistory, listHistory, listExams, listFavorites, nextQuestion, putFavorite } from '../server/services/learning.ts'

process.env.APP_ENV = 'test'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const integration = { skip: !process.env.DATABASE_URL }
const original = structuredClone(configuration)
const errorStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status
const exam = 9917
const labels = ['ア', 'イ', 'ウ', 'エ']
const passage = [{ label: 'A', display_order: 1, content_blocks: [{ type: 'text' as const, id: 'paragraph', inlines: [{ type: 'text' as const, text: 'Synthetic context ' }, { type: 'anchor' as const, id: 'detail', label: 'a', text: 'a comparison', underline: true }] }] }]
function input(number: number, group: number, child: number, refs: { passage_id: number; anchor_id: string | null }[] = []): QuestionInput {
  const category = configuration.categories.minor[0]!
  return { exam_number: exam, question_number: number, group_id: group, group_question_number: child, passage_references: refs,
    major_category_code: category.major_category_value, category_code: category.value, publication_status: 'published',
    content_blocks: [{ type: 'text', text: 'Synthetic child prompt' }], explanation_blocks: [{ type: 'text', text: 'Answer-only explanation' }], source_text: 'Synthetic source | https://example.invalid/source',
    choices: choiceLabelsForQuestion(configuration, exam, number).map((label, index) => ({ choice_label: label, display_order: index + 1, is_correct: index === 0, content_blocks: [{ type: 'text', text: `Synthetic choice ${label}` }] })) }
}
async function fixture(run: (db: Database, groups: number[], questions: number[], user: User) => Promise<void>) {
  const sets = Array.from({ length: 10000 }, (_, i) => ({ exam_number: i + 1, title: `Synthetic ${i + 1}`, question_count: 6, sections: [
    { title: 'Four', first: 1, last: 4, choice_labels: labels }, { title: 'Six', first: 5, last: 6, choice_labels: [...labels, 'オ', 'カ'] },
  ] }))
  setConfigurationForTesting({ ...original, exam: { ...original.exam, upcoming_sets: [], set_count: 10000, questions_per_exam: 6, sets }, payments: { ...original.payments, enabled: false, free_exam_count: 10000 } })
  try { await isolatedTransaction(async db => {
    const owner = await db.user.create({ data: { name: 'Synthetic group member', email: `group-${randomUUID()}@example.invalid`, created_at: new Date(), updated_at: new Date() } })
    const groups = []
    for (let index = 1; index <= 3; index++) groups.push((await createQuestionGroup(exam, { group_number: index, title: `Synthetic group ${index}`, planned_question_count: 2, passages: index === 1 ? passage : [] }, { db })).id)
    const lead = (await loadQuestionGroup(groups[0]!, db)).passages[0]!
    const numbers = [4, 1, 5, 6, 2, 3]
    const questions = []
    for (const [index, number] of numbers.entries()) questions.push((await saveQuestion(input(number, groups[Math.floor(index / 2)]!, index % 2 + 1, index < 2 ? [{ passage_id: lead.id, anchor_id: index ? null : 'detail' }] : []), { db })).id)
    assert.equal((await validateExamSet(exam, db)).valid, true)
    for (const id of groups) { const before = await loadQuestionGroup(id, db); await saveQuestionGroup(id, { publication_status: 'published', lock_version: before.lock_version }, { db }) }
    const set = await loadExamSet(exam, db)
    await saveExamSet({ exam_number: exam, title: set.title, publication_status: 'published', lock_version: set.lock_version }, { db })
    await run(db, groups, questions, { ...owner, id: Number(owner.id) } as unknown as User)
  }) } finally { setConfigurationForTesting(original) }
}
after(async () => { setConfigurationForTesting(original); await closeDatabase() })

test('grouped public DTO, stable internal URLs, mixed choices and display-order cursors agree', integration, () => fixture(async (db, groups, questions) => {
  const first = (await getQuestion(questions[0]!, null, db)).data
  assert.equal(first.question_number, 4)
  assert.equal(first.group_question_number, 1)
  assert.deepEqual((first.group as any).question_numbers, [4, 1])
  assert.equal((first.shared_passages as any[]).length, 1)
  assert.equal('explanation_blocks' in first, false)
  assert.equal('source_text' in first, false)
  assert((first.choices as any[]).every(choice => !('is_correct' in choice)))
  assert.equal((await nextQuestion({ exam_number: exam, after_question_number: 4 }, null, db)).data.question_number, 1)
  assert.equal((await nextQuestion({ exam_number: exam, question_number: 1 }, null, db)).data.question_number, 1)
  assert.equal(((await getQuestion(questions[2]!, null, db)).data.choices as any[]).length, 6)
  assert.equal(((await getQuestion(questions[2]!, null, db)).data.shared_passages as any[]).length, 0)
  assert.deepEqual((await listExams(null, db)).data.find(set => set.exam_number === exam)!.question_numbers, [4, 1, 5, 6, 2, 3])
  assert.equal((await listExams(null, db)).data.find(set => set.exam_number === exam)!.groups.length, groups.length)
  const original = await loadQuestion(questions[0]!, db)
  await assert.rejects(saveQuestion({ ...original, group_question_number: 999 }, { id: original.id, db }), errorStatus(422))
  await assert.rejects(saveQuestion({ ...original, group_id: null, group_question_number: null, passage_references: [] }, { id: original.id, db }), errorStatus(422))
  await assert.rejects(deleteQuestion(original.id, db), errorStatus(422))
  assert.deepEqual(await loadQuestion(original.id, db), original)
}))

test('shared lead edits preserve history/favorite/choice IDs, mark old histories and reject stale answers', integration, () => fixture(async (db, groups, questions, owner) => {
  const initial = await loadQuestion(questions[0]!, db)
  const answer = await answerQuestion(initial.id, initial.choices[0]!.id, owner, db, initial.content_version)
  await putFavorite(initial.id, owner, db)
  const before = await loadQuestionGroup(groups[0]!, db)
  const changedPassages = structuredClone(before.passages)
  changedPassages[0]!.content_blocks[0]!.inlines![0] = { type: 'text', text: 'Changed synthetic context ' }
  await saveQuestionGroup(before.id, { passages: changedPassages, lock_version: before.lock_version }, { db })
  const after = await loadQuestion(initial.id, db)
  assert.equal(after.content_version, initial.content_version + 1)
  assert.deepEqual(after.choices.map(choice => choice.id), initial.choices.map(choice => choice.id))
  assert.equal(await db.answerHistory.count({ where: { id: answer.data.answer_history_id! } }), 1)
  assert.equal((await listHistory(owner, {}, db)).data[0]!.is_outdated, true)
  await assert.rejects(getHistory(answer.data.answer_history_id!, owner, db), errorStatus(409))
  assert.equal((await listFavorites(owner, {}, db)).data.length, 1)
  await assert.rejects(answerQuestion(after.id, after.choices[0]!.id, owner, db, initial.content_version), errorStatus(409))
  const noOp = await loadQuestionGroup(before.id, db)
  await saveQuestionGroup(noOp.id, { passages: noOp.passages, lock_version: noOp.lock_version }, { db })
  assert.equal((await loadQuestion(initial.id, db)).content_version, after.content_version)
}))

test('cross-group references and removed targets cannot corrupt the graph; unpublished parents hide direct answers', integration, () => fixture(async (db, groups, questions) => {
  const originalQuestion = await loadQuestion(questions[2]!, db)
  const foreign = (await loadQuestionGroup(groups[0]!, db)).passages[0]!
  await assert.rejects(saveQuestion({ ...originalQuestion, passage_references: [{ passage_id: foreign.id, anchor_id: null }] }, { id: originalQuestion.id, db }), errorStatus(422))
  const before = await loadQuestionGroup(groups[0]!, db)
  await assert.rejects(saveQuestionGroup(before.id, { passages: [], lock_version: before.lock_version }, { db }), errorStatus(422))
  assert.deepEqual((await loadQuestionGroup(before.id, db)).passages, before.passages)
  const removedAnchor = structuredClone(before.passages)
  removedAnchor[0]!.content_blocks[0]!.inlines = [{ type: 'text', text: 'Target removed' }]
  await assert.rejects(saveQuestionGroup(before.id, { passages: removedAnchor, lock_version: before.lock_version }, { db }), errorStatus(422))
  assert.deepEqual((await loadQuestionGroup(before.id, db)).passages, before.passages)
  await deleteQuestionGroup(before.id, { db })
  await assert.rejects(getQuestion(questions[0]!, null, db), errorStatus(404))
  await assert.rejects(answerQuestion(questions[0]!, before.questions[0].choices[0].id, null, db, 1), errorStatus(404))
  assert.equal((await listExams(null, db)).data.find(set => set.exam_number === exam)!.groups.length, 2)
  const set = await loadExamSet(exam, db)
  await saveExamSet({ exam_number: exam, title: set.title, publication_status: 'private', lock_version: set.lock_version }, { db })
  await assert.rejects(getQuestion(originalQuestion.id, null, db), errorStatus(404))
  assert.equal((await listExams(null, db)).data.some(set => set.exam_number === exam), false)
}))


test('explicit matching legacy structure conversion preserves content meaning, identity, dates and all learning records', integration, () => fixture(async (db, _groups, _questions, owner) => {
  const legacyExam = exam + 1
  const childBlocks = [{ type: 'text' as const, text: 'Independent synthetic child' }]
  const { group_id: _group, group_question_number: _number, passage_references: _refs, ...base } = input(1, 1, 1)
  const legacyInput = { ...base, exam_number: legacyExam, content_blocks: [...passage[0]!.content_blocks, ...childBlocks] }
  const legacy = await saveQuestion(legacyInput, { db })
  const history = await answerQuestion(legacy.id, legacy.choices[0]!.id, owner, db)
  await putFavorite(legacy.id, owner, db)
  const group = await createQuestionGroup(legacyExam, { group_number: 1, title: 'Synthetic migrated group', planned_question_count: 1, passages: passage }, { db })
  const raw = { ...legacyInput, group_id: group.id, group_question_number: 1, passage_references: [{ passage_id: group.passages[0]!.id, anchor_id: null }], content_blocks: childBlocks }
  await assert.rejects(saveQuestionStructure(legacy.id, { ...raw, content_blocks: [{ type: 'text', text: 'Unmatched replacement' }] }, { db }), errorStatus(422))
  assert.deepEqual(await loadQuestion(legacy.id, db), legacy)
  const migrated = await saveQuestionStructure(legacy.id, raw, { db })
  assert.equal(migrated.id, legacy.id)
  assert.equal(migrated.question_number, legacy.question_number)
  assert.deepEqual(migrated.choices, legacy.choices)
  assert.deepEqual(migrated.created_at, legacy.created_at)
  assert.deepEqual(migrated.updated_at, legacy.updated_at)
  assert.equal(migrated.content_version, legacy.content_version)
  assert.equal(await db.answerHistory.count({ where: { id: history.data.answer_history_id! } }), 1)
  assert.equal(await db.favorite.count({ where: { question_id: legacy.id } }), 1)
  await assert.rejects(saveQuestionStructure(legacy.id, raw, { db }), errorStatus(422))
}))


test('inline question excerpts retain visible text and blank labels without requiring a duplicate text field', () => {
  assert.equal(excerptFrom([{ type: 'text', inlines: [{ type: 'text', text: 'A ' }, { type: 'anchor', id: 'detail', label: 'a', text: 'visible passage' }, { type: 'blank', id: 'blank', label: '①' }] }]), 'A visible passage①')
})
