import {readFileSync} from 'node:fs'
import {test,expect} from '@playwright/test'
const revision=JSON.parse(readFileSync(new URL('../../content/revisions/mock02-textbook-v2/revision.json',import.meta.url),'utf8'))
test('V2 source: static numbers, independent ordinary question and shared application grading',async({page,isMobile},info)=>{
 const catalogRequests:string[]=[]
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/exams')catalogRequests.push(r.url())})
 await page.goto('/')
 await expect(page.getByRole('heading',{name:'問題演習を始める'})).toBeVisible()
 if(isMobile)await page.getByRole('button',{name:'試験セットを開く',exact:true}).click()
 await page.getByRole('button',{name:'模擬試験2の問題一覧を開く',exact:true}).click()
 const nav=page.locator('#exam-2-questions');await expect(nav.getByRole('link')).toHaveCount(85)
 expect(catalogRequests).toEqual([])
 await nav.getByRole('link',{name:'模擬試験2・問1',exact:true}).click()
 await expect(page.getByRole('heading',{name:'問1',exact:true})).toBeVisible()
 await expect(page.getByRole('radio')).toHaveCount(4)
 await expect(page.locator('.practice-materials')).toHaveCount(0)
 await expect(page.getByRole('heading',{name:'解答解説',exact:true})).toHaveCount(0)
 for(const n of [81,85]){
  await page.goto(`/practice/2/${n}`)
  await expect(page.getByRole('heading',{name:`問${n}`,exact:true})).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(4)
  const materials=page.locator('.practice-materials.is-shared');await expect(materials).toBeVisible()
  const details=materials.locator('details').first();if(!await details.evaluate(e=>e.hasAttribute('open')))await details.locator('summary').click()
  await expect(materials.locator('img')).toHaveCount(4)
  await expect.poll(()=>materials.locator('img').evaluateAll(imgs=>imgs.every(i=>(i as HTMLImageElement).complete&&(i as HTMLImageElement).naturalWidth>0))).toBe(true)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.screenshot({path:info.outputPath(`mock02-v2-${n}.png`),fullPage:true})
  if(n===81){
   const expected=revision.questions.find((q:any)=>q.question_number===81),index=expected.choices.findIndex((c:any)=>c.is_correct)
   await page.getByRole('radio').nth(index).check()
   const answerPromise=page.waitForResponse(r=>/\/api\/v1\/questions\/\d+\/answer$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST')
   await page.getByRole('button',{name:'回答する',exact:true}).click()
   const answer=await answerPromise;expect(answer.status()).toBe(200);expect((await answer.json()).data.is_correct).toBe(true)
   await expect(page.getByRole('heading',{name:'解答解説',exact:true})).toBeVisible()
   await page.getByRole('button',{name:'次の問題',exact:true}).click()
   await expect(page.getByRole('heading',{name:'問82',exact:true})).toBeVisible()
   await expect(page.locator('.practice-materials.is-shared')).toBeVisible()
  }
 }
})
