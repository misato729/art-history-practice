import {test,expect} from '@playwright/test'

test('assigned categories show correct counts and start filtered practice without extra catalog requests',async({page})=>{
 let catalogs=0
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/exams')catalogs++})
 await page.goto('/')
 await page.getByRole('tab',{name:'条件を指定',exact:true}).click()
 const ancient=page.getByRole('checkbox',{name:'古代の美術',exact:true})
 await expect(ancient).toBeVisible()
 await expect(page.locator('.condition-submit strong')).toHaveText('全170問')
 await ancient.check()
 await expect(page.locator('.condition-submit strong')).toHaveText('全8問')
 expect(catalogs).toBe(1)
 await page.getByRole('button',{name:'順番に始める',exact:true}).click()
 await expect(page.getByRole('heading',{name:'問1',exact:true})).toBeVisible()
 await expect(page.getByText('西洋美術史 / 古代の美術',{exact:true})).toBeVisible()
 expect(new URL(page.url()).searchParams.get('study_category_codes')).toBe('part_01_section_01')
 expect(catalogs).toBe(1)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('taxonomy API preserves intersection, scope and paid authorization and never broadens a mismatched question',async({page})=>{
 const parent=await page.request.get('/api/v1/exams?study_part_code=part_02')
 expect(parent.status()).toBe(200);const sets=(await parent.json()).data
 expect(sets).toHaveLength(8);for(const set of sets)expect(set.question_numbers).toHaveLength(25)
 const empty=await page.request.get('/api/v1/exams?study_part_code=part_02&study_scope_codes=scope_01');expect((await empty.json()).data).toEqual([])
 const mismatch=await page.request.get('/api/v1/questions/next?exam_number=1&question_number=1&study_category_codes=part_02_section_01');expect(mismatch.status()).toBe(404)
 const paid=await page.request.get('/api/v1/questions/next?exam_number=3&question_number=1&study_category_codes=part_01_section_01');expect(paid.status()).toBe(401)
 const unknown=await page.request.get('/api/v1/exams?study_category_codes=unknown');expect(unknown.status()).toBe(400)
 await page.goto('/practice/1/1?study_category_codes=part_02_section_01')
 await expect(page.getByRole('heading',{name:'問題を表示できません',exact:true})).toBeVisible();await expect(page.getByRole('radio')).toHaveCount(0)
})
