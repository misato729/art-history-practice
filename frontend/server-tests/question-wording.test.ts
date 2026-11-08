import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {closeDatabase,isolatedTransaction} from '../server/core/db.ts'
import {saveQuestion,saveQuestionWording,materialDigest} from '../server/services/learning-writer.ts'
import {configuration} from '../server/core/config.ts'
import {choiceLabelsForQuestion} from '../shared/schemas/exam.ts'
process.env.APP_ENV='test'
if(process.env.TEST_DATABASE_URL)process.env.DATABASE_URL=process.env.TEST_DATABASE_URL
after(()=>closeDatabase())
test('reviewed wording preserves answer identities, grade versions, histories and favorites and rejects non-text or stale edits',{skip:!process.env.DATABASE_URL},async()=>{
 await isolatedTransaction(async db=>{
  await db.question.deleteMany()
  const category=configuration.categories.minor[0]!
  const q=await saveQuestion({exam_number:1,question_number:1,major_category_code:category.major_category_value,category_code:category.value,publication_status:'draft',source_text:'Synthetic source',content_blocks:[{type:'text',text:'Synthetic original wording'}],explanation_blocks:[{type:'text',text:'Synthetic explanation'}],choices:choiceLabelsForQuestion(configuration,1,1).map((choice_label,i)=>({choice_label,display_order:i+1,is_correct:i===0,content_blocks:[{type:'text',text:'Synthetic choice '+i}]}))},{db})
  const user=await db.user.create({data:{name:'Wording fixture',email:'wording-fixture@example.invalid',created_at:new Date(),updated_at:new Date()}})
  await db.answerHistory.create({data:{user_id:user.id,question_id:q.id,selected_choice_id:q.choices[0]!.id,question_version:q.content_version,is_correct:false,created_at:new Date(),updated_at:new Date()}})
  await db.favorite.create({data:{user_id:user.id,question_id:q.id,created_at:new Date(),updated_at:new Date()}})
  const histories=await db.answerHistory.findMany(),favorites=await db.favorite.findMany(),next={...q,content_blocks:[{type:'text' as const,text:'Synthetic revised wording'}]}
  await assert.rejects(saveQuestionWording(q.id,'0'.repeat(64),next,db))
  await assert.rejects(saveQuestionWording(q.id,materialDigest(q),{...next,source_text:'Changed source'},db))
  await assert.rejects(saveQuestionWording(q.id,materialDigest(q),{...next,choices:next.choices.map(c=>({...c,is_correct:!c.is_correct}))},db))
  const saved=await saveQuestionWording(q.id,materialDigest(q),next,db)
  assert.equal(saved.content_version,q.content_version);assert.deepEqual(saved.choices,q.choices)
  assert.deepEqual(await db.answerHistory.findMany(),histories);assert.deepEqual(await db.favorite.findMany(),favorites)
  const repeated=await saveQuestionWording(q.id,materialDigest(saved),saved,db)
  assert.equal(repeated.lock_version,saved.lock_version)
 })
})
