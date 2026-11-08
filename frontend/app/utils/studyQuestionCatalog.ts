import type { ExamCatalogEntry } from './examCatalog.ts'
/** Metadata-only preview. The API validates taxonomy and publication again before returning a question. */
export function filterStudyQuestionCatalog(catalog: readonly ExamCatalogEntry[], params: Record<string, unknown>): ExamCatalogEntry[] {
 const list=(value:unknown):string[]=>typeof value==='string'?value.split(','):Array.isArray(value)?value as string[]:[]
 const groups:string[][]=[]
 if(params.study_category_codes!==undefined)groups.push(list(params.study_category_codes))
 if(params.study_part_code!==undefined)groups.push([String(params.study_section_code??params.study_part_code)])
 if(params.study_scope_codes!==undefined)groups.push(list(params.study_scope_codes))
 if(!groups.length)return [...catalog]
 return catalog.map(exam=>({...exam,question_numbers:exam.question_numbers.filter(n=>groups.every(group=>group.some(code=>exam.question_study_codes?.[n]?.includes(code))))}))
}
