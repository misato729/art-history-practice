import {publicSourceText} from '../../shared/sourceReferences.ts'
import { studyQuestionWhere, questionStudyCategories } from './study-categories.ts'
import { hasPaidAccess, type User } from '../core/auth.ts'
import { configuration, freeExamMax, paymentsEnabled } from '../core/config.ts'
import { getDatabase, Prisma, query, record, transaction, type Database } from '../core/db.ts'
import { fail } from '../core/errors.ts'
import { excerptFrom, integer, sanitizeQuestionInput } from './learning-validation.ts'
import { loadExamSet, loadQuestionGroup } from './learning-structure.ts'
import { deleteQuestion, loadQuestion, saveQuestion, type ChoiceRecord, type QuestionRecord } from './learning-writer.ts'

export { saveQuestion, deleteQuestion, validateCompleteExam } from './learning-writer.ts'
export { validateQuestionInput } from './learning-validation.ts'
export type { QuestionInput } from './learning-validation.ts'

const notFound = (): never => fail(404, 'not_found', '対象が見つかりません')
const iso = (value: Date | string) => new Date(value).toISOString()
const present = (value: unknown) => value !== undefined && value !== null && value !== ''
function requireUser(user: User | null): User {
  if (!user) return fail(401, 'unauthorized', 'ログインが必要です')
  return user
}
function checkAdmin(user: User | null): User {
  const current = requireUser(user)
  if (current.role !== 'admin') fail(403, 'forbidden', '管理者権限が必要です')
  return current
}
function integerParam(value: unknown, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = integer(value)
  if (parsed === undefined || parsed < minimum || parsed > maximum) return fail(400, 'bad_request', `${name}を正しく指定してください`)
  return parsed
}
function pagination(params: Record<string, unknown>) {
  return { page: integerParam(present(params.page) ? params.page : 1, 'page'),
    perPage: integerParam(present(params.per_page) ? params.per_page : 20, 'per_page', 1, 100) }
}
function meta(page: number, perPage: number, total: number, atLeastOne = false) {
  return { current_page: page, per_page: perPage, total_count: total,
    total_pages: Math.max(atLeastOne ? 1 : 0, Math.ceil(total / perPage)) }
}
const serializeChoice = (choice: ChoiceRecord) => ({ id: Number(choice.id), choice_label: choice.choice_label,
  content_blocks: choice.content_blocks, display_order: Number(choice.display_order) })

export async function authorizeExam(examNumber: number, user: User | null, db?: Database): Promise<void> {
  if (!paymentsEnabled || examNumber <= freeExamMax || await hasPaidAccess(user, db)) return
  if (user) fail(403, 'paid_membership_required', 'この模擬試験の利用にはプレミアム会員資格が必要です')
  fail(401, 'unauthorized', 'この模擬試験を利用するにはログインが必要です')
}

/** Parent visibility applies consistently to direct URLs, grading, catalog and saved learning records. */
export async function publicQuestionWhere(db: Database): Promise<Prisma.QuestionWhereInput> {
  const hidden = await db.examSet.findMany({ where: { publication_status: { not: 'published' } }, select: { exam_number: true } })
  return { publication_status: 'published', exam_number: { notIn: hidden.map(set => set.exam_number) },
    OR: [{ group_id: null }, { group: { is: { publication_status: 'published' } } }] }
}
async function assertVisible(question: QuestionRecord, db: Database) {
  if (!await db.question.findFirst({ where: { ...(await publicQuestionWhere(db)), id: question.id }, select: { id: true } })) return notFound()
}
async function publicHierarchy(question: QuestionRecord, db: Database) {
  if (question.group_id === null) return { group_question_number: null, group: null, shared_passages: [], passage_references: [], question_version: question.content_version }
  const group = await loadQuestionGroup(question.group_id, db)
  const required = new Set(question.passage_references.map(ref => ref.passage_id))
  return { group_question_number: question.group_question_number, group: { id: group.id, group_number: group.group_number,
    title: group.title, question_numbers: group.questions.filter(child => child.publication_status === 'published').map(child => child.question_number) },
    shared_passages: group.passages.filter(passage => required.has(passage.id)).map(passage => ({ id: passage.id, label: passage.label, display_order: passage.display_order, content_blocks: passage.content_blocks })),
    passage_references: question.passage_references, question_version: question.content_version }
}
async function serializePublicQuestion(question: QuestionRecord, user: User | null, db: Database) {
  const payload: Record<string, unknown> = { id: question.id, exam_number: question.exam_number,
    question_number: question.question_number, content_blocks: question.content_blocks,
    major_category_code: question.major_category_code, category_code: question.category_code,
    choices: question.choices.map(serializeChoice), ...(await publicHierarchy(question, db)), study_categories: await questionStudyCategories(question.id, db) }
  if (user) {
    const allowed = await hasPaidAccess(user, db)
    const favorite = allowed ? await db.favorite.findUnique({ where: { user_id_question_id: { user_id: user.id, question_id: question.id } }, select: { id: true } }) : null
    payload.is_favorite = allowed && favorite !== null
  }
  return payload
}

export async function getQuestion(id: number, user: User | null, db: Database = getDatabase()) {
  const question = await loadQuestion(id, db, { published: true })
  await assertVisible(question, db)
  await authorizeExam(question.exam_number, user, db)
  return { data: await serializePublicQuestion(question, user, db) }
}

export async function nextQuestion(params: Record<string, unknown>, user: User | null, db: Database = getDatabase()) {
  const where: Prisma.QuestionWhereInput = await publicQuestionWhere(db)
  if (present(params.exam_number)) {
    const exam = integerParam(params.exam_number, 'exam_number')
    await authorizeExam(exam, user, db)
    // Preserve the parent exclusion already present in the visibility predicate.
    where.AND = [{ exam_number: exam }]
  } else {
    if (present(params.after_question_number) || present(params.question_number)) fail(400, 'bad_request', 'exam_numberを指定してください')
    if (!await hasPaidAccess(user, db)) where.AND = [{ exam_number: { lte: freeExamMax } }]
  }
  const filter = await studyQuestionWhere(params, db)
  const filteredWhere: Prisma.QuestionWhereInput = { AND: [where, filter] }
  const rows = record(await db.question.findMany({ where: filteredWhere, include: { group: { select: { group_number: true } } } }))
  rows.sort((a, b) => a.exam_number - b.exam_number || (a.group?.group_number ?? 0) - (b.group?.group_number ?? 0) ||
    (a.group_question_number ?? a.question_number) - (b.group_question_number ?? b.question_number) || a.question_number - b.question_number)
  let candidates = rows
  if (present(params.question_number)) candidates = candidates.filter(question => question.question_number === integerParam(params.question_number, 'question_number'))
  else if (present(params.after_question_number)) {
    const after = integerParam(params.after_question_number, 'after_question_number', 0)
    const cursor = rows.findIndex(question => question.question_number === after)
    candidates = cursor >= 0 ? rows.slice(cursor + 1) : rows.filter(question => question.question_number > after)
  }
  const excluded = !present(params.exam_number) && present(params.exclude_question_id) ? integerParam(params.exclude_question_id, 'exclude_question_id') : null
  const question = candidates.find(question => question.id !== excluded) ?? (excluded ? candidates[0] : undefined)
  if (!question) return notFound()
  return getQuestion(question.id, user, db)
}

export async function answerQuestion(id: number, selectedChoiceId: unknown, user: User | null, db?: Database, expectedVersion?: unknown) {
  return transaction(async connection => {
    // The same row lock is held by edits/deletes, so grade and history agree.
    const question = await loadQuestion(id, connection, { published: true, lock: true })
    await assertVisible(question, connection)
    await authorizeExam(question.exam_number, user, connection)
    if ((expectedVersion !== undefined && integer(expectedVersion) !== question.content_version) || (question.group_id !== null && expectedVersion === undefined)) fail(409, 'content_conflict', '問題の内容が更新されました。再読込して回答してください')
    const choiceId = integer(selectedChoiceId)
    const selected = question.choices.find(choice => choice.id === choiceId)
    if (!selected) fail(422, 'validation_error', '選択肢を確認してください', { selected_choice_id: ['この問題の選択肢を指定してください'] })
    const correct = question.choices.find(choice => choice.is_correct)
    if (!correct) return notFound()
    const isCorrect = selected.id === correct.id
    const history = user ? record(await connection.answerHistory.create({ data: {
      user_id: user.id, question_id: question.id, selected_choice_id: selected.id, is_correct: isCorrect, question_version: question.content_version,
      created_at: new Date(), updated_at: new Date() }, select: { id: true } })) : null
    return { data: { question_id: question.id, selected_choice_id: selected.id, is_correct: isCorrect,
      correct_choice: serializeChoice(correct), explanation_blocks: question.explanation_blocks,
      source_text: publicSourceText(question.source_text), question_version: question.content_version, answer_history_id: history?.id ?? null } }
  }, db)
}

export async function listExams(user: User | null, db: Database = getDatabase(), params: Record<string, unknown> = {}) {
  const filter = await studyQuestionWhere(params, db)
  const published = record(await db.question.findMany({ where: { AND: [await publicQuestionWhere(db), filter] },
    include: { group: { select: { group_number: true } }, study_categories: { include: { category: { select: { parent_code: true } } } } } }))
  published.sort((a, b) => a.exam_number - b.exam_number || (a.group?.group_number ?? 0) - (b.group?.group_number ?? 0) ||
    (a.group_question_number ?? a.question_number) - (b.group_question_number ?? b.question_number) || a.question_number - b.question_number)
  const fullAccess = await hasPaidAccess(user, db)
  const data = []
  for (const exam of [...new Set(published.map(question => question.exam_number))]) {
    const questions = published.filter(question => question.exam_number === exam)
    const set = await loadExamSet(exam, db)
    data.push({ exam_number: exam, title: set.title, question_numbers: questions.map(question => question.question_number),
      question_count: questions.length, published_question_count: questions.length,
      question_study_codes: Object.fromEntries(questions.map(q=>[q.question_number,[...new Set(q.study_categories.flatMap(c=>[c.study_category_code,...(c.category.parent_code?[c.category.parent_code]:[])]))]])),
      groups: set.groups.filter(group => group.publication_status === 'published' && questions.some(question => question.group_id === group.id)).map(group => ({ id: group.id, group_number: group.group_number, title: group.title, question_numbers: questions.filter(question => question.group_id === group.id).map(question => question.question_number) })),
      access: !paymentsEnabled || exam <= freeExamMax || fullAccess ? 'available' : 'paid_membership_required' })
  }
  return { data }
}
export async function listPublicGroups(exam: number, user: User | null, db: Database = getDatabase()) {
  await authorizeExam(exam, user, db)
  const set = (await listExams(user, db)).data.find(set => set.exam_number === exam)
  if (!set) return notFound()
  return { data: set.groups }
}

type HistoryRow = { id: number, is_correct: boolean, question_version: number, answered_at: Date | string,
  question: Omit<QuestionRecord, 'choices'>, selected_choice: ChoiceRecord }
function serializeHistory(row: HistoryRow, fullAccess: boolean) {
  const question = row.question
  const base = { id: Number(row.id), question: { id: Number(question.id), exam_number: Number(question.exam_number), question_number: Number(question.question_number), group_id: question.group_id, group_question_number: question.group_question_number }, answered_at: iso(row.answered_at), question_version: row.question_version, is_outdated: row.question_version !== question.content_version }
  if (question.exam_number > freeExamMax && !fullAccess) return { ...base, locked: true }
  if (base.is_outdated) return { ...base, locked: false }
  return { ...base, locked: false, question: { ...base.question, body_excerpt: excerptFrom(question.content_blocks),
    major_category_code: question.major_category_code, category_code: question.category_code },
  selected_choice: { id: Number(row.selected_choice.id), choice_label: row.selected_choice.choice_label, body_excerpt: excerptFrom(row.selected_choice.content_blocks) }, is_correct: row.is_correct }
}

export async function listHistory(user: User | null, params: Record<string, unknown>, db: Database = getDatabase()) {
  const current = requireUser(user)
  const { page, perPage } = pagination(params)
  const where = { user_id: current.id }
  const count = await db.answerHistory.count({ where })
  const rows = record(await db.answerHistory.findMany({ where, include: { question: true, selected_choice: true },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: perPage, skip: (page - 1) * perPage }))
  const fullAccess = await hasPaidAccess(current, db)
  const visibleIds = new Set((await db.question.findMany({ where: await publicQuestionWhere(db), select: { id: true } })).map(question => Number(question.id)))
  return { data: rows.map(row => visibleIds.has(Number(row.question_id)) ? serializeHistory({ ...row, answered_at: row.created_at } as unknown as HistoryRow, fullAccess) : { id: row.id, question: { id: row.question_id, exam_number: row.question.exam_number, question_number: row.question.question_number }, answered_at: iso(row.created_at), locked: true, question_version: row.question_version, is_outdated: row.question_version !== row.question.content_version }), meta: meta(page, perPage, count) }
}

export async function getHistory(id: number, user: User | null, db: Database = getDatabase()) {
  const current = requireUser(user)
  const found = await db.answerHistory.findFirst({ where: { user_id: current.id, id }, include: { question: true, selected_choice: true } })
  if (!found) return notFound()
  const row = { ...record(found), answered_at: found.created_at } as unknown as HistoryRow
  await assertVisible(await loadQuestion(Number(row.question.id), db), db)
  await authorizeExam(Number(row.question.exam_number), current, db)
  if (row.question_version !== row.question.content_version) fail(409, 'content_conflict', '問題の内容が更新されています。この解答履歴の解説は表示できません')
  const correct = await db.questionChoice.findFirst({ where: { question_id: row.question.id, is_correct: true } })
  if (!correct) return notFound()
  return { data: { ...serializeHistory(row, await hasPaidAccess(current, db)), correct_choice: serializeChoice(record(correct) as unknown as ChoiceRecord),
    explanation_blocks: row.question.explanation_blocks, source_text: publicSourceText(row.question.source_text) } }
}

type FavoriteRow = { id: number, created_at: Date | string, question: Omit<QuestionRecord, 'choices'> }
function serializeFavorite(row: FavoriteRow, fullAccess: boolean) {
  const base = { id: Number(row.id), question: { id: Number(row.question.id), exam_number: Number(row.question.exam_number), question_number: Number(row.question.question_number), group_id: row.question.group_id, group_question_number: row.question.group_question_number }, created_at: iso(row.created_at) }
  if (row.question.exam_number > freeExamMax && !fullAccess) return { ...base, locked: true }
  return { ...base, locked: false, question: { ...base.question, body_excerpt: excerptFrom(row.question.content_blocks), major_category_code: row.question.major_category_code, category_code: row.question.category_code } }
}
async function authorizeFavorites(user: User | null, db: Database): Promise<User> {
  const current = requireUser(user)
  if (!await hasPaidAccess(current, db)) fail(403, 'paid_membership_required', 'お気に入りの利用にはプレミアム会員資格が必要です')
  return current
}

export async function listFavorites(user: User | null, params: Record<string, unknown>, db: Database = getDatabase()) {
  const current = await authorizeFavorites(user, db)
  const { page, perPage } = pagination(params)
  const where = { user_id: current.id, question: { is: await publicQuestionWhere(db) } }
  const count = await db.favorite.count({ where })
  const rows = record(await db.favorite.findMany({ where, include: { question: true },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: perPage, skip: (page - 1) * perPage }))
  return { data: rows.map(row => serializeFavorite(row as unknown as FavoriteRow, true)), meta: meta(page, perPage, count) }
}

export async function putFavorite(questionId: number, user: User | null, db?: Database) {
  return transaction(async connection => {
    const current = await authorizeFavorites(user, connection)
    const question = await loadQuestion(questionId, connection, { published: true, lock: true })
    await assertVisible(question, connection)
    await authorizeExam(question.exam_number, current, connection)
    const inserted = await connection.favorite.createMany({ data: [{ user_id: current.id, question_id: questionId,
      created_at: new Date(), updated_at: new Date() }], skipDuplicates: true })
    const favorite = record(await connection.favorite.findUniqueOrThrow({ where: { user_id_question_id: { user_id: current.id, question_id: questionId } }, select: { id: true, created_at: true } }))
    return { created: inserted.count > 0, data: serializeFavorite({ ...favorite, question }, true) }
  }, db)
}

export async function removeFavorite(questionId: number, user: User | null, db?: Database): Promise<void> {
  await transaction(async connection => {
    const current = await authorizeFavorites(user, connection)
    await loadQuestion(questionId, connection, { published: true, lock: true })
    await connection.favorite.deleteMany({ where: { user_id: current.id, question_id: questionId } })
  }, db)
}

function serializeAdmin(question: QuestionRecord) {
  return { ...question, choices: question.choices.map(choice => ({ ...serializeChoice(choice), is_correct: choice.is_correct })),
    created_at: iso(question.created_at), updated_at: iso(question.updated_at) }
}

export async function listAdminQuestions(user: User | null, params: Record<string, unknown>, db: Database = getDatabase()) {
  checkAdmin(user)
  const where: Prisma.QuestionWhereInput = {}
  for (const key of ['exam_number', 'major_category_code', 'category_code', 'publication_status'] as const) {
    if (!present(params[key])) continue
    if (typeof params[key] !== 'string' && typeof params[key] !== 'number') fail(400, 'bad_request', `${key}を正しく指定してください`)
    if (key === 'exam_number' && integer(params[key]) === undefined) fail(400, 'bad_request', `${key}を正しく指定してください`)
    if (key === 'exam_number') where.exam_number = integer(params[key])!
    else where[key] = String(params[key])
  }
  if (present(params.keyword)) {
    if (typeof params.keyword !== 'string') fail(400, 'bad_request', 'keywordを正しく指定してください')
    // Prisma's JSON filters cannot search the serialized root array. Keep this
    // PostgreSQL-specific predicate parameterized, then paginate through Prisma.
    const matches = await query<{ id: number }>('SELECT id FROM questions WHERE content_blocks::text ILIKE $1',
      [`%${params.keyword.trim().replace(/[\\%_]/g, '\\$&')}%`], db)
    where.id = { in: matches.map(question => question.id) }
  }
  const total = await db.question.count({ where })
  const requestedPage = integer(params.page)
  const requestedPerPage = integer(params.per_page)
  const perPage = Math.min(requestedPerPage && requestedPerPage > 0 ? requestedPerPage : 20, 100)
  const page = Math.min(requestedPage && requestedPage > 0 ? requestedPage : 1, Math.max(1, Math.ceil(total / perPage)))
  const rows = record(await db.question.findMany({ where, orderBy: [{ exam_number: 'asc' }, { question_number: 'asc' }, { id: 'asc' }],
    take: perPage, skip: (page - 1) * perPage })) as unknown as Omit<QuestionRecord, 'choices'>[]
  return { data: rows.map(question => ({ id: Number(question.id), exam_number: Number(question.exam_number), question_number: Number(question.question_number),
    summary: excerptFrom(question.content_blocks) || '表・プログラムを含む問題',
    major_category_code: question.major_category_code, category_code: question.category_code, publication_status: question.publication_status, group_id: question.group_id, group_question_number: question.group_question_number, lock_version: question.lock_version, updated_at: iso(question.updated_at) })),
  meta: meta(page, perPage, total, true) }
}

export async function getAdminQuestion(id: number, user: User | null) {
  checkAdmin(user)
  return { data: serializeAdmin(await loadQuestion(id, getDatabase())) }
}

export async function writeAdminQuestion(value: unknown, user: User | null, id?: number) {
  checkAdmin(user)
  const input = sanitizeQuestionInput(value)
  return { data: serializeAdmin(await saveQuestion(input, { id, requireCompleteExam: true })) }
}

export async function deleteAdminQuestion(id: number, user: User | null) {
  checkAdmin(user)
  await deleteQuestion(id)
}
