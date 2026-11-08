import { getDatabase, type Database, type Prisma } from '../core/db.ts'
import { fail } from '../core/errors.ts'
import { studyCategoryTree, studyCategoryFilterSchema, type StudyCategory } from '../../shared/schemas/study-categories.ts'

export async function listStudyCategories(db: Database = getDatabase()) {
  const rows = await db.studyCategory.findMany({ orderBy: [{ sort_order: 'asc' }, { code: 'asc' }] })
  return { data: studyCategoryTree(rows as StudyCategory[]) }
}

/** Validate requested taxonomy codes without ever silently broadening a filter. */
export async function validateStudyFilter(params: Record<string, unknown>, db: Database = getDatabase()) {
  const keys = ['study_category_codes', 'study_part_code', 'study_section_code', 'study_scope_codes'] as const
  if (!keys.some(key => params[key] !== undefined)) return false
  const input = Object.fromEntries(keys.filter(key => params[key] !== undefined).map(key => [key, params[key]]))
  if (typeof input.study_category_codes === 'string') input.study_category_codes = input.study_category_codes.split(',')
  if (typeof input.study_scope_codes === 'string') input.study_scope_codes = input.study_scope_codes.split(',')
  const parsed = studyCategoryFilterSchema.safeParse(input)
  if (!parsed.success) fail(400, 'bad_request', '分野の条件を確認してください')
  const filter = parsed.data
  const codes = [filter.study_part_code, filter.study_section_code, ...(filter.study_scope_codes ?? []), ...(filter.study_category_codes ?? [])].filter((code): code is string => Boolean(code))
  const rows = await db.studyCategory.findMany({ where: { code: { in: codes } } })
  const part = rows.find(row => row.code === filter.study_part_code)
  const section = rows.find(row => row.code === filter.study_section_code)
  if ((filter.study_part_code && (!part || part.scheme !== 'study_outline' || part.parent_code !== null)) ||
      (filter.study_section_code && (!section || section.scheme !== 'study_outline' || section.parent_code !== part?.code)) ||
      (filter.study_category_codes?.some(code => !rows.some(row => row.code === code && row.scheme === 'study_outline'))) ||
      (filter.study_scope_codes?.some(code => !rows.some(row => row.code === code && row.scheme === 'exam_scope' && row.parent_code === null)))) {
    fail(400, 'bad_request', '分野の組み合わせを確認してください')
  }
  return true
}


export async function studyQuestionWhere(params: Record<string, unknown>, db: Database): Promise<Prisma.QuestionWhereInput> {
  if (!await validateStudyFilter(params, db)) return {}
  const rows = await db.studyCategory.findMany()
  const list = (value: unknown): string[] => typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value as string[] : []
  const expand = (codes: string[]) => [...new Set(codes.flatMap(code => [code, ...rows.filter(row => row.parent_code === code).map(row => row.code)]))]
  const groups: string[][] = []
  if (params.study_category_codes !== undefined) groups.push(expand(list(params.study_category_codes)))
  if (params.study_part_code !== undefined) groups.push(expand([String(params.study_section_code ?? params.study_part_code)]))
  if (params.study_scope_codes !== undefined) groups.push(list(params.study_scope_codes))
  return { AND: groups.map(codes => ({ study_categories: { some: { study_category_code: { in: codes } } } })) }
}
export async function questionStudyCategories(questionId: number, db: Database) {
  const rows = await db.questionStudyCategory.findMany({ where: { question_id: questionId }, include: { category: { include: { parent: true } } }, orderBy: { study_category_code: 'asc' } })
  return rows.map(({category}) => ({code:category.code, scheme:category.scheme, label:category.label, parent_code:category.parent_code, parent_label:category.parent?.label ?? null}))
}
