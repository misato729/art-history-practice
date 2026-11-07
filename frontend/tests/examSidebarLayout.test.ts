import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), 'utf8')
const layout = source('layouts/default.vue')
const header = source('components/SiteHeader.vue')
const sidebar = source('components/ExamSidebar.vue')

test('one shared exam sidebar is rendered inside the sticky site header', () => {
  assert.equal(layout.match(/<ExamSidebar\b/g)?.length, 1)
  assert.match(layout, /<SiteHeader>\s*<ExamSidebar\b[^>]*\/>\s*<\/SiteHeader>/)
  assert.match(header, /<slot\s*\/>\s*<\/header>/)
  assert.match(header, /\.site-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/)
})

test('mobile menu starts closed and exams have separate question-list toggles', () => {
  assert.match(sidebar, /const mobileOpen = ref\(false\)/)
  assert.match(sidebar, /:aria-expanded="mobileOpen"/)
  assert.match(sidebar, /aria-controls="exam-sidebar-content"/)
  assert.match(sidebar, /id="exam-sidebar-content"/)
  assert.match(sidebar, /:aria-expanded="openExam === exam.examNumber"/)
  assert.match(sidebar, /:aria-controls="`exam-\$\{exam.examNumber\}-questions`"/)
  assert.match(sidebar, /\.mobile-open \.sidebar-content\s*\{ display: block; \}/)
})

test('navigation closes mobile menu, Escape restores focus, and no catalog is loaded', () => {
  assert.match(sidebar, /watch\(\(\) => route.fullPath, closeMobileList\)/)
  assert.equal(sidebar.match(/@click="closeMobileList"/g)?.length, 2)
  assert.match(sidebar, /@keydown.esc="closeSidebarOnEscape"/)
  assert.match(sidebar, /mobileToggle.value\?\.focus\(\)/)
  assert.doesNotMatch(sidebar, /\b(?:usePracticeCatalog|useFetch|useAsyncData|useApi|\$fetch)\s*\(/)
  assert.doesNotMatch(sidebar, /sidebar-loading|catalogStatus|catalogError/)
})

test('sidebar renders number links and disables link prefetch', () => {
  assert.match(sidebar, /createStaticExamNavigation\(STATIC_EXAM_CATALOG,/)
  assert.match(sidebar, /v-for="entry in exam.questions"/)
  assert.match(sidebar, /問\{\{ entry.number \}\}/)
  assert.match(sidebar, /:to="entry.to"/)
  assert.equal(sidebar.match(/\bno-prefetch\b/g)?.length, 2)
  assert.match(sidebar, /:aria-current="isCurrentQuestion\(exam.examNumber, entry.number\) \? 'page' : undefined"/)
  assert.doesNotMatch(sidebar, /sectionLinks|groupLinks|\/practice\/start/)
})

test('number links keep comfortable targets and titles can wrap', () => {
  assert.match(sidebar, /\.question-list a\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*44px;/)
  assert.match(sidebar, /\.exam-link\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/)
  assert.match(sidebar, /button:focus-visible/)
})

test('home anchor leaves room for both mobile header rows', () => {
  assert.match(layout, /--site-navigation-height: calc\(var\(--header-height\) \+ var\(--exam-toggle-height\)\)/)
  assert.match(source('pages/index.vue'), /scroll-margin-top: calc\(var\(--site-navigation-height, var\(--header-height\)\) \+ 20px\)/)
})

test('mobile exam rows stack; question grids do not overlap adjacent rows', () => {
  const mobileStyles = sidebar.split('@media (max-width: 760px)')[1]
  assert.ok(mobileStyles)
  assert.match(mobileStyles, /\.exam-groups\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(mobileStyles, /\.question-list\s*\{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/)
  assert.match(mobileStyles, /overflow-y: auto/)
  assert.match(mobileStyles, /100dvh/)
  assert.doesNotMatch(mobileStyles, /width: calc\(200%|margin-left: calc\(-100%/)
})

test('question routes open the current exam and desktop collapse still belongs to the layout', () => {
  assert.match(sidebar, /watch\(\(\) => currentPosition.value\?\.examNumber,/)
  assert.match(sidebar, /\{ immediate: true \}/)
  assert.match(sidebar, /emit\('toggle-desktop'\)/)
  assert.match(sidebar, /desktopToggle.value\?\.focus\(\)/)
  assert.match(sidebar, /\.desktop-collapsed \.sidebar-content \{ display: none; \}/)
})
