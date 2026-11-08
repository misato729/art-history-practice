<script setup lang="ts">
useSeoMeta({ title: `利用規約｜${SITE.name}`, robots: 'noindex' })
</script>

<template>
  <div class="page-wrap legal-page">
    <header class="page-intro"><h1>利用規約</h1><p>{{ SITE.name }}の利用について</p></header>
    <article class="legal-document">
      <section><h2>サービスの内容</h2><p>{{ SITE.name }}は、{{ SITE.exam_name }}の学習を支援する問題演習サービスです。問題と解説は学習の補助として利用するものであり、試験の合格を保証するものではありません。</p></section>
      <section><h2>アカウント</h2><p>登録情報は正確に入力し、パスワードを適切に管理してください。ログイン後は解答履歴を保存できます。</p></section>
      <section><h2>利用範囲</h2><p v-if="PAYMENTS_ENABLED">無料で利用できる範囲は{{ EXAM_CONFIG.payments.free_exam_count }}セットです。有料会員の料金は{{ PRICE_LABEL }}（税込）の買い切りです。販売条件と返金の取扱いは、特定商取引法に基づく表記に記載します。</p><p v-else>公開中の問題は無料で演習できます。お気に入りと解答履歴の保存にはログインが必要です。</p></section>
      <section><h2>禁止事項と利用制限</h2><p>不正アクセス、他者の権利を侵害する行為、サービスの運営を妨げる行為は行わないでください。安定した提供のため、操作回数を一時的に制限する場合があります。</p></section>
      <section><h2>お問い合わせ</h2><p v-if="SITE.contact_email"><a :href="`mailto:${SITE.contact_email}`">{{ SITE.contact_email }}</a></p><p v-else><NuxtLink to="/commercial-disclosure">特定商取引法に基づく表記に記載の問い合わせ先</NuxtLink>へご連絡ください。</p></section>
    </article>
  </div>
</template>
