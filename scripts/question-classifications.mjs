import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseArgs,parseEnv} from 'node:util'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {questionStudyClassificationsSchema,studyCategoryCatalogSchema} from '../frontend/shared/schemas/study-categories.ts'
import {materialDigest} from '../frontend/server/services/learning-writer.ts'
import {classificationTarget} from '../frontend/server/operations/classification-target.ts'
import {createDatabase,record} from '../frontend/server/core/db.ts'
import {installBundledClassifications,classificationFingerprint} from '../frontend/server/operations/question-classifications.ts'
const root=resolve(new URL('../',import.meta.url).pathname),read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8')),sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const {values:v,positionals:[mode='check']}=parseArgs({options:{env:{type:'string'},confirm:{type:'string'},backup:{type:'string'}},allowPositionals:true})
const manifest=questionStudyClassificationsSchema.parse(read('content/question-study-classifications.json')),catalog=studyCategoryCatalogSchema.parse(read('config/study-categories.json')),content=read('content/questions.json')
assert.equal(manifest.questions.length,content.questions.length)
for(const q of content.questions){const row=manifest.questions.find(r=>r.exam_number===q.exam_number&&r.question_number===q.question_number);assert.ok(row);assert.equal(row.material_sha256,materialDigest(q));const cats=row.codes.map(code=>catalog.categories.find(c=>c.code===code));assert.ok(cats.every(Boolean));assert.ok(cats.some(c=>c.scheme==='exam_scope'));assert.ok(cats.some(c=>c.scheme==='study_outline'))}
if(mode==='check'){console.log(JSON.stringify({status:'passed',questions:manifest.questions.length,associations:manifest.questions.reduce((n,q)=>n+q.codes.length,0),material_unchanged:true}));process.exit(0)}
assert.ok(['plan','dry-run','apply','verify','restore-test'].includes(mode));assert.ok(v.env)
const env=parseEnv(readFileSync(resolve(v.env),'utf8')),target=classificationTarget(env.DATABASE_URL,mode==='restore-test');process.env.DATABASE_URL=target.connectionString;const db=createDatabase(target.connectionString),databaseKey=sha(target.identity)
const out=resolve(root,'local-only/backups/question-classifications',new Date().toISOString().replace(/[:.]/g,'-')),write=(name,x)=>{mkdirSync(out,{recursive:true,mode:0o700});writeFileSync(resolve(out,name),JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600})}
const pairs=async connection=>record(await connection.questionStudyCategory.findMany({orderBy:[{question_id:'asc'},{study_category_code:'asc'}]}))
let rolledBack=false
try{await db.$transaction(async connection=>{
 if(mode==='plan'){
  await connection.$executeRawUnsafe('SET TRANSACTION READ ONLY')
  const questions=record(await connection.question.findMany({include:{choices:{orderBy:{display_order:'asc'}}}}));assert.equal(questions.length,manifest.questions.length)
  for(const item of manifest.questions){const q=questions.find(q=>q.exam_number===item.exam_number&&q.question_number===item.question_number);assert.ok(q);assert.equal(materialDigest(q),item.material_sha256)}
  const before=await classificationFingerprint(connection),history_count=await connection.answerHistory.count(),favorite_count=await connection.favorite.count()
  write('preflight.json',{database_key:databaseKey,preserved:before,question_count:questions.length,history_count,favorite_count,planned_associations:manifest.questions.reduce((n,q)=>n+q.codes.length,0)})
  console.log(JSON.stringify({status:'planned',questions:questions.length,history_count,favorite_count,backup_directory:out,material_unchanged:true}));return
 }
 if(mode==='verify'){
  await connection.$executeRawUnsafe('SET TRANSACTION READ ONLY')
  const questions=record(await connection.question.findMany({include:{choices:{orderBy:{display_order:'asc'}}}}));assert.equal(questions.length,680)
  const expected=[]
  for(const row of manifest.questions){const q=questions.find(q=>q.exam_number===row.exam_number&&q.question_number===row.question_number);assert.ok(q);assert.equal(materialDigest(q),row.material_sha256);for(const code of row.codes)expected.push(`${q.id}/${code}`)}
  const actual=(await pairs(connection)).map(p=>`${p.question_id}/${p.study_category_code}`);assert.deepEqual(actual.sort(),expected.sort())
  assert.equal(await connection.question.count({where:{study_categories:{none:{}}}}),0)
  const byCode=(a,b)=>a.code.localeCompare(b.code);assert.deepEqual((await connection.studyCategory.findMany()).sort(byCode),[...catalog.categories].sort(byCode))
  console.log(JSON.stringify({status:'verified',questions:680,unassigned:0,associations:actual.length,material_unchanged:true}));return
 }
 if(mode==='restore-test'){
  assert.equal(v.confirm,'RESTORE_CLASSIFICATIONS_TEST');const backup=JSON.parse(readFileSync(v.backup,'utf8'));assert.equal(backup.database_key,databaseKey);assert.equal(backup.before_sha256,sha(backup.before));assert.equal(sha(await pairs(connection)),backup.after_pairs_sha256)
  const before=await classificationFingerprint(connection),old=new Set(backup.before.map(p=>`${p.question_id}/${p.study_category_code}`)),remove=(await pairs(connection)).filter(p=>!old.has(`${p.question_id}/${p.study_category_code}`));await connection.questionStudyCategory.deleteMany({where:{OR:remove.map(p=>({question_id:p.question_id,study_category_code:p.study_category_code}))}});assert.deepEqual(await pairs(connection),backup.before);assert.deepEqual(await classificationFingerprint(connection),before);console.log(JSON.stringify({status:'restored_test_only',restored_associations:backup.before.length}));return
 }
 if(mode==='apply')assert.equal(v.confirm,'ASSIGN_680')
 const before=await pairs(connection),result=await installBundledClassifications(connection),after=await pairs(connection)
 const backup={database_key:databaseKey,before_sha256:sha(before),before,after_pairs_sha256:sha(after),preserved:result.preserved}
 write('before.json',backup);write('receipt.json',result);console.log(JSON.stringify({status:mode==='apply'?'validated':'validated_rollback_pending',questions:result.questions,created:result.created,associations:result.associations,backup_directory:out}))
 if(mode==='dry-run'){rolledBack=true;throw Error('ROLLBACK_VALIDATED')}
 },{timeout:180000,maxWait:15000});if(mode==='apply')write('commit-confirmed.json',{status:'committed'})
}catch(e){if(rolledBack&&e.message==='ROLLBACK_VALIDATED')console.log(JSON.stringify({status:'dry_run_rolled_back'}));else{console.error(JSON.stringify({status:'failed',name:e.name,code:e.code,reason:e.name==='OperationError'?e.message:undefined,frames:e.stack?.split('\n').filter(x=>x.trim().startsWith('at ')).slice(0,2)}));process.exitCode=1}}finally{await db.$disconnect()}
