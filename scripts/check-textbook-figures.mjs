import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {materialDigest} from '../frontend/server/services/learning-writer.ts'

const load = name => JSON.parse(readFileSync(new URL('../content/' + name, import.meta.url), 'utf8'))

// The page numbers are a publication contract. Independent review verifies the
// actual claims against the supplied textbook; this check preserves that version.
export function checkTextbookFigures(document) {
  const revision = load('editorial/figure-textbook-20261111.json')
  const original = load('editorial/figure-history-20261111.json')
  const key = q => q.exam_number + '-' + q.question_number
  assert.equal(revision.questions.length, 127)
  assert.deepEqual(new Set(revision.questions.map(key)), new Set(original.questions.map(key)))
  const questions = new Map(document.questions.map(q => [key(q), q]))
  let references = 0
  for (const patch of revision.questions) {
    const question = questions.get(key(patch))
    assert.ok(question && question.question_number <= 80)
    const pages = patch.textbook_pages
    assert.ok(pages.length && new Set(pages).size === pages.length)
    assert.ok(pages.every(p => Number.isInteger(p) && p >= 12 && p <= 271))
    assert.equal(materialDigest(question), patch.after_sha256)
    const [book, ...supplements] = question.source_text.split('\n')
    assert.equal(book, '『改訂版 西洋・日本美術史の基本』p.' + pages.join('・') + '（textbook.pdf：PDF ' + pages.map(p => p + 2).join('・') + 'ページ）')
    assert.ok(supplements.every(line => line.startsWith('図版出典：') && line.includes(' | https://')))
    const images = question.content_blocks.filter(block => block.type === 'image')
    assert.equal(supplements.length, images.length)
    references += pages.length
  }
  return {textbook_questions: 127, printed_page_references: references}
}
