import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { configuration, setConfigurationForTesting } from '../server/core/config.ts'
import { closeDatabase, isolatedTransaction, query, type Database } from '../server/core/db.ts'
import { hasPaidAccess, userPayload, type User } from '../server/core/auth.ts'
import { grantVerification } from '../server/operations/accounts.ts'
import { listFavorites, listHistory, putFavorite } from '../server/services/learning.ts'
import { saveQuestion } from '../server/services/learning-writer.ts'
import type { QuestionInput } from '../server/services/learning-validation.ts'

// Node's default test runner gives this file its own process. Exercise the
// driver's parser and Date serializer under a real non-UTC local timezone.
const originalTimezone = process.env.TZ
process.env.TZ = 'Asia/Tokyo'
process.env.APP_ENV = 'test'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const integration = { skip: !Boolean(process.env.DATABASE_URL || process.env.PGHOST) }
const originalConfiguration = structuredClone(configuration)

after(async () => {
  setConfigurationForTesting(originalConfiguration)
  await closeDatabase()
  if (originalTimezone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimezone
})

async function isolated(action: (db: Database) => Promise<void>) {
  try {
    await isolatedTransaction(async db => {
      // Use an otherwise unused configured exam slot in the migrated test DB.
      setConfigurationForTesting({ ...originalConfiguration, exam: { set_count: 10000,
        questions_per_exam: originalConfiguration.exam.questions_per_exam, choice_labels: [...originalConfiguration.exam.choice_labels] }, payments: { ...originalConfiguration.payments, enabled: false, free_exam_count: 10000 } })
      await query("SET LOCAL TIME ZONE 'UTC'", [], db)
      await query("SET LOCAL lock_timeout='10s'", [], db)
      await action(db)
    })
  } finally {
    setConfigurationForTesting(originalConfiguration)
  }
}

async function createUser(db: Database, createdAt?: Date): Promise<User> {
  const [row] = await query<User>("INSERT INTO users(name,email,role,created_at,updated_at) VALUES('Timezone test',$1,'user',COALESCE($2::timestamp,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP) RETURNING *", [`timezone-${randomUUID()}@example.invalid`, createdAt ?? null], db)
  return row!
}

function questionInput(): QuestionInput {
  const category = configuration.categories.minor[0]!
  return {
    exam_number: configuration.exam.set_count, question_number: 1,
    major_category_code: category.major_category_value, category_code: category.value,
    publication_status: 'published', content_blocks: [{ type: 'text', text: 'Timezone sample' }],
    explanation_blocks: [{ type: 'text', text: 'Sample explanation' }], source_text: 'Self-authored sample | https://example.com/timezone',
    choices: configuration.exam.choice_labels.map((label, index) => ({ choice_label: label,
      content_blocks: [{ type: 'text', text: label }], is_correct: index === 0, display_order: index + 1 })),
  }
}

test('PostgreSQL timestamp-without-time-zone roundtrips preserve UTC under Asia/Tokyo', integration, async () => isolated(async db => {
  assert.equal(new Date('2020-02-03T04:05:06.789Z').getTimezoneOffset(), -540)
  const [legacy] = await query<{ instant: Date }>("SELECT '2020-02-03 04:05:06.789'::timestamp AS instant", [], db)
  assert.equal(legacy!.instant.toISOString(), '2020-02-03T04:05:06.789Z')
  const value = new Date('2020-02-03T04:05:06.789Z')
  const [roundtrip] = await query<{ instant: Date, stored: string }>(`SELECT $1::timestamp AS instant,to_char($1::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS') AS stored`, [value], db)
  assert.equal(roundtrip!.stored, '2020-02-03T04:05:06.789')
  assert.equal(roundtrip!.instant.toISOString(), value.toISOString())
}))

test('verification access uses the requested UTC deadline and expires without a local-time extension', integration, async () => isolated(async db => {
  setConfigurationForTesting({ ...configuration, payments: { ...configuration.payments, enabled: true, free_exam_count: 0 } })
  const owner = await createUser(db)
  const [clock] = await query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now', [], db)
  const now = clock!.now
  const deadline = new Date(now.getTime() + 3600000)
  const result = await grantVerification({ email: owner.email, reason: 'Timezone regression', grantedBy: 'test', expiresAt: deadline.toISOString() }, db)
  assert.equal(result.expires_at, deadline.toISOString())
  const [grant] = await query<{ expires_at: Date, epoch: string }>("SELECT expires_at,(EXTRACT(EPOCH FROM expires_at AT TIME ZONE 'UTC')*1000)::text AS epoch FROM verification_access_grants WHERE user_id=$1", [owner.id], db)
  assert.equal(grant!.expires_at.toISOString(), deadline.toISOString())
  assert.equal(Number(grant!.epoch), deadline.getTime())
  assert.equal(await hasPaidAccess(owner, db), true)
  assert.equal((await userPayload(owner, db)).verification_access?.expires_at, deadline.toISOString())

  // Keep the valid duration while moving the entire grant into the past. If the
  // client serializes JST wall time, this deadline incorrectly remains active.
  await query('UPDATE verification_access_grants SET created_at=$1,expires_at=$2 WHERE user_id=$3', [new Date(now.getTime() - 7200000), new Date(now.getTime() - 3600000), owner.id], db)
  assert.equal(await hasPaidAccess(owner, db), false)
  assert.equal((await userPayload(owner, db)).verification_access, null)
}))

test('account, purchase, history and favorite API timestamps keep their original UTC instant', integration, async () => isolated(async db => {
  const instant = new Date('2020-02-03T04:05:06.789Z')
  const owner = await createUser(db, instant)
  const question = await saveQuestion(questionInput(), { db })
  const [payment] = await query<{ id: number }>("INSERT INTO payments(user_id,stripe_checkout_session_id,stripe_price_id,amount,currency,status,paid_at,created_at,updated_at) VALUES($1,$2,'price_timezone',$3,'jpy','paid',$4,$4,$4) RETURNING id", [owner.id, `cs_${randomUUID()}`, configuration.payments.amount, instant], db)
  await query("INSERT INTO memberships(user_id,source_payment_id,status,activated_at,created_at,updated_at) VALUES($1,$2,'active',$3,$3,$3)", [owner.id, payment!.id, instant], db)
  const payload = await userPayload(owner, db)
  assert.equal(payload.created_at, instant.toISOString())
  assert.equal(payload.membership.purchased_at, instant.toISOString())

  await query('INSERT INTO answer_histories(user_id,question_id,selected_choice_id,is_correct,created_at,updated_at) VALUES($1,$2,$3,true,$4,$4)', [owner.id, question.id, question.choices[0]!.id, instant], db)
  await putFavorite(question.id, owner, db)
  await query('UPDATE favorites SET created_at=$1 WHERE user_id=$2', [instant, owner.id], db)
  assert.equal((await listHistory(owner, {}, db)).data[0]!.answered_at, instant.toISOString())
  assert.equal((await listFavorites(owner, {}, db)).data[0]!.created_at, instant.toISOString())
}))
