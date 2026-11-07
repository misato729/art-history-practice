import { STATIC_EXAM_GROUPS } from './staticExamGroups.ts'
import { EXAM_CONFIG, type ExamConfiguration } from './examConfig.ts'
import { getExamSet, questionCountForExam } from '../../shared/schemas/exam.ts'

export type ExamCatalogGroup = { id: number; group_number: number; title: string; question_numbers: number[] }

export type ExamCatalogEntry = {
  exam_number: number
  title?: string
  comingSoon?: boolean
  access?: 'available' | 'paid_membership_required'
  groups?: ExamCatalogGroup[]
  question_numbers: readonly number[]
}

export const FREE_EXAM_MAX = EXAM_CONFIG.payments.enabled ? EXAM_CONFIG.payments.free_exam_count : EXAM_CONFIG.exam.set_count
export const EXAM_SET_COUNT = EXAM_CONFIG.exam.set_count
export const QUESTIONS_PER_EXAM = Math.max(...Array.from({ length: EXAM_SET_COUNT }, (_, index) => questionCountForExam(EXAM_CONFIG, index + 1)))

// Catalog navigation comes from the shared configuration. Publication and access are checked by the API.
export const createExamCatalog = (config: ExamConfiguration = EXAM_CONFIG): readonly ExamCatalogEntry[] => Object.freeze(
  Array.from({ length: config.exam.set_count }, (_, index) => Object.freeze({
    exam_number: index + 1,
    title: getExamSet(config, index + 1)!.title,
    question_numbers: Object.freeze(Array.from({ length: questionCountForExam(config, index + 1) }, (_, questionIndex) => questionIndex + 1)),
  })),
)
export const EXAM_CATALOG = createExamCatalog()
// Planned sets are navigation only; they are never included in practice sequences or API publication.
export const UPCOMING_EXAM_CATALOG: readonly ExamCatalogEntry[] = Object.freeze((EXAM_CONFIG.exam.upcoming_sets ?? []).map(exam => Object.freeze({ ...exam, comingSoon: true, question_numbers: Object.freeze([] as number[]) })))
export const STATIC_EXAM_CATALOG: readonly ExamCatalogEntry[] = Object.freeze([...EXAM_CATALOG, ...UPCOMING_EXAM_CATALOG])
export const comingSoonExamPath = (examNumber: number) => `/mock-exams/${examNumber}`
export const FREE_EXAM_CATALOG = EXAM_CATALOG.filter(exam => exam.exam_number <= FREE_EXAM_MAX)
export const examTitle = (examNumber: number): string => getExamSet(EXAM_CONFIG, examNumber)?.title ?? `試験セット ${examNumber}`

export const questionNumbersForExams = (
  examNumbers: readonly number[],
  catalog: readonly ExamCatalogEntry[] = EXAM_CATALOG,
): number[] => [...new Set(catalog.filter(exam => examNumbers.includes(exam.exam_number)).flatMap(exam => [...exam.question_numbers]))].sort((left, right) => left - right)

export const catalogExamLabel = (examNumber: number) => `模擬試験${examNumber}`
export const catalogGroupLabel = (group: Pick<ExamCatalogGroup, 'group_number' | 'title'>) => {
  const title = group.title.trim()
  return `大問${group.group_number}${title ? ` ${title}` : ''}`
}
export const catalogExamStartNumber = (exam: ExamCatalogEntry) => exam.question_numbers.find(number => Number.isSafeInteger(number) && number > 0)

/** API groups use published positions; static groups use verified fixed entry positions. */
export const catalogGroupLinks = (exam: ExamCatalogEntry) => {
  const published = new Set(exam.question_numbers)
  const isStatic = 'isStatic' in exam && exam.isStatic === true
  return [...(exam.groups ?? [])].sort((left, right) => left.group_number - right.group_number).flatMap(group => {
    const questionNumber = group.question_numbers.find(number => Number.isSafeInteger(number) && number > 0 && (isStatic || published.has(number)))
    return questionNumber === undefined ? [] : [{ group, questionNumber, to: isStatic ? (exam.access === 'paid_membership_required' ? '/premium' : `/practice/start?exams=${exam.exam_number}&group=${group.group_number}`) : `/practice/${exam.exam_number}/${questionNumber}` }]
  })
}

export const isCatalogGroupActive = (exam: ExamCatalogEntry, group: ExamCatalogGroup, currentExamNumber: number, currentQuestionNumber: number) => (
  exam.exam_number === currentExamNumber && exam.question_numbers.includes(currentQuestionNumber) && group.question_numbers.includes(currentQuestionNumber)
)


export type SidebarExamCatalogEntry = ExamCatalogEntry & { isStatic: boolean }

/** Static rows use fixed navigation metadata without asserting counts; API rows keep their real positions. */
export const createSidebarExamCatalog = (
  catalog: readonly ExamCatalogEntry[] | null,
  usePublished: boolean,
  fullAccess: boolean,
  config: ExamConfiguration = EXAM_CONFIG,
): SidebarExamCatalogEntry[] => {
  const freeMax = config.payments.enabled ? config.payments.free_exam_count : config.exam.set_count
  const published = new Map((catalog ?? []).map(exam => [exam.exam_number, exam]))
  return Array.from({ length: config.exam.set_count }, (_, index) => index + 1).flatMap<SidebarExamCatalogEntry>(examNumber => {
    const exam = published.get(examNumber)
    const locked = (!fullAccess && examNumber > freeMax)
      || (usePublished && exam?.access === 'paid_membership_required')
    if (!usePublished || locked) return [{
      exam_number: examNumber, question_numbers: [], isStatic: true,
      groups: STATIC_EXAM_GROUPS[examNumber]?.map(group => ({ ...group, question_numbers: [...group.question_numbers] })) ?? [],
      access: locked ? 'paid_membership_required' as const : 'available' as const,
    }]
    return exam && catalogExamStartNumber(exam) !== undefined ? [{ ...exam, isStatic: false }] : []
  })
}
