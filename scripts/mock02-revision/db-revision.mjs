#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync, chmodSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { RevisionError, requireThat, canonical, hash, gitBlob, material, databaseKey, validatePackage, imagePaths,
  assertBaseline, isRevised, contentFingerprint, assertHistoryPreserved, applyContent, restoreContent, resolveRevisionSources, assertStartingPoint } from './revision-core.mjs';

const HOME=resolve(dirname(fileURLToPath(import.meta.url)),'../../content/revisions/mock02-textbook-v2');
const requiredBlobs={
  'frontend/server/services/learning-writer.ts':'3773b97d3232d2ad0d2e76b4433e4176175c3246',
  'frontend/server/services/learning-structure.ts':'2f74b5303246d2a2fdfc04fb3e9e500e4b7a7a8e',
  'frontend/server/core/db.ts':'6c6914e11a1452c9ccdfa09477916ae3a3970457',
  'frontend/prisma/schema.prisma':'38a5369472ecfc3551554a7e2fb9a71e7236860f',
  'frontend/server/services/learning.ts':'be2f612056ea2e39befa0a73016696da2c21da47',
  'frontend/server/services/incorrect-review.ts':'7a142d3232faa48c56119b2e97b081f7674366ad',
  'frontend/app/pages/history.vue':'8d24453d5c168434c670f0411707d8ca7fc4f49d',
};
const print=object=>console.log(JSON.stringify(object,null,2));
const readJSON=path=>JSON.parse(readFileSync(path,'utf8'));
function writePrivate(path,value,{exclusive=false}={}) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temp=exclusive?path:path+`.tmp-${process.pid}`;
  const fd=openSync(temp,'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(canonical(value),null,2)+'\n'); fsyncSync(fd); } finally {closeSync(fd);}
  if (!exclusive) renameSync(temp,path);
  chmodSync(path,0o600);
}
function readEnvelope(path,format) {
  const e=readJSON(path); requireThat(e.payload?.format===format && e.sha256===hash(e.payload),'BACKUP_CHECKSUM','バックアップの形式・SHA256が一致しません。'); return e.payload;
}
function envelope(payload) {return {payload,sha256:hash(payload)};}
function repositoryChecks(root,pkg) {
  const cfg=readJSON(join(root,'config/exam.json'));
  requireThat(cfg.site?.id==='art-certification-2' && cfg.exam?.sets?.find(s=>s.exam_number===2)?.question_count===85,'REPOSITORY','美術史ラボの85問構成のリポジトリではありません。');
  for(const [name,expected] of Object.entries(requiredBlobs)) requireThat(gitBlob(readFileSync(join(root,name)))===expected,'CODE_CHANGED',`${name} が確認済み実装と異なります。互換性を再確認するまで停止します。`);
  const bytes=readFileSync(join(HOME,'baseline-original.json'));
  requireThat(gitBlob(bytes)===pkg.baseline_seed_git_blob,'SEED_CHANGED','元の模試2データが確認済み版と異なります。手元の編集を上書きしないため停止します。');
  const manifest=readJSON(join(root,'content/mock-exams/mock-02/image-manifest.json'));
  for(const src of imagePaths(pkg)) {
    const entry=manifest.assets.find(a=>a.src===src);
    requireThat(entry?.sha256,'IMAGE_MANIFEST','図版の照合用記録がありません。');
    const bytes=readFileSync(join(root,'frontend/public',src.slice(1)));
    requireThat(createHash('sha256').update(bytes).digest('hex')===entry.sha256,'IMAGE_CHANGED',`${src} の図版が確認済み記録と一致しません。`);
  }
  return JSON.parse(bytes.toString('utf8'));
}
export async function loadAPI(root) {
  const mod=path=>import(pathToFileURL(join(root,'frontend',path)).href);
  const database=await mod('server/core/db.ts');
  const writer=await mod('server/services/learning-writer.ts');
  const structure=await mod('server/services/learning-structure.ts');
  const validation=await mod('server/services/learning-validation.ts');
  const {parseBlocks}=await mod('shared/schemas/content.ts');
  return {...database,...writer,...structure,...validation,parseBlocks};
}
export async function readState(api,db) {
  const ids=api.record(await db.question.findMany({where:{exam_number:2},select:{id:true},orderBy:{question_number:'asc'}}));
  const qids=ids.map(x=>x.id);
  const count=await db.answerHistory.count({where:{question_id:{in:qids}}});
  requireThat(count<=100_000,'HISTORY_LIMIT','履歴が10万件を超えています。大容量向けの運用手順が必要です。');
  const questions=[];for(const {id} of ids) questions.push(await api.loadQuestion(id,db));
  const groupIds=api.record(await db.questionGroup.findMany({where:{exam_number:2},select:{id:true},orderBy:{group_number:'asc'}}));
  const groups=[];
  for(const {id} of groupIds) {
    const g=await api.loadQuestionGroup(id,db);
    groups.push({id:g.id,exam_number:g.exam_number,group_number:g.group_number,title:g.title,planned_question_count:g.planned_question_count,
      publication_status:g.publication_status,lock_version:g.lock_version,created_at:g.created_at,updated_at:g.updated_at,
      passages:g.passages});
  }
  const histories=api.record(await db.answerHistory.findMany({where:{question_id:{in:qids}},orderBy:{id:'asc'}}));
  const favorites=api.record(await db.favorite.findMany({where:{question_id:{in:qids}},orderBy:{id:'asc'}}));
  // PostgreSQL timestamp(6) must not lose microseconds through JavaScript Date.
  for (const [table,rows] of [['answer_histories',histories],['favorites',favorites]]) {
    const stamps=api.record(await api.query(`SELECT h.id, to_char(h.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, to_char(h.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM ${table} h JOIN questions q ON q.id=h.question_id WHERE q.exam_number=$1 ORDER BY h.id`,[2],db));
    const map=new Map(stamps.map(row=>[row.id,row]));
    for (const row of rows) { const stamp=map.get(row.id); requireThat(stamp,'TIMESTAMP_SNAPSHOT','日時控えを照合できません。'); row.created_at=stamp.created_at;row.updated_at=stamp.updated_at; }
  }
  return canonical({set:api.record(await db.examSet.findUnique({where:{exam_number:2}})),groups,questions,histories,favorites});
}
async function lockTarget(api,db) {
  // Parent/group editors take this same advisory lock. Grading/favorite edits lock Question rows.
  await api.query("SET LOCAL lock_timeout = '10s'",[],db);
  await api.query('SELECT pg_advisory_xact_lock($1)::text',[71514345],db);
  await api.query('SELECT id FROM questions WHERE exam_number = $1 ORDER BY id FOR UPDATE',[2],db);
}
function summary(s) {return {questions:s.questions.length,choices:s.questions.reduce((n,q)=>n+q.choices.length,0),histories:s.histories.length,favorites:s.favorites.length};}

async function main() {
  const {values:v,positionals}=parseArgs({options:{repo:{type:'string'},env:{type:'string'},plan:{type:'string'},confirm:{type:'string'},run:{type:'string'},help:{type:'boolean'}},allowPositionals:true,strict:true});
  if(v.help || !positionals.length) {console.log('Usage: node --experimental-strip-types tools/db-revision.mjs <validate|check|dry-run|apply|verify|rollback> --repo /path/to/art-history-practice [--env frontend/.env.production.local] [--plan /path/to/plan.json] [--confirm REVISE_MOCK_02] [--run /path/to/backup-run]');return;}
  const mode=positionals[0];
  requireThat(positionals.length===1 && ['validate','check','dry-run','apply','verify','rollback'].includes(mode),'MODE','操作名が不正です。');
  const root=resolve(v.repo || process.cwd());
  const revisionBytes=readFileSync(join(HOME,'revision.json'));
  requireThat(createHash('sha256').update(revisionBytes).digest('hex')==='6772db27010e8706eeb7af990694a54215c46d9fdcc764e5811c1e11321aa6c2','REVISION_BYTES_CHANGED','受領したV2原稿の指紋が変わっています。');
  const rawPackage=validatePackage(JSON.parse(revisionBytes));
  const baseline=repositoryChecks(root,rawPackage);
  const pkg=resolveRevisionSources(rawPackage,baseline), revisionHash=hash(pkg);
  const prior=readJSON(join(HOME,'compat/prior-r1.json'));
  if(mode==='validate') {
    // Canonical schema validation has no database connection; loading Prisma classes requires generation.
    const api=await loadAPI(root);
    for(const q of pkg.questions) api.validateQuestionInput(q);
    api.parseBlocks(pkg.application_group.content_blocks,'question',true);
    print({status:'validated_offline',questions:85,choices:340,images:imagePaths(pkg).length,revision_id:pkg.revision_id,db_connected:false});return;
  }
  requireThat(v.env,'ENV_REQUIRED','--env で接続情報ファイルを指定してください。既存のシェル環境変数は使いません。');
  const env=parseEnv(readFileSync(resolve(root,v.env),'utf8'));
  requireThat(env.DATABASE_URL?.trim(),'ENV_REQUIRED','指定したファイルに DATABASE_URL がありません。');
  process.env.DATABASE_URL=env.DATABASE_URL;
  // The writer needs only DATABASE_URL; never import arbitrary env-file entries as code/config.
  const dbKey=databaseKey(env.DATABASE_URL);
  const api=await loadAPI(root);
  for(const q of pkg.questions) api.validateQuestionInput(q);
  api.parseBlocks(pkg.application_group.content_blocks,'question',true);
  const planPath=resolve(v.plan || join(HOME,'plan.json')),trialPath=planPath+'.dry-run.json';
  const pkgID=pkg.revision_id;
  const runPrefix=()=>`${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}`;
  try {
    if(mode==='check') {
      const state=await api.transaction(async db=>{await lockTarget(api,db);return readState(api,db);},undefined,{timeout:600_000});
      if(isRevised(state,pkg)) {print({status:'already_applied',revision_id:pkgID,...summary(state)});return;}
      const startingPoint=assertStartingPoint(state,baseline,prior);
      const plan={format:'art-lab-revision-plan',version:1,revision_id:pkgID,revision_sha256:revisionHash,starting_point:startingPoint,db_fingerprint:dbKey,before_content_fingerprint:contentFingerprint(state),created_at:new Date().toISOString(),...summary(state)};
      if(existsSync(planPath)) requireThat(readJSON(planPath).format==='art-lab-revision-plan','PLAN_PATH','計画ファイル以外を上書きできません。');
      writePrivate(planPath,plan);
      print({status:'ready',starting_point:startingPoint,plan:planPath,db_fingerprint:dbKey,...summary(state),history_policy:'履歴は元のID・回答・正誤のまま保存し、改稿後は更新前の回答として扱います。'});return;
    }
    if(mode==='verify') {
      const state=await api.transaction(async db=>{await lockTarget(api,db);return readState(api,db);},undefined,{timeout:600_000});
      requireThat(isRevised(state,pkg),'VERIFY','改稿版と一致しません。');
      print({status:'verified',revision_id:pkgID,...summary(state),normal_passage_references:state.questions.filter(q=>q.question_number<=80).reduce((n,q)=>n+q.passage_references.length,0),application_questions_in_one_group:5});return;
    }
    if(mode==='rollback') {
      requireThat(v.run && v.confirm==='RESTORE_MOCK_02','CONFIRM','復元は --run と --confirm RESTORE_MOCK_02 の両方が必要です。');
      const run=resolve(v.run), backup=readEnvelope(join(run,'before.json'),'art-lab-revision-backup'),receipt=readJSON(join(run,'receipt.json'));
      requireThat(backup.db_fingerprint===dbKey && backup.revision_id===pkgID && receipt.db_fingerprint===dbKey && receipt.revision_sha256===revisionHash && receipt.before_sha256===hash(backup),'BACKUP_TARGET','接続先・改稿・バックアップの組合せが一致しません。');
      const before=backup.state;
      const restoreRun=join(run,'restore-'+runPrefix());
      let result;
      await api.transaction(async db=>{
        await lockTarget(api,db);
        const current=await readState(api,db);
        requireThat(contentFingerprint(current)===receipt.after_content_fingerprint,'POST_EDIT','更新後に問題が変更されています。後続の編集を上書きしないため停止しました。');
        requireThat(hash(current.histories)===hash(before.histories),'NEW_ANSWERS','更新後の新しい回答、または履歴の削除・変更があります。履歴を失わないため自動復元を停止しました。');
        mkdirSync(restoreRun,{recursive:false,mode:0o700});
        writePrivate(join(restoreRun,'before-restore.json'),envelope({format:'art-lab-revision-backup',revision_id:pkgID,db_fingerprint:dbKey,state:current}),{exclusive:true});
        const histories=await restoreContent(api,db,before,current);
        const after=await readState(api,db);
        assertBaseline(after,{exam_sets:[before.set],groups:before.groups,questions:before.questions});
        requireThat(hash(after.histories)===hash(histories) && hash(after.favorites)===hash(current.favorites),'RESTORE_VERIFY','復元後の履歴・お気に入りの照合に失敗しました。');
        requireThat(before.questions.every(q=>after.questions.find(a=>a.id===q.id)?.choices.every((c,i)=>c.id===q.choices[i].id)),'ID_VERIFY','復元後のID照合に失敗しました。');
        result={status:'restored',run:restoreRun,...summary(after)};
        writePrivate(join(restoreRun,'receipt.json'),{revision_id:pkgID,db_fingerprint:dbKey,after_content_fingerprint:contentFingerprint(after),commit_state:'not_yet_confirmed'},{exclusive:true});
      },undefined,{timeout:600_000});
      try{writePrivate(join(restoreRun,'commit-confirmed.json'),{committed_at:new Date().toISOString()},{exclusive:true});}catch{result.receipt_warning='DBの復元は確定しましたが、確定マーカーの保存に失敗しました。';}
      print(result);return;
    }
    // dry-run and apply share the exact same data path; the dry-run throws to roll back.
    requireThat(existsSync(planPath),'PLAN_REQUIRED','先に check を実行してください。');
    const plan=readJSON(planPath);
    requireThat(plan.format==='art-lab-revision-plan' && plan.revision_sha256===revisionHash && plan.db_fingerprint===dbKey,'PLAN_TARGET','計画と接続先または改稿データが一致しません。');
    if(mode==='apply') {
      requireThat(v.confirm==='REVISE_MOCK_02','CONFIRM','確定には --confirm REVISE_MOCK_02 が必要です。');
      requireThat(existsSync(trialPath),'DRY_RUN_REQUIRED','先に同じ接続先・計画で dry-run を成功させてください。');
      const trial=readJSON(trialPath);
      requireThat(trial.plan_sha256===hash(plan) && trial.revision_sha256===revisionHash && trial.db_fingerprint===dbKey,'DRY_RUN_STALE','dry-run の記録と現在の計画が一致しません。');
    }
    const rollbackSignal=new Error('DRY_RUN_ROLLBACK');
    let result,run;
    try {
      await api.transaction(async db=>{
        await lockTarget(api,db);
        const before=await readState(api,db);
        if(isRevised(before,pkg)){result={status:'already_applied',revision_id:pkgID,...summary(before)};return;}
        assertStartingPoint(before,baseline,prior);
        requireThat(contentFingerprint(before)===plan.before_content_fingerprint,'PLAN_STALE','check 以後に問題が変更されています。計画を作り直してください。');
        const backup={format:'art-lab-revision-backup',version:1,revision_id:pkgID,revision_sha256:revisionHash,db_fingerprint:dbKey,created_at:new Date().toISOString(),state:before};
        if(mode==='apply') {
          const parent=join(root,'local-only','backups','mock02-textbook-v2');
          mkdirSync(parent,{recursive:true,mode:0o700});
          run=join(parent,runPrefix());mkdirSync(run,{mode:0o700});
          writePrivate(join(run,'before.json'),envelope(backup),{exclusive:true});
          // A full readback detects partial/disk failures before any content write.
          readEnvelope(join(run,'before.json'),'art-lab-revision-backup');
        }
        await applyContent(api,db,pkg,before);
        const after=await readState(api,db);
        requireThat(isRevised(after,pkg),'CONTENT_VERIFY','改稿内容の書込み照合に失敗しました。');
        assertHistoryPreserved(before,after);
        requireThat(after.questions.every(q=>q.content_version>before.questions.find(b=>b.id===q.id).content_version),'VERSION_VERIFY','問題バージョンの更新確認に失敗しました。');
        result={status:mode==='dry-run'?'dry_run_passed':'applied',revision_id:pkgID,...summary(after),old_histories_preserved:before.histories.length,backup_run:run};
        if(mode==='dry-run') throw rollbackSignal;
        writePrivate(join(run,'receipt.json'),{format:'art-lab-revision-receipt',revision_id:pkgID,revision_sha256:revisionHash,db_fingerprint:dbKey,before_sha256:hash(backup),after_content_fingerprint:contentFingerprint(after),commit_state:'not_yet_confirmed'},{exclusive:true});
      },undefined,{timeout:600_000});
    } catch(error) {if(error!==rollbackSignal) throw error;}
    if(mode==='dry-run' && result?.status==='dry_run_passed') {
      writePrivate(trialPath,{format:'art-lab-revision-dry-run',plan_sha256:hash(plan),revision_sha256:revisionHash,db_fingerprint:dbKey,completed_at:new Date().toISOString()});
      result.committed=false;result.note='問題・履歴の書込みはロールバック済み。PostgreSQLの採番値には欠番が生じる場合があります。';
    }
    if(mode==='apply' && result?.status==='applied') {
      try{writePrivate(join(run,'commit-confirmed.json'),{committed_at:new Date().toISOString()},{exclusive:true});}catch{result.receipt_warning='DB更新は確定しましたが、確定マーカーの保存に失敗しました。verify で状態を確認してください。';}
    }
    print(result);
  } finally {await api.closeDatabase();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{ console.log(JSON.stringify({diagnostic:true,name:error?.name,code:error?.code,statusCode:error?.statusCode,frames:String(error?.stack||'').split('\n').filter(x=>x.trim().startsWith('at ')).slice(0,6),meta_keys:Object.keys(error?.meta||{}),cause_name:error?.cause?.name,cause_code:error?.cause?.code}));
  if(error instanceof RevisionError) print({status:'stopped',code:error.code,message:error.message});
  else if(error?.name==='ApiError' && ['validation_error','content_conflict','not_found'].includes(error.code)) print({status:'stopped',code:'API_'+error.code.toUpperCase(),http_status:error.status,fields:Object.keys(error.details||{}),message:'現行アプリの入力・版・参照条件で停止しました。原稿と構造変換を確認してください。'});
  else if(error?.code==='ENOENT') print({status:'stopped',code:'FILE_NOT_FOUND',message:'必要なファイルがありません。リポジトリ・環境変数ファイル・Prisma生成物・図版のパスを確認してください。'});
  else if(error?.code==='ERR_MODULE_NOT_FOUND') print({status:'stopped',code:'DEPENDENCY',message:'依存パッケージまたはPrisma生成物がありません。frontend で npm ci と npm run db:generate を実行してください。'});
  else print({status:'stopped',code:typeof error?.code==='string' && /^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'OPERATION_FAILED',message:'処理は正常完了していません。秘密値や問題本文を含むエラー詳細は出力しません。apply で通信が切れた場合は再実行前に verify を実行し、バックアップの有無とDB状態を確認してください。'});
  process.exitCode=1;
});
