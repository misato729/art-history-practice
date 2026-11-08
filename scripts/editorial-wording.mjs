import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {materialDigest} from '../frontend/server/services/learning-writer.ts'
import assert from 'node:assert/strict'
export function wordingPatches(revision='standalone-wording'){
 assert.ok(['standalone-wording','sculpture-identification'].includes(revision),'Unknown editorial revision')
 return JSON.parse(readFileSync(new URL(`../content/editorial/${revision}.json`,import.meta.url),'utf8'))
}
export function applyWording(document){
 const result=structuredClone(document)
 for(const revision of ['standalone-wording','sculpture-identification']){
 const patches=wordingPatches(revision)
 for(const patch of patches.questions){
  const q=result.questions.find(q=>q.exam_number===patch.exam_number&&q.question_number===patch.question_number)
  if(!q)continue
  assert.equal(materialDigest(q),patch.before_sha256,'Editorial baseline differs')
  Object.assign(q,patch.fields)
  assert.equal(materialDigest(q),patch.after_sha256,'Editorial result differs')
 }
 for(const patch of patches.groups??[]){const group=result.groups.find(g=>g.exam_number===patch.exam_number&&g.group_number===patch.group_number);if(!group)continue;const passage=group.passages.find(p=>p.label===patch.passage_label);assert.ok(passage);const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):x;const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');assert.equal(hash(passage.content_blocks),patch.before_sha256);passage.content_blocks=structuredClone(patch.content_blocks);assert.equal(hash(passage.content_blocks),patch.after_sha256)}
 }
 return result
}
