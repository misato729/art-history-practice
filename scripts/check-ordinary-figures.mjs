import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const sha = data => createHash('sha256').update(data).digest('hex')

function artworkRegistry() {
  const assets = new Map()
  const originals = new Map()
  for (const exam of [1, 2, 3, 4, 5]) {
    const directory = exam === 2 ? 'content/revisions/mock02-textbook-v2'
      : `content/revisions/illustrated-01345/mock-${exam}`
    for (const item of read(`${directory}/baseline-artifacts/image-manifest.json`).assets) {
      assets.set(item.src, item)
      originals.set(item.sha256, item)
    }
  }
  for (const directory of ['illustrated-01345', 'illustrated-06-08']) {
    for (const copy of read(`content/revisions/${directory}/asset-manifest.json`)) {
      const item = originals.get(copy.original_sha256)
      assert.ok(item && item.source_page === copy.source_page, `Unknown artwork for ${copy.asset_id}`)
      const src = '/images/artworks/illustrated-' + basename(copy.file)
      assets.set(src, { ...item, src, sha256: copy.sha256 })
    }
  }
  for (const item of read('content/editorial/figure-history-assets.json').assets) {
    assert.ok(!assets.has(item.src))
    assets.set(item.src, item)
  }
  return assets
}

const normal = cell => cell.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '')

// Order and typography alone do not make a comparison table a different figure.
function tableKey(block) {
  const headings = block.headers.map(normal)
  const rows = block.rows.map(row => row.map((cell, i) => [headings[i], normal(cell)]).sort())
  return 'table:' + sha(JSON.stringify(rows.map(row => JSON.stringify(row)).sort()))
}

export function checkOrdinaryFigures(document) {
  const assets = artworkRegistry()
  const seen = new Map()
  const ledger = []
  const register = (id, location) => {
    assert.ok(!seen.has(id), `Repeated figure in ${seen.get(id)} and ${location}: ${id}`)
    seen.set(id, location)
  }
  const passages = new Map(document.groups.flatMap(group => group.passages.map(p => [p.id, p])))
  const illustrated = Array(8).fill(0)
  const ordinary = document.questions.filter(q => q.question_number <= 80)
  assert.equal(ordinary.length, 640)
  for (const q of ordinary) {
    const location = `${q.exam_number}-${q.question_number}`
    const blocks = [...q.content_blocks, ...q.choices.flatMap(c => c.content_blocks)]
    for (const ref of q.passage_references) {
      const passage = passages.get(ref.passage_id)
      assert.ok(passage, `Unknown passage in ${location}`)
      blocks.push(...passage.content_blocks)
    }
    const figures = blocks.filter(b => b.type === 'image' || b.type === 'table')
    if (figures.length) illustrated[q.exam_number - 1]++
    for (const block of figures) {
      if (block.type === 'table') {
        const identity = tableKey(block)
        register(identity, location)
        ledger.push({ location, type: 'table', identity })
        continue
      }
      const item = assets.get(block.src)
      assert.ok(item?.candidate_id && item.accession_number && item.source_page && item.policy_url && item.license === 'CC0-1.0', `Missing museum record in ${location}: ${block.src}`)
      assert.equal(sha(readFileSync(resolve(root, 'frontend/public' + block.src))), item.sha256, `Image differs in ${location}`)
      register(item.candidate_id, location)
      register(item.provider + '/' + item.accession_number, location)
      register(item.source_page, location)
      register(item.sha256, location)
      ledger.push({ location, type: 'image', src: block.src, identity: item.candidate_id, title: item.title, provider: item.provider,
        accession_number: item.accession_number, source_page: item.source_page, sha256: item.sha256 })
    }
  }
  return { ordinary: ordinary.length, illustrated, ledger }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ordinary, illustrated, ledger } = checkOrdinaryFigures(read('content/questions.json'))
  console.log(JSON.stringify({ ordinary, illustrated_by_exam: illustrated,
    artworks: ledger.filter(x => x.type === 'image').length, tables: ledger.filter(x => x.type === 'table').length, duplicates: 0 }))
}
