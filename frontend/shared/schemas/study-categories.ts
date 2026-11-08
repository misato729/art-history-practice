import { z } from 'zod'

export const studySchemeSchema = z.enum(['exam_scope', 'study_outline'])
export const studyCategorySchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  scheme: studySchemeSchema,
  parent_code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).nullable(),
  number: z.number().int().positive(),
  sort_order: z.number().int().positive(),
  label: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().min(1).max(200).nullable().default(null),
  source_page: z.number().int().positive().nullable().default(null),
  reference_page: z.number().int().positive().nullable().default(null),
}).strict()

export const studyCategoryCatalogSchema = z.object({
  schema_version: z.literal(1), categories: z.array(studyCategorySchema).min(1).max(2000),
}).strict().superRefine(({ categories }, ctx) => {
  const byCode = new Map(categories.map(row => [row.code, row]))
  const codes = new Set<string>(), numbers = new Set<string>(), orders = new Set<string>()
  categories.forEach((row, index) => {
    const error = (message: string) => ctx.addIssue({ code: 'custom', path: ['categories', index], message })
    if (codes.has(row.code)) error('duplicate category code')
    codes.add(row.code)
    const group = `${row.scheme}/${row.parent_code ?? ''}`
    for (const [set, key] of [[numbers, `${group}/${row.number}`], [orders, `${group}/${row.sort_order}`]] as const) {
      if (set.has(key)) error('duplicate number or order within a parent')
      set.add(key)
    }
    if (row.parent_code !== null) {
      const parent = byCode.get(row.parent_code)
      if (!parent || parent.scheme !== row.scheme || parent.parent_code !== null || parent.code === row.code) error('parent must be a root in the same scheme')
      if (row.scheme === 'exam_scope') error('exam scope must be a root')
    }
  })
})

export type StudyCategory = z.infer<typeof studyCategorySchema>
export type StudyCategoryNode = StudyCategory & { children: StudyCategoryNode[] }
export const studyCategoryFilterSchema = z.object({
  study_category_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).min(1).max(2000).optional(),
  study_part_code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).optional(),
  study_section_code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).optional(),
  study_scope_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).min(1).max(100).optional(),
}).refine(value => !value.study_section_code || Boolean(value.study_part_code), { message: 'section requires a part' })

export function studyCategoryTree(rows: StudyCategory[]): Record<'exam_scope' | 'study_outline', StudyCategoryNode[]> {
  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))
  const roots = (scheme: StudyCategory['scheme']) => sorted.filter(row => row.scheme === scheme && row.parent_code === null)
    .map(row => ({ ...row, children: sorted.filter(child => child.parent_code === row.code).map(child => ({ ...child, children: [] })) }))
  return { exam_scope: roots('exam_scope'), study_outline: roots('study_outline') }
}

export const questionStudyClassificationsSchema = z.object({
  schema_version: z.literal(1),
  questions: z.array(z.object({
    exam_number: z.number().int().positive(), question_number: z.number().int().positive(),
    codes: z.array(studyCategorySchema.shape.code).min(2).max(50),
    material_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(10000),
}).strict().superRefine(({questions},ctx)=>{
  const seen=new Set<string>()
  for(const [i,q] of questions.entries()){
    const key=`${q.exam_number}/${q.question_number}`
    if(seen.has(key)||new Set(q.codes).size!==q.codes.length)ctx.addIssue({code:'custom',path:['questions',i],message:'duplicate question or category'})
    seen.add(key)
  }
})
