#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { verify678 } from './illustrated-678/build.mjs'
import { verifyIllustrated } from './illustrated-revision/build.mjs'
import { verifySeed } from './mock02-revision/build-seed.mjs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { artworkImagePathSchema } from '../frontend/shared/schemas/content.ts'
import assert from 'node:assert/strict'
import { parseExamConfig, choiceLabelsForQuestion } from '../frontend/shared/schemas/exam.ts'
import { parseContentDocument } from '../frontend/shared/schemas/structure.ts'

function main() {
  const dir = resolve(process.argv[2] ?? 'content/mock-exams/mock-01')
  const read = name => JSON.parse(readFileSync(resolve(dir, name), 'utf8'))
  if ([6,7,8].some(n=>dir===resolve(`content/mock-exams/mock-${String(n).padStart(2,'0')}`))) { verify678(); console.log(JSON.stringify({status:'passed',scope:'received_illustrated_678_source_conversion',questions:85,choices:340,academic_review:false})); return }
  if ([1,3,4,5].some(n=>dir===resolve(`content/mock-exams/mock-${String(n).padStart(2,'0')}`))) { verifyIllustrated(); console.log(JSON.stringify({status:'passed',scope:'received_illustrated_source_conversion',questions:85,choices:340,academic_review:false})); return }
  if(dir===resolve('content/mock-exams/mock-02')) {
    const {revision}=verifySeed(),registry=JSON.parse(readFileSync('content/mock-exams/mock-02/image-manifest.json','utf8')).assets
    const paths=[...new Set([...revision.questions.flatMap(q=>[...q.content_blocks,...q.choices.flatMap(c=>c.content_blocks),...q.explanation_blocks]),...revision.application_group.content_blocks].filter(b=>b.type==='image').map(b=>b.src))]
    assert.equal(paths.length,8)
    for(const src of paths){const entry=registry.find(a=>a.src===src);assert.ok(entry);assert.equal(createHash('sha256').update(readFileSync(resolve('frontend/public',src.slice(1)))).digest('hex'),entry.sha256)}
    console.log(JSON.stringify({status:'passed',scope:'active_textbook_v2_technical_source_match',revision_id:revision.revision_id,questions:85,choices:340,images:8,normal_references:0,academic_review_by_works:false}));return
  }
  const manifest = read('manifest.json')
  const editorial = read('editorial.json')
  const examNumber = manifest.exam_number ?? Number(manifest.id.match(/mock-(\d+)$/)?.[1])
  assert.ok(Number.isInteger(examNumber) && examNumber >= 1 && examNumber <= 5)
  const config = parseExamConfig(manifest.validation_config)
  // Runtime, operational imports and this editorial check share one document parser.
  const document = parseContentDocument(read('questions.json'), config)
  const counts = {}
  assert.equal(document.schema_version, 2)
  assert.equal(document.questions.length, 85)
  assert.equal(manifest.duration_minutes, 60)
  assert.equal(manifest.scoring.points_per_question * document.questions.length, 85)
  assert.equal(manifest.scoring.study_target_correct / 85, 0.6)
  assert.equal(manifest.scoring.official_pass_mark, false)
  assert.equal(Object.keys(editorial.questions).length, 85)
  const groupMap = new Map(document.groups.map(group => [group.id, group]))
  const passages = new Map(document.groups.flatMap(group => group.passages.map(passage => [passage.id, passage])))
  assert.equal(document.groups.length, manifest.hierarchy.group_count)
  assert.equal(passages.size, manifest.hierarchy.shared_passage_count)
  assert.equal(editorial.hierarchy.group_count, document.groups.length)
  assert.equal(editorial.hierarchy.shared_passage_count, passages.size)
  const stems = new Set()
  const correctLabels = {}
  let sharedLeadQuestions = 0
  for (const [index, question] of document.questions.entries()) {
    const n = index + 1
    const section = manifest.sections.filter(section => n >= section.first && n <= section.last)
    assert.equal(section.length, 1)
    assert.deepEqual(choiceLabelsForQuestion(config, question.exam_number, n), section[0].choice_labels)
    assert.equal(question.choices.length, 4)
    assert.equal(question.question_number, n)
    assert.equal(question.exam_number, examNumber)
    assert.equal(question.publication_status, 'published')
    assert.equal(question.major_category_code === 'application', n > 80)
    const choices = question.choices.map(choice => JSON.stringify(choice.content_blocks))
    assert.equal(new Set(choices).size, choices.length)
    const group = groupMap.get(question.group_id)
    assert(group)
    const referencedBlocks = (question.passage_references ?? []).flatMap(reference => {
      assert.equal(reference.anchor_id, null)
      const passage = passages.get(reference.passage_id)
      assert(passage)
      return passage.content_blocks
    })
    const effectiveBlocks = [...referencedBlocks, ...question.content_blocks]
    const stem = JSON.stringify(effectiveBlocks)
    assert.ok(!stems.has(stem)); stems.add(stem)
    const meta = editorial.questions[n]
    assert.ok(meta.topic?.trim())
    assert.ok(['basic', 'standard', 'advanced'].includes(meta.difficulty))
    assert.equal(meta.group_number, group.group_number)
    assert.equal(meta.group_question_number, question.group_question_number)
    if (meta.group) {
      assert.deepEqual(referencedBlocks, [{ type: 'text', text: meta.group.passage }])
      assert.ok(!question.content_blocks.some(block => block.type === 'text' && block.text === meta.group.passage))
      sharedLeadQuestions += 1
    } else {
      assert.deepEqual(referencedBlocks, [])
    }
    counts[question.major_category_code] = (counts[question.major_category_code] ?? 0) + 1
    if (n <= 80) {
      const label = question.choices.find(choice => choice.is_correct).choice_label
      correctLabels[label] = (correctLabels[label] ?? 0) + 1
    }
  }
  for (const expected of editorial.hierarchy.groups) {
    const group = document.groups.find(group => group.group_number === expected.group_number)
    assert(group)
    assert.equal(group.title, expected.title)
    assert.equal(group.planned_question_count, expected.question_count)
    assert.equal(group.passages.length, expected.shared_passage_count)
    const numbers = document.questions.filter(question => question.group_id === group.id).map(question => question.question_number)
    assert.deepEqual(numbers, Array.from({ length: expected.question_count }, (_, index) => expected.first_question_number + index))
    assert.equal(numbers.at(-1), expected.last_question_number)
  }
  assert.equal(sharedLeadQuestions, manifest.hierarchy.questions_with_shared_passage)
  assert.deepEqual(counts, manifest.allocation)
  assert.deepEqual(Object.values(correctLabels).sort(), [20, 20, 20, 20])
  const difficultyCounts = {}
  for (const meta of Object.values(editorial.questions)) {
    difficultyCounts[meta.difficulty] = (difficultyCounts[meta.difficulty] ?? 0) + 1
    if (examNumber > 1) {
      assert.ok(meta.focus_key && meta.focus_claim && meta.difficulty_reason)
      assert.deepEqual(Object.keys(meta.choice_reasons).sort(), ['ア', 'イ', 'ウ', 'エ'].sort())
      assert.ok(Object.values(meta.choice_reasons).every(reason => reason.trim().length > 0))
    }
  }
  assert.deepEqual(difficultyCounts, { basic: 19, advanced: 13, standard: 53 })
  const imageManifest = read('image-manifest.json')
  const assets = imageManifest.assets
  assert.equal(assets.length, manifest.figures.distinct_images)
  assert.equal(assets.length, examNumber === 1 ? 35 : 36)
  const bySource = new Map(assets.map(asset => [asset.src, asset]))
  assert.equal(bySource.size, assets.length)
  const imageQuestions = document.questions.filter(question => question.content_blocks.some(block => block.type === 'image'))
  assert.equal(imageQuestions.length, 31)
  assert.equal(imageQuestions.filter(question => question.question_number <= 80).length, 26)
  assert.equal(imageQuestions.filter(question => question.question_number > 80).length, 5)
  const imageAllocation = {}
  let occurrences = 0
  for (const question of imageQuestions) {
    const blocks = question.content_blocks.filter(block => block.type === 'image')
    occurrences += blocks.length
    assert.equal(editorial.questions[question.question_number].image_required, true)
    assert.deepEqual(editorial.questions[question.question_number].image_ids, blocks.map(block => bySource.get(block.src)?.id))
    if (question.question_number <= 80) imageAllocation[question.major_category_code] = (imageAllocation[question.major_category_code] ?? 0) + 1
    for (const block of blocks) {
      const asset = bySource.get(block.src)
      assert(asset)
      assert(asset.question_numbers.includes(question.question_number))
      assert(!/https?:|(?:Giotto|Raphael|Monet|Botticelli|Hokusai|Utamaro|広重|北斎|歌麿|宗達|元信)/i.test(block.alt))
      assert(question.source_text.includes(asset.source_page))
    }
  }
  assert.deepEqual(imageAllocation, { western: 16, japanese: 8, asian: 1, design: 1 })
  assert.equal(occurrences, 36)
  for (const asset of assets) {
    assert(artworkImagePathSchema.safeParse(asset.src).success)
    assert.match(asset.src, new RegExp(`^/images/artworks/mock${String(examNumber).padStart(2, '0')}-img-\\d{2}\\.jpg$`))
    assert.equal(asset.license, 'CC0-1.0')
    assert.equal(asset.official_problem_book_reuse, false)
    assert(asset.rights_review?.japan_term_expired || asset.rights_review?.japan_ordinary_term_expired)
    assert(asset.source_page.startsWith('https://'))
    assert(asset.policy_url.startsWith('https://'))
    assert(asset.width > 100 && asset.height > 100 && Math.max(asset.width, asset.height) <= 1800)
    const bytes = readFileSync(resolve('frontend/public', asset.src.slice(1)))
    assert.equal(bytes.readUInt16BE(0), 0xffd8)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    assert.deepEqual(asset.question_numbers, imageQuestions.filter(q => q.content_blocks.some(b => b.type === 'image' && b.src === asset.src)).map(q => q.question_number))
  }
  // Print only safe aggregate results; never question bodies, keys, or explanations.
  console.log(JSON.stringify({ status: 'passed', exam: examNumber, difficulty: difficultyCounts, questions: document.questions.length,
    groups: document.groups.length, shared_passages: passages.size, shared_lead_questions: sharedLeadQuestions,
    history: 80, application: 5, minutes: manifest.duration_minutes, image_questions: imageQuestions.length, images: assets.length,
    schema: 'frontend/shared/schemas', categories: Object.keys(counts).length }))
}

try { main() } catch {
  // Assertions may contain authored bodies; expose only a fixed safe diagnostic.
  console.error('Mock exam validation failed. Check the shared schema, hierarchy and editorial metadata.')
  process.exitCode = 1
}
