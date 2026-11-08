#!/usr/bin/env node
import assert from 'node:assert/strict'
import './check-wording.mjs'
import { readFileSync } from 'node:fs'
import { verify678 } from './illustrated-678/build.mjs'
import { verifyIllustrated } from './illustrated-revision/build.mjs'
import { verifySeed } from './mock02-revision/build-seed.mjs'
import { createHash } from 'node:crypto'
import { parseExamConfig } from '../frontend/shared/schemas/exam.ts'
import { parseContentDocument } from '../frontend/shared/schemas/structure.ts'
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const characters = block => block.type === 'image' ? 0
  : block.type === 'table' ? [...(block.headers ?? []), ...(block.rows ?? []).flat()].reduce((sum, cell) => sum + [...cell].length, 0)
  : block.inlines ? block.inlines.reduce((sum, inline) => sum + [...(inline.text ?? inline.label ?? '')].length, 0)
  : [...(block.text ?? block.code ?? '')].length
const reading = questions => questions.reduce((counts, question) => {
  const size = [...question.content_blocks, ...question.choices.flatMap(choice => choice.content_blocks)].reduce((sum, block) => sum + characters(block), 0)
  counts[question.major_category_code] = (counts[question.major_category_code] ?? 0) + size
  return counts
}, {})
function main() {
  const authoringOnly = process.argv.includes('--authoring-only')
  // Original series ratings/PDFs remain historical artifacts; V2 is checked against its supplied source.
  verify678()
  verifySeed()
  verifyIllustrated()
  const directory = exam => exam === 2 ? 'content/revisions/mock02-textbook-v2/baseline-artifacts' : `content/revisions/illustrated-01345/mock-${exam}/baseline-artifacts`
  const config = parseExamConfig(authoringOnly ? read(`${directory(2)}/manifest.json`).validation_config : read('config/exam.json'))
  const authored = [1,2,3,4,5].map(exam => read(`${directory(exam)}/questions.json`))
  const document = parseContentDocument({schema_version:2,exam_sets:authored.flatMap(item=>item.exam_sets),groups:authored.flatMap(item=>item.groups),questions:authored.flatMap(item=>item.questions)},config)
  const series = read('content/mock-exams/series.json')
  assert.equal(config.exam.set_count, authoringOnly ? 5 : 8)
  assert.equal(document.questions.length, 425)
  assert.equal(document.groups.length, 155)
  assert.equal(document.exam_sets.length, 5)
  assert.deepEqual(document.exam_sets.map(set => set.title), [1,2,3,4,5].map(exam => `模擬試験${exam}`))
  assert.deepEqual(Object.keys(series.calibration_adjustments).sort(), ['4-12', '4-7'])
  assert.deepEqual(Object.keys(series.rubric_normalizations).sort(), ['3-61', '5-61'])
  assert.equal(series.rubric_scale.minimum, 0); assert.equal(series.rubric_scale.maximum, 2)
  const focuses = new Set(), stems = new Set(), assets = new Set(), hashes = new Set()
  let newFocuses = 0, choices = 0, occurrences = 0
  const baseDifficulty = read(`${directory(1)}/editorial.json`).questions
  const baseReading = reading(document.questions.filter(question => question.exam_number === 1))
  for (const exam of [1,2,3,4,5]) {
    const dir = directory(exam)
    const standalone = parseContentDocument(read(`${dir}/questions.json`), config)
    const meta = read(`${dir}/editorial.json`).questions
    const registry = read(`${dir}/image-manifest.json`).assets
    const actual = document.questions.filter(question => question.exam_number === exam)
    assert.equal(actual.length, 85)
    assert.deepEqual(actual, standalone.questions)
    assert.deepEqual(document.groups.filter(group => group.exam_number === exam), standalone.groups)
    const difficulty = {}, counts = {}
    for (const question of actual) {
      choices += question.choices.length
      const n = question.question_number, item = meta[n]
      difficulty[item.difficulty] = (difficulty[item.difficulty] ?? 0) + 1
      counts[question.major_category_code] = (counts[question.major_category_code] ?? 0) + 1
      const adjustment = series.calibration_adjustments?.[`${exam}-${n}`]
      if (adjustment) assert.equal(adjustment.from, baseDifficulty[n].difficulty)
      assert.equal(item.difficulty, adjustment?.to ?? baseDifficulty[n].difficulty)
      if (exam > 1) {
        assert.deepEqual(Object.keys(item.rubric).sort(), ['knowledge_specificity','inference_steps','distractor_proximity','visual_demand'].sort())
        assert.ok(Object.values(item.rubric).every(value => Number.isInteger(value) && value >= 0 && value <= 2))
        for (const [field, change] of Object.entries(series.rubric_normalizations[`${exam}-${n}`]?.fields ?? {})) {
          assert.equal(change.from, 3); assert.equal(change.to, 2); assert.equal(item.rubric[field], change.to)
        }
      }
      const stem = JSON.stringify(question.content_blocks)
      assert.ok(!stems.has(stem)); stems.add(stem)
      occurrences += question.content_blocks.filter(block => block.type === 'image').length
      if (exam > 1) {
        assert.ok(!focuses.has(item.focus_key)); focuses.add(item.focus_key); newFocuses += 1
        assert.equal(Object.keys(item.choice_reasons).length, 4)
        assert.ok(item.focus_claim.trim() && item.difficulty_reason.trim())
      }
    }
    assert.deepEqual(difficulty, { basic: 19, advanced: 13, standard: 53 })
    assert.deepEqual(counts, { western:41, japanese:25, contemporary:5, asian:3, design:4, museum:2, application:5 })
    for (const asset of registry) {
      assert.ok(!assets.has(asset.candidate_id)); assets.add(asset.candidate_id)
      assert.ok(!hashes.has(asset.sha256)); hashes.add(asset.sha256)
    }
    if (exam > 1) {
      const questionMarkdown = readFileSync(`${dir}/questions.md`, 'utf8')
      const answerMarkdown = readFileSync(`${dir}/answers.md`, 'utf8')
      assert.equal((questionMarkdown.match(/^### 問[0-9]+$/gm) ?? []).length, 85)
      assert.equal((answerMarkdown.match(/^## 問[0-9]+ 正答：/gm) ?? []).length, 85)
      for (const question of actual) {
        const number = question.question_number
        const qPart = questionMarkdown.split(new RegExp(`^### 問${number}$`, 'm'))[1]?.split(/^### 問[0-9]+$/m)[0] ?? ''
        for (const block of question.content_blocks) {
          if (block.type === 'text') assert.ok(qPart.includes(block.text))
          if (block.type === 'image') assert.ok(qPart.includes(`![${block.alt}](../../../frontend/public${block.src})`))
          if (block.type === 'table') assert.ok([...(block.headers ?? []), ...(block.rows ?? []).flat()].every(cell => qPart.includes(cell)))
        }
        for (const choice of question.choices) assert.ok(qPart.includes(`${choice.choice_label}．${choice.content_blocks[0].text}`))
        const correct = question.choices.find(choice => choice.is_correct).choice_label
        const aPart = answerMarkdown.split(`## 問${number} 正答：${correct}\n`)[1]?.split(/^## /m)[0] ?? ''
        assert.ok(aPart)
        for (const block of question.explanation_blocks) if (block.type === 'text') assert.ok(aPart.includes(block.text))
        for (const source of question.source_text.split('\n')) assert.ok(aPart.includes(source))
      }
    }
    const record = series.sets.find(set => set.exam_number === exam)
    assert.equal(record.question_sha256, hash(`${dir}/questions.json`))
    const actualReading = reading(actual)
    assert.deepEqual(record.reading_characters, actualReading)
    if (exam > 1) for (const [area, size] of Object.entries(actualReading)) {
      assert.ok(size >= baseReading[area] * 0.85 && size <= baseReading[area] * 1.15)
    }
    for (const kind of ['questions', 'answers']) assert.equal(record.pdf_sha256[kind], hash(`output/pdf/art-grade2-mock-${String(exam).padStart(2, '0')}-${kind}.pdf`))
  }
  assert.equal(newFocuses, 340)
  assert.equal(choices, 1700)
  assert.equal(assets.size, 179)
  assert.equal(occurrences, 180)
  for (const [path, digest] of Object.entries(series.preserved_mock01_files)) assert.equal(hash(path.replace('content/mock-exams/mock-01/','content/revisions/illustrated-01345/mock-1/baseline-artifacts/')), digest)
  // This structural comparison does not replace independent semantic or difficulty review.
  console.log(JSON.stringify({ status:'passed', scope:'historical_series_and_source_checked_active_revision', active_revision:'mock02-textbook-v2-20261107', sets:5, questions:425, choices, new_focuses:newFocuses,
    artwork_assets:assets.size, image_occurrences:occurrences, historical_mock01_preserved:true,reviewed_wording_applied:true, calibration:'historical_editorial_only_v2_not_calibrated' }))
}
try { main() } catch {
  console.error('Mock series validation failed. Check set integration, allocation, editorial records, preserved files and PDF hashes.')
  process.exitCode = 1
}
