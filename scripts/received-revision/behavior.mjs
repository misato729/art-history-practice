import assert from 'node:assert/strict'
import {createDatabase,record} from '../../frontend/server/core/db.ts'
import {grantVerification} from '../../frontend/server/operations/accounts.ts'
import {answerQuestion,getHistory,listHistory} from '../../frontend/server/services/learning.ts'
import {classificationFingerprint} from '../../frontend/server/operations/question-classifications.ts'
const url=new URL(process.env.DATABASE_URL);assert.equal(process.env.APP_ENV,'test');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/art_received_test');const db=createDatabase(url.toString()),before=await classificationFingerprint(db);let rollback=false
try{await db.$transaction(async c=>{
 const user=record(await c.user.findUniqueOrThrow({where:{email:'received-fixture@example.invalid'}}))
 await grantVerification({email:user.email,expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Isolated received revision fixture',grantedBy:'fixture'},c)
 const old=await listHistory(user,{},c);assert.equal(old.data.length,3)
 const rows=record(await c.question.findMany({include:{choices:{orderBy:{display_order:'asc'}}},orderBy:[{exam_number:'asc'},{question_number:'asc'}]}))
 const q3=rows.find(q=>q.exam_number===3&&q.question_number===1),q4=rows.find(q=>q.exam_number===4&&q.question_number===72)
 assert.equal(old.data.find(h=>h.question.id===q3.id).is_outdated,true);assert.equal(old.data.find(h=>h.question.id===q4.id).is_outdated,false)
 const h=await c.answerHistory.findFirstOrThrow({where:{question_id:q3.id}});await assert.rejects(getHistory(Number(h.id),user,c),e=>e.status===409)
 await assert.rejects(answerQuestion(q3.id,q3.choices[0].id,null,c,q3.content_version),e=>e.status===401)
 let checked=0
 for(const q of rows.filter(q=>q.exam_number>=3))for(const choice of q.choices){const result=await answerQuestion(q.id,choice.id,user,c,q.content_version);assert.equal(result.data.is_correct,choice.is_correct);checked++}
 console.log(JSON.stringify({status:'passed',questions:510,choice_grades:checked,old_history_outdated:true,source_only_history_current:true,paid_anonymous:401}))
 rollback=true;throw Error('TEST_ROLLBACK')
 },{timeout:180000})}catch(e){if(!rollback||e.message!=='TEST_ROLLBACK')throw e}finally{await db.$disconnect()}
const finalDb=createDatabase(url.toString());try{assert.deepEqual(await classificationFingerprint(finalDb),before);console.log(JSON.stringify({learning_writes_rolled_back:true}))}finally{await finalDb.$disconnect()}
