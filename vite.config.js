import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { copyFile } from "wpsjs/vite_plugins"

// https://vitejs.dev/config/
export default defineConfig({
  base:'./',
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
