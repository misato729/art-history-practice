import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (name: string) => readFileSync(new URL(`../app/pages/${name}.vue`, import.meta.url), 'utf8')

test('published legal pages are accessible without application login and omit internal draft instructions', () => {
  for (const name of ['terms', 'privacy-policy', 'commercial-disclosure']) {
    const page = source(name)
    assert.doesNotMatch(page, /middleware\s*:\s*['"](?:auth|admin)/)
    assert.doesNotMatch(page, /(?:authenticate|ensureCurrentUser|authHeaders)/)
    assert.doesNotMatch(page, /テンプレートの草案/)
    assert.match(page, /SITE.name/)
    assert.doesNotMatch(page, /情報教認|高等学校|Netlify|Sentry|2026年10月21日/)
  }
})

test('commercial disclosure retains seller readiness checks and request-based contact disclosure', () => {
  const page = source('commercial-disclosure')
  assert.match(page, /isSellerInformationComplete\(seller.value\)/)
  assert.match(page, /請求があった場合に遅滞なく開示/)
  assert.match(page, /購入前の請求にも/)
  assert.match(page, /申込みの意思決定に先立って十分な時間的余裕/)
  assert.match(page, /PRICE_LABEL/)
  assert.match(page, /immediate: PAYMENTS_ENABLED/)
})
