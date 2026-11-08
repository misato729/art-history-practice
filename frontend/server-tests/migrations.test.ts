import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import pg from 'pg'
import { closeDatabase, createDatabase, query, type Database } from '../server/core/db.ts'
import { OperationError } from '../server/operations/content.ts'
import { migrate, migrationRunner, BASELINE_MIGRATION, MIGRATIONS_TABLE, BASELINE_CHECKS,
  BASELINE_PARTIAL_INDEXES, assertBaselineFeatures, normalizedExpression } from '../server/database/migrate.ts'

process.env.APP_ENV = 'test'
const testUrl = process.env.TEST_DATABASE_URL
const integration = { skip: !testUrl }
const expectedMigrations = [BASELINE_MIGRATION, '20261024010000_library_rate_limits', '20261030020000_grouped_questions', '20261104010000_study_categories', '20261108020000_question_study_categories']
const baselineSql = await readFile(new URL(`../prisma/migrations/${BASELINE_MIGRATION}/migration.sql`, import.meta.url), 'utf8')
after(closeDatabase)
const features = () => ({
  checks: Object.entries(BASELINE_CHECKS).map(([key, expression]) => ({ table_name: key.split('/')[0]!, name: key.split('/')[1]!, expression })),
  indexes: Object.entries(BASELINE_PARTIAL_INDEXES).map(([key, value]) => ({ table_name: key.split('/')[0]!, name: key.split('/')[1]!, column_name: value.column, predicate: value.predicate, unique: true, columns: 1, valid: true })),
})

test('deployment uses Prisma Migrate without resetting, resolving or seeding a DB', async () => {
  const calls: string[][] = []
  const run = migrationRunner(async args => { calls.push(args); return 0 }, async () => { throw new Error('No implicit baseline') })
  assert.deepEqual(await run(), { migration_status: 'up_to_date' })
  assert.deepEqual(calls, [['migrate', 'deploy']])
  await assert.rejects(run({ query: () => {} } as never), OperationError)
})

test('baseline resolves only after successful schema diff and PostgreSQL feature validation', async () => {
  const calls: string[] = []
  const run = migrationRunner(async args => { calls.push(args.join(' ')); return 0 }, async () => { calls.push('verify constraints') })
  assert.deepEqual(await run({ baseline: true }), { migration_status: 'baselined', baseline: BASELINE_MIGRATION })
  assert.deepEqual(calls, ['migrate diff --from-config-datasource --to-schema prisma/baseline.prisma --exit-code', 'verify constraints', `migrate resolve --applied ${BASELINE_MIGRATION}`])
})

test('drift, unreachable DBs and missing PostgreSQL features never produce a baseline', async () => {
  for (const exit of [1, 2]) {
    const calls: string[][] = []
    const run = migrationRunner(async args => { calls.push(args); return exit }, async () => { throw new Error('Must not run') })
    await assert.rejects(run({ baseline: true }), OperationError)
    assert.equal(calls.length, 1)
  }
  const calls: string[][] = []
  const run = migrationRunner(async args => { calls.push(args); return 0 }, async () => { throw new OperationError('Synthetic feature drift') })
  await assert.rejects(run({ baseline: true }), OperationError)
  assert.equal(calls.length, 1)
})

test('Prisma command failure produces a safe message without command output or connection details', async () => {
  const run = migrationRunner(async () => 1, async () => {})
  await assert.rejects(run({ databaseUrl: 'postgresql://synthetic:secret@localhost/test' }), error => error instanceof OperationError && !error.message.includes('secret'))
})

test('baseline validates every CHECK and partial unique index, preserving literal values', () => {
  const valid = features()
  assert.doesNotThrow(() => assertBaselineFeatures(valid.checks, valid.indexes))
  for (let index = 0; index < valid.checks.length; index++) assert.throws(() => assertBaselineFeatures(valid.checks.filter((_, current) => current !== index), valid.indexes), OperationError)
  for (let index = 0; index < valid.indexes.length; index++) assert.throws(() => assertBaselineFeatures(valid.checks, valid.indexes.filter((_, current) => current !== index)), OperationError)
  const changed = features(); changed.indexes[0]!.unique = false
  assert.throws(() => assertBaselineFeatures(changed.checks, changed.indexes), OperationError)
  changed.indexes[0]!.unique = true; changed.indexes[0]!.predicate = 'is_correct = false'
  assert.throws(() => assertBaselineFeatures(changed.checks, changed.indexes), OperationError)
  assert.equal(normalizedExpression("role IN ('user', 'admin')"), normalizedExpression("((role)::text = ANY ((ARRAY['user'::character varying, 'admin'::character varying])::text[]))"))
  assert.notEqual(normalizedExpression("role IN ('user', 'admin')"), normalizedExpression("role IN ('user', 'admin ()')"))
})

/** Schema names are generated here; no application schema or DB is reused. */
async function isolated(run: (db: Database, databaseUrl: string, raw: pg.Client) => Promise<void>) {
  const url = new URL(testUrl!)
  if (!['localhost', '127.0.0.1', '[::1]', 'db'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) throw new Error('Migration tests require an explicit local test database')
  const schema = `prisma_migration_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: url.toString() })
  const raw = new pg.Client({ connectionString: url.toString(), options: `-c search_path=${schema} -c timezone=UTC` })
  await admin.connect()
  let db: ReturnType<typeof createDatabase> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    url.searchParams.set('schema', schema)
    db = createDatabase(url.toString())
    await raw.connect()
    await run(db, url.toString(), raw)
  } finally {
    await db?.$disconnect()
    await raw.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
}

test('Prisma Migrate deploys an empty schema once and manages its checksum ledger', integration, () => isolated(async (db, databaseUrl) => {
  await migrate({ databaseUrl })
  const ledger = await query<{ migration_name: string, checksum: string }>(`SELECT migration_name,checksum FROM ${MIGRATIONS_TABLE}`, [], db)
  assert.deepEqual(ledger.map(row => row.migration_name).sort(), expectedMigrations)
  assert.match(ledger[0]!.checksum, /^[a-f0-9]{64}$/)
  await migrate({ databaseUrl })
  assert.equal((await query(`SELECT 1 FROM ${MIGRATIONS_TABLE}`, [], db)).length, expectedMigrations.length)
  const created = await db.user.create({ data: { name: 'Migration test', email: 'migration@example.invalid', created_at: new Date(), updated_at: new Date() } })
  assert.equal(typeof created.id, 'bigint')
  assert.equal(created.email_verified, false)
}))

// The previous runner retained both node-pg-migrate and Nitro checksum ledgers;
// templates derived from Rails can also retain its two bookkeeping tables.
async function createLegacyLedgers(raw: pg.Client) {
  await raw.query(`CREATE TABLE pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
    CREATE TABLE nitro_schema_migrations (version varchar(255) PRIMARY KEY, sha256 varchar(64) NOT NULL, applied_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE schema_migrations (version varchar NOT NULL PRIMARY KEY);
    CREATE TABLE ar_internal_metadata (key varchar NOT NULL PRIMARY KEY, value varchar, created_at timestamp(6) NOT NULL, updated_at timestamp(6) NOT NULL)`)
  for (const version of ['001_preserve_rails_schema.sql', '002_better_auth.sql']) {
    const sql = await readFile(new URL(`../server/database/migrations/${version}`, import.meta.url))
    await raw.query('INSERT INTO nitro_schema_migrations(version,sha256) VALUES($1,$2)', [version, createHash('sha256').update(sql).digest('hex')])
    await raw.query('INSERT INTO pgmigrations(name,run_on) VALUES($1,$2)', [version.replace(/\.sql$/, ''), new Date('2026-01-01T00:00:00.000Z')])
  }
  await raw.query("INSERT INTO schema_migrations(version) VALUES('20260101000000')")
  await raw.query("INSERT INTO ar_internal_metadata(key,value,created_at,updated_at) VALUES('environment','test',$1,$1)", [new Date('2026-01-01T00:00:00.000Z')])
}
async function legacyLedgerRows(raw: pg.Client) {
  const rows = []
  for (const table of ['pgmigrations', 'nitro_schema_migrations', 'schema_migrations', 'ar_internal_metadata']) {
    rows.push({ table, rows: (await raw.query(`SELECT * FROM ${table} ORDER BY 1`)).rows })
  }
  return rows
}

test('explicit baseline retains existing IDs, rows and all historical migration ledgers', integration, () => isolated(async (db, databaseUrl, raw) => {
  await raw.query(baselineSql)
  await createLegacyLedgers(raw)
  const ledgers = await legacyLedgerRows(raw)
  const owner = await db.user.create({ data: { name: 'Existing synthetic', email: 'existing@example.invalid', created_at: new Date(), updated_at: new Date() } })
  await migrate({ databaseUrl, baseline: true })
  assert.deepEqual(await db.user.findUnique({ where: { id: owner.id } }), owner)
  await migrate({ databaseUrl })
  assert.equal((await query(`SELECT 1 FROM ${MIGRATIONS_TABLE}`, [], db)).length, expectedMigrations.length)
  assert.deepEqual(await legacyLedgerRows(raw), ledgers, 'baseline and deploy must leave historical ledger rows unchanged')
}))

test('historical ledger exemptions do not hide unknown application tables', integration, () => isolated(async (db, databaseUrl, raw) => {
  await raw.query(baselineSql)
  await createLegacyLedgers(raw)
  const ledgers = await legacyLedgerRows(raw)
  await raw.query('CREATE TABLE unexpected_domain_data (id integer PRIMARY KEY, value text NOT NULL)')
  await raw.query("INSERT INTO unexpected_domain_data(id,value) VALUES(1,'Synthetic preserved row')")
  await assert.rejects(migrate({ databaseUrl, baseline: true }), OperationError)
  assert.equal((await query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', [MIGRATIONS_TABLE], db))[0]!.relation, null)
  assert.deepEqual((await raw.query('SELECT * FROM unexpected_domain_data')).rows, [{ id: 1, value: 'Synthetic preserved row' }])
  assert.deepEqual(await legacyLedgerRows(raw), ledgers)
}))

test('an incompatible existing schema is rejected before baseline adoption', integration, () => isolated(async (db, databaseUrl, raw) => {
  await raw.query(baselineSql)
  await raw.query('ALTER TABLE users DROP CONSTRAINT users_role_valid')
  await assert.rejects(migrate({ databaseUrl, baseline: true }), OperationError)
  assert.equal((await query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', [MIGRATIONS_TABLE], db))[0]!.relation, null)
}))


test('the library migration preserves active hashed buckets and does not revive expired ones', integration, () => isolated(async (db, databaseUrl, raw) => {
  await raw.query(baselineSql)
  const future = new Date(Date.now() + 600000)
  await raw.query('INSERT INTO api_rate_limit_buckets(key,request_count,expires_at) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$3)',
    ['a'.repeat(64), 30, future, 'b'.repeat(64), 10, new Date(Date.now()-10000), 'c'.repeat(64), '2147483648'])
  await migrate({ databaseUrl, baseline: true })
  await migrate({ databaseUrl })
  assert.deepEqual(await db.rateLimiterFlexible.findMany({orderBy:{key:'asc'}}), [
    {key:'a'.repeat(64),points:30,expire:BigInt(future.getTime())},
    {key:'c'.repeat(64),points:1000000,expire:BigInt(future.getTime())},
  ])
  assert.equal(await db.apiRateLimitBucket.count(),3,'the legacy source remains available for rollback inspection')
}))

test('group hierarchy migration retains existing question, choice, history and favorite identities and content', integration, () => isolated(async (db, databaseUrl, raw) => {
  await raw.query(baselineSql)
  await raw.query("INSERT INTO users(id,name,email,created_at,updated_at) VALUES(70001,'Preserved synthetic','group-migration@example.invalid','2026-01-01','2026-01-01')")
  await raw.query("INSERT INTO questions(id,exam_number,question_number,major_category_code,category_code,content_blocks,explanation_blocks,source_text,publication_status,created_at,updated_at) VALUES(70002,7,81,'sample','sample','[{\"type\":\"text\",\"text\":\"Preserved synthetic\"}]','[]','Synthetic source','published','2026-01-01','2026-01-01')")
  await raw.query("INSERT INTO question_choices(id,question_id,choice_label,content_blocks,is_correct,display_order,created_at,updated_at) VALUES(70003,70002,'カ','[]',true,6,'2026-01-01','2026-01-01')")
  await raw.query("INSERT INTO answer_histories(id,user_id,question_id,selected_choice_id,is_correct,created_at,updated_at) VALUES(70004,70001,70002,70003,true,'2026-01-01','2026-01-01')")
  await raw.query("INSERT INTO favorites(id,user_id,question_id,created_at,updated_at) VALUES(70005,70001,70002,'2026-01-01','2026-01-01')")
  const before = new Map<string, any[]>()
  for (const table of ['users', 'questions', 'question_choices', 'answer_histories', 'favorites']) before.set(table, (await raw.query(`SELECT * FROM ${table} ORDER BY id`)).rows)
  await migrate({ databaseUrl, baseline: true })
  await migrate({ databaseUrl })
  for (const [table, rows] of before) {
    const columns = Object.keys(rows[0]!).join(',')
    assert.deepEqual((await raw.query(`SELECT ${columns} FROM ${table} ORDER BY id`)).rows, rows, table)
  }
  assert.deepEqual((await raw.query('SELECT exam_number,publication_status FROM exam_sets')).rows, [{ exam_number: 7, publication_status: 'published' }])
  const question = await db.question.findUniqueOrThrow({ where: { id: 70002 } })
  assert.equal(question.group_id, null)
  assert.equal(question.content_version, 1)
  assert.equal((await db.answerHistory.findUniqueOrThrow({ where: { id: 70004 } })).question_version, 1)
}))
