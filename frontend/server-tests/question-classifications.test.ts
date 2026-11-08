import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import {closeDatabase,isolatedTransaction} from '../server/core/db.ts'
import {saveQuestion,materialDigest} from '../server/services/learning-writer.ts'
import {assignQuestionClassifications,classificationFingerprint} from '../server/operations/question-classifications.ts'
import {configuration} from '../server/core/config.ts'
import {choiceLabelsForQuestion} from '../shared/schemas/exam.ts'
process.env.APP_ENV='test'
if(process.env.TEST_DATABASE_URL)process.env.DATABASE_URL=process.env.TEST_DATABASE_URL
const integration={skip:!process.env.DATABASE_URL}
after(()=>closeDatabase())
test('classification assignment is atomic and idempotent, preserves learning records and refuses unknown material or existing labels',integration,async()=>{
 await isolatedTransaction(async db=>{
  await db.question.deleteMany();await db.studyCategory.deleteMany()
  await db.studyCategory.createMany({data:[{code:'test_scope',scheme:'exam_scope',parent_code:null,number:1,sort_order:1,label:'Synthetic scope'},{code:'test_part',scheme:'study_outline',parent_code:null,number:1,sort_order:1,label:'Synthetic part'}]})
  await db.studyCategory.createMany({data:[{code:'test_leaf',scheme:'study_outline',parent_code:'test_part',number:1,sort_order:1,label:'Synthetic leaf'},{code:'test_other',scheme:'study_outline',parent_code:'test_part',number:2,sort_order:2,label:'Synthetic other'}]})
  const category=configuration.categories.minor[0]!,questions=[]
  for(const n of [1,2])questions.push(await saveQuestion({exam_number:1,question_number:n,major_category_code:category.major_category_value,category_code:category.value,publication_status:'draft',source_text:'',content_blocks:[{type:'text',text:'Synthetic classification question '+n}],explanation_blocks:[{type:'text',text:'Synthetic explanation'}],choices:choiceLabelsForQuestion(configuration,1,n).map((choice_label,i)=>({choice_label,display_order:i+1,is_correct:i===0,content_blocks:[{type:'text',text:'Synthetic choice '+i}]}))},{db}))
  const user=await db.user.create({data:{name:'Synthetic classifier',email:'classifier-regression@example.invalid',created_at:new Date(),updated_at:new Date()}}),q=questions[0]!
  await db.answerHistory.create({data:{user_id:user.id,question_id:q.id,selected_choice_id:q.choices[0]!.id,question_version:q.content_version,is_correct:true,created_at:new Date(),updated_at:new Date()}})
  await db.favorite.create({data:{user_id:user.id,question_id:q.id,created_at:new Date(),updated_at:new Date()}})
  const before=await classificationFingerprint(db),document={schema_version:1,questions:questions.map(q=>({exam_number:q.exam_number,question_number:q.question_number,codes:['test_scope','test_leaf'],material_sha256:materialDigest(q)}))}
  const corrupt=structuredClone(document);corrupt.questions[1]!.material_sha256='0'.repeat(64);await assert.rejects(assignQuestionClassifications(corrupt,db));assert.equal(await db.questionStudyCategory.count(),0)
  assert.equal((await assignQuestionClassifications(document,db)).created,4);assert.equal((await assignQuestionClassifications(document,db)).created,0)
  assert.deepEqual(await classificationFingerprint(db),before)
  const changed=structuredClone(document);changed.questions[0]!.codes=['test_scope','test_other'];await assert.rejects(assignQuestionClassifications(changed,db));assert.equal(await db.questionStudyCategory.count(),4)
  const parent=structuredClone(document);parent.questions[0]!.codes=['test_scope','test_part'];await assert.rejects(assignQuestionClassifications(parent,db))
 })
})
