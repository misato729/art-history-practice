import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { STATIC_EXAM_GROUPS } from '../app/utils/staticExamGroups.ts'
import { catalogGroupLinks, createSidebarExamCatalog, isCatalogGroupActive } from '../app/utils/examCatalog.ts'

test('all eight static sidebars match their own public groups and exact child positions', () => {
  const content = JSON.parse(readFileSync(new URL('../../content/questions.json', import.meta.url), 'utf8'))
  const staticRows = createSidebarExamCatalog(null, false, true)
  assert.equal(staticRows.length, 8)
  assert.equal(content.groups.length, 161)
  for (const exam of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const groups = content.groups.filter((group: any) => group.exam_number === exam && group.publication_status === 'published')
    assert.equal(STATIC_EXAM_GROUPS[exam]!.length, groups.length)
    assert.ok(groups.length > 0)
    for (const group of groups) {
      const row = STATIC_EXAM_GROUPS[exam]!.find(item => item.group_number === group.group_number)!
      assert.equal(row.title, group.title)
      assert.deepEqual(row.question_numbers, content.questions.filter((q: any) => q.exam_number === exam && q.group_id === group.id).map((q: any) => q.question_number))
    }
    const sidebar = staticRows.find(row => row.exam_number === exam)!
    assert.deepEqual(sidebar.question_numbers, [])
    const links = catalogGroupLinks(sidebar)
    assert.equal(links.length, groups.length)
    assert.equal(links.every(link => link.to === `/practice/start?exams=${exam}&group=${link.group.group_number}`), true)
  }
})

test('live group links use only published sparse positions and active membership', () => {
  const group = { id: 1, group_number: 2, title: 'Synthetic', question_numbers: [7, 11, 13] }
  const exam = { exam_number: 1, question_numbers: [11, 13], groups: [group] }
  const rows = createSidebarExamCatalog([exam], true, true)
  assert.equal(rows[0]!.isStatic, false)
  assert.equal(catalogGroupLinks(rows[0]!)[0]!.to, '/practice/1/11')
  assert.equal(isCatalogGroupActive(exam, group, 1, 7), false)
  assert.equal(isCatalogGroupActive(exam, group, 1, 13), true)
  assert.equal(isCatalogGroupActive(exam, group, 2, 13), false)
  assert.deepEqual(createSidebarExamCatalog([], true, true), [])
})
