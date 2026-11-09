from pathlib import Path
import json,hashlib,copy,collections,re
root=Path.cwd();received=root/'local-only/received-revisions-20261109';out=received/'verification';out.mkdir(exist_ok=True)
read=lambda p:json.loads(p.read_text());sha=lambda b:hashlib.sha256(b).hexdigest();text=lambda t:{'type':'text','text':t}
assets=collections.defaultdict(list)
for p in (root/'frontend/public/images/artworks').glob('*'):
 if p.is_file():assets[sha(p.read_bytes())].append('/images/artworks/'+p.name)
current=read(root/'content/questions.json');issues=[];summary=[];payloads={}
for file in sorted(received.glob('*/mock-*/exam.json')):
 d=read(file);n=d['exam_number'];baseline=next(p for p in (file.parent.parent/'baseline').glob('*.json') if isinstance((b:=read(p)),dict) and b.get('exam_number')==n);b=read(baseline)
 snapshot=read(out/'before-archive.json');archive={**snapshot,'questions':[q for q in snapshot['questions']if q['exam_number']==n],'groups':[g for g in snapshot['groups']if g['exam_number']==n],'exam_sets':[e for e in snapshot['exam_sets']if e['exam_number']==n]} if (out/'before-archive.json').exists() else read(root/f'content/mock-exams/mock-{n:02}/questions.json')
 def convert(doc):
  part=copy.deepcopy(archive);credits={c['asset_id']:c for c in doc['artwork_credits']};shared=doc['shared_materials'][0]
  def image(i):
   p=(file.parent/i['file']).resolve();digest=sha(p.read_bytes());matches=assets.get(digest,[])
   if not matches:issues.append({'exam':n,'asset':i['asset_id'],'kind':'asset_not_present'});src='/images/artworks/received-'+digest[:16]+p.suffix
   else:
    candidates=[x for q in archive['questions'] for v in q['content_blocks'] if v['type']=='image' for x in [v['src']] if x in matches];src=candidates[0] if candidates else matches[0]
   return {'type':'image','src':src,'alt':i['alt'],**({'label':i['label']}if i.get('label')else{})}
  assert len(doc['questions'])==85
  for index,q in enumerate(doc['questions'],1):
   assert q['question_number']==index and q['exam_number']==n and not q.get('supplementary_blocks')
   assert next(c['label']for c in q['choices']if c['is_correct'])==q['correct_label']
   code=lambda v:{'eastern':'asian','eastern_study':'asian_study','craft_design':'design','craft_design_study':'design_study'}.get(v,v)
   assert all(code(q[k])==archive['questions'][index-1][k]for k in ['major_category_code','category_code'])
   old=part['questions'][q['question_number']-1];assert old['question_number']==q['question_number'];assert len(q['choices'])==4;assert sum(c['is_correct']for c in q['choices'])==1
   credit='\n\n'.join('\n'.join(str(c[k])for k in ['credit','museum','source_page','policy_url','license_record']if c.get(k))for aid in dict.fromkeys(i['asset_id']for i in (shared['images']if q['question_number']>80 else q['images'])) for c in [credits[aid]])
   old.update(content_blocks=[text(q['stem'])]+[image(i)for i in q['images']],explanation_blocks=[text(q['explanation'])]+[text(c['label']+'：'+c['explanation'])for c in q['choices']]+([text(credit)]if credit else []),source_text=re.sub(r' / ([^\n]+\.pdf) PDF ([^\n]+ページ)',r'（\1：PDF \2）',q['source_text'])+''.join('\n外部確認資料：'+e['title']+' | '+e['url'] for e in q.get('external_sources',[])+(shared.get('external_sources',[])if q['question_number']>80 else [])),choices=[{'choice_label':c['label'],'content_blocks':[text(c['text'])],'is_correct':c['is_correct'],'display_order':c['display_order']}for c in q['choices']])
  q=part['questions'][80];group=next(g for g in part['groups']if g['id']==q['group_id']);p=next(p for p in group['passages']if p['id']==q['passage_references'][0]['passage_id']);group['title']=shared['title'];p['content_blocks']=[text(shared['intro'])]+[image(i)for i in shared['images']]+[{'type':'table',**shared['table']}]+[text(t)for t in shared['notes']]
  return part
 before=convert(b);after=convert(d);conflicts=[];changes=[]
 # Three-way merge: preserve already approved Works corrections only where the received revision leaves that field unchanged.
 for cur,baseq,nextq in zip(archive['questions'],before['questions'],after['questions']):
  for field in ['content_blocks','explanation_blocks','source_text','choices']:
   if nextq[field]==baseq[field] and cur[field]!=baseq[field]:
    approved=[p for file in (root/'content/editorial').glob('*.json') for p in read(file).get('questions',[]) if p['exam_number']==n and p['question_number']==cur['question_number'] and field in p.get('fields',{})]
    assert approved and any(p['fields'][field]==cur[field]for p in approved), 'Unreviewed current change; stop'
    nextq[field]=copy.deepcopy(cur[field])
 for q,old,new,author in zip(archive['questions'],before['questions'],after['questions'],d['questions']):
  mismatch=[f for f in ['content_blocks','explanation_blocks','source_text','choices']if q[f]!=old[f]]
  if mismatch:
   for f in mismatch:
    approved=[p for file in (root/'content/editorial').glob('*.json') for p in read(file).get('questions',[]) if p['exam_number']==n and p['question_number']==q['question_number'] and f in p.get('fields',{})]
    assert any(p['fields'][f]==q[f]for p in approved), 'Unknown baseline conflict; stop'
   conflicts.append({'exam':n,'question':q['question_number'],'fields':mismatch})
  fields=[f for f in ['content_blocks','explanation_blocks','source_text','choices']if q[f]!=new[f]]
  if fields:changes.append({'exam':n,'question':q['question_number'],'fields':fields})
  if [(c['choice_label'],c['is_correct'],c['display_order'])for c in q['choices']]!=[(c['choice_label'],c['is_correct'],c['display_order'])for c in new['choices']]:issues.append({'exam':n,'question':q['question_number'],'kind':'answer_identity_changed'})
 summary.append({'exam':n,'questions':len(d['questions']),'changed_from_current':len(changes),'baseline_mismatches':len(conflicts)})
 (out/f'mock-{n:02}-converted.json').write_text(json.dumps(after,ensure_ascii=False,indent=2)+'\n');(out/f'mock-{n:02}-baseline-converted.json').write_text(json.dumps(before,ensure_ascii=False,indent=2)+'\n');payloads[n]={'conflicts':conflicts,'changes':changes}
(out/'preflight.json').write_text(json.dumps({'summary':summary,'issues':issues,'details':payloads},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'summary':summary,'issues':issues},ensure_ascii=False))
