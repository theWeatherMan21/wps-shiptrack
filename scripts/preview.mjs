// 无头端到端预览（v0.4）：模拟爹地真实表结构 —— O 列是 MBL（含空行/表头），R 列是回填列
// 关键验证点：整列读（Range.Value2）、非提单行自动跳过、写回同行的输出列、写完读回校验
// 静默红线：全程 headless
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = process.env.PREVIEW_OUT || path.join(os.tmpdir(), 'shiptrack-preview')
fs.mkdirSync(OUT, { recursive: true })

const http = require('node:http')
const BUILD = path.join(ROOT, 'wps-addon-build')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.xml': 'text/xml' }
const srv = http.createServer((req, res) => {
  const p = path.join(BUILD, decodeURIComponent(req.url.split('?')[0].split('#')[0]))
  const f = p.endsWith('/') ? path.join(p, 'index.html') : p
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end('nf'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    res.end(buf)
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const PAGE = `http://127.0.0.1:${srv.address().port}/index.html#/taskpane`

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 520, height: 820 }, deviceScaleFactor: 2 })

const MODE = process.env.STUB_MODE || 'range'
const SEL_ROWS = Number(process.env.SEL_ROWS || 1048576)
await ctx.addInitScript(([MODE, SEL_ROWS]) => {
  // 爹地真实布局：O=MBL（表头 + 5 个单号 + 2 空行 + 1 个单号），R=状态回填列
  const NUMCOL = 15 // O
  const OUTCOL = 18 // R
  const grid = {
    [`1,${NUMCOL}`]: 'MBL',
    [`2,${NUMCOL}`]: '276759780',
    [`3,${NUMCOL}`]: '181AY26A0590138S1',
    [`4,${NUMCOL}`]: '177FCACAS347328',
    [`5,${NUMCOL}`]: '177FCACAS347312',
    [`6,${NUMCOL}`]: '802735343',
    [`9,${NUMCOL}`]: '802735426',
    // 第 7、8 行没有提单号（LCL / 空行）
  }
  const LAST_ROW = 10
  window.__written = []
  window.__selRows = SEL_ROWS
  window.__sel = { col: NUMCOL, row: 1, rows: window.__selRows || 1048576, cols: 1 } // 默认整列选中

  const colName = (n) => {
    let s = ''
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
    return s
  }
  const parseAddr = (addr) => {
    // 支持 "O2" 和 "O2:O10"
    const parts = String(addr).split(':')
    const one = (a) => {
      const m = /^([A-Z]+)(\d+)$/.exec(a.trim().toUpperCase())
      if (!m) throw new Error('bad addr ' + a)
      let col = 0
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
      return { col, row: Number(m[2]) }
    }
    const a = one(parts[0])
    const b = parts[1] ? one(parts[1]) : a
    return { a, b }
  }

  window.Application = {
    Version: '12.1.28496',
    Build: '28496',
    Name: 'WPS 表格',
    ActiveDocument: { Name: '波兰2026.xlsx' },
    ActiveWorkbook: { ReadOnly: false, ProtectStructure: false },
    get Selection() {
      const s = window.__sel
      return {
        Column: s.col, Row: s.row,
        Rows: { Count: s.rows }, Columns: { Count: s.cols },
        Value2: [[grid[`1,${s.col}`] || '']],
        Text: grid[`1,${s.col}`] || ''
      }
    },
    ActiveSheet: {
      ProtectContents: false,
      UsedRange: { Row: 1, Rows: { Count: LAST_ROW }, Columns: { Count: 13 } },
      Cells: {
        Item: (r, c) => ({
          get Value2() { return grid[`${r},${c}`] ?? '' },
          set Value2(v) { grid[`${r},${c}`] = v; window.__written.push([r, c, v]) }
        })
      },
      Range: (addr) => {
        if (MODE === 'cells') throw new Error('Range 不可用（模拟旧版 WPS）')
        const { a, b } = parseAddr(addr)
        return {
          get Value2() {
            if (a.row === b.row && a.col === b.col) return grid[`${a.row},${a.col}`] ?? ''
            const out = []
            for (let r = a.row; r <= b.row; r++) out.push([grid[`${r},${a.col}`] ?? ''])
            return out
          },
          set Value2(v) {
            grid[`${a.row},${a.col}`] = v
            window.__written.push([a.row, a.col, v])
          }
        }
      }
    },
    PluginStorage: { _m: {}, getItem(k) { return this._m[k] ?? null }, setItem(k, v) { this._m[k] = String(v) } }
  }
}, [MODE, SEL_ROWS])

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(PAGE, { waitUntil: 'load' })
await page.waitForTimeout(800)

const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p, fullPage: true }); console.log('SHOT ' + p) }

console.log('① 整列选中 O（含表头）→ 点「选单号列」')
await page.getByRole('button', { name: /选单号列/ }).click()
await page.waitForTimeout(500)

console.log('② 选中 R 列 → 点「选输出列」（自动开始刷新）')
await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
await page.getByRole('button', { name: /选输出列/ }).click()

for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000)
  const busy = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('立即刷新'))
    return b ? b.disabled : false
  })
  if (!busy) break
}
await shot('01-result.png')

const written = await page.evaluate(() => window.__written)
console.log('\n=== 写回（应为 R2..R6、R9 共 6 格）===')
for (const [r, c, v] of written) console.log(`  ${String.fromCharCode(64 + c)}${r} = ${v}`)

const rows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\n/g, ' | ')))
console.log('\n=== 面板行 ==='); rows.forEach((r) => console.log('  ' + r))
const err = await page.evaluate(() => (document.querySelector('.err') || {}).innerText || '')
console.log('\n错误横幅:', err || '(无)')

await browser.close()
srv.close()
console.log('DONE')
process.exit(0)
