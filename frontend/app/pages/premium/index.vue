<!-- Paid membership landing page. -->
<script setup lang="ts">
type PaymentConfig = {
  enabled: boolean
  amount: number
  currency: 'jpy'
  purchase_type: 'one_time'
  free_exam_max: number
  seller: {
    name: string
    representative: string
    address: string
    phone: string
    email: string
  }
}

type ApiResponse<T> = { data: T }

useSeoMeta({
  title: `プレミアム会員｜${SITE.name}`,
  description: '公開問題を利用できる買い切りのプレミアム会員についてご案内します。',
})

const route = useRoute()
const { $api: api } = useNuxtApp()
const { isLoggedIn, user, authHeaders, ensureCurrentUser } = useAuth()
const agreed = ref(false)
const submitting = ref(false)
const errorMessage = ref('')

onMounted(() => {
  void ensureCurrentUser()
})

const { data: paymentConfigResponse, status: configStatus } = await useFetch<ApiResponse<PaymentConfig>>(
  '/api/v1/payments/config',
  { $fetch: api, server: false, immediate: PAYMENTS_ENABLED },
)

const paymentConfig = computed(() => paymentConfigResponse.value?.data)
const paymentEnabled = computed(() => PAYMENTS_ENABLED && paymentConfig.value?.enabled === true)
const alreadyActive = computed(() => user.value?.paid_content_access === true)
const isAdmin = computed(() => user.value?.role === 'admin')
const isVerificationAccount = computed(() => Boolean(user.value?.verification_access) && user.value?.membership.status !== 'active')
const canceled = computed(() => route.query.canceled === '1')

const startCheckout = async () => {
  if (!agreed.value || submitting.value || !paymentEnabled.value) return

  submitting.value = true
  errorMessage.value = ''
  try {
    const response = await api<ApiResponse<{ checkout_url: string }>>(
      '/api/v1/payments/checkout_sessions',
      {
        method: 'POST',
        headers: authHeaders.value,
        body: {},
      },
    )
    window.location.assign(response.data.checkout_url)
  }
  catch (error: any) {
    const status = error?.statusCode ?? error?.status
    const code = error?.data?.error?.code
    if (status === 401) {
      errorMessage.value = 'ログインの有効期限が切れました。もう一度ログインしてください。'
    }
    else if (code === 'membership_already_active') {
      await ensureCurrentUser(true)
      errorMessage.value = 'プレミアム会員資格はすでに有効です。'
    }
    else if (code === 'checkout_session_in_progress') {
      errorMessage.value = '未完了の決済があります。Stripeの決済画面をご確認ください。'
    }
    else {
      errorMessage.value = error?.data?.error?.message ?? '現在、決済を開始できません。時間をおいてお試しください。'
    }
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="!PAYMENTS_ENABLED" class="page-wrap premium-page">
    <header class="page-intro"><h1>無料で利用できます</h1><p>このサービスでは有料機能を提供していません。すべての公開問題を演習できます。</p></header>
    <NuxtLink class="primary-link" to="/#practice-launcher">問題演習へ</NuxtLink>
  </div>
  <div v-else class="page-wrap premium-page">
    <header class="page-intro premium-intro">
      <span class="premium-kicker">ONE-TIME PURCHASE</span>
      <h1>プレミアム会員</h1>
      <p>{{ PRICE_LABEL }}（税込）の買い切りで、模擬試験3以降の公開問題を利用できます。模擬試験1・2は無料です。月額料金や自動更新はありません。</p>
    </header>

    <div v-if="canceled" class="notice-panel" role="status">
      決済は完了していません。料金はこの画面では発生しません。
    </div>

    <section class="premium-card">
      <div class="price-block">
        <span>買い切り</span>
        <strong><small>税込</small> {{ PRICE_LABEL }}</strong>
        <p>有効期限なし</p>
      </div>
      <div class="benefit-block">
        <h2>利用できる内容</h2>
        <ul>
          <li><UIcon name="i-lucide-circle-check" />無料問題を含む、公開中の全模擬試験</li>
          <li><UIcon name="i-lucide-circle-check" />模擬試験{{ EXAM_CONFIG.payments.free_exam_count + 1 }}以降の公開問題</li>
          <li><UIcon name="i-lucide-circle-check" />お気に入り登録とサイドバーでの目印表示</li>
        </ul>
        <p class="scope-note">模擬試験3〜8の全6回・510問をご利用いただけます。</p>
        <p class="scope-note">資格はアカウント削除、全額返金、支払取消し、異議申立てによる取消し、またはサービス終了まで有効です。</p>
      </div>
    </section>

    <section class="purchase-panel content-panel">
      <template v-if="alreadyActive">
        <div class="active-state">
          <UIcon name="i-lucide-badge-check" />
          <div>
            <h2>{{ isAdmin ? '管理者権限で全問題を利用できます' : isVerificationAccount ? '検証用資格で全問題を利用できます' : 'プレミアム会員資格は有効です' }}</h2>
            <p>公開中の全問題を利用できます。購入手続きは必要ありません。</p>
          </div>
        </div>
        <NuxtLink class="primary-link" :to="`/practice/${Math.min(EXAM_CONFIG.payments.free_exam_count + 1, EXAM_CONFIG.exam.set_count)}/1`">問題演習へ</NuxtLink>
      </template>

      <template v-else-if="configStatus === 'pending' || configStatus === 'idle'">
        <p>販売状況を確認しています。</p>
      </template>

      <template v-else-if="!paymentEnabled">
        <h2>現在は販売準備中です</h2>
        <p>決済設定と販売者情報の確認が完了するまで購入はできません。{{ EXAM_CONFIG.payments.free_exam_count > 0 ? '無料の公開問題は引き続き利用できます。' : '販売開始後に有料機能を利用できます。' }}</p>
        <NuxtLink v-if="EXAM_CONFIG.payments.free_exam_count > 0" class="secondary-link" to="/practice/1/1">無料問題を利用する</NuxtLink>
      </template>

      <template v-else-if="!isLoggedIn">
        <h2>購入にはログインが必要です</h2>
        <p>決済をアカウントへ安全に紐づけるため、ログインまたは会員登録をしてください。</p>
        <div class="purchase-actions">
          <NuxtLink class="primary-link" to="/login?redirect=/premium">ログイン</NuxtLink>
          <NuxtLink class="secondary-link" to="/signup?redirect=/premium">会員登録</NuxtLink>
        </div>
      </template>

      <template v-else>
        <h2>購入手続き</h2>
        <p>決済はStripeの安全な決済画面で行います。本サイトはカード番号、有効期限、セキュリティコードを保存しません。</p>
        <label class="agreement">
          <input v-model="agreed" type="checkbox">
          <span>
            <NuxtLink to="/terms" target="_blank">利用規約</NuxtLink>、
            <NuxtLink to="/privacy-policy" target="_blank">プライバシーポリシー</NuxtLink>、
            <NuxtLink to="/commercial-disclosure" target="_blank">特定商取引法に基づく表記</NuxtLink>を確認し、{{ PRICE_LABEL }}の買い切り購入に同意します。
          </span>
        </label>
        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        <button class="primary-link checkout-button" type="button" :disabled="!agreed || submitting" @click="startCheckout">
          <UIcon name="i-lucide-lock-keyhole" />
          {{ submitting ? '決済画面を準備しています' : `Stripeで${PRICE_LABEL}を支払う` }}
        </button>
      </template>
    </section>

    <section class="premium-notes">
      <h2>購入前にご確認ください</h2>
      <dl>
        <div><dt>支払方法</dt><dd>クレジットカード（Stripe Checkout）</dd></div>
        <div><dt>提供時期</dt><dd>決済完了をStripeの通知で確認後、直ちに利用できます。通知の遅延時は反映まで時間を要する場合があります。</dd></div>
        <div><dt>返金</dt><dd>デジタルコンテンツの性質上、提供開始後の利用者都合による返金は原則として受け付けません。不具合や重複決済はお問い合わせください。</dd></div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.premium-page { max-width: 980px; }
.premium-intro { text-align: center; }
.premium-intro p { margin-right: auto; margin-left: auto; }
.premium-kicker { display: inline-block; margin-bottom: 12px; color: var(--teal-dark); font-size: 12px; font-weight: 900; letter-spacing: .14em; }
.notice-panel { margin-bottom: 18px; padding: 14px 18px; border: 1px solid #dfc278; border-radius: 7px; background: #fff9e8; color: #6c5519; font-weight: 700; }
.premium-card { display: grid; grid-template-columns: minmax(220px, .7fr) minmax(0, 1.3fr); overflow: hidden; border: 1px solid #aad0d1; border-radius: 10px; background: #fff; box-shadow: 0 18px 50px rgba(18, 59, 63, .08); }
.price-block { display: grid; align-content: center; justify-items: center; min-height: 270px; padding: 32px; background: var(--teal-dark); color: #fff; text-align: center; }
.price-block > span { font-size: 14px; font-weight: 800; }
.price-block strong { margin-top: 10px; font-size: clamp(38px, 6vw, 58px); line-height: 1.2; }
.price-block strong small { font-size: 13px; }
.price-block p { margin: 12px 0 0; color: #d8f3f3; }
.benefit-block { padding: clamp(28px, 5vw, 48px); }
.benefit-block h2 { margin: 0; font-size: 24px; }
.benefit-block ul { display: grid; gap: 15px; margin: 24px 0 0; padding: 0; list-style: none; }
.benefit-block li { display: grid; grid-template-columns: 22px 1fr; gap: 9px; color: #334950; line-height: 1.65; }
.benefit-block li :deep(svg) { color: var(--teal); }
.scope-note { margin: 24px 0 0; color: var(--muted); font-size: 13px; line-height: 1.75; }
.purchase-panel { margin-top: 22px; }
.purchase-panel h2 { margin-bottom: 10px; }
.purchase-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.agreement { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; margin-top: 22px; color: #40545b; line-height: 1.75; }
.agreement input { width: 18px; height: 18px; margin-top: 4px; accent-color: var(--teal); }
.agreement a { color: var(--teal-dark); font-weight: 700; }
.checkout-button { width: 100%; margin-top: 22px; }
.checkout-button:disabled { opacity: .5; cursor: not-allowed; }
.active-state { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 20px; }
.active-state > :deep(svg) { width: 34px; height: 34px; color: var(--teal); }
.active-state h2, .active-state p { margin: 0; }
.active-state p { margin-top: 5px; }
.premium-notes { margin-top: 34px; padding: 0 4px; }
.premium-notes h2 { font-size: 20px; }
.premium-notes dl { display: grid; gap: 1px; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--line); }
.premium-notes dl div { display: grid; grid-template-columns: 140px 1fr; background: #fff; }
.premium-notes dt, .premium-notes dd { margin: 0; padding: 15px 18px; line-height: 1.7; }
.premium-notes dt { background: #edf4f4; font-weight: 800; }
.premium-notes dd { color: var(--muted); }
@media (max-width: 700px) {
  .premium-card { grid-template-columns: 1fr; }
  .price-block { min-height: 210px; }
  .premium-notes dl div { grid-template-columns: 1fr; }
  .premium-notes dt { padding-bottom: 7px; }
  .premium-notes dd { padding-top: 7px; }
}
</style>
