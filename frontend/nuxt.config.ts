import { SITE, themeVariables } from './app/utils/examConfig.ts'
import { e2eBuildConfiguration } from './scripts/e2e-build.mjs'

export default defineNuxtConfig({
  ...e2eBuildConfiguration(),
  compatibilityDate: '2024-07-03',
  devtools: { enabled: false },
  // Static hosting does not need SSR source maps in the build cache.
  sourcemap: { server: false },
  ui: { fonts: false, colorMode: false },
  modules: ['@nuxt/ui'],
  // Nitro resolves shared modules after the intermediate SSR build. Keep their
  // paths absolute until that bundle step, independent of Nuxt's cache directory.
  vite: { build: { rolldownOptions: { makeAbsoluteExternalsRelative: false } } },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      script: [{
        src: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2745326644447602',
        async: true,
        crossorigin: 'anonymous',
      }],
      link: [{ rel: 'icon', href: SITE.logo_path }],
      style: [{ innerHTML: themeVariables() }],
    },
  },
  routeRules: {
    // User-specific application screens do not benefit from server rendering.
    '/practice/**': { ssr: false, headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
    '/history': { ssr: false, headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
    '/favorites': { ssr: false, headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
    '/account': { ssr: false, headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
    '/premium/complete': { ssr: false, headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
    '/admin/**': { ssr: false, headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
    '/login': { headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
    '/signup': { headers: { 'X-Robots-Tag': 'noindex, nofollow' } },
  },
  runtimeConfig: {
    apiBaseInternal: '',
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || '',
    },
  },
})
