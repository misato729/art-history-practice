import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {closeDatabase,isolatedTransaction,record} from '../server/core/db.ts'
import {saveQuestion,saveQuestionRevision,materialDigest} from '../server/services/learning-writer.ts'
import {answerQuestion,getHistory,listHistory} from '../server/services/learning.ts'
import {listIncorrectReviewQuestions} from '../server/services/incorrect-review.ts'
import {configuration} from '../server/core/config.ts'
import type {User} from '../server/core/auth.ts'
import {choiceLabelsForQuestion} from '../shared/schemas/exam.ts'
process.env.APP_ENV='test'
if(process.env.TEST_DATABASE_URL)process.env.DATABASE_URL=process.env.TEST_DATABASE_URL
after(()=>closeDatabase())
test('substantive revisions keep identities and old learning records, mark old grades outdated, and grade the new version without source metadata',{skip:!process.env.DATABASE_URL},async()=>{
 await isolatedTransaction(async db=>{
  await db.question.deleteMany()
  const category=configuration.categories.minor[0]!
  const q=await saveQuestion({exam_number:1,question_number:1,major_category_code:category.major_category_value,category_code:category.value,publication_status:'published',source_text:'『Synthetic book』p.4（1.pdf：PDF 9ページ）',content_blocks:[{type:'text',text:'Synthetic original question'}],explanation_blocks:[{type:'text',text:'Synthetic explanation'}],choices:choiceLabelsForQuestion(configuration,1,1).map((choice_label,i)=>({choice_label,display_order:i+1,is_correct:i===0,content_blocks:[{type:'text',text:'Synthetic choice '+i}]}))},{db})
  const user=record(await db.user.create({data:{name:'Revision fixture',email:'revision-fixture@example.invalid',created_at:new Date(),updated_at:new Date()}})) as unknown as User
  const oldAnswer=await answerQuestion(q.id,q.choices[1]!.id,user,db,q.content_version)
  assert.equal(oldAnswer.data.source_text,'『Synthetic book』p.4')
  await db.favorite.create({data:{user_id:user.id,question_id:q.id,created_at:new Date(),updated_at:new Date()}})
  const histories=await db.answerHistory.findMany(),favorites=await db.favorite.findMany()
  assert.equal((await listIncorrectReviewQuestions(user,db)).data.length,1)
  const next={...q,source_text:q.source_text+'\nSynthetic museum | https://example.invalid/collection',content_blocks:[{type:'text' as const,text:'Synthetic revised question'}],choices:q.choices.map(c=>({...c,content_blocks:[{type:'text' as const,text:'Revised option '+c.display_order}]}))}
  await assert.rejects(saveQuestionRevision(q.id,'0'.repeat(64),next,db))
  await assert.rejects(saveQuestionRevision(q.id,materialDigest(q),{...next,source_text:'Changed source'},db))
  const saved=await saveQuestionRevision(q.id,materialDigest(q),next,db)
  assert.equal(saved.content_version,q.content_version+1)
  assert.deepEqual(saved.choices.map(c=>[c.id,c.is_correct,c.display_order]),q.choices.map(c=>[c.id,c.is_correct,c.display_order]))
  assert.deepEqual(await db.answerHistory.findMany(),histories);assert.deepEqual(await db.favorite.findMany(),favorites)
  assert.equal((await listHistory(user,{},db)).data[0]!.is_outdated,true)
  await assert.rejects(getHistory(oldAnswer.data.answer_history_id!,user,db),e=>(e as any).status===409)
  assert.equal((await listIncorrectReviewQuestions(user,db)).data.length,0)
  await assert.rejects(answerQuestion(q.id,saved.choices[0]!.id,user,db,q.content_version),e=>(e as any).status===409)
  const repeated=await saveQuestionRevision(q.id,materialDigest(saved),saved,db)
  assert.equal(repeated.content_version,saved.content_version);assert.equal(repeated.lock_version,saved.lock_version)
  const answer=await answerQuestion(q.id,saved.choices[0]!.id,user,db,saved.content_version)
  assert.equal(answer.data.is_correct,true);assert.equal(answer.data.source_text,'『Synthetic book』p.4\nSynthetic museum | https://example.invalid/collection')
  assert.equal((await getHistory(answer.data.answer_history_id!,user,db)).data.source_text,'『Synthetic book』p.4\nSynthetic museum | https://example.invalid/collection')
 })
})
