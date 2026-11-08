import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {publicSourceReferences,stripSourceParentheses,publicSourceText} from '../shared/sourceReferences.ts'

test('source labels hide nested Japanese and ASCII parentheses while retaining book titles and printed page numbers',()=>{
 assert.equal(stripSourceParentheses('『美術史』p.23（2.pdf：PDF 10（内部）ページ） / p.24 (source.pdf: p.11)'), '『美術史』p.23 / p.24')
 assert.equal(stripSourceParentheses('資料（内部情報'), '資料')
 assert.deepEqual(publicSourceReferences('（内部情報）\n\n'), [])
})
test('source labels never modify a citation link target, including parentheses in URLs',()=>{
 assert.deepEqual(publicSourceReferences('収蔵作品（内部メモ）|https://example.org/work_(detail)'), [{label:'収蔵作品',url:'https://example.org/work_(detail)'}])
 assert.deepEqual(publicSourceReferences('資料（内部）|javascript:alert(1)'), [{label:'資料|javascript:alert',url:null}])
 assert.deepEqual(publicSourceReferences(null), [])
})
test('all eight mock sets render every citation without parenthetical internal metadata and never mutate stored sources',()=>{
 const document=JSON.parse(readFileSync(new URL('../../content/questions.json',import.meta.url),'utf8'))
 const before=JSON.stringify(document)
 assert.equal(document.questions.length,680)
 for(const question of document.questions){const refs=publicSourceReferences(question.source_text);assert.ok(refs.length);for(const ref of refs)assert.ok(!/[()（）]/.test(ref.label));assert.ok(!/[（）]/.test(publicSourceText(question.source_text)));const originalUrls=question.source_text.split('\n').map((line:string)=>line.slice(line.lastIndexOf('|')+1).trim()).filter((value:string)=>/^https:\/\//.test(value));assert.deepEqual(refs.filter(ref=>ref.url).map(ref=>ref.url),originalUrls)}
 assert.equal(JSON.stringify(document),before)
})
