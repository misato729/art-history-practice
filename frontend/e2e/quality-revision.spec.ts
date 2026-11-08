import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const archive=JSON.parse(readFileSync(new URL('../../content/questions.json',import.meta.url),'utf8'))
for(const [exam,number]of[[1,14],[1,82],[2,8],[2,85]] as const){
 test(`revised ${exam}-${number} renders, grades and shows public source information`,async({page,isMobile})=>{
  if(isMobile)await page.setViewportSize({width:390,height:844})
  const question=archive.questions.find((q:any)=>q.exam_number===exam&&q.question_number===number)
  await page.goto(`/practice/${exam}/${number}`)
  await expect(page.getByRole('heading',{name:`問${number}`,exact:true})).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(4)
  if(number>80)await expect(page.getByRole('region',{name:'共通資料・図版',exact:true})).toBeVisible()
  const responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/answer'))
  await page.locator('.choices label').nth(question.choices.findIndex((c:any)=>c.is_correct)).click()
  await page.getByRole('button',{name:'回答する',exact:true}).click()
  const response=await responsePromise
  expect(response.status()).toBe(200)
  const answer=(await response.json()).data
  expect(answer.is_correct).toBe(true);expect(answer.source_text).not.toContain('（')
  await expect(page.getByText('正解です',{exact:true})).toBeVisible()
  await expect(page.locator('.source-section')).toBeVisible()
  await expect(page.locator('.source-section')).not.toContainText('（')
  await expect(page.locator('.source-section')).not.toContainText('.pdf')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 })
}
