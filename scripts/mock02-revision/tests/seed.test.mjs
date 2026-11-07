import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {buildSeed,verifySeed} from '../build-seed.mjs'
const root=new URL('../../../',import.meta.url)
const read=p=>JSON.parse(readFileSync(new URL(p,root),'utf8'))
test('received author documents remain byte identical',()=>{for(const [path,digest] of Object.entries(read('content/revisions/mock02-textbook-v2/received-sha256.json')))assert.equal(createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex'),digest)})
test('rebuilding deterministically reproduces active V2 and all five complete sets',()=>{const {combined}=verifySeed();assert.equal(combined.questions.length,425);assert.equal(combined.questions.reduce((n,q)=>n+q.choices.length,0),1700);assert.deepEqual(buildSeed().combined,combined)})
test('ordinary references are absent and all five applications use the supplied four-image context',()=>{const {standalone,revision}=buildSeed();assert(standalone.questions.filter(q=>q.question_number<=80).every(q=>q.passage_references.length===0));const group=standalone.groups.find(g=>g.group_number===27),passage=group.passages.find(p=>p.label===revision.application_group.passage_label);assert.deepEqual(passage.content_blocks,revision.application_group.content_blocks);assert.equal(passage.content_blocks.filter(b=>b.type==='image').length,4);assert.deepEqual(standalone.questions.filter(q=>q.question_number>=81).map(q=>[q.group_id,q.group_question_number,q.passage_references]),[1,2,3,4,5].map(n=>[group.id,n,[{passage_id:passage.id,anchor_id:null}]]));assert.equal(standalone.groups.filter(g=>g.publication_status==='private').length,4)})
test('other four standalone exams are copied without changed fields',()=>{const {combined}=buildSeed();for(const n of [1,3,4,5]){const original=read(`content/mock-exams/mock-${String(n).padStart(2,'0')}/questions.json`);assert.deepEqual(combined.questions.filter(q=>q.exam_number===n),original.questions);assert.deepEqual(combined.groups.filter(g=>g.exam_number===n),original.groups)}})
