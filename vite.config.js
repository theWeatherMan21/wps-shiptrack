import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { copyFile } from "wpsjs/vite_plugins"

// ★ 10-30：面板上那个版本号必须与 package.json 同源 —— 以前 TaskPane 里手写 APP_VER，
//   改包忘了改它，就会出现「面板显示新版本、包其实是旧的」（两个真相）。
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// https://vitejs.dev/config/
export default defineConfig({
  base:'./',
  define: { __APP_VERSION__: JSON.stringify(PKG.version) },
  // 目标降到 es2017：WPS 内置 CEF 内核版本参差，语法别用太新的
  build: { target: 'es2017', cssTarget: 'chrome90' },
  plugins: [
    copyFile({
      src: 'manifest.xml',
      dest: 'manifest.xml',
    }),
    vue()
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0'
  }
})
