<script setup lang="ts">
import { isSellerInformationComplete, type SellerInformation } from '~/utils/sellerInformation'

type PaymentConfig = { seller?: SellerInformation }
type ApiResponse<T> = { data: T }

const { $api: api } = useNuxtApp()
const { data: paymentConfigResponse, status: paymentConfigStatus } = await useFetch<ApiResponse<PaymentConfig>>(
  '/api/v1/payments/config',
  { $fetch: api, server: false, immediate: PAYMENTS_ENABLED },
)
const seller = computed(() => ({
  name: paymentConfigResponse.value?.data.seller?.name || '',
  representative: paymentConfigResponse.value?.data.seller?.representative || '',
  address: paymentConfigResponse.value?.data.seller?.address || '',
  phone: paymentConfigResponse.value?.data.seller?.phone || '',
  email: paymentConfigResponse.value?.data.seller?.email || '',
  contact_disclosure_mode: paymentConfigResponse.value?.data.seller?.contact_disclosure_mode ?? 'public',
  contact_disclosure_ready: paymentConfigResponse.value?.data.seller?.contact_disclosure_ready === true,
}))
const requestDisclosure = computed(() => seller.value.contact_disclosure_mode === 'on_request')
const sellerConfigured = computed(() => isSellerInformationComplete(seller.value))

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

    <p v-if="PAYMENTS_ENABLED && (paymentConfigStatus === 'idle' || paymentConfigStatus === 'pending')" role="status" aria-live="polite">販売者情報を読み込んでいます。</p>
    <p v-else-if="PAYMENTS_ENABLED && paymentConfigStatus === 'error'" role="alert">販売者情報を読み込めませんでした。ページを再読み込みしてください。</p>

    <div v-if="PAYMENTS_ENABLED && paymentConfigStatus === 'success' && !sellerConfigured" class="legal-warning" role="status">
      現在は販売準備中です。販売者情報と必要な対応体制を確認しています。
    </div>

    <article v-if="PAYMENTS_ENABLED && paymentConfigStatus === 'success'" class="legal-document disclosure-table">
      <dl>
        <div><dt>販売事業者</dt><dd>{{ seller.name || '販売開始前に掲載' }}</dd></div>
        <div><dt>運営責任者</dt><dd>{{ seller.representative || '販売開始前に掲載' }}</dd></div>
        <div><dt>所在地</dt><dd>{{ requestDisclosure ? '請求があった場合に遅滞なく開示します。' : (seller.address || '販売開始前に掲載') }}</dd></div>
        <div><dt>電話番号</dt><dd>{{ requestDisclosure ? '請求があった場合に遅滞なく開示します。' : (seller.phone || '販売開始前に掲載') }}</dd></div>
        <div><dt>問い合わせ先</dt><dd><a v-if="seller.email" :href="`mailto:${seller.email}`">{{ seller.email }}</a><span v-else>販売開始前に掲載</span></dd></div>
        <div v-if="requestDisclosure"><dt>開示の請求方法</dt><dd>上記の問い合わせ先へ、所在地・電話番号の開示を希望する旨をメールでご連絡ください。購入前の請求にも、申込みの意思決定に先立って十分な時間的余裕をもって、電子メールで遅滞なく開示します。開示に費用はかかりません。</dd></div>
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
