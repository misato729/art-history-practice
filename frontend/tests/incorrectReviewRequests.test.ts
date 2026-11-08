import assert from 'node:assert/strict'
import test from 'node:test'
import {computed,ref,watch,effectScope,onScopeDispose} from 'vue'
import {useIncorrectReview} from '../app/composables/useIncorrectReview.ts'
const g=globalThis as any
g.computed=computed;g.ref=ref;g.watch=watch;g.onScopeDispose=onScopeDispose
function harness(){
 const states=new Map(),responses:((x:any)=>void)[]=[],version=ref(0),user=ref<any>({id:1,role:'user',paid_content_access:false});let reads=0
 const app={$api:()=>{reads++;return new Promise(done=>responses.push(done))}}
 g.useNuxtApp=()=>app;g.useState=(key:string,init:()=>any)=>{if(!states.has(key))states.set(key,ref(init()));return states.get(key)}
 g.useAuth=()=>({user,isLoggedIn:computed(()=>!!user.value),sessionVersion:version,authHeaders:computed(()=>({})),ensureCurrentUser:async()=>user.value})
 const scope=effectScope(),review=scope.run(()=>useIncorrectReview())!
 return {scope,review,responses,version,get reads(){return reads}}
}
const response=(n:number)=>({data:[{question_id:n,exam_number:1,question_number:n}],meta:{total_count:1}})
test('review force joins an active request; unchanged tab loads reuse the result',async()=>{
 const h=harness();try{const first=h.review.load(),forced=h.review.load({force:true});assert.equal(h.reads,1);assert.equal(first,forced)
 h.responses[0]!(response(1));await first;assert.deepEqual(await h.review.load(),[{examNumber:1,questionNumber:1}]);assert.equal(h.reads,1)
 const externalUpdate=h.review.load({force:true});assert.equal(h.reads,2);h.responses[1]!(response(2));await externalUpdate;assert.deepEqual(h.review.positions.value,[{examNumber:1,questionNumber:2}])
 }finally{h.scope.stop()}
})
test('answer invalidation bypasses the old request and cannot restore its stale review result',async()=>{
 const h=harness();try{const stale=h.review.load();h.review.invalidate();const fresh=h.review.load();assert.equal(h.reads,2)
 h.responses[0]!(response(1));await stale;assert.deepEqual(h.review.positions.value,[])
 h.responses[1]!(response(2));await fresh;assert.deepEqual(h.review.positions.value,[{examNumber:1,questionNumber:2}])
 h.version.value++;assert.deepEqual(h.review.positions.value,[]);assert.equal(h.review.loaded.value,false)
 }finally{h.scope.stop()}
})
