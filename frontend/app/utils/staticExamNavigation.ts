/** Number-only navigation. Never import question data, answers or an API client here. */
export type StaticExamDefinition = {
  exam_number: number
  title?: string
  comingSoon?: boolean
  question_numbers: readonly number[]
}

export type StaticNavigationAccess = {
  paymentsEnabled: boolean
  freeExamCount: number
  fullAccess: boolean
}

export type StaticExamNavigationEntry = {
  examNumber: number
  title: string
  locked: boolean
  comingSoon: boolean
  to: string
  questions: { number: number; to: string }[]
}

/** Configuration is the navigation source; the backend still authorizes every request. */
export function createStaticExamNavigation(
  catalog: readonly StaticExamDefinition[],
  access: StaticNavigationAccess,
): StaticExamNavigationEntry[] {
  return catalog.map(exam => {
    const numbers = [...exam.question_numbers]
    if (!Number.isSafeInteger(exam.exam_number) || exam.exam_number < 1
      || (!exam.comingSoon && !numbers.length) || (exam.comingSoon && numbers.length > 0) || numbers.some(number => !Number.isSafeInteger(number) || number < 1)
      || new Set(numbers).size !== numbers.length) {
      throw new TypeError('静的な模試一覧の模試番号・問番号を確認してください')
    }
    const locked = access.paymentsEnabled && !access.fullAccess && exam.exam_number > access.freeExamCount
    const target = (number: number) => exam.comingSoon ? `/mock-exams/${exam.exam_number}` : locked ? '/premium' : `/practice/${exam.exam_number}/${number}`
    return {
      examNumber: exam.exam_number,
      title: exam.title?.trim() || `模擬試験${exam.exam_number}`,
      locked,
      comingSoon: exam.comingSoon === true,
      to: target(numbers[0] ?? 1),
      questions: numbers.map(number => ({ number, to: target(number) })),
    }
  })
}

/** Match only a question route, not /practice/start or unrelated nested URLs. */
export function staticPracticePosition(path: string): { examNumber: number; questionNumber: number } | null {
  const match = /^\/practice\/([1-9]\d*)\/([1-9]\d*)\/?$/.exec(path)
  if (!match) return null
  const examNumber = Number(match[1])
  const questionNumber = Number(match[2])
  return Number.isSafeInteger(examNumber) && Number.isSafeInteger(questionNumber)
    ? { examNumber, questionNumber } : null
}
