import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const document=JSON.parse(readFileSync(new URL('../content/questions.json',import.meta.url),'utf8'))
let fields=0
function check(value){
 if(Array.isArray(value))return value.forEach(check)
 if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){
  if(key==='source_text')continue
  if(key==='text'&&typeof item==='string'){fields++;assert.ok(!/本書|教科書|テキスト|教材|公式問題集/.test(item),'Displayed wording depends on an unavailable book')}
  else check(item)
 }
}
check(document)
console.log(JSON.stringify({status:'passed',questions:document.questions.length,displayed_text_fields:fields,book_dependent_wording:0}))
