<script setup lang="ts">
import { loginFormSchema } from '../../shared/schemas/auth.ts'
import { apiFormErrors, focusFormError } from '~/utils/apiFormErrors'
const { login } = useAuth()
const state = reactive({ email: '', password: '' })
const authForm = useTemplateRef('authForm')
const submitting = ref(false)
const errorMessage = ref('')
watch(state, () => { errorMessage.value = '' })

const redirectPath = '/'

const submit = async (event: { data: typeof state }) => {
  Object.assign(state, event.data)
  if (submitting.value) return

  submitting.value = true
  errorMessage.value = ''
  try {
    await login({ email: state.email, password: state.password })
    await navigateTo('/', { replace: true })
  }
  catch (error: any) {
    authForm.value?.setErrors(apiFormErrors(error, { name: 'ユーザー名', email: 'メールアドレス', password: 'パスワード', password_confirmation: '確認用パスワード' }))
    errorMessage.value = error?.data?.error?.message ?? 'ログインできませんでした。もう一度お試しください。'
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="page-wrap auth-page">
    <header class="page-intro"><h1>ログイン</h1><p>解答履歴を保存できます。お気に入りはプレミアム会員向けです。</p></header>
    <UForm ref="authForm" :schema="loginFormSchema" :state="state" class="content-panel auth-form" novalidate @error="focusFormError" @submit="submit">
      <FormTextField id="email" v-model="state.email" name="email" label="メールアドレス" autocomplete="email" type="email" />
      <FormTextField id="password" v-model="state.password" name="password" label="パスワード" autocomplete="current-password" type="password" />
      <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
      <button class="primary-link" type="submit" :disabled="submitting">{{ submitting ? 'ログイン中です' : 'ログイン' }}</button>
      <p class="auth-note">アカウントをお持ちでない方は <NuxtLink :to="{ path: '/signup', query: { redirect: redirectPath } }">会員登録</NuxtLink></p>
    </UForm>
  </div>
</template>
