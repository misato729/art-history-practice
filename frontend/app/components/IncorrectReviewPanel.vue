<script setup lang="ts">
const { isLoggedIn } = useAuth()
const { totalCount, loading, loaded, error, load, start, starting, sessionKey } = useIncorrectReview()
onMounted(() => { if (isLoggedIn.value) void load({ force: true }) })
watch(sessionKey, () => { if (isLoggedIn.value) void load({ force: true }) })
</script>
<template>
  <div class="incorrect-review-panel" aria-live="polite">
    <template v-if="!isLoggedIn">
      <h3>ログインして復習する</h3><p>間違えた問題の記録は、ログイン後に利用できます。</p>
      <NuxtLink class="primary-link" to="/login?redirect=/%23practice-launcher">ログインへ</NuxtLink>
    </template>
    <template v-else-if="loading || starting"><p role="status">復習する問題を確認しています。</p></template>
    <template v-else-if="error"><h3>間違えた問題を読み込めません</h3><p role="alert">{{ error }}</p><button class="secondary-link" type="button" @click="load({ force: true })">再読み込み</button></template>
    <template v-else-if="loaded && totalCount === 0"><h3>現在、復習する問題はありません</h3><p>最新の回答が不正解の問題があると、ここから復習できます。</p></template>
    <template v-else><h3>{{ loaded ? `復習する問題が${totalCount}問あります` : '間違えた問題を復習' }}</h3><p>最新の回答が不正解の問題を、毎回異なる順番で復習します。</p><button class="primary-link" type="button" @click="start">ランダムに復習を始める</button></template>
  </div>
</template>
<style scoped>
.incorrect-review-panel { padding: 24px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); overflow-wrap: anywhere; }
h3 { margin: 0; font-size: 1.2rem; color: var(--ink); } p { margin: 12px 0 20px; color: var(--muted); line-height: 1.7; }
button:disabled { opacity: .5; }
@media(max-width:640px) { .incorrect-review-panel { padding: 20px 16px; } .primary-link,.secondary-link { width:100%; white-space:normal; text-align:center; } }
</style>
