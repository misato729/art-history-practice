<script setup lang="ts">
import { UPCOMING_EXAM_CATALOG, FREE_EXAM_MAX } from '~/utils/examCatalog'
const route = useRoute()
const exam = computed(() => UPCOMING_EXAM_CATALOG.find(exam => String(exam.exam_number) === route.params.examNumber))
if (!exam.value) throw createError({ statusCode: 404, statusMessage: 'Not found' })
useSeoMeta({ title: () => `${exam.value?.title}は準備中です｜${SITE.name}`, robots: 'noindex, nofollow' })
</script>

<template>
  <section class="upcoming-exam">
    <p class="status-label">準備中</p>
    <h1>{{ exam?.title }}</h1>
    <p>問題を作成しています。準備が整い次第、このサイトで公開します。</p>
    <p>現在は模擬試験1〜{{ EXAM_CONFIG.exam.set_count }}を公開しています。模擬試験1〜{{ FREE_EXAM_MAX }}は無料、模擬試験{{ FREE_EXAM_MAX + 1 }}以降の公開問題はプレミアム会員向けです。</p>
    <p>この回はまだ演習できません。公開日は未定です。</p>
    <div class="upcoming-actions">
      <NuxtLink to="/" no-prefetch>公開中の模擬試験を選ぶ</NuxtLink>
      <NuxtLink to="/premium" no-prefetch>プレミアム会員について</NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.upcoming-exam { max-width: 800px; margin: 0 auto; padding: 48px 24px; }
.status-label { color: var(--teal-dark); font-weight: 700; }
h1 { margin: 12px 0 24px; }
p { line-height: 1.9; }
.upcoming-actions { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 28px; }
a { color: var(--teal-dark); text-underline-offset: 4px; }
</style>
