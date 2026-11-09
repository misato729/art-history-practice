import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {createDatabase} from '../../frontend/server/core/db.ts'
import {classificationFingerprint} from '../../frontend/server/operations/question-classifications.ts'
const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/art_received_restore_test');assert.equal(process.env.APP_ENV,'test');const db=createDatabase(url.toString())
try{const before=JSON.parse(readFileSync(process.argv[2]));assert.deepEqual(await classificationFingerprint(db),before.preserved);assert.equal(await db.questionStudyCategory.count(),1382);assert.equal(await db.answerHistory.count(),3);assert.equal(await db.favorite.count(),3);console.log(JSON.stringify({status:'restored',fingerprints:7,classifications:1382,histories:3,favorites:3}))}finally{await db.$disconnect()}
