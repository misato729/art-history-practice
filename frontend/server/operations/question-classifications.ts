import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {questionStudyClassificationsSchema} from '../../shared/schemas/study-categories.ts'
import {query,record,transaction,type Database} from '../core/db.ts'
import {materialDigest,QUESTION_WRITE_LOCK} from '../services/learning-writer.ts'
import {importStudyCategories,STUDY_CATEGORY_CONFIRMATION} from './study-categories.ts'
import {OperationError} from './content.ts'
const path=(name:string)=>fileURLToPath(new URL(`../../../${name}`,import.meta.url))
export const CLASSIFICATION_CONFIRMATION='ASSIGN_STUDY_CLASSIFICATIONS'
export async function classificationFingerprint(db:Database){
 const result:Record<string,string>={}
 for(const table of ['questions','question_choices','question_groups','group_passages','question_passage_references','answer_histories','favorites']){
  const [row]=await query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) AS digest FROM ${table} t`,[],db)
  result[table]=row.digest
 }
 return result
}
export async function assignQuestionClassifications(document:unknown,db:Database){
 const input=questionStudyClassificationsSchema.parse(document)
 await query('SELECT pg_advisory_xact_lock($1)::text',[QUESTION_WRITE_LOCK],db)
 const categories=await db.studyCategory.findMany(),byCode=new Map(categories.map(c=>[c.code,c]))
 const questions=record(await db.question.findMany({include:{choices:{orderBy:{display_order:'asc'}}}}))
 if(questions.length!==input.questions.length)throw new OperationError('登録済み問題数と分類の対象数が異なります')
 const desired:{question_id:number,study_category_code:string}[]=[]
 for(const item of input.questions){
  const q=questions.find(q=>q.exam_number===item.exam_number&&q.question_number===item.question_number)
  if(!q||materialDigest(q as any)!==item.material_sha256)throw new OperationError(`分類対象が確認済み原稿と異なります：模試${item.exam_number}問${item.question_number}`)
  const rows=item.codes.map(code=>byCode.get(code))
  if(rows.some(r=>!r)||!rows.some(r=>r?.scheme==='exam_scope')||!rows.some(r=>r?.scheme==='study_outline')||rows.some(r=>r?.scheme==='study_outline'&&categories.some(c=>c.parent_code===r.code)))throw new OperationError('範囲と学習分野の両方を指定してください')
  for(const code of item.codes)desired.push({question_id:q.id,study_category_code:code})
 }
 const old=record(await db.questionStudyCategory.findMany()),key=(x:{question_id:number,study_category_code:string})=>`${x.question_id}/${x.study_category_code}`,wanted=new Set(desired.map(key))
 if(old.some(x=>!wanted.has(key(x))))throw new OperationError('既存の分類を自動で上書きできません')
 const before=await classificationFingerprint(db)
 const result=await db.questionStudyCategory.createMany({data:desired,skipDuplicates:true})
 const after=await classificationFingerprint(db)
 if(JSON.stringify(before)!==JSON.stringify(after))throw new OperationError('問題・履歴の保持確認に失敗しました')
 return {status:result.count?'assigned':'unchanged',questions:questions.length,associations:desired.length,created:result.count,preserved:before}
}
export async function installBundledClassifications(db:Database){
 await importStudyCategories(path('config/study-categories.json'),STUDY_CATEGORY_CONFIRMATION,db)
 return assignQuestionClassifications(JSON.parse(await readFile(path('content/question-study-classifications.json'),'utf8')),db)
}
export async function assignBundledClassifications(confirmation:string|undefined,db?:Database){
 if(confirmation!==CLASSIFICATION_CONFIRMATION)throw new OperationError('分野を割り当てる明示確認が必要です')
 return transaction(connection=>installBundledClassifications(connection),db,{timeout:180000})
}
