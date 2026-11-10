import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {createDatabase} from '../server/core/db.ts'
import {e2eSettings} from '../scripts/e2e-settings.mjs'
const archive=JSON.parse(readFileSync(new URL('../../content/questions.json',import.meta.url),'utf8'))
test('received exams keep images, shared material, four choices and grading on desktop and mobile',async({page,baseURL})=>{
 test.setTimeout(180000)
 const email=`received-${randomUUID()}@example.invalid`
 const signup=await page.request.post('/api/auth/sign-up/email',{headers:{Origin:baseURL!},data:{name:'Received browser fixture',email,password:'Isolated-test-password-2026'}})
 expect(signup.ok()).toBe(true)
 const settings=e2eSettings(),maintenance=new pg.Client({connectionString:settings.maintenance.toString()});await maintenance.connect()
 let databaseName:string
 try{const result=await maintenance.query("SELECT datname FROM pg_database WHERE datname LIKE 'exam_e2e_%_test'");expect(result.rows).toHaveLength(1);databaseName=result.rows[0].datname}finally{await maintenance.end()}
 expect(databaseName!).toMatch(/^exam_e2e_[a-f0-9]{24}_test$/)
 const url=new URL(settings.maintenance);url.pathname='/'+databaseName!;const db=createDatabase(url.toString())
 try{const user=await db.user.findUniqueOrThrow({where:{email}});await db.verificationAccessGrant.create({data:{user_id:user.id,reason:'Isolated browser fixture',granted_by:'Playwright',expires_at:new Date(Date.now()+3600000),created_at:new Date(),updated_at:new Date()}})}finally{await db.$disconnect()}
 for(const exam of[3,4,5,6,7,8])for(const q of[archive.questions.find((q:any)=>q.exam_number===exam&&q.question_number<=80&&q.content_blocks.some((b:any)=>b.type==='image')),archive.questions.find((q:any)=>q.exam_number===exam&&q.question_number===81)]){
  await page.goto(`/practice/${exam}/${q.question_number}`)
  await expect(page.getByRole('heading',{name:`問${q.question_number}`,exact:true})).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(4)
  if(q.question_number<=80)await expect(page.getByRole('region',{name:'共通資料・図版',exact:true})).toHaveCount(0)
  else await expect(page.getByRole('region',{name:'共通資料・図版',exact:true})).toBeVisible()
  await expect(page.locator('.artwork-image img, .artwork-figure img').first()).toBeVisible()
  await expect.poll(()=>page.locator('.artwork-thumbnail').first().evaluate(e=>(e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.locator('.artwork-enlarge').first().click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click()
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/answer'))
  await page.locator('.choices label').nth(q.choices.findIndex((c:any)=>c.is_correct)).click();await page.getByRole('button',{name:'回答する',exact:true}).click()
  expect((await pending).status()).toBe(200);await expect(page.getByText('正解です',{exact:true})).toBeVisible()
  await expect(page.locator('.source-section')).not.toContainText('（')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true)
 }
 const tableQuestion=archive.questions.find((q:any)=>q.question_number<=80&&q.content_blocks.some((b:any)=>b.type==='table'))
 const expectedTable=tableQuestion.content_blocks.find((b:any)=>b.type==='table')
 await page.goto(`/practice/${tableQuestion.exam_number}/${tableQuestion.question_number}`)
 const table=page.getByRole('table')
 await expect(table.getByRole('columnheader')).toHaveText(expectedTable.headers)
 await expect(table.getByRole('cell')).toHaveText(expectedTable.rows.flat())
 await expect(page.getByRole('radio')).toHaveCount(4)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)

})
