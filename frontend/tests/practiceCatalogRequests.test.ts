import assert from 'node:assert/strict'
import test from 'node:test'
import {computed,ref,watch,effectScope,onScopeDispose} from 'vue'
import {usePracticeCatalog} from '../app/composables/usePracticeCatalog.ts'
const g=globalThis as any
g.computed=computed;g.watch=watch;g.onScopeDispose=onScopeDispose
function harness(){
 const states=new Map(),mounts:(()=>void)[]=[],responses:((x:any)=>void)[]=[],version=ref(0),user=ref<any>(null)
 let reads=0
 const app={$api:()=>{reads++;return new Promise(done=>responses.push(done))}}
 g.useNuxtApp=()=>app;g.useState=(key:string,init:()=>any)=>{if(!states.has(key))states.set(key,ref(init()));return states.get(key)}
 g.useAuth=()=>({user,sessionVersion:version});g.onMounted=(fn:()=>void)=>mounts.push(fn)
 const scope=effectScope()
 return {scope,version,user,responses,get reads(){return reads},mount(){mounts.splice(0).forEach(fn=>fn())},create(immediate=true){return scope.run(()=>usePracticeCatalog(computed(()=>true),{immediate}))!}}
}
const catalog=[{exam_number:1,question_numbers:[1,2]}]
test('manual start and mounted question page join and reuse the same public catalog',async()=>{
 const h=harness();try{const start=h.create(false);h.mount();assert.equal(h.reads,0)
 const pending=start.load();assert.equal(h.reads,1);const question=h.create();h.mount();assert.equal(h.reads,1)
 h.responses[0]!({data:catalog});assert.deepEqual(await pending,catalog)
 assert.deepEqual(await question.load(),catalog);assert.equal(h.reads,1)
 }finally{h.scope.stop()}
})
test('a changed session discards the old response and does not share it with the new identity',async()=>{
 const h=harness();try{const page=h.create();h.mount();assert.equal(h.reads,1)
 h.version.value++;assert.equal(h.reads,2)
 h.responses[0]!({data:catalog});await new Promise(resolve=>setImmediate(resolve));assert.equal(page.data.value,null)
 const newer=page.load();h.responses[1]!({data:[{exam_number:2,question_numbers:[1]}]});await newer
 assert.equal(page.data.value?.[0]?.exam_number,2);assert.equal(h.reads,2)
 }finally{h.scope.stop()}
})
