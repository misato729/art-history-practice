<script setup lang="ts">
import { STATIC_EXAM_CATALOG } from '~/utils/examCatalog'
import { EXAM_CONFIG, hasFullExamAccess } from '~/utils/examConfig'
import { createStaticExamNavigation, staticPracticePosition } from '~/utils/staticExamNavigation'

const props = withDefaults(defineProps<{ desktopOpen?: boolean }>(), { desktopOpen: true })
const emit = defineEmits<{ 'toggle-desktop': [] }>()
const route = useRoute()
const openExam = ref<number | null>(null)
const mobileOpen = ref(false)
const mobileToggle = ref<HTMLButtonElement | null>(null)
const desktopToggle = ref<HTMLButtonElement | null>(null)
const { user } = useAuth()

// All configured questions are published together. Navigation must not wait for Fly.io.
// No catalog request on mount, accordion expansion, hover or focus.
const exams = computed(() => createStaticExamNavigation(STATIC_EXAM_CATALOG, {
  paymentsEnabled: EXAM_CONFIG.payments.enabled,
  freeExamCount: EXAM_CONFIG.payments.free_exam_count,
  fullAccess: hasFullExamAccess(user.value),
}))
const currentPosition = computed(() => staticPracticePosition(route.path))
const isCurrentQuestion = (exam: number, question: number) => (
  currentPosition.value?.examNumber === exam && currentPosition.value.questionNumber === question
)

const toggleExam = (exam: number) => {
  openExam.value = openExam.value === exam ? null : exam
}

const closeMobileList = () => { mobileOpen.value = false }
const closeSidebarOnEscape = () => {
  if (window.matchMedia('(min-width: 761px)').matches) {
    if (!props.desktopOpen) return
    emit('toggle-desktop')
    desktopToggle.value?.focus()
    return
  }
  if (!mobileOpen.value) return
  closeMobileList()
  mobileToggle.value?.focus()
}

watch(() => route.fullPath, closeMobileList)
watch(() => currentPosition.value?.examNumber, exam => {
  openExam.value = exam !== undefined && exams.value.some(entry => entry.examNumber === exam) ? exam : null
}, { immediate: true })
</script>

<template>
  <aside
    class="exam-sidebar"
    :class="{ 'mobile-open': mobileOpen, 'desktop-collapsed': !desktopOpen }"
    aria-label="模擬試験一覧"
    @keydown.esc="closeSidebarOnEscape"
  >
    <div class="sidebar-heading">
      <span class="sidebar-title">
        <UIcon name="i-lucide-files" />
        <span>試験セット</span>
      </span>
      <button
        ref="desktopToggle"
        class="desktop-exam-toggle"
        type="button"
        :aria-expanded="desktopOpen"
        aria-controls="exam-sidebar-content"
        :aria-label="desktopOpen ? 'サイドバーを閉じる' : 'サイドバーを開く'"
        :title="desktopOpen ? 'サイドバーを閉じる' : 'サイドバーを開く'"
        @click="emit('toggle-desktop')"
      >
        <UIcon :name="desktopOpen ? 'i-lucide-chevron-left' : 'i-lucide-chevron-right'" />
      </button>
    </div>

    <button
      ref="mobileToggle"
      class="mobile-exam-toggle"
      type="button"
      :aria-expanded="mobileOpen"
      aria-controls="exam-sidebar-content"
      :title="mobileOpen ? '試験セットを閉じる' : '試験セットを開く'"
      :aria-label="mobileOpen ? '試験セットを閉じる' : '試験セットを開く'"
      @click="mobileOpen = !mobileOpen"
    >
      <UIcon name="i-lucide-files" />
      <span>試験セット</span>
      <UIcon :name="mobileOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
    </button>

    <div id="exam-sidebar-content" class="sidebar-content">
      <div class="exam-groups">
        <section v-for="exam in exams" :key="exam.examNumber" class="exam-group">
          <div class="exam-row" :class="{ current: currentPosition?.examNumber === exam.examNumber }">
            <NuxtLink class="exam-link" :to="exam.to" no-prefetch @click="closeMobileList">
              {{ exam.title }}
              <span v-if="exam.comingSoon" class="coming-soon-label">準備中</span>
              <UIcon v-if="exam.locked" name="i-lucide-lock-keyhole" aria-label="プレミアム会員向け" />
            </NuxtLink>
            <button
              v-if="!exam.comingSoon"
              type="button"
              :aria-expanded="openExam === exam.examNumber"
              :aria-controls="`exam-${exam.examNumber}-questions`"
              :title="`${exam.title}の問題一覧を${openExam === exam.examNumber ? '閉じる' : '開く'}`"
              @click="toggleExam(exam.examNumber)"
            >
              <UIcon :name="openExam === exam.examNumber ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
              <span class="sr-only">{{ exam.title }}の問題一覧を{{ openExam === exam.examNumber ? '閉じる' : '開く' }}</span>
            </button>
          </div>

          <Transition name="questions">
            <nav
              v-if="openExam === exam.examNumber"
              :id="`exam-${exam.examNumber}-questions`"
              class="question-list"
              :aria-label="`${exam.title}の問題一覧`"
            >
              <NuxtLink
                v-for="entry in exam.questions"
                :key="entry.number"
                :to="entry.to"
                no-prefetch
                :class="{ active: isCurrentQuestion(exam.examNumber, entry.number) }"
                :aria-current="isCurrentQuestion(exam.examNumber, entry.number) ? 'page' : undefined"
                :aria-label="`${exam.title}・問${entry.number}${exam.locked ? '（プレミアム会員向け）' : ''}`"
                @click="closeMobileList"
              >
                問{{ entry.number }}
              </NuxtLink>
            </nav>
          </Transition>
        </section>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.coming-soon-label { font-size: 12px; color: var(--muted); white-space: nowrap; }
.exam-sidebar {
  width: var(--exam-sidebar-width, 260px);
  min-height: calc(100vh - var(--header-height));
  padding: 22px 16px;
  border-right: 1px solid var(--line);
  background: var(--surface-tint);
}

.sidebar-heading {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
  padding: 0 0 10px 10px;
  color: var(--muted);
  font-size: 0.8125rem;
  font-weight: 800;
}

.sidebar-title { display: flex; align-items: center; gap: 9px; white-space: nowrap; }
.desktop-exam-toggle {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  font-size: 1.25rem;
  cursor: pointer;
}
.desktop-exam-toggle:hover { background: var(--surface-selected); }
.mobile-exam-toggle { display: none; }

.exam-group + .exam-group {
  margin-top: 10px;
}

.exam-row {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 10px 10px 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}

.exam-link {
  min-width: 0;
  align-self: stretch;
  flex: 1;
  display: flex;
  align-items: center;
  color: var(--ink);
  font-size: 0.9375rem;
  font-weight: 800;
  text-decoration: none;
  overflow-wrap: anywhere;
}

.exam-link:hover {
  color: var(--teal-dark);
}

.exam-row.current {
  border-color: var(--teal);
}

.exam-row button {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: var(--surface-tint);
  color: var(--teal-dark);
  font-size: 1.3125rem;
  cursor: pointer;
}

.exam-row button:hover {
  background: var(--surface-selected);
}

.question-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
  padding: 10px 2px 4px;
}

.question-list a {
  min-width: 0;
  min-height: 44px;
  padding: 8px 2px;
  border: 1px solid transparent;
  display: grid;
  place-items: center;
  white-space: nowrap;
  border-radius: 5px;
  color: var(--muted);
  font-size: 0.8125rem;
  font-weight: 700;
  text-decoration: none;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.question-list a:hover,
.question-list a.active {
  background: var(--surface-selected);
  color: var(--teal-dark);
}

.question-list a.active { box-shadow: inset 0 0 0 2px var(--teal-dark); }
.question-list a:focus-visible,
.exam-link:focus-visible,
button:focus-visible { outline: 2px solid var(--teal-dark); outline-offset: 2px; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.questions-enter-active,
.questions-leave-active {
  transition: opacity 150ms ease, transform 180ms ease;
}

.questions-enter-from,
.questions-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (min-width: 761px) {
  .exam-sidebar {
    position: absolute;
    top: 100%;
    left: 0;
    height: calc(100vh - var(--header-height));
    overflow-y: auto;
    overflow-x: hidden;
    transition: width 180ms ease, padding 180ms ease;
  }
  .desktop-collapsed { padding: 22px 6px; }
  .desktop-collapsed .sidebar-heading { padding: 0; justify-content: center; }
  .desktop-collapsed .sidebar-title,
  .desktop-collapsed .sidebar-content { display: none; }
}

@media (max-width: 760px) {
  .exam-sidebar {
    position: relative;
    width: 100%;
    min-height: auto;
    padding: 0;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .sidebar-heading {
    display: none;
  }

  .mobile-exam-toggle {
    width: 100%;
    height: var(--exam-toggle-height);
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) 20px;
    align-items: center;
    gap: 9px;
    padding: 0 16px;
    border: 0;
    background: transparent;
    color: var(--teal-dark);
    font-size: 0.875rem;
    font-weight: 800;
    text-align: left;
    cursor: pointer;
  }

  .mobile-exam-toggle:hover { background: var(--surface-selected); }
  .mobile-exam-toggle > :first-child,
  .mobile-exam-toggle > :last-child { width: 20px; height: 20px; }

  .sidebar-content {
    display: none;
    position: absolute;
    inset: 100% 0 auto;
    max-height: min(70vh, calc(100vh - var(--site-navigation-height, var(--header-height)) - 12px));
    max-height: min(70dvh, calc(100dvh - var(--site-navigation-height, var(--header-height)) - 12px));
    padding: 12px;
    overflow-y: auto;
    scrollbar-gutter: stable;
    overscroll-behavior-y: contain;
    border-bottom: 1px solid var(--line);
    background: var(--surface-tint);
    box-shadow: 0 10px 16px rgba(18, 42, 48, .12);
  }

  .mobile-open .sidebar-content { display: block; }
  .exam-groups { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .exam-group + .exam-group { margin-top: 0; }
  .exam-group { min-width: 0; }
  .exam-row { min-height: 56px; gap: 6px; padding: 5px 6px 5px 12px; }
  .exam-link { font-size: 0.875rem; }
  .question-list { grid-template-columns: repeat(5, minmax(0, 1fr)); }

}

@media (prefers-reduced-motion: reduce) {
  .exam-sidebar, .questions-enter-active, .questions-leave-active { transition: none; }
}
</style>
