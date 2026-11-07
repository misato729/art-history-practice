import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import type { ExamConfiguration } from '../app/utils/examConfig.ts'
import { choiceLabelsForQuestion } from '../shared/schemas/exam.ts'
import { configuration, setConfigurationForTesting } from '../server/core/config.ts'
import { ApiError } from '../server/core/errors.ts'
import { closeDatabase, isolatedTransaction, query, type Database } from '../server/core/db.ts'
import type { User } from '../server/core/auth.ts'
import { excerptFrom, sanitizeQuestionInput, validateQuestionInput, type QuestionInput } from '../server/services/learning-validation.ts'
import { deleteQuestion, loadQuestion, materialDigest, saveQuestion, validateCompleteExam } from '../server/services/learning-writer.ts'
import { answerQuestion, getHistory, getQuestion, listAdminQuestions, listExams, listFavorites, listHistory, nextQuestion, putFavorite, removeFavorite } from '../server/services/learning.ts'

process.env.APP_ENV = 'test'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.PGHOST)
const originalConfiguration = structuredClone(configuration)
const configFor = (changes: Partial<ExamConfiguration> = {}): ExamConfiguration => ({ ...structuredClone(originalConfiguration), ...changes })
const apiError = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status

function input(overrides: Partial<QuestionInput> = {}, config = configuration): QuestionInput {
  const category = config.categories.minor[0]!
  return {
    exam_number: 1, question_number: 1, major_category_code: category.major_category_value, category_code: category.value,
    publication_status: 'published', content_blocks: [{ type: 'text', text: 'Sample question' }],
    explanation_blocks: [{ type: 'text', text: 'Explanation revealed only after answering' }], source_text: 'Self-authored sample | https://example.com/sample',
    choices: choiceLabelsForQuestion(config, overrides.exam_number ?? 1, overrides.question_number ?? 1).map((label, index) => ({ choice_label: label, content_blocks: [{ type: 'text', text: `Choice ${label}` }], is_correct: index === 1, display_order: index + 1 })),
    ...overrides,
  }
}

async function isolated(action: (db: Database, exam: number) => Promise<void>) {
  const testConfiguration = configFor({ exam: { set_count: 10000, questions_per_exam: 3, choice_labels: [...configuration.exam.choice_labels] }, payments: { ...configuration.payments, enabled: false, free_exam_count: 10000 } })
  setConfigurationForTesting(testConfiguration)
  try {
    await isolatedTransaction(async db => {
      await query("SET LOCAL lock_timeout='10s'", [], db)
      await action(db, 100 + Math.floor(Math.random() * 9000))
    })
  } finally {
    setConfigurationForTesting(originalConfiguration)
  }
}
async function user(db: Database, role: 'user' | 'admin' = 'user'): Promise<User> {
  const [row] = await query<User>("INSERT INTO users(name,email,role,created_at,updated_at) VALUES('Learning test',$1,$2,NOW(),NOW()) RETURNING *", [`learning-${randomUUID()}@example.invalid`, role], db)
  return row!
}
const integration = { skip: !hasDatabase }
after(async () => { setConfigurationForTesting(originalConfiguration); await closeDatabase() })

function mixedConfiguration(): ExamConfiguration {
  const four = ['ア', 'イ', 'ウ', 'エ']
  return configFor({ exam: { set_count: 2, questions_per_exam: 10, choice_labels: four, sets: [
    { exam_number: 1, title: 'Synthetic ten-question set', question_count: 10 },
    { exam_number: 2, title: 'Synthetic mixed-choice set', question_count: 85, sections: [
      { title: 'History', first: 1, last: 80, choice_labels: four },
      { title: 'Application', first: 81, last: 85, choice_labels: [...four, 'オ', 'カ'] },
    ] },
  ] }, payments: { ...originalConfiguration.payments, enabled: false, free_exam_count: 2 } })
}

async function isolatedMixed(action: (db: Database) => Promise<void>) {
  setConfigurationForTesting(mixedConfiguration())
  try {
    await isolatedTransaction(async db => {
      // Only fixtures in the caller-owned rollback transaction use these two slots.
      await db.answerHistory.deleteMany({ where: { question: { exam_number: { in: [1, 2] } } } })
      await db.question.deleteMany({ where: { exam_number: { in: [1, 2] } } })
      await action(db)
    })
  } finally { setConfigurationForTesting(originalConfiguration) }
}

test('mixed set validation enforces each position and its exact choice labels', () => {
  const config = mixedConfiguration()
  for (const [exam_number, question_number, count] of [[1, 10, 4], [2, 80, 4], [2, 81, 6], [2, 85, 6]] as const) {
    assert.equal(validateQuestionInput(input({ exam_number, question_number }, config), config).choices.length, count)
  }
  for (const [exam_number, question_number] of [[1, 11], [2, 86]] as const) {
    assert.throws(() => validateQuestionInput(input({ exam_number, question_number }, config), config), apiError(422))
  }
  const six = input({ exam_number: 2, question_number: 81 }, config)
  assert.throws(() => validateQuestionInput({ ...six, choices: six.choices.slice(0, 4) }, config), apiError(422))
  const wrongLabels = structuredClone(six)
  wrongLabels.choices[5]!.choice_label = '別'
  assert.throws(() => validateQuestionInput(wrongLabels, config), apiError(422))
  assert.throws(() => validateQuestionInput({ ...six, question_number: 80 }, config), apiError(422))
})

test('publication completeness resolves ten and eighty-five question sets independently', async () => {
  const config = mixedConfiguration()
  for (const [exam, count] of [[1, 10], [2, 85]] as const) {
    const rows = Array.from({ length: count - 1 }, (_, index) => ({ question_number: index + 1 }))
    const db = { question: { findMany: async () => rows } } as unknown as Database
    await assert.rejects(validateCompleteExam(exam, db, config), apiError(422))
    await validateCompleteExam(exam, db, config, { question_number: count })
    rows.push({ question_number: count })
    await validateCompleteExam(exam, db, config)
  }
  const unused = { question: { findMany: async () => { throw new Error('Invalid set must not query the DB') } } } as unknown as Database
  await assert.rejects(validateCompleteExam(3, unused, config), apiError(422))
})

test('configuration-derived question and choice limits support three/five choices and 25 questions', () => {
  for (const labels of [['A', 'B', 'C'], ['A', 'B', 'C', 'D', 'E']]) {
    const config = configFor({ exam: { set_count: 2, questions_per_exam: 25, choice_labels: labels } })
    const attributes = input({ question_number: 25 }, config)
    assert.equal(validateQuestionInput(attributes, config).choices.length, labels.length)
    assert.throws(() => validateQuestionInput({ ...attributes, question_number: 26 }, config), apiError(422))
    assert.throws(() => validateQuestionInput({ ...attributes, exam_number: 3 }, config), apiError(422))
    const duplicateCorrect = structuredClone(attributes)
    duplicateCorrect.choices[0]!.is_correct = true
    assert.throws(() => validateQuestionInput(duplicateCorrect, config), apiError(422))
  }
})

test('publication validates six blanks, table widths, category ownership and HTTPS sources', () => {
  const attributes = input()
  const blanks = ['①', '②', '③', '④', '⑤', '⑥']
  attributes.content_blocks = [{ type: 'fill_in_quote', text: blanks.map(label => `{{${label}}}`).join('、') }]
  for (const choice of attributes.choices) choice.content_blocks = [{ type: 'fill_in_choice', cells: blanks.map(label => `Term ${label}`) }]
  assert.equal(validateQuestionInput(attributes).choices[0]!.content_blocks[0]!.cells!.length, 6)
  const invalidCells = structuredClone(attributes)
  invalidCells.choices[0]!.content_blocks[0]!.cells!.pop()
  assert.throws(() => validateQuestionInput(invalidCells), apiError(422))
  assert.throws(() => validateQuestionInput({ ...input(), source_text: 'Source | https://user:secret@example.com' }), apiError(422))
  assert.throws(() => validateQuestionInput({ ...input(), category_code: 'nonexistent' }), apiError(422))
  assert.throws(() => validateQuestionInput({ ...input(), content_blocks: [{ type: 'table', headers: ['A', 'B'], rows: [['only one']] }] }), apiError(422))
  assert.throws(() => validateQuestionInput({ ...input(), explanation_blocks: [] }), apiError(422))
  const draft = validateQuestionInput({ ...input(), publication_status: 'draft', content_blocks: [], explanation_blocks: [], source_text: null })
  assert.deepEqual(draft.content_blocks, [])
})

test('admin normalization handles form booleans, enforces all choice rows and ignores unrelated fields', () => {
  const raw = { ...input({ publication_status: 'draft' }), difficulty: 'ignored', choices: input().choices.map(choice => ({ ...choice, is_correct: choice.is_correct ? '1' : 'false' })) }
  const normalized = sanitizeQuestionInput(raw)
  assert.equal(normalized.choices.filter(choice => choice.is_correct).length, 1)
  assert.equal('difficulty' in normalized, false)
  assert.throws(() => sanitizeQuestionInput({ ...raw, choices: raw.choices.slice(1) }), apiError(422))
  assert.throws(() => sanitizeQuestionInput({ ...raw, content_blocks: [] }), apiError(422))
})

test('material comparison ignores visibility and IDs; excerpts remove blank markers and limit Unicode characters', () => {
  const attributes = input()
  assert.equal(materialDigest(attributes), materialDigest({ ...attributes, publication_status: 'private', choices: attributes.choices.map((choice, index) => ({ ...choice, id: index + 10 })) }))
  assert.notEqual(materialDigest(attributes), materialDigest({ ...attributes, content_blocks: [{ type: 'text', text: 'Changed' }] }))
  assert.equal(excerptFrom([{ type: 'text', text: ' A {{①}}\n B ' }]), 'A ① B')
  assert.equal(Array.from(excerptFrom([{ type: 'text', text: '情'.repeat(130) }])).length, 120)
})

test('PostgreSQL accepts configurable 25-position sets and 3/5 choices while enforcing one correct row', integration, async () => isolated(async (db, exam) => {
  for (const [offset, labels] of [['A', 'B', 'C'], ['A', 'B', 'C', 'D', 'E']].entries()) {
    setConfigurationForTesting({ ...configuration, exam: { ...configuration.exam, questions_per_exam: 25, choice_labels: labels } })
    const saved = await saveQuestion(input({ exam_number: exam + offset, question_number: 25 }), { db })
    assert.equal(saved.question_number, 25)
    assert.deepEqual(saved.choices.map(choice => choice.choice_label), labels)
    await query('SAVEPOINT correct_answer_constraint', [], db)
    await assert.rejects(query('UPDATE question_choices SET is_correct=true WHERE question_id=$1', [saved.id], db), (error: unknown) => (error as { code?: string }).code === '23505')
    await query('ROLLBACK TO SAVEPOINT correct_answer_constraint', [], db)
    await query('RELEASE SAVEPOINT correct_answer_constraint', [], db)
    assert.equal((await loadQuestion(saved.id, db)).choices.filter(choice => choice.is_correct).length, 1)
  }
}))

test('anonymous exercise never exposes answer fields until answering and rejects a foreign choice', integration, async () => isolated(async (db, exam) => {
  const question = await saveQuestion(input({ exam_number: exam }), { db })
  const other = await saveQuestion(input({ exam_number: exam, question_number: 2 }), { db })
  const response = await getQuestion(question.id, null, db)
  assert.equal('explanation_blocks' in response.data, false)
  assert.equal('source_text' in response.data, false)
  assert.equal('is_correct' in (response.data.choices as Record<string, unknown>[])[0]!, false)
  const answer = await answerQuestion(question.id, question.choices[1]!.id, null, db)
  assert.equal(answer.data.is_correct, true)
  assert.equal(answer.data.answer_history_id, null)
  assert.deepEqual(answer.data.explanation_blocks, question.explanation_blocks)
  await assert.rejects(answerQuestion(question.id, other.choices[0]!.id, null, db), apiError(422))
  const rows = await query<{ total: number }>('SELECT COUNT(*)::integer AS total FROM answer_histories WHERE question_id=$1', [question.id], db)
  assert.equal(rows[0]!.total, 0)
}))

test('next-question selection is ordered and validates parameters without returning private content', integration, async () => isolated(async (db, exam) => {
  const first = await saveQuestion(input({ exam_number: exam }), { db })
  await saveQuestion(input({ exam_number: exam, question_number: 2, publication_status: 'private' }), { db })
  const third = await saveQuestion(input({ exam_number: exam, question_number: 3 }), { db })
  assert.equal((await nextQuestion({ exam_number: exam, after_question_number: 0 }, null, db)).data.id, first.id)
  assert.equal((await nextQuestion({ exam_number: exam, after_question_number: 1 }, null, db)).data.id, third.id)
  await assert.rejects(nextQuestion({ after_question_number: 0 }, null, db), apiError(400))
  await assert.rejects(nextQuestion({ exam_number: 'invalid' }, null, db), apiError(400))
  await assert.rejects(nextQuestion({ exam_number: exam, after_question_number: 3 }, null, db), apiError(404))
  const exams = await listExams(null, db)
  assert.deepEqual(exams.data.find(item => item.exam_number === exam)?.question_numbers, [1, 3])
}))

test('signed-in answers, history ownership, favorite idempotency and pagination retain the API contract', integration, async () => isolated(async (db, exam) => {
  const owner = await user(db)
  const other = await user(db)
  const question = await saveQuestion(input({ exam_number: exam }), { db })
  await assert.rejects(listHistory(null, {}, db), apiError(401))
  await assert.rejects(putFavorite(question.id, null, db), apiError(401))
  const answer = await answerQuestion(question.id, question.choices[0]!.id, owner, db)
  assert.equal(answer.data.is_correct, false)
  const historyId = answer.data.answer_history_id!
  const newer = await answerQuestion(question.id, question.choices[1]!.id, owner, db)
  const page = await listHistory(owner, { per_page: 1 }, db)
  assert.equal(page.data[0]!.id, newer.data.answer_history_id)
  assert.equal(page.meta.total_count, 2)
  assert.equal(page.meta.total_pages, 2)
  assert.equal((await listHistory(owner, { per_page: 1, page: 2 }, db)).data[0]!.id, historyId)
  assert.equal((await listHistory(other, {}, db)).data.length, 0)
  await assert.rejects(getHistory(historyId, other, db), apiError(404))
  assert.deepEqual((await getHistory(historyId, owner, db)).data.explanation_blocks, question.explanation_blocks)
  const favorite = await putFavorite(question.id, owner, db)
  const repeated = await putFavorite(question.id, owner, db)
  assert.equal(favorite.created, true)
  assert.equal(repeated.created, false)
  assert.equal(favorite.data.id, repeated.data.id)
  assert.equal((await getQuestion(question.id, owner, db)).data.is_favorite, true)
  assert.equal((await listFavorites(owner, {}, db)).meta.total_count, 1)
  assert.equal((await listFavorites(other, {}, db)).meta.total_pages, 0)
  for (const params of [{ page: 0 }, { per_page: 101 }, { page: '1.5' }]) {
    await assert.rejects(listHistory(owner, params, db), apiError(400))
    await assert.rejects(listFavorites(owner, params, db), apiError(400))
  }
  await removeFavorite(question.id, owner, db)
  await removeFavorite(question.id, owner, db)
  assert.equal((await listFavorites(owner, {}, db)).data.length, 0)
}))

test('paid-mode authorization conceals restricted histories and preserves favorites when access is revoked', integration, async () => isolated(async (db, exam) => {
  setConfigurationForTesting({ ...configuration, payments: { ...configuration.payments, enabled: true, free_exam_count: 0 } })
  const owner = await user(db)
  const admin = await user(db, 'admin')
  const question = await saveQuestion(input({ exam_number: exam }), { db })
  await assert.rejects(getQuestion(question.id, null, db), apiError(401))
  await assert.rejects(getQuestion(question.id, owner, db), apiError(403))
  assert.equal((await getQuestion(question.id, admin, db)).data.id, question.id)
  const [payment] = await query<{ id: number }>("INSERT INTO payments(user_id,stripe_checkout_session_id,stripe_price_id,amount,currency,status,paid_at,created_at,updated_at) VALUES($1,$2,'price_learning',500,'jpy','paid',NOW(),NOW(),NOW()) RETURNING id", [owner.id, `cs_${randomUUID()}`], db)
  await query("INSERT INTO memberships(user_id,source_payment_id,status,activated_at,created_at,updated_at) VALUES($1,$2,'active',NOW(),NOW(),NOW())", [owner.id, payment!.id], db)
  const answer = await answerQuestion(question.id, question.choices[1]!.id, owner, db)
  await putFavorite(question.id, owner, db)
  await query("UPDATE memberships SET status='revoked' WHERE user_id=$1", [owner.id], db)
  await assert.rejects(getQuestion(question.id, owner, db), apiError(403))
  const history = (await listHistory(owner, {}, db)).data[0]!
  assert.equal(history.locked, true)
  assert.equal('selected_choice' in history, false)
  assert.equal('is_correct' in history, false)
  assert.equal('body_excerpt' in history.question, false)
  await assert.rejects(getHistory(answer.data.answer_history_id!, owner, db), apiError(403))
  await assert.rejects(listFavorites(owner, {}, db), apiError(403))
  assert.equal((await query('SELECT id FROM favorites WHERE user_id=$1', [owner.id], db)).length, 1)
}))

test('no-op and visibility-only saves preserve histories, identities and favorites; material edits invalidate histories', integration, async () => isolated(async (db, exam) => {
  const owner = await user(db)
  const initial = input({ exam_number: exam })
  const question = await saveQuestion(initial, { db })
  const answer = await answerQuestion(question.id, question.choices[1]!.id, owner, db)
  await putFavorite(question.id, owner, db)
  const ids = question.choices.map(choice => choice.id)
  const before = await loadQuestion(question.id, db)
  await saveQuestion(initial, { id: question.id, db })
  assert.deepEqual(await loadQuestion(question.id, db), before)
  await saveQuestion({ ...initial, publication_status: 'private' }, { id: question.id, db })
  assert.equal((await query('SELECT id FROM answer_histories WHERE id=$1', [answer.data.answer_history_id], db)).length, 1)
  const changed = await saveQuestion({ ...initial, content_blocks: [{ type: 'text', text: 'Changed question' }] }, { id: question.id, db })
  assert.deepEqual(changed.choices.map(choice => choice.id), ids)
  assert.equal((await query('SELECT id FROM answer_histories WHERE id=$1', [answer.data.answer_history_id], db)).length, 0)
  assert.equal((await query('SELECT id FROM favorites WHERE user_id=$1 AND question_id=$2', [owner.id, question.id], db)).length, 1)
}))

test('internal revision preservation retains exact historical rows, timestamps and stale-version boundaries', integration, async () => isolated(async (db, exam) => {
  const owner=await user(db),initial=input({exam_number:exam}),question=await saveQuestion(initial,{db})
  const answer=await answerQuestion(question.id,question.choices[1]!.id,owner,db)
  await putFavorite(question.id,owner,db)
  await query("UPDATE answer_histories SET created_at='2026-11-01 01:02:03.123456'::timestamp,updated_at='2026-11-01 01:02:03.654321'::timestamp WHERE id=$1",[answer.data.answer_history_id],db)
  const snapshot=()=>query('SELECT id,user_id,question_id,selected_choice_id,question_version,is_correct,created_at::text,updated_at::text FROM answer_histories WHERE id=$1',[answer.data.answer_history_id],db)
  const before=await snapshot()
  const changed=await saveQuestion({...initial,content_blocks:[{type:'text',text:'Revised synthetic content'}]},{id:question.id,db,preserveHistory:true})
  assert.deepEqual(await snapshot(),before)
  assert.deepEqual(changed.choices.map(c=>c.id),question.choices.map(c=>c.id))
  assert(changed.content_version>question.content_version)
  assert.equal(await db.favorite.count({where:{user_id:owner.id,question_id:question.id}}),1)
  const history=(await listHistory(owner,{},db)).data.find(h=>h.id===answer.data.answer_history_id)!
  assert.equal(history.is_outdated,true)
  assert.equal('selected_choice' in history,false)
  assert.equal('is_correct' in history,false)
  await assert.rejects(getHistory(answer.data.answer_history_id!,owner,db),apiError(409))
  await assert.rejects(answerQuestion(question.id,changed.choices[1]!.id,owner,db,question.content_version),apiError(409))
  assert.deepEqual(await snapshot(),before)
}))

test('raw question input cannot enable internal history preservation',integration,async()=>isolated(async(db,exam)=>{
  const owner=await user(db),initial=input({exam_number:exam}),question=await saveQuestion(initial,{db})
  const answer=await answerQuestion(question.id,question.choices[1]!.id,owner,db)
  await saveQuestion({...initial,content_blocks:[{type:'text',text:'Injected synthetic content'}],preserveHistory:true} as QuestionInput,{id:question.id,db})
  assert.equal(await db.answerHistory.count({where:{id:answer.data.answer_history_id!}}),0)
}))

test('publication requires all configured positions and invalid input cannot partially save', integration, async () => isolated(async (db, exam) => {
  await assert.rejects(saveQuestion(input({ exam_number: exam }), { db, requireCompleteExam: true }), apiError(422))
  assert.equal((await query('SELECT id FROM questions WHERE exam_number=$1', [exam], db)).length, 0)
  await saveQuestion(input({ exam_number: exam, publication_status: 'draft' }), { db })
  await saveQuestion(input({ exam_number: exam, question_number: 2, publication_status: 'private' }), { db })
  const last = await saveQuestion(input({ exam_number: exam, question_number: 3 }), { db, requireCompleteExam: true })
  assert.equal(last.publication_status, 'published')
  const invalid = input({ exam_number: exam, question_number: 3, explanation_blocks: [] })
  await assert.rejects(saveQuestion(invalid, { id: last.id, db }), apiError(422))
  assert.deepEqual((await loadQuestion(last.id, db)).explanation_blocks, last.explanation_blocks)
}))

test('changing the correct answer preserves choice IDs and enforces choice-ID ownership', integration, async () => isolated(async (db, exam) => {
  const owner = await user(db)
  const question = await saveQuestion(input({ exam_number: exam }), { db })
  const other = await saveQuestion(input({ exam_number: exam, question_number: 2 }), { db })
  await answerQuestion(question.id, question.choices[1]!.id, owner, db)
  const changed = input({ exam_number: exam })
  changed.choices.forEach((choice, index) => { choice.is_correct = index === 0; choice.id = question.choices[index]!.id })
  const saved = await saveQuestion(changed, { id: question.id, db })
  assert.deepEqual(saved.choices.map(choice => choice.id), question.choices.map(choice => choice.id))
  assert.equal(saved.choices.filter(choice => choice.is_correct).length, 1)
  assert.equal((await query('SELECT id FROM answer_histories WHERE question_id=$1', [question.id], db)).length, 0)
  changed.choices[0]!.id = other.choices[0]!.id
  await assert.rejects(saveQuestion(changed, { id: question.id, db }), apiError(422))
  assert.deepEqual(await loadQuestion(question.id, db), saved)
}))

test('six-choice grading and edits preserve identities, no-op histories and visibility-only histories', integration, async () => isolatedMixed(async db => {
  const owner = await user(db)
  const initial = input({ exam_number: 2, question_number: 81 })
  initial.choices.forEach((choice, index) => { choice.is_correct = index === 5 })
  const question = await saveQuestion(initial, { db })
  assert.equal(question.choices.length, 6)
  const ids = question.choices.map(choice => choice.id)
  const publicQuestion = (await getQuestion(question.id, owner, db)).data
  const publicChoices = publicQuestion.choices as Record<string, unknown>[]
  assert.equal(publicChoices.length, 6)
  assert.equal('explanation_blocks' in publicQuestion, false)
  assert.equal('source_text' in publicQuestion, false)
  assert(publicChoices.every(choice => !('is_correct' in choice)))
  const answer = await answerQuestion(question.id, question.choices[5]!.id, owner, db)
  assert.equal(answer.data.is_correct, true)
  assert.equal(answer.data.correct_choice.choice_label, 'カ')
  await putFavorite(question.id, owner, db)
  const before = await loadQuestion(question.id, db)
  await saveQuestion(initial, { id: question.id, db })
  assert.deepEqual(await loadQuestion(question.id, db), before)
  await saveQuestion({ ...initial, publication_status: 'private' }, { id: question.id, db })
  await saveQuestion(initial, { id: question.id, db })
  assert.equal(await db.answerHistory.count({ where: { id: answer.data.answer_history_id! } }), 1)
  const changed = structuredClone(initial)
  changed.choices.forEach((choice, index) => {
    choice.id = ids[index]
    choice.is_correct = index === 4
  })
  const saved = await saveQuestion(changed, { id: question.id, db })
  assert.deepEqual(saved.choices.map(choice => choice.id), ids)
  assert.equal(saved.choices.filter(choice => choice.is_correct).length, 1)
  assert.equal(await db.answerHistory.count({ where: { question_id: question.id } }), 0)
  assert.equal(await db.favorite.count({ where: { user_id: owner.id, question_id: question.id } }), 1)
  assert.equal((await answerQuestion(question.id, saved.choices[4]!.id, owner, db)).data.is_correct, true)
}))

test('existing questions cannot move across choice-label sections or lose choices and histories', integration, async () => isolatedMixed(async db => {
  const owner = await user(db)
  const fourInput = input({ exam_number: 1, question_number: 1 })
  const sixInput = input({ exam_number: 2, question_number: 81 })
  const four = await saveQuestion(fourInput, { db })
  const six = await saveQuestion(sixInput, { db })
  await answerQuestion(four.id, four.choices[1]!.id, owner, db)
  await answerQuestion(six.id, six.choices[1]!.id, owner, db)
  for (const [before, destination] of [
    [four, input({ exam_number: 2, question_number: 82 })],
    [six, input({ exam_number: 2, question_number: 80 })],
  ] as const) {
    destination.choices.forEach((choice, index) => { choice.id = before.choices[index]?.id })
    await assert.rejects(saveQuestion(destination, { id: before.id, db }), (error: unknown) => error instanceof ApiError && error.status === 422 &&
      error.message === '選択肢のラベルが異なる区分へ既存の問題は移動できません')
    assert.deepEqual(await loadQuestion(before.id, db), before)
    assert.equal(await db.answerHistory.count({ where: { question_id: before.id } }), 1)
  }
  assert.equal(await db.question.count({ where: { exam_number: 2, question_number: { in: [80, 82] } } }), 0)
  const sameLabels = await saveQuestion({ ...sixInput, question_number: 82 }, { id: six.id, db })
  assert.deepEqual(sameLabels.choices.map(choice => choice.id), six.choices.map(choice => choice.id))
  assert.equal(await db.answerHistory.count({ where: { question_id: six.id } }), 0)
}))

test('question deletion cascades only its own learning records and admin filtering remains scoped', integration, async () => isolated(async (db, exam) => {
  const owner = await user(db)
  const admin = await user(db, 'admin')
  const first = await saveQuestion(input({ exam_number: exam }), { db })
  const other = await saveQuestion(input({ exam_number: exam, question_number: 2 }), { db })
  await answerQuestion(first.id, first.choices[1]!.id, owner, db)
  await answerQuestion(other.id, other.choices[1]!.id, owner, db)
  await putFavorite(first.id, owner, db)
  await putFavorite(other.id, owner, db)
  await assert.rejects(listAdminQuestions(owner, {}, db), apiError(403))
  await assert.rejects(listAdminQuestions(null, {}, db), apiError(401))
  const result = await listAdminQuestions(admin, { exam_number: exam, per_page: 1, page: 999 }, db)
  assert.equal(result.meta.current_page, 2)
  assert.equal(result.meta.total_count, 2)
  await deleteQuestion(first.id, db)
  assert.equal((await query('SELECT id FROM question_choices WHERE question_id=$1', [first.id], db)).length, 0)
  assert.equal((await query('SELECT id FROM answer_histories WHERE question_id=$1', [first.id], db)).length, 0)
  assert.equal((await listFavorites(owner, {}, db)).data.length, 1)
  assert.equal((await listHistory(owner, {}, db)).data.length, 1)
  await assert.rejects(getQuestion(first.id, owner, db), apiError(404))
}))
