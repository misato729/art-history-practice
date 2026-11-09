import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {materialDigest} from '../../frontend/server/services/learning-writer.ts'
import {parseContentDocument} from '../../frontend/shared/schemas/structure.ts'
import {EXAM_CONFIG} from '../../frontend/shared/examConfig.ts'
const read=p=>JSON.parse(readFileSync(p,'utf8')),write=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2)+'\n')
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):x
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
assert.deepEqual(read('local-only/received-revisions-20261109/verification/preflight.json').issues,[])
const current=read('local-only/received-revisions-20261109/verification/before-archive.json'),next=structuredClone(current),patches={questions:[],groups:[]}
for(let n=3;n<=8;n++){
 const part=read(`local-only/received-revisions-20261109/verification/mock-${String(n).padStart(2,'0')}-converted.json`)
 parseContentDocument(part,EXAM_CONFIG)
 for(const q of part.questions){const old=current.questions.find(x=>x.exam_number===n&&x.question_number===q.question_number);assert.ok(old)
  const fields=Object.fromEntries(['content_blocks','explanation_blocks','source_text','choices'].filter(f=>hash(old[f])!==hash(q[f])).map(f=>[f,q[f]]))
  if(Object.keys(fields).length)patches.questions.push({exam_number:n,question_number:q.question_number,change_kind:Object.keys(fields).every(f=>f==='source_text')?'wording':'substantive',before_sha256:materialDigest(old),after_sha256:materialDigest(q),fields})
  next.questions[next.questions.findIndex(x=>x.exam_number===n&&x.question_number===q.question_number)]=q
 }
 for(const g of part.groups){const old=current.groups.find(x=>x.id===g.id);assert.ok(old)
  for(const p of g.passages){const op=old.passages.find(x=>x.id===p.id);assert.ok(op);if(hash(p.content_blocks)!==hash(op.content_blocks))patches.groups.push({exam_number:n,group_number:g.group_number,passage_label:p.label,before_sha256:hash(op.content_blocks),after_sha256:hash(p.content_blocks),content_blocks:p.content_blocks})}
  // Keep existing group titles and identities: the material title is metadata, not a new group.
  next.groups[next.groups.findIndex(x=>x.id===g.id)]={...g,title:old.title}
 }
 write(`content/mock-exams/mock-${String(n).padStart(2,'0')}/questions.json`,{...part,groups:part.groups.map(g=>({...g,title:current.groups.find(x=>x.id===g.id).title}))})
}
parseContentDocument(next,EXAM_CONFIG)
for(const n of[1,2])assert.equal(hash(next.questions.filter(q=>q.exam_number===n)),hash(current.questions.filter(q=>q.exam_number===n)))
write('content/editorial/received-revision-36-20261109.json',patches);write('content/questions.json',next)
const classifications=read('content/question-study-classifications.json')
for(const q of next.questions)classifications.questions.find(r=>r.exam_number===q.exam_number&&r.question_number===q.question_number).material_sha256=materialDigest(q)
write('content/question-study-classifications.json',classifications)
console.log(JSON.stringify({status:'converted',questions:510,changed:patches.questions.length,groups:patches.groups.length,exams_1_2_preserved:true}))
