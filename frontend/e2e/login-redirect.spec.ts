import {test,expect} from '@playwright/test'
import {randomUUID} from 'node:crypto'
for(const redirect of ['/login','/favorites'])test(`successful login returns home with redirect=${redirect}`,async({page,baseURL})=>{
 const email=`login-${randomUUID()}@example.invalid`,password='Isolated-login-password-2026'
 expect((await page.request.post('/api/auth/sign-up/email',{headers:{Origin:baseURL!},data:{name:'Login fixture',email,password}})).ok()).toBe(true)
 expect((await page.request.post('/api/auth/sign-out',{headers:{Origin:baseURL!},data:{}})).ok()).toBe(true)
 await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`)
 await page.getByLabel('メールアドレス',{exact:true}).fill(email)
 await page.getByLabel('パスワード',{exact:true}).fill(password)
 await page.getByRole('button',{name:'ログイン',exact:true}).click()
 await expect(page).toHaveURL('/')
 const me=await page.request.get('/api/v1/me');expect(me.status()).toBe(200);expect((await me.json()).data.email).toBe(email)
})
