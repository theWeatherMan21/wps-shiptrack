#!/usr/bin/env node
// 契约（schemaVersion）的**面板级**探针：真渲染、真点按钮、真看格子写了什么。
// 跑法：node scripts/schema-probe.mjs   （先在 verify-all 里跟在构建之后）
//
// 为什么单测不够：contract.js 的闸门再对，也可能在 TaskPane 里接错线（0-10-26 的 colLetter 事故就是
// 单测全绿、面板一点就炸）。这条探针只认「用户真的会看到的那一格」：
//   A 正常 v1        → 格子是「日期 · 事件 · 港口」，没有横幅
//   B 桥给 v99       → 格子只有「单号 · 插件版本旧，请更新加载项」，横幅在顶部，且**不带任何业务字段**
//   C 桥主动降级     → 同上（schemaUnsupported 桩）
//   D 老桥（没版本号）→ 照常渲染（只加不改，不许因为加了版本号就把老环境弄坏）
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { chromium } = (() => {
  try { return require('playwright') } catch (e) {
    const os = require('node:os')
    return require(process.env.PLAYWRIGHT_CORE || path.join(os.homedir(), 'Documents/trae_projects/ShipScheduleHub/engine/node_modules/playwright-core'))
  }
})()
const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'wps-addon-build')
if (!fs.existsSync(path.join(BUILD, 'index.html'))) {
  console.log(`✗ 没有构建产物: ${BUILD}（先跑 scripts/build.cjs online）`)
  process.exit(1)
}
const { STUB } = await import('./lib/wps-stub.mjs')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const srv = http.createServer((req, res) => {
  const f = path.join(BUILD, decodeURIComponent(req.url.split('?')[0].split('#')[0]))
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nf') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    res.end(buf)
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const URL0 = `http://127.0.0.1:${srv.address().port}/index.html#/taskpane`

const browser = await chromium.launch({ headless: true, channel: 'chrome' })   // 静默红线：只跑无头
let bad = 0
const pass = (n, ok, d = '') => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ← ' + d}`) }

// 在桩之上再包一层 fetch：只改契约版本，其它一律走原桩（两套桩行为不一致会骗人）
const WRAP = (initMode = 1) => {
  const orig = window.fetch
  window.__fakeSchema = initMode // 1 = 正常；99 = 新契约；null = 桥没上报（老桥）；'refuse' = 桥主动降级
  window.fetch = async (u, init) => {
    const s = String(u)
    const r = await orig(u, init)
    if (!s.includes('/health') && !s.includes('/track')) return r
    const body = await r.json()
    const mode = window.__fakeSchema
    const out = { ...body }
    if (s.includes('/health')) {
      if (mode === null) { delete out.schemaVersion; delete out.supportedSchemaVersions; delete out.minSchemaVersion; delete out.maxSchemaVersion }
      else if (mode !== 'refuse') out.schemaVersion = mode
    } else {
      if (mode === 'refuse') {
        // 桥拒绝旧插件时真正会回的东西：只有单号 + 一句人话
        for (const k of ['events', 'current', 'origin', 'destination', 'carrier', 'errorKind', 'phase', 'containers']) delete out[k]
        out.ok = false; out.schemaUnsupported = true; out.schemaVersion = 1
        out.error = '插件版本旧，请更新加载项（桥契约 v1）'
      } else if (mode === null) delete out.schemaVersion
      else out.schemaVersion = mode
    }
    return { json: async () => out }
  }
}

const open = async (mode = 1) => {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 820 } })
  await ctx.addInitScript(`(${STUB.toString()})(${JSON.stringify({})})`)
  // 版本必须在**面板挂载前的第一次 ping 之前**就位 —— 否则 bridgeSchema 记的是上一轮的值
  await ctx.addInitScript(`(${WRAP.toString()})(${JSON.stringify(mode)})`)
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message)))
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForTimeout(400)
  return { ctx, page, errs }
}
const click = (p, re) => p.getByRole('button', { name: re }).click({ timeout: 8000, force: true })
/** 选列只做一次（重复点①会把这一轮的扫描/配置重置掉 → 第二次跑不起来，那是探针的假象） */
const setup = async (p) => {
  await click(p, /选单号列/)
  await p.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(p, /选输出列/)
}
const runOnce = async (p) => {
  try { await click(p, /③ 立即刷新/) } catch (e) {}
  for (let i = 0; i < 60; i++) {
    await p.waitForTimeout(200)
    const busy = await p.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('立即刷新'))
      return b ? b.disabled : false
    })
    if (!busy) break
  }
}
const cell = (p) => p.evaluate(() => String((window.__grid || {})['2,18'] || ''))
const bannerText = (p) => p.evaluate(() => {
  const el = document.querySelector('.schema-alert')
  return el ? el.innerText.replace(/\n/g, ' ') : ''
})

// ---------- A 正常 v1 ----------
{
  const { ctx, page, errs } = await open(1)
  await setup(page)
  await runOnce(page)
  const c = await cell(page)
  const b = await bannerText(page)
  pass('A 正常版本 → 格子是「日期 · 事件 · 港口」', /^\d{4}-\d{2}-\d{2} · /.test(c) && /离港/.test(c) && /QINGDAO/i.test(c), `格子="${c}"`)
  pass('A 正常版本 → 没有契约横幅', b === '', `横幅="${b}"`)
  pass('A 无 pageerror', errs.length === 0, errs.join(' | '))
  await ctx.close()
}

// ---------- B 桥给 v99（插件认不得）----------
{
  const { ctx, page, errs } = await open(99)
  await setup(page)
  await runOnce(page)
  const c = await cell(page)
  const b = await bannerText(page)
  pass('B 新契约 → 格子只写「单号 · 插件版本旧，请更新加载项」', c === 'TEST-BL-0001 · 插件版本旧，请更新加载项', `格子="${c}"`)
  pass('B 不许出现任何业务字段（事件/港口/日期）', !/QINGDAO|离港|2026-10/.test(c), `格子="${c}"`)
  pass('B 顶部有契约横幅', /插件版本旧/.test(b), `横幅="${b}"`)
  pass('B 横幅说清双方版本', /v99/.test(b) && /v1/.test(b), `横幅="${b}"`)
  pass('B 无 pageerror', errs.length === 0, errs.join(' | '))
  // 视觉验收用：以后端出这版时要给人看「旧插件到底长什么样」，别只给一句 PASS
  if (process.env.SCHEMA_PROBE_SHOT) {
    await page.screenshot({ path: process.env.SCHEMA_PROBE_SHOT, fullPage: false })
    console.log(`      截图 → ${process.env.SCHEMA_PROBE_SHOT}`)
  }
  // 再跑一轮（版本恢复）→ 横幅必须自动消失，不挂僵尸提示
  await page.evaluate(() => { window.__fakeSchema = 1 })
  await runOnce(page)
  const c2 = await cell(page)
  const b2 = await bannerText(page)
  pass('B→A 版本恢复后横幅自动消失', b2 === '' && /离港/.test(c2), `横幅="${b2}" 格子="${c2}"`)
  await ctx.close()
}

// ---------- C 桥主动降级（schemaUnsupported）----------
{
  const { ctx, page } = await open('refuse')
  await setup(page)
  await runOnce(page)
  const c = await cell(page)
  const b = await bannerText(page)
  pass('C 桥降级桩 → 格子只有单号 + 更新提示', c === 'TEST-BL-0001 · 插件版本旧，请更新加载项', `格子="${c}"`)
  pass('C 顶部有横幅', /插件版本旧/.test(b), `横幅="${b}"`)
  await ctx.close()
}

// ---------- D 老桥（/health 与结果都没有版本号）----------
{
  const { ctx, page } = await open(null)
  await setup(page)
  await runOnce(page)
  const c = await cell(page)
  const b = await bannerText(page)
  pass('D 老桥 → 照常渲染（只加不改）', /^\d{4}-\d{2}-\d{2} · /.test(c), `格子="${c}"`)
  pass('D 老桥 → 没有横幅', b === '', `横幅="${b}"`)
  await ctx.close()
}

await browser.close()
srv.close()
console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
