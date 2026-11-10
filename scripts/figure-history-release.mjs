import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {parseArgs,parseEnv} from 'node:util'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {createDatabase,record} from '../frontend/server/core/db.ts'
import {materialDigest,saveQuestionWording,saveQuestionRevision,QUESTION_WRITE_LOCK} from '../frontend/server/services/learning-writer.ts'
import {classificationTarget} from '../frontend/server/operations/classification-target.ts'
import {classificationFingerprint} from '../frontend/server/operations/question-classifications.ts'
import {loadQuestionGroup,saveQuestionGroup} from '../frontend/server/services/learning-structure.ts'
import {wordingPatches} from './editorial-wording.mjs'
const {values:v,positionals:[mode]}=parseArgs({options:{env:{type:'string'},confirm:{type:'string'},revision:{type:'string'}},allowPositionals:true})
assert.ok(['plan','dry-run','apply','verify'].includes(mode));assert.ok(v.env)
const env=parseEnv(readFileSync(v.env,'utf8')),target=classificationTarget(env.DATABASE_URL),db=createDatabase(target.connectionString)
assert.equal(v.revision,'figure-history-20261111');const patches=wordingPatches(v.revision),desired=JSON.parse(readFileSync('content/questions.json','utf8')),manifest=JSON.parse(readFileSync('content/question-study-classifications.json','utf8'))
const dir=resolve('local-only/backups/figure-history',new Date().toISOString().replace(/[:.]/g,'-')),write=(name,x)=>{mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(resolve(dir,name),JSON.stringify(x,null,2)+'\n',{mode:0o600,flag:'wx'})}
const canonical=x=>x instanceof Date?x.toISOString():Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):x
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');let rollback=false
try{await db.$transaction(async connection=>{
 if(['plan','verify'].includes(mode))await connection.$executeRawUnsafe('SET TRANSACTION READ ONLY')
 else await connection.$queryRawUnsafe('SELECT pg_advisory_xact_lock($1)::text',QUESTION_WRITE_LOCK)
 const groups=record(await connection.questionGroup.findMany({orderBy:{id:'asc'},include:{passages:{orderBy:{display_order:'asc'}}}}))
 const groupSnapshots=[]
 for(const patch of patches.groups??[]){const g=groups.find(g=>g.exam_number===patch.exam_number&&g.group_number===patch.group_number),passage=g?.passages.find(p=>p.label===patch.passage_label);assert.ok(passage);const digest=hash(passage.content_blocks);assert.ok(digest===patch.after_sha256||(mode!=='verify'&&digest===patch.before_sha256));groupSnapshots.push(g)}
 const before=record(await connection.question.findMany({include:{choices:{orderBy:{display_order:'asc'}},passage_references:{orderBy:{display_order:'asc'}}},orderBy:[{exam_number:'asc'},{question_number:'asc'}]}))
 assert.equal(before.length,680)
 for(const q of before){const target=desired.questions.find(x=>x.exam_number===q.exam_number&&x.question_number===q.question_number),patch=patches.questions.find(x=>x.exam_number===q.exam_number&&x.question_number===q.question_number);assert.ok(target);const digest=materialDigest(q);assert.ok(digest===materialDigest(target)||(mode!=='verify'&&patch&&digest===patch.before_sha256),'Unexpected material; no overwrite');assert.equal(manifest.questions.find(x=>x.exam_number===q.exam_number&&x.question_number===q.question_number).material_sha256,materialDigest(target))}
 if(['plan','verify'].includes(mode)){console.log(JSON.stringify({status:mode==='plan'?'planned':'verified',questions:680,patches:patches.questions.length,unrevised:before.filter(q=>patches.questions.some(p=>p.exam_number===q.exam_number&&p.question_number===q.question_number&&materialDigest(q)===p.before_sha256)).length}));return}
 assert.equal(v.confirm,'APPLY_REVIEWED_WORDING')
 const originalCategories=record(await connection.questionStudyCategory.findMany({orderBy:[{question_id:'asc'},{study_category_code:'asc'}]}))
 const fingerprints=await classificationFingerprint(connection),categories=hash(record(await connection.questionStudyCategory.findMany({orderBy:[{question_id:'asc'},{study_category_code:'asc'}]}))),affected=before.filter(q=>patches.questions.some(p=>p.exam_number===q.exam_number&&p.question_number===q.question_number))
 const backup={database:hash(target.identity),questions:affected,groups:groupSnapshots,preserved:fingerprints,categories,classification_rows:originalCategories};write('before.json',{...backup,sha256:hash(backup)})
 let changed=0
 for(const patch of patches.questions){const q=before.find(q=>q.exam_number===patch.exam_number&&q.question_number===patch.question_number),next=desired.questions.find(x=>x.exam_number===q.exam_number&&x.question_number===q.question_number);if(materialDigest(q)===patch.after_sha256)continue
  await saveQuestionRevision(q.id,patch.before_sha256,{...next,group_id:q.group_id,group_question_number:q.group_question_number,passage_references:q.passage_references.map(r=>({passage_id:r.passage_id,anchor_id:r.anchor_id})),choices:next.choices.map(c=>({...c,id:q.choices.find(x=>x.choice_label===c.choice_label).id}))},connection,{replaceReviewedSources:true,preserveScoringVersion:patch.change_kind==='wording'});changed++}
 for(const patch of patches.groups??[]){const g=groupSnapshots.find(g=>g.exam_number===patch.exam_number&&g.group_number===patch.group_number),passage=g.passages.find(p=>p.label===patch.passage_label);if(hash(passage.content_blocks)===patch.after_sha256)continue;const current=await loadQuestionGroup(g.id,connection);await saveQuestionGroup(g.id,{lock_version:current.lock_version,passages:current.passages.map(p=>({id:p.id,label:p.label,display_order:p.display_order,content_blocks:p.id===passage.id?patch.content_blocks:p.content_blocks}))},{db:connection});for(const q of before.filter(q=>q.passage_references.some(r=>r.passage_id===passage.id)))await connection.question.update({where:{id:q.id},data:{content_version:q.content_version+(patches.questions.some(p=>p.exam_number===q.exam_number&&p.question_number===q.question_number&&p.change_kind==='substantive'&&materialDigest(q)!==p.after_sha256)||hash(passage.content_blocks)!==patch.after_sha256?1:0)}});assert.equal(hash((await connection.groupPassage.findUnique({where:{id:passage.id}})).content_blocks),patch.after_sha256)}
 const expectedGroups=structuredClone(groups)
 for(const patch of patches.groups??[]){const g=expectedGroups.find(g=>g.exam_number===patch.exam_number&&g.group_number===patch.group_number);g.passages.find(p=>p.label===patch.passage_label).content_blocks=patch.content_blocks}
 const actualGroups=record(await connection.questionGroup.findMany({orderBy:{id:'asc'},include:{passages:{orderBy:{display_order:'asc'}}}}))
 const groupShape=rows=>rows.map(g=>{const patched=(patches.groups??[]).some(p=>p.exam_number===g.exam_number&&p.group_number===g.group_number);if(!patched)return g;const {updated_at,lock_version,...rest}=g;return {...rest,passages:g.passages.map(p=>{const {updated_at,...rest}=p;return rest})}})
 assert.equal(hash(groupShape(actualGroups)),hash(groupShape(expectedGroups)))
 const wanted=before.flatMap(q=>manifest.questions.find(m=>m.exam_number===q.exam_number&&m.question_number===q.question_number).codes.map(code=>({question_id:q.id,study_category_code:code})))
 const associationKey=row=>row.question_id+'/'+row.study_category_code
 const wantedKeys=new Set(wanted.map(associationKey)), oldKeys=new Set(originalCategories.map(associationKey))
 const removals=originalCategories.filter(row=>!wantedKeys.has(associationKey(row)))
 const additions=wanted.filter(row=>!oldKeys.has(associationKey(row)))
 const changedClassificationIds=new Set([...removals,...additions].map(x=>x.question_id))
 assert.ok(changedClassificationIds.size<=15)
 assert.ok([...changedClassificationIds].every(id=>affected.some(q=>q.id===id)))
 for(const row of removals)await connection.questionStudyCategory.deleteMany({where:{question_id:row.question_id,study_category_code:row.study_category_code}})
 if(additions.length)await connection.questionStudyCategory.createMany({data:additions,skipDuplicates:true})
 const actualCategories=record(await connection.questionStudyCategory.findMany({orderBy:[{question_id:'asc'},{study_category_code:'asc'}]}))
 assert.deepEqual(actualCategories.map(associationKey).sort(),wanted.map(associationKey).sort())
 const after=await classificationFingerprint(connection)
 for(const name of ['question_passage_references','answer_histories','favorites'])assert.equal(after[name],fingerprints[name])

 const rows=record(await connection.question.findMany({include:{choices:{orderBy:{display_order:'asc'}}}}))
 for(const q of rows){assert.equal(materialDigest(q),materialDigest(desired.questions.find(x=>x.exam_number===q.exam_number&&x.question_number===q.question_number)));const old=before.find(x=>x.id===q.id);const patch=patches.questions.find(p=>p.exam_number===q.exam_number&&p.question_number===q.question_number);const sharedChanged=(patches.groups??[]).some(p=>{const g=groupSnapshots.find(g=>g.exam_number===p.exam_number&&g.group_number===p.group_number),passage=g?.passages.find(x=>x.label===p.passage_label);return passage&&hash(passage.content_blocks)!==p.after_sha256&&old.passage_references.some(r=>r.passage_id===passage.id)});const advance=(patch?.change_kind==='substantive'&&materialDigest(old)!==materialDigest(q))||sharedChanged?1:0;assert.equal(q.content_version,old.content_version+advance);assert.deepEqual(q.choices.map(c=>[c.id,c.choice_label,c.is_correct,c.display_order]),old.choices.map(c=>[c.id,c.choice_label,c.is_correct,c.display_order]))}
 write('receipt.json',{questions:680,changed,preserved_learning_records:true,reviewed_classifications_updated:changedClassificationIds.size,substantive_versions_advanced:rows.filter(q=>q.content_version!==before.find(old=>old.id===q.id).content_version).length,preserved_choice_identities:true});console.log(JSON.stringify({status:'validated',changed,backup_directory:dir}))
 if(mode==='dry-run'){rollback=true;throw new Error('VALIDATED_ROLLBACK')}
 assert.equal(mode,'apply')
 },{timeout:1200000,maxWait:15000});if(mode==='apply')write('committed.json',{status:'committed'})
}catch(e){if(rollback&&e.message==='VALIDATED_ROLLBACK')console.log(JSON.stringify({status:'rolled_back'}));else{console.error(JSON.stringify({status:'failed',name:e.name,code:e.code,frames:e.stack?.split('\n').filter(x=>x.trim().startsWith('at ')).slice(0,2)}));process.exitCode=1}}finally{await db.$disconnect()}
