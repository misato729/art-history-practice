import {applyWording} from '../editorial-wording.mjs'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {parseContentDocument} from '../../frontend/shared/schemas/structure.ts'
import {EXAM_CONFIG} from '../../frontend/shared/examConfig.ts'
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=resolve(root,'content/revisions/illustrated-06-08')
const read=p=>JSON.parse(readFileSync(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex'),text=text=>({type:'text',text})
const paths=read(resolve(dir,'asset-paths.json'))
const image=i=>{const key=i.file.replace(/^\.\.\//,'');assert.ok(paths[key]);return {type:'image',src:paths[key],alt:i.alt,...(i.label?{label:i.label}:{})}}
// Transport identities only. The DB importer obtains fresh database identities.
export function convert(n){
 assert.ok([6,7,8].includes(n));const s=read(resolve(dir,`mock-${String(n).padStart(2,'0')}/exam.json`)),shared=s.shared_materials[0]
 assert.equal(s.exam_number,n);assert.equal(s.questions.length,85);assert.equal(s.shared_materials.length,1)
 const group=156+(n-6)*2,passage=116+n-6,credits=new Map(s.artwork_credits.map(c=>[c.asset_id,c]))
 const blocks=[text(shared.intro),...shared.images.map(image),{type:'table',...shared.table},...shared.notes.map(text)]
 const groups=[{id:group,exam_number:n,group_number:1,title:'美術史問題',planned_question_count:80,publication_status:'published',passages:[]},{id:group+1,exam_number:n,group_number:2,title:shared.title,planned_question_count:5,publication_status:'published',passages:[{id:passage,label:'共通資料・図版',display_order:1,content_blocks:blocks}]}]
 const code=x=>({eastern:'asian',eastern_study:'asian_study',craft_design:'design',craft_design_study:'design_study'}[x]??x)
 const questions=s.questions.map((q,i)=>{
  assert.equal(q.question_number,i+1);assert.equal(q.exam_number,n);assert.equal(q.choices.length,4);assert.equal(q.choices.filter(c=>c.is_correct).length,1);assert.equal(q.choices.find(c=>c.is_correct).label,q.correct_label);assert.equal(q.supplementary_blocks.length,0)
  const creditText=[...new Set((i>=80?shared.images:q.images).map(x=>x.asset_id))].map(id=>{const c=credits.get(id);assert.ok(c);return [c.credit,c.museum,c.source_page,c.policy_url,c.license_record].filter(Boolean).join('\n')}).join('\n\n')
  return {exam_number:n,question_number:i+1,group_id:group+(i>=80?1:0),group_question_number:i>=80?i-79:i+1,passage_references:i>=80?[{passage_id:passage,anchor_id:null}]:[],major_category_code:code(q.major_category_code),category_code:code(q.category_code),publication_status:'published',content_blocks:[text(q.stem),...q.images.map(image)],explanation_blocks:[text(q.explanation),...q.choices.map(c=>text(`${c.label}：${c.explanation}`)),...(creditText?[text(creditText)]:[])],source_text:q.source_text,choices:q.choices.map(c=>({choice_label:c.label,content_blocks:[text(c.text)],is_correct:c.is_correct,display_order:c.display_order}))}
 })
 const result={schema_version:2,exam_sets:[{exam_number:n,title:`模擬試験${n}`,publication_status:'published'}],groups,questions};parseContentDocument(result,EXAM_CONFIG);return applyWording(result)
}
export function verify678(){
 for(const [p,h] of Object.entries(read(resolve(dir,'received-sha256.json'))))assert.equal(sha(readFileSync(resolve(root,p))),h)
 for(const a of read(resolve(dir,'asset-manifest.json')))assert.equal(sha(readFileSync(resolve(root,'frontend/public'+paths[a.file]))),a.sha256)
 const parts=[6,7,8].map(convert)
 for(const part of parts)assert.deepEqual(read(resolve(root,`content/mock-exams/mock-${String(part.exam_sets[0].exam_number).padStart(2,'0')}/questions.json`)),part)
 const all=[...Array.from({length:5},(_,i)=>read(resolve(root,`content/mock-exams/mock-${String(i+1).padStart(2,'0')}/questions.json`))),...parts]
 const combined={schema_version:2,exam_sets:all.flatMap(p=>p.exam_sets),groups:all.flatMap(p=>p.groups),questions:all.flatMap(p=>p.questions)}
 assert.equal(combined.questions.length,680);parseContentDocument(combined,EXAM_CONFIG);assert.deepEqual(read(resolve(root,'content/questions.json')),combined)
 return parts
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--write')){
  const parts=[1,2,3,4,5].map(n=>read(resolve(root,`content/mock-exams/mock-${String(n).padStart(2,'0')}/questions.json`)))
  for(const n of [6,7,8]){const p=resolve(root,`content/mock-exams/mock-${String(n).padStart(2,'0')}/questions.json`);mkdirSync(resolve(p,'..'),{recursive:true});const part=convert(n);writeFileSync(p,JSON.stringify(part,null,2)+'\n');parts.push(part)}
  const combined={schema_version:2,exam_sets:parts.flatMap(p=>p.exam_sets),groups:parts.flatMap(p=>p.groups),questions:parts.flatMap(p=>p.questions)};parseContentDocument(combined,EXAM_CONFIG);writeFileSync(resolve(root,'content/questions.json'),JSON.stringify(combined,null,2)+'\n')
 }
 verify678();console.log(JSON.stringify({status:'verified',exams:3,questions:255,choices:1020,received_archive_unchanged:true,reviewed_wording_applied:true}))
}
