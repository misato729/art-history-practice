<script setup lang="ts">
import type { LearningBlock } from '../../shared/types/learning'

withDefaults(defineProps<{ blocks: LearningBlock[]; anchorPrefix?: string }>(), { anchorPrefix: '' })

const blankLabels = ['①', '②', '③', '④', '⑤', '⑥']
</script>

<template>
  <div class="content-blocks">
    <div v-for="(block, index) in blocks" :id="anchorPrefix && block.id ? `${anchorPrefix}-${block.id}` : undefined" :key="`${block.type}-${index}`" class="content-block" :tabindex="anchorPrefix && block.id ? -1 : undefined">
      <p v-if="block.type === 'text'" class="content-text"><QuestionInlineText :text="block.text" :inlines="block.inlines" :anchor-prefix="anchorPrefix" /></p>

      <blockquote v-else-if="block.type === 'quote'" class="content-quote">
        <p><QuestionInlineText :text="block.text" :inlines="block.inlines" :anchor-prefix="anchorPrefix" /></p>
        <cite v-if="block.source">{{ block.source }}</cite>
      </blockquote>

      <p v-else-if="block.type === 'fill_in_text'" class="content-text fill-in-text">
        <QuestionInlineText :text="block.text" :inlines="block.inlines" :anchor-prefix="anchorPrefix" fill />
      </p>

      <blockquote v-else-if="block.type === 'fill_in_quote'" class="exam-fill-in-quote">
        <p>
          <QuestionInlineText :text="block.text" :inlines="block.inlines" :anchor-prefix="anchorPrefix" fill />
        </p>
      </blockquote>

      <div v-else-if="block.type === 'fill_in_choice'" class="fill-in-choice">
        <span v-for="(cell, cellIndex) in block.cells" :key="cellIndex" class="fill-in-choice-cell">
          <small>{{ blankLabels[cellIndex] }}</small>
          <span>{{ cell }}</span>
        </span>
      </div>

      <div v-else-if="block.type === 'table'" class="content-table-wrap" tabindex="0">
        <table class="content-table">
          <thead v-if="block.headers?.length">
            <tr>
              <th v-for="header in block.headers" :key="header" scope="col">{{ header }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
              <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <ArtworkImage v-else-if="block.type === 'image'" :src="block.src" :alt="block.alt" :label="block.label" />

      <figure v-else-if="block.type === 'code'" class="code-panel">
        <figcaption v-if="block.title">{{ block.title }}</figcaption>
        <pre><code>{{ block.code }}</code></pre>
      </figure>

      <div v-else-if="block.type === 'code_group'" class="code-group">
        <figure v-for="(item, itemIndex) in block.items" :key="item.title ?? itemIndex" class="code-panel">
          <figcaption>{{ item.title }}</figcaption>
          <pre><code>{{ item.code }}</code></pre>
        </figure>
      </div>
    </div>
  </div>
</template>

<style scoped>
.content-blocks { display: grid; gap: 20px; min-width: 0; }
.content-block { min-width: 0; scroll-margin-top: calc(var(--site-navigation-height, var(--header-height)) + 28px); outline-offset: 5px; }
.content-block:focus { outline: 2px solid var(--teal); }
.content-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.content-quote { margin: 0; padding: 18px 20px; border: 1px solid var(--line); border-left: 4px solid var(--teal); background: #f7faf9; }
.content-quote p { margin: 0; font-size: 18px; font-weight: 500; white-space: pre-wrap; }
.content-quote cite { display: block; margin-top: 10px; color: var(--muted); font-size: 13px; font-style: normal; }
.fill-in-text { line-height: 2.15; }
.fill-in-blank {
  min-width: 3.1em;
  min-height: 1.75em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0 .18em;
  padding: 0 .55em;
  border: 2px solid #46575c;
  background: #fff;
  color: #46575c;
  font-size: .82em;
  font-weight: 700;
  line-height: 1;
  vertical-align: middle;
}
.exam-fill-in-quote {
  margin: 0;
  padding: 22px 24px;
  border: 1px solid #66777c;
  background: #fff;
  color: #263a41;
  font-size: 18px;
  font-weight: 500;
  line-height: 2.3;
}
.exam-fill-in-quote p { margin: 0; white-space: pre-wrap; }
.fill-in-choice { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.fill-in-choice-cell { min-width: 0; display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: baseline; gap: 6px; }
.fill-in-choice-cell small { color: #52666d; font-size: 14px; font-weight: 700; }
.fill-in-choice-cell > span { font-weight: 700; }
.content-table-wrap { max-width: 100%; overflow-x: auto; border: 1px solid var(--line); }
.content-table { width: 100%; min-width: 620px; border-collapse: collapse; background: #fff; font-size: 16px; font-weight: 500; line-height: 1.7; }
.content-table th,
.content-table td { padding: 12px 14px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; white-space: pre-wrap; }
.content-table th { background: #f1f6f5; color: #30464d; font-size: 14px; font-weight: 700; }
.content-table tr:last-child td { border-bottom: 0; }
.content-table th:last-child,
.content-table td:last-child { border-right: 0; }
.code-group { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.code-panel { min-width: 0; margin: 0; border: 1px solid var(--line); background: #f8faf9; }
.code-panel figcaption { padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 800; text-align: center; }
.code-panel pre { margin: 0; padding: 16px; overflow-x: auto; font-size: 14px; line-height: 1.75; white-space: pre; }
.code-panel code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
@media (max-width: 720px) {
  .code-group { grid-template-columns: 1fr; }
  .content-quote { padding: 16px; }
  .exam-fill-in-quote { padding: 17px 16px; line-height: 2.15; }
  .fill-in-choice { grid-template-columns: 1fr; gap: 5px; }
}
</style>
