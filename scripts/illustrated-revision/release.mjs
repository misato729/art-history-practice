import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {parseArgs,parseEnv} from 'node:util'
import assert from 'node:assert/strict'
import {loadAPI} from '../mock02-revision/db-revision.mjs'
import {material,hash} from '../mock02-revision/revision-core.mjs'
import {verifyIllustrated} from './build.mjs'
const {values:v,positionals}=parseArgs({options:{env:{type:'string'},confirm:{type:'string'},backup:{type:'string'}},allowPositionals:true})
const mode=positionals[0],root=resolve(new URL('../../',import.meta.url).pathname)
assert.ok(['apply','verify','restore'].includes(mode));assert.ok(v.env)
const env=parseEnv(readFileSync(resolve(root,v.env),'utf8'));assert.ok(env.DATABASE_URL);process.env.DATABASE_URL=env.DATABASE_URL
const desired=verifyIllustrated(),api=await loadAPI(root),client=api.createDatabase(env.DATABASE_URL)
const dbkey=hash(new URL(env.DATABASE_URL).hostname.replace('-pooler','')),out=resolve(root,'local-only/backups/illustrated-five',new Date().toISOString().replace(/[:.]/g,'-'))
const privateWrite=(p,x)=>{mkdirSync(resolve(p,'..'),{recursive:true,mode:0o700});writeFileSync(p,JSON.stringify(x,null,2)+'\n',{mode:0o600,flag:'wx'})}
async function snapshot(db){
 const questions=api.record(await db.question.findMany({orderBy:[{exam_number:'asc'},{question_number:'asc'}],include:{choices:{orderBy:{display_order:'asc'}},passage_references:{orderBy:{display_order:'asc'}}}})).map(q=>({...q,passage_references:q.passage_references.map(r=>({passage_id:r.passage_id,anchor_id:r.anchor_id}))}))
 const groups=api.record(await db.questionGroup.findMany({orderBy:{id:'asc'},include:{passages:{orderBy:{display_order:'asc'}}}})),sets=api.record(await db.examSet.findMany({orderBy:{exam_number:'asc'}}))
 const history=await api.query('SELECT to_jsonb(t)::text AS row FROM answer_histories t ORDER BY id',[],db),favorites=await api.query('SELECT to_jsonb(t)::text AS row FROM favorites t ORDER BY id',[],db)
 return {questions,groups,sets,history,favorites}
}
function match(state,target){
 assert.equal(state.questions.length,425)
 for(const q of target.questions){const live=state.questions.find(x=>x.exam_number===q.exam_number&&x.question_number===q.question_number);assert.ok(live);assert.equal(hash(material(live)),hash(material(q)));assert.equal(live.publication_status,'published');const g=state.groups.find(g=>g.id===live.group_id),sg=target.groups.find(g=>g.id===q.group_id);assert.equal(g.group_number,sg.group_number);assert.equal(live.group_question_number,q.group_question_number);assert.equal(live.passage_references.length,q.passage_references.length)
  for(const ref of q.passage_references){const sp=sg.passages.find(p=>p.id===ref.passage_id),actual=live.passage_references.map(r=>g.passages.find(p=>p.id===r.passage_id));assert.ok(actual.some(p=>p.label===sp.label&&hash(p.content_blocks)===hash(sp.content_blocks)))}
 }
}
async function writeAll(db,before,target){
 // Atomic structural preparation; final publication still uses the canonical validator.
 await db.questionGroup.updateMany({data:{publication_status:'draft',planned_question_count:85,lock_version:{increment:1},updated_at:new Date()}})
 console.log(JSON.stringify({phase:'groups_prepared',groups:before.groups.length}))
 // Map archive identities to existing DB identities; preserve old passages and append only new labels.
 const groupMap=new Map(),passageMap=new Map()
 const existingGroups=[...before.groups]
 for(const group of target.groups)if(!existingGroups.some(g=>g.exam_number===group.exam_number&&g.group_number===group.group_number)){const created=await api.createQuestionGroup(group.exam_number,{group_number:group.group_number,title:group.title,planned_question_count:85,publication_status:'draft',passages:[]},{db});existingGroups.push(created)}
 for(const group of target.groups){const id=existingGroups.find(g=>g.exam_number===group.exam_number&&g.group_number===group.group_number).id;groupMap.set(group.id,id);const needed=new Set(target.questions.filter(q=>q.group_id===group.id).flatMap(q=>q.passage_references.map(r=>r.passage_id)));if(!needed.size)continue;let live=await api.loadQuestionGroup(id,db);
  const missing=group.passages.filter(p=>needed.has(p.id)&&!live.passages.some(x=>x.label===p.label));if(missing.length)live=await api.saveQuestionGroup(live.id,{lock_version:live.lock_version,passages:[...live.passages.map(p=>({id:p.id,label:p.label,display_order:p.display_order,content_blocks:p.content_blocks})),...missing.map((p,i)=>({label:p.label,display_order:live.passages.length+i+1,content_blocks:p.content_blocks}))]},{db})
  for(const p of group.passages.filter(p=>needed.has(p.id))){const actual=live.passages.find(x=>x.label===p.label);assert.ok(actual);assert.equal(hash(actual.content_blocks),hash(p.content_blocks));passageMap.set(p.id,actual.id)}
 }
 // Vacate existing unique group slots inside the locked transaction before moving members.
 await db.question.updateMany({data:{group_question_number:{increment:100000}}})
 for(const n of [1,2,3,4,5]){for(const q of target.questions.filter(q=>q.exam_number===n)){
  const old=before.questions.find(x=>x.exam_number===n&&x.question_number===q.question_number),live=await api.loadQuestion(old.id,db)
  await api.saveQuestion({...q,publication_status:'draft',lock_version:live.lock_version,group_id:groupMap.get(q.group_id),passage_references:q.passage_references.map(r=>({...r,passage_id:passageMap.get(r.passage_id)})),choices:q.choices.map(c=>({...c,id:live.choices.find(x=>x.choice_label===c.choice_label).id}))},{id:old.id,db,preserveHistory:true})
 }console.log(JSON.stringify({phase:'saved',exam:n,questions:85}))}
 for(const group of target.groups){const id=groupMap.get(group.id);await db.questionGroup.update({where:{id},data:{title:group.title,planned_question_count:group.planned_question_count,publication_status:group.publication_status==='private'?'private':'draft',lock_version:{increment:1},updated_at:new Date()}})}
 for(const g of existingGroups.filter(g=>!target.groups.some(t=>t.exam_number===g.exam_number&&t.group_number===g.group_number))){const live=await api.loadQuestionGroup(g.id,db);await api.saveQuestionGroup(g.id,{lock_version:live.lock_version,publication_status:'private'},{db})}
 for(const n of [1,2,3,4,5]){const set=await db.examSet.findUniqueOrThrow({where:{exam_number:n}});await api.publishExamSet(n,set.lock_version,{db})}
}
try{
 if(mode==='verify'){await client.$transaction(async db=>{await db.$executeRawUnsafe('SET TRANSACTION READ ONLY');const s=await snapshot(db);match(s,desired);console.log(JSON.stringify({status:'verified',questions:425,choices:1700,histories:s.history.length,favorites:s.favorites.length}))},{timeout:180000});}
 else{
 assert.equal(v.confirm,mode==='restore'?'RESTORE_FIVE':'UPDATE_FIVE')
 await client.$transaction(async db=>{
  await api.query("SET LOCAL lock_timeout='10s'",[],db);await api.query('SELECT pg_advisory_xact_lock($1)::text',[71514345],db);await api.query('SELECT id FROM questions ORDER BY id FOR UPDATE',[],db)
  const before=await snapshot(db);assert.equal(before.questions.length,425);let target=desired
  if(mode==='apply'){
   try{match(before,desired);console.log(JSON.stringify({status:'already_applied',questions:425}));return}catch{}
   // Accept only the five known original editions (or the approved V2 for mock2).
   for(const n of [1,2,3,4,5]){const baseline=JSON.parse(readFileSync(resolve(root,n===2?'content/revisions/mock02-textbook-v2/baseline-original.json':`content/revisions/illustrated-01345/mock-${n}/baseline.json`),'utf8'));const rows=before.questions.filter(q=>q.exam_number===n);assert.equal(rows.length,85);const accepted=JSON.parse(readFileSync(resolve(root,'content/revisions/illustrated-01345/accepted-live-material-sha256.json'),'utf8'));if(accepted[String(n)]===hash(rows.map(material)))continue;for(const q of rows){const original=baseline.questions.find(x=>x.question_number===q.question_number),next=desired.questions.find(x=>x.exam_number===n&&x.question_number===q.question_number);assert.ok(hash(material(q))===hash(material(original))||(n===2&&hash(material(q))===hash(material(next))),`UNEXPECTED_BASELINE_EXAM_${n}_Q_${q.question_number}`)}}
  }else{const backup=JSON.parse(readFileSync(v.backup,'utf8'));assert.equal(backup.database_key,dbkey);assert.equal(hash(backup.before),backup.before_sha256);match(before,desired);assert.equal(hash(before.history),hash(backup.before.history));target={questions:backup.before.questions,groups:backup.before.groups};}
  privateWrite(resolve(out,'before.json'),{database_key:dbkey,before_sha256:hash(before),before});console.log(JSON.stringify({phase:'backup_saved',directory:out,questions:425,histories:before.history.length,favorites:before.favorites.length}))
  await writeAll(db,before,target)
  const after=await snapshot(db);match(after,target);assert.equal(hash(after.history),hash(before.history));assert.equal(hash(after.favorites),hash(before.favorites));for(const q of before.questions){const a=after.questions.find(x=>x.id===q.id);assert.ok(a);assert.deepEqual(a.choices.map(c=>c.id),q.choices.map(c=>c.id))}
  if(mode==='restore'){for(const q of after.questions){const original=target.questions.find(x=>x.id===q.id);await db.answerHistory.updateMany({where:{question_id:q.id,question_version:original.content_version},data:{question_version:q.content_version}})}}
  privateWrite(resolve(out,'receipt.json'),{database_key:dbkey,status:mode==='apply'?'updated':'restored',questions:425,choices:1700,histories:after.history.length,favorites:after.favorites.length,after_material_sha256:hash(after.questions.map(material))})
 },{timeout:3600000,maxWait:15000});privateWrite(resolve(out,'commit-confirmed.json'),{status:'committed'});console.log(JSON.stringify({status:'committed',directory:out}))
 }
}catch(e){console.error(JSON.stringify({status:'failed',name:e.name,code:e.code,frames:e.stack?.split('\n').filter(l=>l.trim().startsWith('at ')).slice(0,2),reason:e.code==='ERR_ASSERTION'?String(e.message).split('\n')[0].slice(0,160):undefined}));process.exitCode=1}finally{await client.$disconnect()}
