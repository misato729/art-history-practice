<script setup lang="ts">
useSeoMeta({ title: `プライバシーポリシー｜${SITE.name}`, robots: 'noindex' })
</script>

<template>
  <div class="page-wrap legal-page">
    <header class="page-intro"><h1>プライバシーポリシー</h1><p>個人情報の取扱いについて</p></header>
    <article class="legal-document">
      <section><h2>取り扱う情報</h2><p>会員登録時のユーザー名とメールアドレス、認証情報、解答履歴、お気に入りを取り扱います。パスワードは復元できない形式で保存します。</p><p v-if="PAYMENTS_ENABLED">有料機能を提供する場合は、決済識別子と会員資格の状態も管理します。カード番号等は決済サービスが取り扱います。</p></section>
      <section><h2>利用目的</h2><p>認証、学習履歴の表示、お気に入りの保存、問い合わせ対応、不正利用の防止のために情報を利用します。</p></section>
      <section><h2>Cookie</h2><p>ログイン状態を保持するためにCookieを使用します。保存した認証情報はログアウト時に削除されます。</p></section>
      <section><h2>保存と削除</h2><p>アカウント削除の操作により、登録情報と関連する学習データを削除します。決済記録は、返金対応や法令上必要な範囲で保存します。</p></section>
      <section><h2>お問い合わせ</h2><p v-if="SITE.contact_email"><a :href="`mailto:${SITE.contact_email}`">{{ SITE.contact_email }}</a></p><p v-else><NuxtLink to="/commercial-disclosure">特定商取引法に基づく表記に記載の問い合わせ先</NuxtLink>へご連絡ください。</p></section>
    </article>
  </div>
</template>
