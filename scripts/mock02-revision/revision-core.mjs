import { createHash } from 'node:crypto';

export class RevisionError extends Error {
  constructor(code, message) { super(message); this.name = 'RevisionError'; this.code = code; }
}
export function requireThat(ok, code, message) { if (!ok) throw new RevisionError(code, message); }
export function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    const n = Number(value); requireThat(Number.isSafeInteger(n), 'UNSAFE_ID', '安全に扱えないIDです。'); return n;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)]));
  return value;
}
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export function material(q) {
  return { exam_number: q.exam_number, question_number: q.question_number, major_category_code: q.major_category_code,
    category_code: q.category_code, content_blocks: q.content_blocks, explanation_blocks: q.explanation_blocks,
    source_text: q.source_text, choices: q.choices.map(c => ({choice_label:c.choice_label,content_blocks:c.content_blocks,is_correct:c.is_correct,display_order:c.display_order})) };
}
export function databaseKey(value) {
  let u; try { u = new URL(value); } catch { throw new RevisionError('DATABASE_URL', 'DATABASE_URL の形式を確認してください。値をチャットへ貼らないでください。'); }
  requireThat(['postgres:','postgresql:'].includes(u.protocol) && u.hostname && u.pathname.length > 1, 'DATABASE_URL','PostgreSQL の接続先を明示してください。');
  // Excludes password/user/SSL parameters; retains the selected branch/host/database/schema.
  return hash({host:u.hostname,port:u.port || '5432',database:u.pathname,schema:u.searchParams.get('schema') || 'public'});
}
export function validatePackage(pkg) {
  requireThat(pkg?.format === 'art-lab-exam-revision' && pkg.version === 1 && pkg.exam_number === 2, 'PACKAGE','模試2用の改稿データではありません。');
  requireThat(pkg.questions?.length === 85, 'QUESTION_COUNT', '問題数は85件である必要があります。');
  const categories = [[41,'western'],[66,'japanese'],[71,'contemporary'],[74,'asian'],[78,'design'],[80,'museum'],[85,'application']];
  const labels = ['ア','イ','ウ','エ'];
  for (const [i,q] of pkg.questions.entries()) {
    const n=i+1, major=categories.find(([end])=>n<=end)[1];
    requireThat(q.exam_number===2 && q.question_number===n && q.publication_status==='published', 'POSITION','問題番号・公開状態が不正です。');
    requireThat(q.major_category_code===major && q.category_code===major+'_study','CATEGORY',`問${n}の分類が不正です。`);
    requireThat(q.content_blocks?.length && q.explanation_blocks?.length && q.choices?.length===4,'EMPTY',`問${n}の本文・解説・選択肢を確認してください。`);
    requireThat(q.choices.every((c,j)=>c.choice_label===labels[j] && c.display_order===j+1 && typeof c.is_correct==='boolean' && c.content_blocks?.length) && q.choices.filter(c=>c.is_correct).length===1,'ANSWER',`問${n}の正答は1つ必要です。`);
    requireThat(new Set(q.choices.map(c=>JSON.stringify(c.content_blocks))).size===4,'DUPLICATE_CHOICE',`問${n}の選択肢が重複しています。`);
    requireThat(typeof q.source_text==='string' && q.source_text.split('\n').every(s=>/^.+ \| https:\/\/\S+$/.test(s)),'SOURCE',`問${n}の出典形式が不正です。`);
    requireThat(!('id' in q) && !('group_id' in q) && !('passage_references' in q),'LIVE_IDS','配布データに本番IDを固定しないでください。');
  }
  requireThat(pkg.normal_group_ranges?.length===26 && pkg.application_group?.group_number===27 && pkg.application_group.first===81 && pkg.application_group.last===85 && pkg.application_group.content_blocks?.length,'GROUPS','問題群の指定が不正です。');
  const numbers=pkg.normal_group_ranges.flatMap(g=>Array.from({length:g.last-g.first+1},(_,i)=>g.first+i));
  requireThat(JSON.stringify(numbers)===JSON.stringify(Array.from({length:80},(_,i)=>i+1)),'COVERAGE','通常問題の範囲が連続していません。');
  requireThat(JSON.stringify(pkg.retired_group_numbers)===JSON.stringify([28,29,30,31]),'GROUPS','旧活用問題群の指定が異なります。');
  return pkg;
}
export function imagePaths(pkg) {
  const blocks=pkg.questions.flatMap(q=>[...q.content_blocks,...q.explanation_blocks,...q.choices.flatMap(c=>c.content_blocks)]).concat(pkg.application_group.content_blocks);
  const paths=[...new Set(blocks.filter(b=>b.type==='image').map(b=>b.src))].sort();
  requireThat(paths.every(p=>/^\/images\/artworks\/mock02-img-\d{2}\.jpg$/.test(p)), 'IMAGE_PATH','この改稿は既存の模試2の図版のみを使用します。');
  return paths;
}
export function desiredPlacement(n,pkg) {
  if (n>=81) return {group_number:27,slot:n-80,shared:true};
  const g=pkg.normal_group_ranges.find(g=>g.first<=n && n<=g.last);
  requireThat(g,'PLACEMENT',`問${n}の所属が見つかりません。`);
  return {group_number:g.group_number,slot:n-g.first+1,shared:false};
}
function referenceMeaning(q,groups) {
  const g=groups.find(g=>g.id===q.group_id);
  return {group_number:g?.group_number ?? null,slot:q.group_question_number ?? null,references:(q.passage_references||[]).map(r=>({label:g?.passages.find(p=>p.id===r.passage_id)?.label,anchor:r.anchor_id ?? null}))};
}
function groupMeaning(g) { return {group_number:g.group_number,title:g.title,planned_question_count:g.planned_question_count,publication_status:g.publication_status,passages:g.passages.map(p=>({label:p.label,display_order:p.display_order,content_blocks:p.content_blocks}))}; }
export function assertBaseline(state, baseline) {
  requireThat(state.questions.length===85 && state.groups.length===31 && baseline.questions?.length===85 && baseline.groups?.length===31,'BASELINE_COUNT','改稿前の85問・31問題群がそろっていません。');
  const set=baseline.exam_sets.find(s=>s.exam_number===2);
  requireThat(set && state.set?.title===set.title && state.set.publication_status===set.publication_status && state.set.publication_status==='published','SET','模試2のタイトル・公開状態が改稿前の記録と異なります。');
  for (const old of baseline.groups) {
    const live=state.groups.find(g=>g.group_number===old.group_number);
    requireThat(live && hash(groupMeaning(live))===hash(groupMeaning(old)),'BASELINE_GROUP',`大問${old.group_number}が元データと異なります。上書きせず停止しました。`);
  }
  for (const old of baseline.questions) {
    const q=state.questions.find(q=>q.question_number===old.question_number);
    requireThat(q && q.exam_number===2 && q.publication_status===old.publication_status && hash(material(q))===hash(material(old)),'BASELINE_CONTENT',`問${old.question_number}が元データと異なります。上書きせず停止しました。`);
    requireThat(hash(referenceMeaning(q,state.groups))===hash(referenceMeaning(old,baseline.groups)),'BASELINE_REF',`問${old.question_number}の参照・所属が元データと異なります。`);
  }
}
export function isRevised(state,pkg) {
  if (state.questions.length!==85 || state.groups.length!==31 || state.set?.publication_status!=='published') return false;
  const shared=state.groups.find(g=>g.group_number===27);
  const passage=shared?.passages.find(p=>p.label===pkg.application_group.passage_label);
  if (!shared || shared.title!==pkg.application_group.title || shared.planned_question_count!==5 || shared.publication_status!=='published' || !passage || hash(passage.content_blocks)!==hash(pkg.application_group.content_blocks)) return false;
  if (!pkg.retired_group_numbers.every(n=>state.groups.some(g=>g.group_number===n && g.publication_status==='private') && !state.questions.some(q=>q.group_id===state.groups.find(g=>g.group_number===n)?.id))) return false;
  return pkg.questions.every(expected=>{
    const q=state.questions.find(q=>q.question_number===expected.question_number),p=desiredPlacement(expected.question_number,pkg),g=state.groups.find(g=>g.group_number===p.group_number);
    const refs=p.shared?[{passage_id:passage.id,anchor_id:null}]:[];
    return q && g?.publication_status==='published' && q.publication_status==='published' && hash(material(q))===hash(material(expected)) && q.group_id===g.id && q.group_question_number===p.slot && hash(q.passage_references)===hash(refs) && (!(String(p.group_number) in pkg.group_title_overrides)||g.title===pkg.group_title_overrides[String(p.group_number)]);
  });
}
export const contentFingerprint = state => hash({set:state.set,groups:state.groups,questions:state.questions});
export function assertHistoryPreserved(before,after) {
  requireThat(hash(before.histories)===hash(after.histories),'HISTORY_VERIFY','履歴の保存確認に失敗しました。変更は確定しません。');
  requireThat(hash(before.favorites)===hash(after.favorites),'FAVORITES_VERIFY','お気に入りの保存確認に失敗しました。変更は確定しません。');
  for(const q of before.questions) {
    const a=after.questions.find(x=>x.question_number===q.question_number);
    requireThat(a?.id===q.id && JSON.stringify(a.choices.map(c=>c.id))===JSON.stringify(q.choices.map(c=>c.id)),'ID_VERIFY','問題・選択肢IDの保存確認に失敗しました。');
  }
}
export function restoredHistories(before, restoredQuestions) {
  const original=new Map(before.questions.map(q=>[q.id,q.content_version]));
  const now=new Map(restoredQuestions.map(q=>[q.id,q.content_version]));
  return before.histories.map(h=>({...h,question_version:h.question_version===original.get(h.question_id)?now.get(h.question_id):h.question_version}));
}
export const historyRows = rows => rows.map(r=>({...r,created_at:new Date(r.created_at),updated_at:new Date(r.updated_at)}));

/** All writes use the application's canonical writer inside an outer transaction. */
export async function applyContent(api,db,pkg,before) {
  for (const g of before.groups) { await api.saveQuestionGroup(g.id,{lock_version:g.lock_version,publication_status:'draft'},{db}); }
  let shared=await api.loadQuestionGroup(before.groups.find(g=>g.group_number===27).id,db);
  requireThat(!shared.passages.some(p=>p.label===pkg.application_group.passage_label),'PASSAGE_EXISTS','新しい共通資料と同じラベルが既にあります。');
  shared=await api.saveQuestionGroup(shared.id,{lock_version:shared.lock_version,title:pkg.application_group.title,planned_question_count:5,publication_status:'draft',passages:[...shared.passages.map((p,i)=>({id:p.id,label:p.label,display_order:i+1,content_blocks:p.content_blocks})),{label:pkg.application_group.passage_label,display_order:shared.passages.length+1,content_blocks:pkg.application_group.content_blocks}]},{db});
  const passage=shared.passages.find(p=>p.label===pkg.application_group.passage_label);
  requireThat(passage,'PASSAGE_CREATE','共通資料を作成できませんでした。');
  for(const draft of pkg.questions) { console.log(JSON.stringify({phase:'save_question',question:draft.question_number}));
    const old=before.questions.find(q=>q.question_number===draft.question_number);
    const live=await api.loadQuestion(old.id,db);
    const p=desiredPlacement(draft.question_number,pkg),group=before.groups.find(g=>g.group_number===p.group_number);
    await api.saveQuestion({...draft,publication_status:'draft',lock_version:live.lock_version,group_id:group.id,group_question_number:p.slot,
      passage_references:p.shared?[{passage_id:passage.id,anchor_id:null}]:[],
      choices:draft.choices.map(c=>({...c,id:live.choices.find(old=>old.choice_label===c.choice_label).id}))},{id:live.id,db,preserveHistory:true});
  }
  // Revision writes retain history rows and their original versions in place.
  for(const old of before.groups) {
    const g=await api.loadQuestionGroup(old.id,db);
    await api.saveQuestionGroup(g.id,{lock_version:g.lock_version,
      title:pkg.group_title_overrides[String(g.group_number)] ?? (g.group_number===27?pkg.application_group.title:old.title),
      planned_question_count:g.group_number===27?5:old.planned_question_count,
      publication_status:pkg.retired_group_numbers.includes(g.group_number)?'private':'draft'},{db});
  }
  const set=await api.loadExamSet(2,db); await api.publishExamSet(2,set.lock_version,{db});
  const report=await api.validateExamSet(2,db,undefined,{publishedOnly:true});
  requireThat(report.valid,'EXAM_VALIDATION','アプリの試験公開条件を満たしません。変更は確定しません。');
}
export async function restoreContent(api,db,before,current) {
  for(const g of current.groups) await api.saveQuestionGroup(g.id,{lock_version:g.lock_version,publication_status:'draft'},{db});
  // Restore membership before shrinking group 27 or removing the new passage.
  for(const old of before.questions) {
    const live=await api.loadQuestion(old.id,db);
    await api.saveQuestion({...material(old),publication_status:'draft',lock_version:live.lock_version,
      group_id:old.group_id,group_question_number:old.group_question_number,passage_references:old.passage_references,
      choices:old.choices.map(c=>({...c,id:live.choices.find(x=>x.choice_label===c.choice_label).id}))},{id:old.id,db,preserveHistory:true});
  }
  for(const old of before.groups) {
    const g=await api.loadQuestionGroup(old.id,db);
    await api.saveQuestionGroup(old.id,{lock_version:g.lock_version,title:old.title,planned_question_count:old.planned_question_count,
      publication_status:old.publication_status==='private'?'private':'draft',passages:old.passages.map((p,i)=>({id:p.id,label:p.label,display_order:i+1,content_blocks:p.content_blocks}))},{db});
  }
  const restored=[];for(const old of before.questions) restored.push(await api.loadQuestion(old.id,db));
  const histories=restoredHistories(before,restored);
  // Rebind only the prior current version, batching by question instead of each history row.
  const counts=new Map();for(const h of before.histories){const key=`${h.question_id}/${h.question_version}`;counts.set(key,(counts.get(key)||0)+1)}
  const restoredQuestions=new Map(restored.map(q=>[q.id,q]));
  for(const old of before.questions){
    const expected=counts.get(`${old.id}/${old.content_version}`)||0;if(!expected)continue;
    const result=await db.answerHistory.updateMany({where:{question_id:old.id,question_version:old.content_version},data:{question_version:restoredQuestions.get(old.id).content_version}});
    requireThat(result.count===expected,'HISTORY_VERSION_CONFLICT','復元中に履歴版が変わりました。');
  }
  const set=await api.loadExamSet(2,db); await api.publishExamSet(2,set.lock_version,{db});
  const report=await api.validateExamSet(2,db,undefined,{publishedOnly:true});
  requireThat(report.valid,'RESTORE_VALIDATION','復元後の公開条件を満たしません。変更は確定しません。');
  return histories;
}

/** V2 is source-bound: never inherit knowledge citations from old questions. */
export function resolveRevisionSources(pkg, _baseline) {
  const result = validatePackage(structuredClone(pkg));
  requireThat(result.revision_id === 'mock02-textbook-v2-20261107', 'REVISION', 'このツールはテキスト準拠V2専用です。');
  for (const question of result.questions) {
    const lines = question.source_text.split('\n');
    requireThat(lines.every(line => /^『(?:改訂版 西洋・日本美術史の基本|美術検定 2級問題集)』p\.\d+(?:・\d+)*（(?:[123]\.pdf|2級公式問題集\.pdf)：\d+(?:・\d+)*ページ／本文は添付資料、リンクは書籍案内） \| https:\/\/www\.bijutsukentei\.com\/coverage$/.test(line)), 'SOURCE_POLICY', `問${question.question_number}の知識出典が指定された書籍のページ表記と一致しません。`);
  }
  return result;
}

/** Reproduce the OLD R1 bibliography solely for recognizing an installed R1.
 * These source lines are never copied into V2 or used to author new questions.
 */
export function resolvePriorR1Sources(prior, baseline) {
  const result = validatePackage(structuredClone(prior));
  for (const question of result.questions) {
    if (question.question_number > 80) continue;
    const old = baseline.questions.find(q => q.exam_number === 2 && q.question_number === question.question_number);
    requireThat(old, 'SOURCE_BASELINE', 'R1の照合に必要な旧問題がありません。');
    question.source_text = [...new Set([...(old.source_text ?? '').split(/\r?\n/), ...question.source_text.split('\n')].map(line => line.trim()).filter(Boolean))].join('\n');
  }
  return result;
}

/** Construct an exact ID-independent baseline for R1, including unused passages.
 * Merely looking like R1 is insufficient: edited labels/old material also stop the update.
 */
export function priorR1Baseline(baseline, prior) {
  const old = structuredClone(baseline);
  const effective = resolvePriorR1Sources(prior, baseline);
  const shared = old.groups.find(group => group.group_number === 27);
  requireThat(shared, 'BASELINE_GROUP', '旧版の大問27がありません。');
  const ids = old.groups.flatMap(group => group.passages.map(passage => passage.id));
  const passageId = Math.max(0, ...ids) + 1;
  shared.passages.push({ id: passageId, group_id: shared.id, label: effective.application_group.passage_label,
    display_order: shared.passages.length + 1, content_blocks: structuredClone(effective.application_group.content_blocks) });
  for (const group of old.groups) {
    group.title = effective.group_title_overrides[String(group.group_number)] ?? (group.group_number === 27 ? effective.application_group.title : group.title);
    if (group.group_number === 27) group.planned_question_count = 5;
    if (effective.retired_group_numbers.includes(group.group_number)) group.publication_status = 'private';
  }
  old.questions = effective.questions.map(question => {
    const position = desiredPlacement(question.question_number, effective);
    const group = old.groups.find(g => g.group_number === position.group_number);
    return { ...structuredClone(question), group_id: group.id, group_question_number: position.slot,
      passage_references: position.shared ? [{ passage_id: passageId, anchor_id: null }] : [] };
  });
  return old;
}
export function assertStartingPoint(state, baseline, prior) {
  try { assertBaseline(state, baseline); return 'original'; }
  catch (error) { if (!(error instanceof RevisionError)) throw error; }
  try { assertBaseline(state, priorR1Baseline(baseline, prior)); return 'prior-r1'; }
  catch (error) { if (!(error instanceof RevisionError)) throw error; }
  throw new RevisionError('BASELINE_MISMATCH', 'DBの模試2が元の公開版・前回の改稿R1版のどちらとも一致しません。手動編集を上書きしないため停止しました。');
}
