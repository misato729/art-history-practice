import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseArgs,parseEnv} from 'node:util'
import assert from 'node:assert/strict'
import {loadAPI} from '../mock02-revision/db-revision.mjs'
import {hash,material} from '../mock02-revision/revision-core.mjs'
import {verify678} from './build.mjs'
const root=resolve(new URL('../../',import.meta.url).pathname)
const {values:v,positionals:[mode]}=parseArgs({options:{env:{type:'string'},confirm:{type:'string'},backup:{type:'string'}},allowPositionals:true})
assert.ok(['dry-run','apply','verify','restore-test'].includes(mode));assert.ok(v.env)
const env=parseEnv(readFileSync(resolve(v.env),'utf8'));assert.ok(env.DATABASE_URL);process.env.DATABASE_URL=env.DATABASE_URL
const api=await loadAPI(root),client=api.createDatabase(env.DATABASE_URL),parts=verify678(),desired={questions:parts.flatMap(x=>x.questions),groups:parts.flatMap(x=>x.groups)}
const key=hash(new URL(env.DATABASE_URL).hostname.replace('-pooler','')+new URL(env.DATABASE_URL).pathname)
const out=resolve(root,'local-only/backups/illustrated-678',new Date().toISOString().replace(/[:.]/g,'-'))
const write=(name,x)=>{mkdirSync(out,{recursive:true,mode:0o700});writeFileSync(resolve(out,name),JSON.stringify(x,null,2)+'\n',{mode:0o600,flag:'wx'})}
export async function snapshot(db){
 const result={};for(const [name,model] of [['questions','question'],['choices','questionChoice'],['groups','questionGroup'],['passages','groupPassage'],['sets','examSet'],['references','questionPassageReference']]){
  result[name]=await db[model].findMany({orderBy:name==='sets'?{exam_number:'asc'}:{id:'asc'}})
 }
 // Preserve timestamp(6) precision for user-owned records; never log their contents.
 for(const name of ['users','answer_histories','favorites'])result[name]=await api.query(`SELECT to_jsonb(t)::text AS row FROM ${name} t ORDER BY id`,[],db)
 return api.record(result)
}
function original(s){const ids=new Set(s.questions.filter(x=>x.exam_number<=5).map(x=>x.id)),gids=new Set(s.groups.filter(x=>x.exam_number<=5).map(x=>x.id));return {questions:s.questions.filter(x=>ids.has(x.id)),choices:s.choices.filter(x=>ids.has(x.question_id)),groups:s.groups.filter(x=>gids.has(x.id)),passages:s.passages.filter(x=>gids.has(x.group_id)),sets:s.sets.filter(x=>x.exam_number<=5),references:s.references.filter(x=>ids.has(x.question_id)),users:s.users,answer_histories:s.answer_histories,favorites:s.favorites}}
function match(s){
 assert.equal(s.questions.filter(q=>q.exam_number>=6).length,255);assert.equal(s.groups.filter(g=>g.exam_number>=6).length,6);assert.equal(s.sets.filter(g=>g.exam_number>=6).length,3)
 for(const q of desired.questions){const live=s.questions.find(x=>x.exam_number===q.exam_number&&x.question_number===q.question_number);assert.ok(live);assert.equal(hash(material({...live,choices:s.choices.filter(c=>c.question_id===live.id).sort((a,b)=>a.display_order-b.display_order)})),hash(material(q)));assert.equal(live.publication_status,'published');assert.equal(live.group_question_number,q.group_question_number)
  const g=s.groups.find(x=>x.id===live.group_id),source=desired.groups.find(x=>x.id===q.group_id);assert.equal(g.group_number,source.group_number);assert.equal(g.title,source.title);assert.equal(g.publication_status,'published');const refs=s.references.filter(x=>x.question_id===live.id);assert.equal(refs.length,q.passage_references.length);for(const ref of q.passage_references){const wanted=source.passages.find(p=>p.id===ref.passage_id);assert.ok(refs.some(r=>{const p=s.passages.find(p=>p.id===r.passage_id);return p?.label===wanted.label&&hash(p.content_blocks)===hash(wanted.content_blocks)}))}
 }
 for(const n of [6,7,8])assert.equal(s.sets.find(x=>x.exam_number===n)?.publication_status,'published')
}
async function append(db){
 const gm=new Map(),pm=new Map()
 for(const g of desired.groups){const {id,...raw}=g;const created=await api.createQuestionGroup(g.exam_number,{...raw,publication_status:'draft',passages:g.passages.map(({id,...p})=>p)},{db});gm.set(id,created.id);for(const p of g.passages)pm.set(p.id,created.passages.find(x=>x.label===p.label).id)}
 for(const q of desired.questions)await api.saveQuestion({...q,publication_status:'draft',group_id:gm.get(q.group_id),passage_references:q.passage_references.map(r=>({...r,passage_id:pm.get(r.passage_id)}))},{db})
 for(const n of [6,7,8]){const set=await db.examSet.findUniqueOrThrow({where:{exam_number:n}});await api.publishExamSet(n,set.lock_version,{db})}
}
let rollback=false
try{
 await client.$transaction(async db=>{
  if(mode==='verify')await db.$executeRawUnsafe('SET TRANSACTION READ ONLY')
  else{await api.query("SET LOCAL lock_timeout='10s'",[],db);await api.query('SELECT pg_advisory_xact_lock($1)::text',[71514345],db)}
  const before=await snapshot(db)
  assert.equal(before.questions.filter(x=>x.exam_number<=5).length,425)
  if(mode==='verify'){match(before);console.log(JSON.stringify({status:'verified',new_questions:255,total_questions:680}));return}
  if(mode==='restore-test'){
   const u=new URL(env.DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.endsWith('_test'));assert.equal(v.confirm,'RESTORE_678_TEST');const backup=JSON.parse(readFileSync(v.backup,'utf8'));assert.equal(backup.database_key,key);assert.equal(backup.before_sha256,hash(backup.before));match(before);assert.equal(hash(original(before)),hash(original(backup.before)))
   const ids=before.questions.filter(q=>q.exam_number>=6).map(q=>q.id);assert.equal(await db.answerHistory.count({where:{question_id:{in:ids}}}),0);assert.equal(await db.favorite.count({where:{question_id:{in:ids}}}),0)
   await db.questionPassageReference.deleteMany({where:{question_id:{in:ids}}});await db.questionChoice.deleteMany({where:{question_id:{in:ids}}});await db.question.deleteMany({where:{id:{in:ids}}});await db.groupPassage.deleteMany({where:{group_id:{in:before.groups.filter(g=>g.exam_number>=6).map(g=>g.id)}}});await db.questionGroup.deleteMany({where:{exam_number:{in:[6,7,8]}}});await db.examSet.deleteMany({where:{exam_number:{in:[6,7,8]}}});assert.equal(hash(await snapshot(db)),hash(backup.before));console.log(JSON.stringify({status:'restored_test_only',original_questions:425}));return
  }
  if(before.questions.some(q=>q.exam_number>=6)){match(before);console.log(JSON.stringify({status:'already_applied'}));return}
  assert.equal(before.questions.length,425);assert.equal(before.sets.filter(x=>x.exam_number>=6).length,0);assert.equal(before.groups.filter(x=>x.exam_number>=6).length,0)
  if(mode==='apply')assert.equal(v.confirm,'APPEND_678')
  write('before.json',{database_key:key,before_sha256:hash(before),before});await append(db);const after=await snapshot(db);match(after);assert.equal(hash(original(after)),hash(original(before)));write('receipt.json',{mode,original_preserved:true,original_sha256:hash(original(before)),new_questions:255,total_questions:680});console.log(JSON.stringify({status:mode==='dry-run'?'validated_rollback_pending':'validated',backup_directory:out,existing_425_and_user_data_unchanged:true,new_questions:255}))
  if(mode==='dry-run'){rollback=true;throw new Error('ROLLBACK_VALIDATED')}
 },{timeout:600000,maxWait:15000})
 if(mode==='apply')write('commit-confirmed.json',{status:'committed'})
}catch(e){if(rollback&&e.message==='ROLLBACK_VALIDATED'){console.log(JSON.stringify({status:'dry_run_rolled_back'}))}else{console.error(JSON.stringify({status:'failed',name:e.name,code:e.code,frames:e.stack?.split('\n').filter(l=>l.trim().startsWith('at ')).slice(0,3)}));process.exitCode=1}}finally{await client.$disconnect()}
