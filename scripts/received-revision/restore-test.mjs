// A disposable local test database only; never a production rollback command.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {createDatabase,json,record} from '../../frontend/server/core/db.ts'
import {classificationFingerprint} from '../../frontend/server/operations/question-classifications.ts'
import {materialDigest,QUESTION_WRITE_LOCK} from '../../frontend/server/services/learning-writer.ts'
const url=new URL(process.env.DATABASE_URL);assert.equal(process.env.APP_ENV,'test');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/art_received_test');assert.equal(url.port,'55449')
const canonical=x=>x instanceof Date?x.toISOString():Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):x
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex'),saved=JSON.parse(readFileSync(process.argv[2],'utf8')),{sha256,...backup}=saved
assert.equal(hash(backup),sha256)
const patches=JSON.parse(readFileSync('content/editorial/received-revision-36-20261109.json')),db=createDatabase(url.toString())
try{await db.$transaction(async c=>{
 await c.$queryRawUnsafe('SELECT pg_advisory_xact_lock($1)::text',QUESTION_WRITE_LOCK)
 for(const old of backup.questions){const q=record(await c.question.findUniqueOrThrow({where:{id:old.id},include:{choices:{orderBy:{display_order:'asc'}}}})),p=patches.questions.find(p=>p.exam_number===q.exam_number&&p.question_number===q.question_number);assert.ok(p);assert.equal(materialDigest(q),p.after_sha256);assert.deepEqual(q.choices.map(x=>x.id),old.choices.map(x=>x.id))
  await c.question.update({where:{id:old.id},data:{content_blocks:json(old.content_blocks),explanation_blocks:json(old.explanation_blocks),source_text:old.source_text,content_version:old.content_version,lock_version:old.lock_version,updated_at:old.updated_at}})
  for(const choice of old.choices)await c.questionChoice.update({where:{id:choice.id},data:{content_blocks:json(choice.content_blocks),updated_at:choice.updated_at}})
 }
 for(const old of backup.groups){const g=record(await c.questionGroup.findUniqueOrThrow({where:{id:old.id},include:{passages:true}}));assert.deepEqual(g.passages.map(x=>x.id).sort(),old.passages.map(x=>x.id).sort());await c.questionGroup.update({where:{id:old.id},data:{title:old.title,lock_version:old.lock_version,updated_at:old.updated_at}})
  for(const p of old.passages)await c.groupPassage.update({where:{id:p.id},data:{content_blocks:json(p.content_blocks),updated_at:p.updated_at}})
 }
 assert.deepEqual(await classificationFingerprint(c),backup.preserved)
 console.log(JSON.stringify({status:'restored_from_revision_backup',fingerprints:7,questions:backup.questions.length,groups:backup.groups.length}))
 },{timeout:180000})}finally{await db.$disconnect()}
