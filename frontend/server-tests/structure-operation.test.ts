import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { configuration, setConfigurationForTesting } from '../server/core/config.ts'
import { closeDatabase, getDatabase, record, type Database } from '../server/core/db.ts'
import type { User } from '../server/core/auth.ts'
import { parseContentDocument } from '../shared/schemas/structure.ts'
import { applyContentStructure, STRUCTURE_CONFIRMATION } from '../server/operations/structure.ts'
import { OperationError, digest } from '../server/operations/content.ts'
import { answerQuestion, putFavorite } from '../server/services/learning.ts'
import { saveQuestion, materialDigest } from '../server/services/learning-writer.ts'

process.env.APP_ENV = 'test'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const integration = { skip: !process.env.DATABASE_URL }
// Preserve the original 85-question structural conversion regression independently of catalog growth.
const legacyContentPath = fileURLToPath(new URL('../../content/mock-exams/mock-01/questions.json', import.meta.url))
const document = parseContentDocument(JSON.parse(await readFile(legacyContentPath, 'utf8')), configuration)
const passages = new Map(document.groups.flatMap(group => group.passages.map(passage => [passage.id, passage] as const)))
after(closeDatabase)

async function legacyFixture(run: (db: Database, before: any[], owner: User) => Promise<void>) {
  const originalConfiguration = structuredClone(configuration)
  setConfigurationForTesting({ ...originalConfiguration, payments: { ...originalConfiguration.payments, enabled: false } })
  const rollback = new Error('structure fixture rollback')
  try { await getDatabase().$transaction(async db => {
    // Only the explicitly isolated test DB's rollback transaction is emptied.
    await db.user.deleteMany()
    await db.question.deleteMany()
    await db.groupPassage.deleteMany()
    await db.questionGroup.deleteMany()
    await db.examSet.deleteMany()
    const owner = await db.user.create({ data: { name: 'Synthetic structural conversion', email: `structure-${randomUUID()}@example.invalid`, created_at: new Date(), updated_at: new Date() } })
    for (const source of document.questions) {
      const { group_id, group_question_number, passage_references, ...question } = source
      const prefix = [...new Set((passage_references ?? []).map(reference => reference.passage_id))].flatMap(id => passages.get(id)!.content_blocks)
      await saveQuestion({ ...question, content_blocks: [...prefix, ...question.content_blocks] }, { db })
    }
    const before = record(await db.question.findMany({ orderBy: { question_number: 'asc' }, include: { choices: { orderBy: { display_order: 'asc' } }, passage_references: true } }))
    await run(db, before, { ...owner, id: Number(owner.id) } as unknown as User)
    throw rollback
  }, { timeout: 180_000, maxWait: 10_000 }) } catch (error) { if (error !== rollback) throw error } finally { setConfigurationForTesting(originalConfiguration) }
}
async function domainSnapshot(db: Database) {
  return digest(record({
    questions: await db.question.findMany({ orderBy: { id: 'asc' } }), choices: await db.questionChoice.findMany({ orderBy: { id: 'asc' } }),
    groups: await db.questionGroup.findMany({ orderBy: { id: 'asc' } }), passages: await db.groupPassage.findMany({ orderBy: { id: 'asc' } }),
    references: await db.questionPassageReference.findMany({ orderBy: { id: 'asc' } }), parents: await db.examSet.findMany({ orderBy: { exam_number: 'asc' } }),
    histories: await db.answerHistory.findMany({ orderBy: { id: 'asc' } }), favorites: await db.favorite.findMany({ orderBy: { id: 'asc' } }),
  }))
}

test('structural conversion requires its exact confirmation before reading a path or touching a DB', async () => {
  const db = new Proxy({}, { get() { throw new Error('Must not access the DB') } }) as Database
  await assert.rejects(applyContentStructure('/missing/path.json', undefined, db), OperationError)
  await assert.rejects(applyContentStructure('/missing/path.json', 'IMPORT_INTO_EMPTY_DATABASE', db), OperationError)
})

test('85 matching legacy questions acquire structure without losing IDs, dates, versions, histories or favorites; repeated conversion does nothing', integration, () => legacyFixture(async (db, before, owner) => {
  assert.equal(before.length, 85)
  assert.equal(before.reduce((sum, question) => sum + question.choices.length, 0), document.questions.reduce((sum, question) => sum + question.choices.length, 0))
  const oldQuestion = before[0]!
  const answer = await answerQuestion(oldQuestion.id, oldQuestion.choices.find((choice: any) => choice.is_correct).id, owner, db)
  await putFavorite(oldQuestion.id, owner, db)
  const history = await db.answerHistory.findUniqueOrThrow({ where: { id: answer.data.answer_history_id! } })
  const favorite = await db.favorite.findFirstOrThrow({ where: { question_id: oldQuestion.id } })
  // A structural conversion must not resume a deliberately hidden parent.
  await db.examSet.update({ where: { exam_number: oldQuestion.exam_number }, data: { publication_status: 'private' } })
  const parentBefore = await db.examSet.findMany({ orderBy: { exam_number: 'asc' } })
  assert.deepEqual(await applyContentStructure(legacyContentPath, STRUCTURE_CONFIRMATION, db), { status: 'applied', question_count: 85, group_count: document.groups.length, passage_count: passages.size })
  const after = record(await db.question.findMany({ orderBy: { question_number: 'asc' }, include: { choices: { orderBy: { display_order: 'asc' } }, passage_references: { orderBy: { display_order: 'asc' } } } }))
  const savedPassages = record(await db.groupPassage.findMany())
  for (const [index, question] of after.entries()) {
    const prior = before[index]!
    assert.equal(question.id, prior.id)
    assert.equal(question.question_number, prior.question_number)
    assert.equal(isDeepStrictEqual(question.choices, prior.choices), true, 'conversion retains every choice')
    assert.deepEqual(question.created_at, prior.created_at)
    assert.deepEqual(question.updated_at, prior.updated_at)
    assert.equal(question.content_version, prior.content_version)
    const prefix = [...new Set(question.passage_references.map(reference => reference.passage_id))].flatMap(id => savedPassages.find(passage => passage.id === id)!.content_blocks as any[])
    assert.equal(materialDigest({ ...question, content_blocks: [...prefix, ...(question.content_blocks as any[])] } as any), materialDigest(prior))
  }
  assert.deepEqual(await db.answerHistory.findUnique({ where: { id: history.id } }), history)
  assert.deepEqual(await db.favorite.findUnique({ where: { id: favorite.id } }), favorite)
  assert.deepEqual(await db.examSet.findMany({ orderBy: { exam_number: 'asc' } }), parentBefore)
  const snapshot = await domainSnapshot(db)
  assert.deepEqual(await applyContentStructure(legacyContentPath, STRUCTURE_CONFIRMATION, db), { status: 'unchanged', question_count: 85, group_count: document.groups.length, passage_count: passages.size })
  assert.equal(await domainSnapshot(db), snapshot)
}))

test('mismatching legacy content and an already edited hierarchy are refused without overwriting any record', integration, () => legacyFixture(async (db, before) => {
  const original = before[0]!
  await db.question.update({ where: { id: original.id }, data: { content_blocks: [{ type: 'text', text: 'An intentionally different synthetic prompt' }] } })
  const mismatched = await domainSnapshot(db)
  await assert.rejects(applyContentStructure(legacyContentPath, STRUCTURE_CONFIRMATION, db), OperationError)
  assert.equal(await domainSnapshot(db), mismatched)
  assert.equal(await db.questionGroup.count(), 0)
  await db.question.update({ where: { id: original.id }, data: { content_blocks: original.content_blocks } })
  await applyContentStructure(legacyContentPath, STRUCTURE_CONFIRMATION, db)
  const group = await db.questionGroup.findFirstOrThrow()
  await db.questionGroup.update({ where: { id: group.id }, data: { title: 'Independently edited hierarchy title' } })
  const edited = await domainSnapshot(db)
  await assert.rejects(applyContentStructure(legacyContentPath, STRUCTURE_CONFIRMATION, db), OperationError)
  assert.equal(await domainSnapshot(db), edited)
}))
