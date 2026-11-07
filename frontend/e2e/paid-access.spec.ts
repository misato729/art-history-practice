import {test,expect} from '@playwright/test'

test('paid navigation stays static, keeps two free exams and includes all eight exams',async({page,isMobile})=>{
 const requests:string[]=[]
 page.on('request',r=>{if(['/api/v1/exams','/api/v1/study_categories','/api/v1/questions/next'].includes(new URL(r.url()).pathname))requests.push(new URL(r.url()).pathname)})
 await page.goto('/')
 await expect(page.locator('.exam-card')).toHaveCount(8)
 await expect(page.locator('.exam-card').nth(1)).toHaveAttribute('href','/practice/2/1')
 await expect(page.locator('.exam-card').nth(2)).toHaveAttribute('href','/premium')
 for(const n of [6,7,8])await expect(page.locator('.exam-card').nth(n-1)).toHaveAttribute('href','/premium')
 if(isMobile)await page.getByRole('button',{name:'試験セットを開く',exact:true}).click()
 await page.getByRole('button',{name:'模擬試験2の問題一覧を開く',exact:true}).click()
 await expect(page.locator('#exam-2-questions a')).toHaveCount(85)
 await page.getByRole('button',{name:'模擬試験3の問題一覧を開く',exact:true}).click()
 await expect(page.locator('#exam-3-questions a')).toHaveCount(85)
 await expect(page.locator('#exam-3-questions a').first()).toHaveAttribute('href','/premium')
 expect(requests).toEqual([])
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('the API and direct question route deny paid questions while free exam 2 still works',async({page})=>{
 await page.goto('/practice/2/1')
 await expect(page.getByRole('heading',{name:'問1',exact:true})).toBeVisible()
 const free=await page.request.get('/api/v1/questions/next?exam_number=2&question_number=1')
 expect(free.status()).toBe(200)
 for(const n of [3,4,5,6,7,8]){
  const denied=await page.request.get(`/api/v1/questions/next?exam_number=${n}&question_number=1`)
  expect(denied.status()).toBe(401)
  expect((await denied.json()).data).toBeUndefined()
 }
 await page.goto('/practice/3/1')
 await expect(page.getByRole('heading',{name:'模擬試験3はプレミアム会員向けです',exact:true})).toBeVisible()
 await expect(page.getByRole('radio')).toHaveCount(0)
 await page.goto('/premium')
 await expect(page.getByRole('heading',{name:'現在は販売準備中です',exact:true})).toBeVisible()
 await expect(page.getByRole('button',{name:/Stripeで.*支払う/})).toHaveCount(0)
})
