<script setup lang="ts">
const SELLER_NAME = '大野佳樹'
const SELLER_REPRESENTATIVE = '大野佳樹'
const SELLER_PHONE = '050-6870-0005'
const SELLER_EMAIL = 'misato0729.official@gmail.com'

useSeoMeta({
  title: `特定商取引法に基づく表記｜${SITE.name}`,
  description: 'プレミアム会員の販売条件と販売事業者情報を表示します。',
})
</script>

<template>
  <div class="page-wrap legal-page">
    <header class="page-intro">
      <h1>特定商取引法に基づく表記</h1>
      <p>{{ PAYMENTS_ENABLED ? 'プレミアム会員の購入条件と販売事業者情報です。' : '現在、有料機能を提供していません。' }}</p>
    </header>

    <article class="legal-document disclosure-table">
      <dl>
        <div><dt>販売事業者</dt><dd>{{ SELLER_NAME }}</dd></div>
        <div><dt>運営責任者</dt><dd>{{ SELLER_REPRESENTATIVE }}</dd></div>
        <div><dt>所在地</dt><dd>請求があった場合に遅滞なく開示します。</dd></div>
        <div><dt>電話番号</dt><dd>{{ SELLER_PHONE }}</dd></div>
        <div><dt>問い合わせ先</dt><dd><a :href="`mailto:${SELLER_EMAIL}`">{{ SELLER_EMAIL }}</a></dd></div>
        <div><dt>所在地の開示請求方法</dt><dd>上記の問い合わせ先へ、所在地の開示を希望する旨をメールでご連絡ください。購入前の請求にも、申込みの意思決定に先立って十分な時間的余裕をもって、電子メールで遅滞なく開示します。開示に費用はかかりません。</dd></div>
        <div><dt>販売価格</dt><dd>{{ PRICE_LABEL }}（税込）</dd></div>
        <div><dt>販売価格以外の負担</dt><dd>インターネット接続に必要な通信料は利用者の負担となります。</dd></div>
        <div><dt>支払方法</dt><dd>クレジットカード（Stripe Checkout）</dd></div>
        <div><dt>支払時期</dt><dd>購入手続き時に決済されます。</dd></div>
        <div><dt>提供内容</dt><dd>公開中の全模擬試験の利用資格。月額課金や自動更新はありません。</dd></div>
        <div><dt>提供時期</dt><dd>決済完了をStripeの通知で確認後、直ちに利用できます。通知の遅延時は反映まで時間を要する場合があります。</dd></div>
        <div><dt>返品・返金</dt><dd>デジタルコンテンツの性質上、提供開始後の利用者都合による返品・返金は原則として受け付けません。重複決済、提供不能その他契約内容に適合しない場合は、上記問い合わせ先へご連絡ください。法令上認められる権利を制限するものではありません。</dd></div>
        <div><dt>利用環境</dt><dd>最新版の主要ブラウザとインターネット接続が必要です。CookieとJavaScriptを有効にしてください。</dd></div>
      </dl>
    </article>


  </div>
</template>

<style scoped>
.legal-warning { max-width: 900px; margin-bottom: 18px; padding: 15px 18px; border: 1px solid #dfc278; border-radius: 7px; background: #fff9e8; color: #6c5519; font-weight: 700; line-height: 1.7; }
.disclosure-table { padding: 0; overflow: hidden; }
.disclosure-table dl { margin: 0; }
.disclosure-table dl div { display: grid; grid-template-columns: minmax(180px, .35fr) minmax(0, 1fr); border-bottom: 1px solid var(--line); }
.disclosure-table dl div:last-child { border-bottom: 0; }
.disclosure-table dt, .disclosure-table dd { margin: 0; padding: 18px 22px; line-height: 1.8; }
.disclosure-table dt { background: #edf4f4; font-weight: 800; }
.disclosure-table dd { color: #42555d; overflow-wrap: anywhere; }
.disclosure-table a { color: var(--teal-dark); font-weight: 700; }
@media (max-width: 640px) {
  .disclosure-table dl div { grid-template-columns: 1fr; }
  .disclosure-table dt { padding-bottom: 8px; }
  .disclosure-table dd { padding-top: 8px; }
}
</style>
