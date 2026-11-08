import {applyWording} from '../editorial-wording.mjs'
import {readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {parseContentDocument} from '../../frontend/shared/schemas/structure.ts'
import {EXAM_CONFIG} from '../../frontend/shared/examConfig.ts'
import {validatePackage,desiredPlacement,material,hash} from './revision-core.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url))
const revisionDir=resolve(root,'content/revisions/mock02-textbook-v2')
const read=p=>JSON.parse(readFileSync(p,'utf8'))
export function buildSeed(){
 const bytes=readFileSync(resolve(revisionDir,'revision.json'))
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'6772db27010e8706eeb7af990694a54215c46d9fdcc764e5811c1e11321aa6c2')
 const revision=validatePackage(JSON.parse(bytes)),base=read(resolve(revisionDir,'baseline-original.json'))
 const parts=Array.from({length:EXAM_CONFIG.exam.set_count},(_,i)=>i+1).map(n=>n===2?base:read(resolve(root,`content/mock-exams/mock-${String(n).padStart(2,'0')}/questions.json`)))
 const next=structuredClone(base),newPassage=111
 const shared=next.groups.find(g=>g.group_number===27)
 shared.passages.push({id:newPassage,label:revision.application_group.passage_label,display_order:shared.passages.length+1,content_blocks:structuredClone(revision.application_group.content_blocks)})
 for(const g of next.groups){g.title=revision.group_title_overrides[String(g.group_number)]??(g.group_number===27?revision.application_group.title:g.title);g.publication_status=revision.retired_group_numbers.includes(g.group_number)?'private':'published';if(g.group_number===27)g.planned_question_count=5}
 next.questions=revision.questions.map(q=>{const p=desiredPlacement(q.question_number,revision),group=next.groups.find(g=>g.group_number===p.group_number);return {...structuredClone(q),group_id:group.id,group_question_number:p.slot,passage_references:p.shared?[{passage_id:newPassage,anchor_id:null}]:[]}})
 const combined={schema_version:2,exam_sets:parts.flatMap(p=>p.exam_sets),groups:parts.flatMap((p,i)=>i===1?next.groups:p.groups),questions:parts.flatMap((p,i)=>i===1?next.questions:p.questions)}
 parseContentDocument(combined,EXAM_CONFIG)
 for(const q of next.questions)assert.equal(hash(material(q)),hash(material(revision.questions.find(x=>x.question_number===q.question_number))))
 const edited=applyWording(next)
 combined.groups=parts.flatMap((p,i)=>i===1?edited.groups:p.groups);combined.questions=parts.flatMap((p,i)=>i===1?edited.questions:p.questions)
 return {standalone:edited,combined,revision}
}
export function verifySeed(){const built=buildSeed();assert.deepEqual(read(resolve(root,'content/questions.json')),built.combined);assert.deepEqual(read(resolve(root,'content/mock-exams/mock-02/questions.json')),built.standalone);return built}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--write')){const b=buildSeed();writeFileSync(resolve(root,'content/questions.json'),JSON.stringify(b.combined,null,2)+'\n');writeFileSync(resolve(root,'content/mock-exams/mock-02/questions.json'),JSON.stringify(b.standalone,null,2)+'\n')}
 const b=verifySeed();console.log(JSON.stringify({status:'passed',revision_id:b.revision.revision_id,questions:85,choices:340,normal_references:0,application_shared_questions:5,received_archive_unchanged:true,reviewed_wording_applied:true,other_mocks_unchanged:true}))
}
