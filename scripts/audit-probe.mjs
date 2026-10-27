// 审计探针（无头）：复现可疑缺陷，输出 PASS(复现成功=有 bug) / no-repro
// 用法：node scripts/audit-probe.mjs [caseA|caseB|caseC|all]
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'wps-addon-build')
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
const PAGE = `http://127.0.0.1:${srv.address().port}/index.html#/taskpane`

const browser = await chromium.launch({ headless: true, channel: 'chrome' })

async function newPane(opts) {
  const ctx = opts.ctx || (await browser.newContext({ viewport: { width: 520, height: 820 } }))
  await ctx.addInitScript(({ seed, rangeMode, trackMode, docName, persist }) => {
    const NUMCOL = 15, OUTCOL = 18, LAST = 10
    const grid = Object.assign({
      [`1,${NUMCOL}`]: 'MBL',
      [`2,${NUMCOL}`]: '276759780',
      [`3,${NUMCOL}`]: '802735343',
      [`4,${NUMCOL}`]: '802735426'
    }, seed || {})
    window.__grid = grid
    window.__last = LAST
    window.__written = []
    window.__sel = { col: NUMCOL, row: 1, rows: 1048576, cols: 1 }
    const parse = (addr) => {
      const p = String(addr).split(':')
      const one = (a) => {
        const m = /^([A-Z]+)(\d+)$/.exec(a.trim().toUpperCase())
        let col = 0
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
        return { col, row: Number(m[2]) }
      }
      const a = one(p[0]); return { a, b: p[1] ? one(p[1]) : a }
    }
    const cell = (r, c) => ({
      get Value2() { return grid[`${r},${c}`] ?? '' },
      set Value2(v) { grid[`${r},${c}`] = v; window.__written.push([r, c, v]) }
    })
    window.Application = {
      Version: '12.1.28496', Build: '28496', Name: 'WPS 表格',
      ActiveDocument: { Name: 'probe.xlsx' },
      get ActiveWorkbook() {
        const nm = (persist && localStorage.getItem('probe-doc')) || docName || 'probe.xlsx'
        return { Name: nm, ReadOnly: false, ProtectStructure: false }
      },
      get Selection() {
        const s = window.__sel
        return { Column: s.col, Row: s.row, Rows: { Count: s.rows }, Columns: { Count: 1 }, Value2: [[grid[`${s.row},${s.col}`] || '']], Text: grid[`${s.row},${s.col}`] || '' }
      },
      ActiveSheet: {
        Name: 'Sheet1',
        ProtectContents: false,
        UsedRange: { Row: 1, get Rows() { return { Count: window.__last || LAST } }, Columns: { Count: 13 } },
        Cells: { Item: (r, c) => cell(r, c) },
        Range: (addr) => {
          const { a, b } = parse(addr)
          return {
            get Value2() {
              if (a.row === b.row && a.col === b.col) return grid[`${a.row},${a.col}`] ?? ''
              if (rangeMode === 'first-only') return grid[`${a.row},${a.col}`] ?? ''
              const out = []
              for (let r = a.row; r <= b.row; r++) out.push([grid[`${r},${a.col}`] ?? ''])
              return out
            },
            get Text() {
              const out = []
              for (let r = a.row; r <= b.row; r++) out.push(grid[`${r},${a.col}`] ?? '')
              return out.join('\n')
            },
            set Value2(v) { grid[`${a.row},${a.col}`] = v; window.__written.push([a.row, a.col, v]) }
          }
        }
      },
      PluginStorage: persist
        ? { getItem(k) { return localStorage.getItem('ps:' + k) }, setItem(k, v) { localStorage.setItem('ps:' + k, String(v)) } }
        : { _m: {}, getItem(k) { return this._m[k] ?? null }, setItem(k, v) { this._m[k] = String(v) } }
    }
    // 桩掉网络
    window.fetch = (url) => {
      const u = String(url)
      let body = { ok: true }
      if (u.includes('/health')) body = { ok: true, service: 'probe' }
      else if (u.includes('/identify')) body = { ok: true, number: 'x', carrier: null, candidates: [] }
      else if (u.includes('/track')) {
        if (trackMode === 'timeout') body = { ok: false, error: '超时（120s 未出结果）', timeout: true }
        else body = { ok: true, events: [{ time: '2026-10-16T00:00:00Z', activity: 'Export Loaded on Vessel', city: 'SHANGHAI, CN' }] }
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
  }, opts)
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(PAGE, { waitUntil: 'load' })
  await page.waitForTimeout(600)
  return { ctx, page, errs }
}

const btn = (page, re) => page.getByRole('button', { name: re }).click()
async function waitIdle(page) {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250)
    const busy = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('立即刷新'))
      return b ? b.disabled : false
    })
    if (!busy) return
  }
}
const out = []
const pass = (c, ok, detail) => { out.push(`${ok ? '通过' : '失败'}  ${c}  ${detail}`); console.log(`${ok ? '✅通过' : '❌失败'}  ${c}\n     ${detail}`) }
const say = (c, ok, detail) => { out.push(`${ok ? '复现' : '未复现'}  ${c}  ${detail}`); console.log(`${ok ? '✅复现' : '❌未复现'}  ${c}\n     ${detail}`) }

// ---- A：输出列 = 单号列（会不会把提单号覆盖掉）----
if (process.argv[2] === 'caseA' || process.argv[2] === 'all' || !process.argv[2]) {
  const { ctx, page } = await newPane({})
  await btn(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 15, row: 1, rows: 1048576, cols: 1 } }) // 仍在 O 列
  await btn(page, /选输出列/)
  await waitIdle(page)
  const w = await page.evaluate(() => window.__written)
  const hitO = w.filter(([, c]) => c === 15)
  say('A 输出列=单号列', hitO.length > 0, `写入 O 列 ${hitO.length} 次（应被阻止）→ ${JSON.stringify(hitO.slice(0, 2))}`)
  await ctx.close()
}

// ---- B：Range 只返回首个值（长度不匹配）→ 行号错位 ----
if (process.argv[2] === 'caseB' || process.argv[2] === 'all' || !process.argv[2]) {
  const { ctx, page } = await newPane({ rangeMode: 'first-only' })
  await btn(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await btn(page, /选输出列/)
  await waitIdle(page)
  const w = await page.evaluate(() => window.__written)
  const rows = [...new Set(w.map(([r]) => r))]
  say('B Range 返回长度不匹配', rows.length !== 3, `实际只写了行 ${JSON.stringify(rows)}（期望 2,3,4 三行）`)
  await ctx.close()
}

// ---- C：已有好数据被失败文案覆盖 ----
if (process.argv[2] === 'caseC' || process.argv[2] === 'all' || !process.argv[2]) {
  const seed = { '2,18': '2026-10-16 · 装船 · SHANGHAI', '3,18': '2026-10-16 · 装船 · SHANGHAI', '4,18': '2026-10-16 · 装船 · SHANGHAI' }
  const { ctx, page } = await newPane({ seed, trackMode: 'timeout' })
  await btn(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await btn(page, /选输出列/)
  await waitIdle(page)
  const g = await page.evaluate(() => window.__grid)
  const now = g['2,18']
  say('C 失败文案覆盖好数据', String(now).includes('超时'), `R2 现在是「${now}」（原来是好数据）`)
  await ctx.close()
}

// ---- E：第一次刷新后，在表尾新增单号（超出当时选区末行）→ 点刷新会不会捡到 ----
if (process.argv[2] === 'caseE' || process.argv[2] === 'all' || !process.argv[2]) {
  const { ctx, page } = await newPane({})
  await btn(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await btn(page, /选输出列/)
  await waitIdle(page)
  // 表尾新增一行单号（UsedRange 从 10 变 12，新单号在第 12 行）
  await page.evaluate(() => {
    window.__grid['12,15'] = '803123456'
    window.__last = 12
  })
  await btn(page, /立即刷新/)
  await waitIdle(page)
  const w = await page.evaluate(() => window.__written)
  const got12 = w.some(([r, c]) => r === 12 && c === 18)
  pass('E 表尾新增单号（超出原选区）', got12, `第 12 行是否被查询并写回：${got12 ? '是' : '否'}`)
  await ctx.close()
}

// ---- F：范围内空行新填单号 → 刷新应捡到 ----
if (process.argv[2] === 'caseF' || process.argv[2] === 'all' || !process.argv[2]) {
  const { ctx, page } = await newPane({})
  await btn(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await btn(page, /选输出列/)
  await waitIdle(page)
  await page.evaluate(() => { window.__grid['7,15'] = '804555666' })  // 范围内原本空着的行
  await btn(page, /立即刷新/)
  await waitIdle(page)
  const w = await page.evaluate(() => window.__written)
  const got7 = w.some(([r, c]) => r === 7 && c === 18)
  pass('F 范围内空行补单号', got7, `第 7 行是否被查询并写回：${got7 ? '是' : '否'}`)
  await ctx.close()
}

// ---- G：点②在前、再点① → 不应出现红色报错，而是清单提示下一步 ----
if (process.argv[2] === 'caseG' || process.argv[2] === 'all' || !process.argv[2]) {
  const { ctx, page } = await newPane({})
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await btn(page, /选输出列/)
  const s1 = await page.evaluate(() => ({
    err: (document.querySelector('.err') || {}).innerText || '',
    hint: (document.querySelector('.next') || {}).innerText || '',
    steps: [...document.querySelectorAll('.step')].map((x) => x.className + ':' + x.innerText.replace(/\n/g, ' '))
  }))
  await page.evaluate(() => { window.__sel = { col: 15, row: 1, rows: 1048576, cols: 1 } })
  await btn(page, /选单号列/)
  await page.waitForTimeout(400)
  const s2 = await page.evaluate(() => ({
    err: (document.querySelector('.err') || {}).innerText || '',
    hint: (document.querySelector('.next') || {}).innerText || '',
    cfg: !!document.querySelector('.cfg'),
    cfgText: (document.querySelector('.cfg') || {}).innerText || ''
  }))
  const ok = !s1.err && /第 1 步/.test(s1.hint) && !s2.err && s2.cfg && /识别到\s*3\s*个提单号/.test(s2.cfgText)
  pass('G 先②后①：无红色报错 + 清单提示 + 立刻显示识别结果', ok,
    `点②后 err="${s1.err}" hint="${s1.hint.slice(0, 24)}" 步骤=${JSON.stringify(s1.steps).slice(0, 120)}\n     点①后 err="${s2.err}" cfg=${s2.cfg} 文字=${s2.cfgText.replace(/\n/g, ' | ').slice(0, 80)}`)
  await ctx.close()
}

// ---- D：配置按文档隔离（同一存储，两个文档名）----
if (process.argv[2] === 'caseD' || process.argv[2] === 'all' || !process.argv[2]) {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 820 } })
  await ctx.addInitScript(() => { /* noop */ })
  const mk = async () => {
    const page = await ctx.newPage()
    await page.goto(PAGE, { waitUntil: 'load' })
    await page.waitForTimeout(500)
    return page
  }
  let { page } = await newPane({ persist: true, docName: 'A.xlsx', ctx })
  await btn(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await btn(page, /选输出列/)
  await waitIdle(page)
  const wroteA = (await page.evaluate(() => window.__written)).length
  // 切到另一个文档名，重开面板
  await page.evaluate(() => localStorage.setItem('probe-doc', 'B.xlsx'))
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(700)
  const stateB = await page.evaluate(() => ({
    ready: !!document.querySelector('.cfg'),
    hint: /单号列\s*未选/.test((document.querySelector('.steps') || {}).innerText || ''),
    text: document.body.innerText.slice(0, 120)
  }))
  // 切回 A，配置应恢复
  await page.evaluate(() => localStorage.setItem('probe-doc', 'A.xlsx'))
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(700)
  const stateA = await page.evaluate(() => ({ ready: /单号列\s*O/.test((document.querySelector('.steps') || {}).innerText || '') }))
  pass('D 配置跨文档隔离', !stateB.ready && stateB.hint && stateA.ready,
    `A 文档写入 ${wroteA} 格；切到 B 文档 ready=${stateB.ready}（应 false）；切回 A ready=${stateA.ready}（应 true）`)
  await ctx.close()
}

await browser.close()
srv.close()
console.log('\n' + out.join('\n'))
process.exit(0)
