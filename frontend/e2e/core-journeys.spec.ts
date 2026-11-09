import { randomBytes } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { loadE2EFixture } from '../scripts/e2e-fixture.mjs'

const { config, question } = loadE2EFixture()
const practicePath = `/practice/${question.exam_number}/${question.question_number}`
const correctIndex = question.choices.findIndex((choice: { is_correct: boolean }) => choice.is_correct)

async function assertFitsViewport(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }))
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport)
}

async function showQuestion(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/questions/next' && response.ok())
  await page.goto(practicePath)
  await expect(page.getByRole('heading', { name: `問${question.question_number}`, exact: true })).toBeVisible()
  return (await (await response).json()).data
}

async function answerCorrectly(page: Page) {
  // Users can select the full choice label, including on a touch screen.
  await page.locator('.choices label').nth(correctIndex).click()
  await expect(page.getByRole('radio').nth(correctIndex)).toBeChecked()
  await page.getByRole('button', { name: '回答する', exact: true }).click()
  await expect(page.getByText('正解です', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '解答解説', exact: true })).toBeVisible()
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'メニューを開く', exact: true }).click()
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.site-header .account-link')).toHaveCount(0)
  // The narrow layout offers login in its drawer rather than this header link.
  await expect(page.locator('.site-header .login-link')).toHaveAttribute('href', '/login')
}

test('anonymous practice hides answers until submitting and fits the screen', async ({ page }) => {
  const publicQuestion = await showQuestion(page)
  for (const key of ['explanation_blocks', 'source_text', 'correct_choice']) expect(Object.hasOwn(publicQuestion, key)).toBe(false)
  for (const choice of publicQuestion.choices) expect(Object.hasOwn(choice, 'is_correct')).toBe(false)
  await expect(page.getByRole('radio')).toHaveCount(config.exam.choice_labels.length)
  await expect(page.getByRole('heading', { name: '解答解説', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '回答する', exact: true })).toBeDisabled()
  await assertFitsViewport(page)
  await answerCorrectly(page)
  await assertFitsViewport(page)
  const historyResponse = await page.request.get('/api/v1/answer_histories')
  expect(historyResponse.status()).toBe(401)
  const deniedAdmin = await page.request.get('/api/v1/admin/questions')
  expect(deniedAdmin.status()).toBe(401)
})

test('registration, history, favorites, relogin and cross-tab logout stay consistent', async ({ page, context }) => {
  const suffix = randomBytes(8).toString('hex')
  const email = `browser-${suffix}@example.test`
  const password = `Synthetic-${randomBytes(16).toString('hex')}`
  await page.goto('/signup')
  await page.getByLabel('ユーザー名', { exact: true }).fill(`検証会員${suffix}`)
  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill(password)
  await page.getByLabel('確認用パスワード', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登録する', exact: true }).click()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.site-header .account-link')).toBeVisible()

  const cookies = await context.cookies()
  const sessionCookie = cookies.find(cookie => cookie.name.endsWith('session_token'))
  expect(sessionCookie).toBeDefined()
  expect(sessionCookie?.httpOnly).toBe(true)
  expect(sessionCookie?.sameSite).toBe('Lax')
  const deniedAdmin = await page.request.get('/api/v1/admin/questions')
  expect(deniedAdmin.status()).toBe(403)

  await showQuestion(page)
  await page.getByRole('button', { name: 'お気に入りに登録する', exact: true }).click()
  await expect(page.getByRole('button', { name: 'お気に入りから解除する', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await answerCorrectly(page)
  await page.goto('/history')
  await expect(page.getByRole('heading', { name: '解答履歴', exact: true })).toBeVisible()
  await expect(page.locator('.history-card')).toHaveCount(1)
  await page.locator('.history-card a').click()
  await expect(page).toHaveURL(/answer_history_id=\d+/)
  await expect(page.getByRole('heading', { name: '解答解説', exact: true })).toBeVisible()
  await page.goto('/favorites')
  await expect(page.locator('.favorite-card')).toHaveCount(1)
  await page.reload()
  await expect(page).toHaveURL('/favorites')
  await expect(page.locator('.favorite-card')).toHaveCount(1)
  await assertFitsViewport(page)
  await logout(page)

  // Successful login returns to the homepage even after a protected URL.
  await page.goto('/favorites')
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill('Deliberately-wrong-password')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('メールアドレスまたはパスワードが正しくありません')
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await page.getByLabel('パスワード', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page).toHaveURL('/')
  await page.goto('/favorites')
  await expect(page.locator('.favorite-card')).toHaveCount(1)
  const firstTabSession = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/get-session' && response.ok())
  await page.goto('/history')
  await firstTabSession
  await expect(page.locator('.history-card')).toHaveCount(1)

  const otherTab = await context.newPage()
  const secondTabSession = otherTab.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/get-session' && response.ok())
  await otherTab.goto('/favorites')
  await secondTabSession
  await expect(otherTab.locator('.favorite-card')).toHaveCount(1)
  // Playwright can interact with a background page; model a real tab switch.
  await page.bringToFront()
  await logout(page)
  await otherTab.bringToFront()
  await expect(otherTab.locator('.site-header .account-link')).toHaveCount(0)
  await expect(otherTab.locator('.site-header .login-link')).toHaveAttribute('href', '/login')
  await expect(otherTab.getByRole('heading', { name: 'ログインが必要です', exact: true })).toBeVisible()
  await expect(otherTab.locator('.favorite-card')).toHaveCount(0)
  const historyAfterLogout = await otherTab.request.get('/api/v1/answer_histories')
  expect(historyAfterLogout.status()).toBe(401)
  await otherTab.reload()
  await expect(otherTab).toHaveURL(/\/login\?redirect=/)
  await otherTab.close()
})

test('outdated history uses a neutral label and opens the current question without an old answer', async ({ page }) => {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const user = { id: 910001, name: '合成の履歴検証', email: 'history-regression@example.test', role: 'user', paid_content_access: false,
    favorite_questions: [], membership: { status: 'free', purchased_at: null, expires_at: null }, verification_access: null, created_at: timestamp }
  await page.route('**/api/v1/me', route => route.fulfill({ json: { data: user } }))
  await page.route('**/api/auth/get-session**', route => route.fulfill({ json: {
    session: { id: 'synthetic-history-session', userId: String(user.id), token: 'synthetic-history-token', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: timestamp, updatedAt: timestamp },
    user: { id: String(user.id), name: user.name, email: user.email, role: user.role, emailVerified: false, createdAt: timestamp, updatedAt: timestamp },
  } }))
  await page.route('**/api/v1/answer_histories?**', route => route.fulfill({ json: {
    data: [{ id: 99, locked: false, is_outdated: true, question_version: 1, answered_at: timestamp, question: { id: 731, exam_number: question.exam_number, question_number: question.question_number } }],
    meta: { current_page: 1, per_page: 20, total_count: 1, total_pages: 1 },
  } }))
  await page.goto('/history')
  const card = page.locator('.history-card')
  await expect(card).toHaveCount(1)
  await expect(card.locator('.result-badge')).toHaveText('更新前の回答')
  await expect(card.locator('.selected-answer')).toHaveCount(0)
  await expect(card.getByRole('link')).toHaveAttribute('href', practicePath)
  await card.getByRole('link').click()
  await expect(page).toHaveURL(practicePath)
  await expect(page.getByRole('heading', { name: `問${question.question_number}`, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '解答解説', exact: true })).toHaveCount(0)
  await expect(page.getByRole('radio')).toHaveCount(question.choices.length)
  await expect(page.locator('input[type="radio"]:checked')).toHaveCount(0)
  await assertFitsViewport(page)
})
