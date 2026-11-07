import { z } from 'zod'

const nonblank = z.string().regex(/\S/, 'must contain non-whitespace text')
const categoryCode = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/)
const category = z.object({ value: categoryCode, label: nonblank }).passthrough()
const count = z.number().int().min(1).max(10000)
const choiceLabels = z.array(nonblank.max(10)).min(2).max(10)
const examSection = z.object({ title: nonblank, first: count, last: count, choice_labels: choiceLabels }).strict()
const examSet = z.object({ exam_number: count, title: nonblank, question_count: count,
  sections: z.array(examSection).min(1).optional(), }).strict()

/** The source of truth for runtime, CLI, TypeScript and generated editor hints. */
export const examConfigurationSchema = z.object({
  schema_version: z.literal(1),
  site: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    name: nonblank,
    short_name: nonblank,
    exam_name: nonblank,
    description: nonblank,
    tagline: nonblank,
    logo_path: z.string().regex(/^\/(?!\/)(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$))[A-Za-z0-9_./-]+$/, 'must be a local absolute asset path'),
    primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #RRGGBB'),
    contact_email: z.string().regex(/^(?:|[^\s@]+@[^\s@]+\.[^\s@]+)$/, 'must be empty or a valid email'),
    overview: z.array(z.object({ title: nonblank, body: nonblank }).passthrough()),
  }).passthrough(),
  exam: z.object({
    set_count: count,
    questions_per_exam: count,
    choice_labels: choiceLabels,
    sets: z.array(examSet).min(1).optional(),
    upcoming_sets: z.array(z.strictObject({ exam_number: count, title: nonblank })).optional(),
  }).passthrough(),
  categories: z.object({
    major: z.array(category).min(1),
    minor: z.array(category.extend({ major_category_value: categoryCode })).min(1),
  }).passthrough(),
  payments: z.object({
    enabled: z.boolean(),
    free_exam_count: z.number().int().min(0),
    amount: z.number().int().min(1),
    currency: z.string().regex(/^jpy$/),
  }).passthrough(),
}).passthrough().superRefine((config, ctx) => {
  const unique = (values: string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path, message: 'values must be unique' })
  }
  unique(config.exam.choice_labels, ['exam', 'choice_labels'])
  if (config.exam.sets) {
    const sets = config.exam.sets
    unique(sets.map(item => String(item.exam_number)), ['exam', 'sets'])
    if (sets.length !== config.exam.set_count || sets.some((item, index) => item.exam_number !== index + 1)) {
      ctx.addIssue({ code: 'custom', path: ['exam', 'sets'], message: 'must define every set in exam_number order' })
    }
    for (const [index, set] of sets.entries()) {
      if (!set.sections) continue
      let next = 1
      for (const [sectionIndex, section] of set.sections.entries()) {
        const path = ['exam', 'sets', index, 'sections', sectionIndex]
        unique(section.choice_labels, [...path, 'choice_labels'])
        if (section.first !== next || section.last < section.first || section.last > set.question_count) {
          ctx.addIssue({ code: 'custom', path, message: 'sections must cover questions consecutively without gaps or overlaps' })
        }
        next = section.last + 1
      }
      if (next !== set.question_count + 1) ctx.addIssue({ code: 'custom', path: ['exam', 'sets', index, 'sections'], message: 'must cover every question in the set' })
    }
  }
  const upcoming = config.exam.upcoming_sets ?? []
  unique(upcoming.map(item => String(item.exam_number)), ['exam', 'upcoming_sets'])
  if (upcoming.some((item, index) => item.exam_number !== config.exam.set_count + index + 1)) {
    ctx.addIssue({ code: 'custom', path: ['exam', 'upcoming_sets'], message: 'must continue after the configured sets without overlap or gaps' })
  }
  unique(config.categories.major.map(item => item.value), ['categories', 'major'])
  unique(config.categories.minor.map(item => item.value), ['categories', 'minor'])
  for (const [index, item] of config.categories.minor.entries()) {
    if (!config.categories.major.some(major => major.value === item.major_category_value)) {
      ctx.addIssue({ code: 'custom', path: ['categories', 'minor', index, 'major_category_value'], message: 'must reference an existing major category' })
    }
  }
  if (config.payments.free_exam_count > config.exam.set_count) {
    ctx.addIssue({ code: 'custom', path: ['payments', 'free_exam_count'], message: 'must not exceed set_count' })
  }
})

export type ExamConfiguration = z.infer<typeof examConfigurationSchema>
export type ExamSetDefinition = z.infer<typeof examSet>

/** All consumers resolve variable set lengths and choices through these helpers. */
export function getExamSet(config: ExamConfiguration, examNumber: number): ExamSetDefinition | undefined {
  if (!Number.isInteger(examNumber) || examNumber < 1 || examNumber > config.exam.set_count) return undefined
  return config.exam.sets?.find(set => set.exam_number === examNumber) ?? {
    exam_number: examNumber, title: `模擬試験 ${examNumber}`, question_count: config.exam.questions_per_exam,
  }
}
export const questionCountForExam = (config: ExamConfiguration, examNumber: number): number => getExamSet(config, examNumber)?.question_count ?? 0
export function choiceLabelsForQuestion(config: ExamConfiguration, examNumber: number, questionNumber: number): string[] {
  const section = getExamSet(config, examNumber)?.sections?.find(section => questionNumber >= section.first && questionNumber <= section.last)
  return section?.choice_labels ?? config.exam.choice_labels
}

export function parseExamConfig(input: unknown): ExamConfiguration {
  const result = examConfigurationSchema.safeParse(input)
  if (result.success) return structuredClone(result.data)
  // Only schema-controlled messages and field paths; never echo configuration values.
  throw new Error(`Invalid exam configuration: ${result.error.issues.map(issue => `${issue.path.join('.') || 'configuration'}: ${issue.message}`).join('; ')}`)
}

export function examConfigurationJsonSchema() {
  return { ...z.toJSONSchema(examConfigurationSchema, { target: 'draft-2020-12', io: 'input' }), title: 'Exam practice template configuration' }
}
