import assert from 'node:assert/strict'
import test from 'node:test'
import {classificationTarget} from '../server/operations/classification-target.ts'
test('restore rejects remote and URI routing overrides before a database can be created',()=>{
 for(const url of ['postgresql://example.invalid/db_test','postgresql://localhost/production','postgresql://localhost/db_test?host=example.invalid','postgresql://localhost/db_test?port=9999','postgresql://localhost/db_test?options=-c%20search_path=other','postgresql://localhost/db_test?database=production'])assert.throws(()=>classificationTarget(url,true))
 assert.equal(classificationTarget('postgresql://localhost/db_test',true).identity.port,'5432')
})
test('backup identity separates ports and schemas, preserves SSL settings and excludes credentials',()=>{
 const a=classificationTarget('postgresql://fixture:synthetic@localhost:55448/db_test?schema=first&sslmode=disable',true)
 const b=classificationTarget('postgresql://fixture:synthetic@localhost:55449/db_test?schema=first',true)
 const c=classificationTarget('postgresql://fixture:synthetic@localhost:55448/db_test?schema=second',true)
 assert.notDeepEqual(a.identity,b.identity);assert.notDeepEqual(a.identity,c.identity)
 assert.deepEqual(Object.keys(a.identity).sort(),['database','host','port','schema'])
 assert.equal(new URL(a.connectionString).searchParams.get('sslmode'),'disable')
})
