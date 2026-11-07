import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs'
import {resolve,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {parseContentDocument} from '../../frontend/shared/schemas/structure.ts'
import {EXAM_CONFIG} from '../../frontend/shared/examConfig.ts'
const root=fileURLToPath(new URL('../../',import.meta.url)), dir=resolve(root,'content/revisions/illustrated-01345')
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const read=p=>JSON.parse(readFileSync(p,'utf8')),text=text=>({type:'text',text})
const image=i=>({type:'image',src:`/images/artworks/illustrated-${basename(i.file)}`,alt:i.alt,...(i.label?{label:i.label}:{})})
export function convert(n){
 const source=read(resolve(dir,`mock-${n}/exam.json`)),base=read(resolve(dir,`mock-${n}/baseline.json`)),next=structuredClone(base)
 assert.equal(source.questions.length,85);assert.equal(source.exam_number,n)
 const appGroup=base.questions.find(q=>q.question_number===81).group_id
 const groupCounts=new Map(),shared=source.shared_materials[0],passageId=112+[1,3,4,5].indexOf(n)
 const blocks=[text(shared.intro),...shared.images.map(image),{type:'table',...shared.table},...shared.notes.map(text)]
 const credits=new Map(source.artwork_credits.map(c=>[c.asset_id,c]))
 next.questions=source.questions.map((q,i)=>{
  assert.equal(q.question_number,i+1);assert.equal(q.exam_number,n);assert.equal(q.choices.length,4);assert.equal(q.choices.filter(c=>c.is_correct).length,1);assert.equal(q.choices.find(c=>c.is_correct).label,q.correct_label)
  const before=base.questions.find(x=>x.question_number===q.question_number),group=q.question_number>80?appGroup:before.group_id,slot=(groupCounts.get(group)||0)+1;groupCounts.set(group,slot)
  const creditText=[...new Set((q.question_number>80?shared.images:q.images).map(i=>i.asset_id))].map(id=>{const c=credits.get(id);assert.ok(c);return [c.credit,c.museum,c.source_page,c.policy_url,c.license_record].filter(Boolean).join('\n')}).join('\n\n')
  return {exam_number:n,question_number:q.question_number,group_id:group,group_question_number:slot,passage_references:q.question_number>80?[{passage_id:passageId,anchor_id:null}]:[],major_category_code:q.major_category_code,category_code:q.category_code,publication_status:'published',content_blocks:[text(q.stem),...q.images.map(image),...q.supplementary_blocks],explanation_blocks:[text(q.explanation),...q.choices.map(c=>text(`${c.label}：${c.explanation}`)),...(creditText?[text(creditText)]:[])],source_text:q.source_text,choices:q.choices.map(c=>({choice_label:c.label,content_blocks:[text(c.text)],is_correct:c.is_correct,display_order:c.display_order}))}
 })
 for(const g of next.groups){g.publication_status=groupCounts.has(g.id)?'published':'private';if(groupCounts.has(g.id))g.planned_question_count=groupCounts.get(g.id);if(g.id===appGroup){g.title=shared.title;g.passages.push({id:passageId,label:`illustrated-${n}-shared`,display_order:g.passages.length+1,content_blocks:blocks})}}
 parseContentDocument(next,EXAM_CONFIG)
 return next
}
export function verifyIllustrated(){
 const received=read(resolve(dir,'received-sha256.json'))
 for(const [p,h] of Object.entries(received))assert.equal(sha(readFileSync(resolve(root,p))),h)
 const parts=[1,2,3,4,5].map(n=>n===2?read(resolve(root,'content/mock-exams/mock-02/questions.json')):convert(n))
 for(const p of parts)assert.deepEqual(read(resolve(root,`content/mock-exams/mock-${String(p.exam_sets[0].exam_number).padStart(2,'0')}/questions.json`)),p)
 const combined={schema_version:2,exam_sets:parts.flatMap(x=>x.exam_sets),groups:parts.flatMap(x=>x.groups),questions:parts.flatMap(x=>x.questions)}
 parseContentDocument(combined,EXAM_CONFIG);assert.deepEqual(read(resolve(root,'content/questions.json')),combined)
 const assets=read(resolve(dir,'asset-manifest.json'));for(const a of assets)assert.equal(sha(readFileSync(resolve(root,`frontend/public/images/artworks/illustrated-${basename(a.file)}`))),a.sha256)
 return combined
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--write')){for(const n of [1,3,4,5])writeFileSync(resolve(root,`content/mock-exams/mock-${String(n).padStart(2,'0')}/questions.json`),JSON.stringify(convert(n),null,2)+'\n');const parts=[1,2,3,4,5].map(n=>read(resolve(root,`content/mock-exams/mock-${String(n).padStart(2,'0')}/questions.json`)));writeFileSync(resolve(root,'content/questions.json'),JSON.stringify({schema_version:2,exam_sets:parts.flatMap(x=>x.exam_sets),groups:parts.flatMap(x=>x.groups),questions:parts.flatMap(x=>x.questions)},null,2)+'\n')}
 const c=verifyIllustrated();console.log(JSON.stringify({status:'verified',questions:c.questions.length,choices:c.questions.flatMap(q=>q.choices).length,received_content_unchanged:true}))
}
