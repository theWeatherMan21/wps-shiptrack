// 写回阶段基准（无头）：97 行提单号 → 一轮刷新 → 量「写回阶段」的耗时与同步 COM 调用次数
//
// 为什么要这个脚本：卡（P0-2）要求「97 行一轮写回阶段耗时降到改造前的 1/3 以下」，
// 这个数不能靠嘴说。桩里给每次表格 API 访问注入可配置的忙等（默认 2ms，等价于真实 WPS
// 同步 COM 的单次开销量级），于是「调用次数」直接变成「主线程被卡住的毫秒数」，
// 改造前后用同一把尺各量一次即可对比。
//
// 用法:
//   node scripts/write-bench.mjs                 # 本仓当前构建
//   node scripts/write-bench.mjs --build ../path/to/wps-addon-build --label 改造前
//   node scripts/write-bench.mjs --rows 97 --com 2 --lead 250
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { chromium } = (() => {
  try { return require('playwright') }
  catch {
    const os = require('node:os')
    const fb = process.env.PLAYWRIGHT_CORE || path.join(os.homedir(), 'Documents/trae_projects/ShipScheduleHub/engine/node_modules/playwright-core')
    return require(fb)
  }
})()
import { STUB } from './lib/wps-stub.mjs'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.resolve(arg('build', path.join(ROOT, 'wps-addon-build')))
const LABEL = arg('label', '本仓构建')
const ROWS = Number(arg('rows', 97))
const COM = Number(arg('com', 2))          // 每次表格 API 访问的忙等毫秒（模拟同步 COM）
const LEAD = Number(arg('lead', 250))      // 每行查询的模拟网络耗时
const NUMCOL = 17, OUTCOL = 18

const http = require('node:http')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const srv = http.createServer((req, res) => {
  const f = path.join(BUILD, decodeURIComponent(req.url.split('?')[0].split('#')[0]))
  fs.readFile(f.endsWith('/') ? path.join(f, 'index.html') : f, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nf') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    res.end(buf)
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const URL0 = `http://127.0.0.1:${srv.address().port}/index.html#/taskpane`

const grid = { [`1,${NUMCOL}`]: 'MBL' }
const evBy = {}
for (let i = 0; i < ROWS; i++) {
  const n = `BENCH${String(i + 1).padStart(4, '0')}`
  grid[`${i + 2},${NUMCOL}`] = n
  evBy[n] = [{ time: '2026-10-02T00:00:00Z', activity: 'Departure From', city: 'QINGDAO' }]
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 520, height: 820 } })
await ctx.addInitScript(`(${STUB.toString()})(${JSON.stringify({ grid, lead: LEAD, last: ROWS + 1, comMs: COM })})`)
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(URL0, { waitUntil: 'load' })
await page.waitForTimeout(600)
await page.evaluate((e) => { window.__evByNumber = e }, evBy)

await page.evaluate((c) => { window.__sel = { col: c, row: 1, rows: 1048576, cols: 1 } }, NUMCOL)
await page.getByRole('button', { name: /选单号列/ }).click()
await page.evaluate((c) => { window.__sel = { col: c, row: 1, rows: 1048576, cols: 1 } }, OUTCOL)
await page.getByRole('button', { name: /选输出列/ }).click()
await page.waitForTimeout(300)

const opsBefore = await page.evaluate(() => window.__ops || 0)
const t0 = Date.now()
await page.getByRole('button', { name: /③ 立即刷新/ }).click({ force: true })
// 等整轮结束（进度条消失 + busy 按钮恢复）
for (let i = 0; i < 1200; i++) {
  await page.waitForTimeout(100)
  const busy = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('立即刷新'))
    return b ? b.disabled : false
  })
  if (i > 5 && !busy) break
}
const runMs = Date.now() - t0
await page.waitForTimeout(600)   // 等最后一次攒批落盘

const out = await page.evaluate(() => ({
  ops: window.__ops || 0,
  batch: window.__batchWrites || [],
  written: (window.__written || []).length,
  filled: (window.__grid ? Object.keys(window.__grid).filter((k) => /,18$/.test(k)).length : 0),
  stats: window.__SHIPTRACK_STATS__ || null,
  before: window.__BENCH_BEFORE_MS || null
}))
await ctx.close()
await browser.close()
srv.close()

const ms = out.stats ? out.stats.ms : (out.before ? Math.round(out.before) : null)
const res = {
  label: LABEL, rows: ROWS, comMs: COM, leadMs: LEAD,
  写回阶段ms: ms,
  '本轮总COM调用': out.ops - opsBefore,
  批量写次数: out.batch.length,
  批量写最大段长: out.batch.reduce((m, b) => Math.max(m, b.rows), 0),
  写入格数: out.written,
  已写结果格: out.filled,
  总墙钟ms: runMs,
  pageerrors: errs
}
console.log(JSON.stringify(res, null, 2))
if (errs.length) { console.error('❌ 页面异常：' + errs.join(' | ')); process.exit(1) }
