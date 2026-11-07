import { randomBytes } from 'node:crypto'
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { loadE2EFixture } from '../scripts/e2e-fixture.mjs'

const { config } = loadE2EFixture()
const publicBlockMessage = '公開する問題の本文・解説・選択肢に空または不正な表示ブロックがあります'
const sourceMessage = '公開する問題には資料名とHTTPS URL、または書名・印刷ページ・PDFページの出典が必要です'

async function assertFitsViewport(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }))
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport)
}

async function saveMaskedScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name)
  await page.screenshot({
    path, fullPage: true, animations: 'disabled',
    mask: [page.locator('input[type="password"], input[type="email"], #name')],
  })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('signup validates fields before requesting and account deletion displays password errors', async ({ page }, testInfo) => {
  const suffix = randomBytes(8).toString('hex')
  const email = `form-${suffix}@example.test`
  const password = `Synthetic-${randomBytes(16).toString('hex')}`
  let signupRequests = 0
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/sign-up/email') signupRequests += 1
  })

  await page.goto('/signup')
  await page.getByLabel('ユーザー名', { exact: true }).fill(`フォーム検証${suffix}`)
  await page.getByLabel('メールアドレス', { exact: true }).fill('invalid-email')
  await page.getByLabel('パスワード', { exact: true }).fill('short')
  await page.getByLabel('確認用パスワード', { exact: true }).fill('different')
  await page.getByRole('button', { name: '登録する', exact: true }).click()
  for (const message of ['メールアドレスの形式を確認してください。', 'パスワードは8文字以上で入力してください。', '確認用パスワードが一致していません。']) {
    await expect(page.getByText(message, { exact: true })).toBeVisible()
  }
  expect(signupRequests).toBe(0)
  await assertFitsViewport(page)
  await saveMaskedScreenshot(page, testInfo, 'signup-validation.png')

  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill(password)
  await page.getByLabel('確認用パスワード', { exact: true }).fill(password)
  await expect(page.locator('.auth-form .form-field-error')).toHaveCount(0)
  await page.getByRole('button', { name: '登録する', exact: true }).click()
  await expect(page).toHaveURL('/')
  expect(signupRequests).toBe(1)

  await page.goto('/account')
  await page.getByRole('button', { name: 'アカウントを削除', exact: true }).click()
  const currentPassword = page.getByLabel('現在のパスワード', { exact: true })
  const deleteButton = page.getByRole('button', { name: '完全に削除する', exact: true })
  await currentPassword.fill('Deliberately-wrong-password')
  await expect(deleteButton).toBeDisabled()
  await page.getByRole('checkbox', { name: /削除後にデータ.*を復元できないことを確認しました。/ }).check()
  const rejectedDeletion = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me' && response.request().method() === 'DELETE' && response.status() === 422)
  await deleteButton.click()
  await rejectedDeletion
  await expect(page.locator('.delete-form .form-field-error')).toContainText('現在のパスワードが正しくありません')
  await expect(currentPassword).toHaveAttribute('aria-invalid', 'true')
  await assertFitsViewport(page)

  await currentPassword.fill(password)
  await expect(page.locator('.delete-form .form-field-error')).toHaveCount(0)
  const acceptedDeletion = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me' && response.request().method() === 'DELETE' && response.status() === 204)
  await deleteButton.click()
  await acceptedDeletion
  await expect(page).toHaveURL('/')
  expect((await page.request.get('/api/v1/me')).status()).toBe(401)
})

test('login shows Japanese errors for throttled requests and unavailable connections', async ({ page }) => {
  let mode: 'limited' | 'offline' = 'limited'
  let loginRequests = 0
  await page.route('**/api/auth/sign-in/email', async route => {
    loginRequests += 1
    if (mode === 'offline') return route.abort('failed')
    await route.fulfill({
      status: 429, contentType: 'application/json', headers: { 'Retry-After': '60' },
      body: JSON.stringify({ code: 'TOO_MANY_REQUESTS', message: 'Synthetic throttling response' }),
    })
  })

  await page.goto('/login')
  await page.getByLabel('メールアドレス', { exact: true }).fill('form-login@example.test')
  await page.getByLabel('パスワード', { exact: true }).fill('Synthetic-login-password')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('操作が集中しています。しばらく待ってからお試しください')
  await expect(page).toHaveURL('/login')
  expect(loginRequests).toBe(1)

  mode = 'offline'
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('ログインできませんでした。もう一度お試しください。')
  expect(loginRequests).toBeGreaterThanOrEqual(2)
  await assertFitsViewport(page)
})

test('admin question form blocks incomplete publication and displays server field errors', async ({ page }, testInfo) => {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const admin = {
    id: 900001, name: 'フォーム検証管理者', email: 'form-admin@example.test', role: 'admin',
    paid_content_access: true, favorite_questions: [],
    membership: { status: 'free', purchased_at: null, expires_at: null },
    verification_access: null, created_at: timestamp,
  }
  await page.route('**/api/v1/me', route => route.fulfill({ json: { data: admin } }))
  await page.route('**/api/auth/get-session**', route => route.fulfill({ json: {
    session: { id: 'synthetic-form-session', userId: String(admin.id), token: 'synthetic-form-token', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: timestamp, updatedAt: timestamp },
    user: { id: String(admin.id), name: admin.name, email: admin.email, role: 'admin', emailVerified: false, createdAt: timestamp, updatedAt: timestamp },
  } }))
  let saveRequests = 0
  await page.route('**/api/v1/admin/questions', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { data: [], meta: { current_page: 1, per_page: 20, total_count: 0, total_pages: 1 } } })
    saveRequests += 1
    const input = route.request().postDataJSON().question
    expect(input.publication_status).toBe('draft')
    expect(input.choices.filter((choice: { is_correct: boolean }) => choice.is_correct)).toHaveLength(1)
    await route.fulfill({ status: 422, json: { error: {
      code: 'validation_error', message: '入力内容を確認してください',
      details: { question_number: ['は同じ試験セット内で既に使用されています'] },
    } } })
  })

  await page.goto('/admin/questions/new')
  await expect(page.getByRole('heading', { name: '問題を作成', exact: true })).toBeVisible()
  // The existing UI starts with one correct choice selected and keeps radio semantics.
  await expect(page.locator('input[name="correct-choice"]:checked')).toHaveCount(1)
  await page.locator('input[name="publication-status"][value="published"]').check()
  await page.getByRole('button', { name: '問題を保存', exact: true }).click()
  await expect(page.getByText(publicBlockMessage, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(sourceMessage, { exact: true })).toBeVisible()
  expect(saveRequests).toBe(0)
  await assertFitsViewport(page)

  // Drafts retain the established ability to save unfinished text blocks.
  await page.locator('input[name="publication-status"][value="draft"]').check()
  const rejectedSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/questions' && response.request().method() === 'POST' && response.status() === 422)
  await page.getByRole('button', { name: '問題を保存', exact: true }).click()
  await rejectedSave
  expect(saveRequests).toBe(1)
  const numberError = page.locator('.admin-question-form .form-field-error').filter({ hasText: '問番号は同じ試験セット内で既に使用されています' })
  await expect(numberError).toBeVisible()
  await expect(page.getByLabel('問番号', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await assertFitsViewport(page)
  await saveMaskedScreenshot(page, testInfo, 'admin-server-validation.png')

  // Changing a field clears the stale server-side error without another write.
  const nextNumber = config.exam.questions_per_exam > 1 ? '2' : ''
  await page.getByLabel('問番号', { exact: true }).fill(nextNumber)
  await expect(numberError).toHaveCount(0)
  expect(saveRequests).toBe(1)
})
