#!/usr/bin/env node
// 截图：把「船期回填确认条」在真实构建产物里拍下来（headless），给爹地做视觉验收。
// 用法：node scripts/sched-shot.mjs [输出目录]
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { chromium } = (() => {
  try { return require('playwright') }
  catch { return require(process.env.PLAYWRIGHT_CORE || path.join(os.homedir(), 'Documents/trae_projects/ShipScheduleHub/engine/node_modules/playwright-core')) }
})()
import { STUB } from './lib/wps-stub.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'wps-addon-build')
const OUT = process.argv[2] || path.join(os.homedir(), '.hermes/wps-shiptrack/shots')
fs.mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const srv = http.createServer((req, res) => {
  const p = path.join(BUILD, decodeURIComponent(req.url.split('?')[0].split('#')[0]))
  const f = p.endsWith('/') ? path.join(p, 'index.html') : p
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nf') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    res.end(buf)
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const URL0 = `http://127.0.0.1:${srv.address().port}/index.html#/taskpane`

const NUMCOL = 15, OUTCOL = 18, ETDCOL = 5
const grid = {
  [`1,${NUMCOL}`]: 'MBL', [`2,${NUMCOL}`]: '900000009', [`3,${NUMCOL}`]: '802735343', [`4,${NUMCOL}`]: '802735426',
  [`1,${ETDCOL}`]: 'ETD',
  [`2,${ETDCOL}`]: 46303, [`3,${ETDCOL}`]: 46302.66666666664, [`4,${ETDCOL}`]: 'SINOTRANS 天津',
}
const EV = { time: '2026-10-08T00:00:00Z', activity: 'Departure From', city: 'QINGDAO' }

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 560, height: 900 }, deviceScaleFactor: 2 })
await ctx.addInitScript(`(${STUB.toString()})(${JSON.stringify({ doc: 'A.xlsx', grid, last: 10 })})`)
await ctx.addInitScript(`window.__evByNumber = ${JSON.stringify({ '900000009': [EV], '802735343': [EV], '802735426': [EV] })};`)
await ctx.addInitScript(`window.__fmts = ${JSON.stringify({ [`2,${ETDCOL}`]: 'yyyy-mm-dd', [`3,${ETDCOL}`]: 'yyyy-mm-dd', [`4,${ETDCOL}`]: 'General' })};`)
const page = await ctx.newPage()
await page.goto(URL0, { waitUntil: 'load' })
await page.waitForTimeout(600)
await page.getByRole('button', { name: /选单号列/ }).click()
await page.waitForTimeout(150)
await page.evaluate((c) => { window.__sel = { col: c, row: 1, rows: 1048576, cols: 1 } }, OUTCOL)
await page.getByRole('button', { name: /选输出列/ }).click()
await page.waitForTimeout(150)
await page.getByRole('button', { name: /立即刷新/ }).click()
for (let i = 0; i < 100; i++) {
  if (await page.evaluate(() => !!document.querySelector('.schedbar'))) break
  await page.waitForTimeout(200)
}
const f1 = path.join(OUT, 'sched-confirm-bar.png')
await page.locator('.schedbar').screenshot({ path: f1 })
const f2 = path.join(OUT, 'sched-confirm-panel.png')
await page.screenshot({ path: f2 })
console.log(f1)
console.log(f2)
await browser.close()
srv.close()
