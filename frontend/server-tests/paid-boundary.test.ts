import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeExam } from '../server/services/learning.ts'
import { configuration } from '../server/core/config.ts'
import type { User } from '../server/core/auth.ts'
import type { Database } from '../server/core/db.ts'
import { ApiError } from '../server/core/errors.ts'

test('configured paywall keeps exams 1 and 2 free and protects every published exam from 3 onward', async () => {
  assert.equal(configuration.payments.enabled, true)
  assert.equal(configuration.payments.free_exam_count, 2)
  const user = { id: 1, role: 'user' } as User
  const noAccess = { membership: { findFirst: async () => null }, verificationAccessGrant: { findFirst: async () => null } } as unknown as Database
  const paid = { membership: { findFirst: async () => ({ id: 1 }) }, verificationAccessGrant: { findFirst: async () => null } } as unknown as Database
  for (const exam of [1, 2]) await authorizeExam(exam, null, noAccess)
  for (const exam of [3, 4, 5, 6, 7, 8]) {
    await assert.rejects(authorizeExam(exam, null, noAccess), (e: unknown) => e instanceof ApiError && e.status === 401)
    await assert.rejects(authorizeExam(exam, user, noAccess), (e: unknown) => e instanceof ApiError && e.status === 403)
    await authorizeExam(exam, user, paid)
    await authorizeExam(exam, { ...user, role: 'admin' }, noAccess)
  }
})
