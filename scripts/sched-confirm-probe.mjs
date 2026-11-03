#!/usr/bin/env node
// 端到端探针：ETD/ETA 回填**必须确认**（★ 11-03 爹地原话「写入 ETD/ETA，请加一个按钮来确认吧，不要静默替换」）
//
// 照知澜的验收造表（三行）：
//   R2 ETD 已经是正确日期（46303 = 2026-10-08）→ 不许出现在条上、不许被重写
//   R3 ETD 是偏一天的脏值（46302.6667）→ 条上只该有这一行
//   R4 ETD 是代理名文本              → 不当船期列，跳过、不列、不写
// 断言顺序（缺一条都不算过）：
//   ① 一轮查完出确认条，内容是「将更新 1 行（ETD 1 / ETA 0）」+「R3 ETD 07-Oct → 2026-10-08」
//   ② **没点确认 → 三个格子一个都没变**（直接读桩的 grid，不读界面）
//   ③ 点「确认写入」→ R3 变成整数序列号 46303；R2/R4 不动
//   ④ 「跳过本次」→ 一格不写，但日志留痕
//   ⑤ 「本表以后直接写」（cfg.autoEtdEta）→ 不出条、直接写
// 静默红线：全程 headless。
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'

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

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'wps-addon-build')
if (!fs.existsSync(path.join(BUILD, 'index.html'))) {
  console.log(`✗ 没有构建产物: ${BUILD}（先跑 node scripts/build.cjs online）`)
  process.exit(1)
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.xml': 'text/xml' }
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

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const results = []
const pass = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n     ' + d : ''}`) }

// ---- 表：O 列(15) 单号、R 列(18) 输出、E 列(5) ETD（表头写 ETD，让插件自己认列）----
const NUMCOL = 15
const OUTCOL = 18
const ETDCOL = 5
const SERIAL_OK = 46303                    // 2026-10-08（正确）
const SERIAL_DIRTY = 46302.66666666664     // 偏一天 + 多 16 小时（R2 E 列那次事故的形状）
const PROXY_TEXT = 'SINOTRANS 天津'
const makeGrid = () => ({
  [`1,${NUMCOL}`]: 'MBL',
  [`2,${NUMCOL}`]: '900000009',
  [`3,${NUMCOL}`]: '802735343',
  [`4,${NUMCOL}`]: '802735426',
  [`1,${ETDCOL}`]: 'ETD',
  [`2,${ETDCOL}`]: SERIAL_OK,              // R2：已经是对的
  [`3,${ETDCOL}`]: SERIAL_DIRTY,           // R3：偏一天
  [`4,${ETDCOL}`]: PROXY_TEXT,             // R4：代理名文本
})
// 三条都回「2026-10-08 离港」→ 引擎给的 ETD 就是 2026-10-08
const EVENTS = { time: '2026-10-08T00:00:00Z', activity: 'Departure From', city: 'QINGDAO' }
const evByNumber = { '900000009': [EVENTS], '802735343': [EVENTS], '802735426': [EVENTS] }

const G = (page, key) => page.evaluate((k) => window.__grid[k], key)
const barText = (page) => page.evaluate(() => {
  const el = document.querySelector('.schedbar')
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''
})
const logs = (page) => page.evaluate(() => {
  const el = document.querySelector('.diag pre') || document.querySelector('.diag')
  return el ? el.textContent : ''
})

async function open({ savedCfg = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 560, height: 900 } })
  await ctx.addInitScript(`(${STUB.toString()})(${JSON.stringify({ doc: 'A.xlsx', grid: makeGrid(), savedCfg, last: 10 })})`)
  await ctx.addInitScript(`window.__evByNumber = ${JSON.stringify(evByNumber)};`)
  // ETD 列是日期格式（真实表就是这样）→ 写入必须是整数序列号，不是 ymd 文本
  await ctx.addInitScript(`window.__fmts = ${JSON.stringify({ [`2,${ETDCOL}`]: 'yyyy-mm-dd', [`3,${ETDCOL}`]: 'yyyy-mm-dd', [`4,${ETDCOL}`]: 'General' })};`)
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForTimeout(600)
  return { ctx, page, errs }
}
async function pickColsAndRun(page) {
  await page.getByRole('button', { name: /选单号列/ }).click()
  await page.waitForTimeout(150)
  await page.evaluate((c) => { window.__sel = { col: c, row: 1, rows: 1048576, cols: 1 } }, OUTCOL)
  await page.getByRole('button', { name: /选输出列/ }).click()
  await page.waitForTimeout(150)
  await page.getByRole('button', { name: /立即刷新/ }).click()
}
async function waitBar(page, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(() => !!document.querySelector('.schedbar'))) return true
    await page.waitForTimeout(200)
  }
  return false
}

// ===================== 场景 1：确认写入 =====================
console.log('\n== 场景 1：R2 干净 / R3 偏一天 / R4 代理名 → 条上只列 R3，确认前一个都不动 ==')
{
  const { ctx, page, errs } = await open()
  await pickColsAndRun(page)
  const gotBar = await waitBar(page)
  pass('① 一轮查完出了确认条', gotBar, gotBar ? await barText(page) : '(20s 内没出条)')

  const txt = await barText(page)
  pass('① 标题口径「将更新 1 行（ETD 1 / ETA 0）」', /船期回填：将更新 1 行/.test(txt) && /ETD 1/.test(txt) && /ETA 0/.test(txt), txt)
  pass('① 只列 R3 一条差异（R2 干净不列、R4 文本不列）', /R3 ETD/.test(txt) && !/R2 ETD/.test(txt) && !/R4 ETD/.test(txt), txt)
  pass('① 差异写明「旧值 → 新值」（07-Oct → 2026-10-08）', /R3 ETD 07-Oct → 2026-10-08/.test(txt), txt)

  const g2 = await G(page, `2,${ETDCOL}`)
  const g3 = await G(page, `3,${ETDCOL}`)
  const g4 = await G(page, `4,${ETDCOL}`)
  pass('② 没点确认：R2 一格没变', g2 === SERIAL_OK, `读到 ${g2}`)
  pass('② 没点确认：R3 还是脏值', g3 === SERIAL_DIRTY, `读到 ${g3}`)
  pass('② 没点确认：R4 代理名原样', g4 === PROXY_TEXT, `读到 ${g4}`)
  pass('② 输出列（短结论）照旧自动写了', !!(await G(page, `3,${OUTCOL}`)), `R 列 R3 = ${await G(page, `3,${OUTCOL}`)}`)

  // 勾「本表以后直接写」再确认 → 记住到 cfg
  await page.locator('.schedbar .sb-auto input').check()
  await page.getByRole('button', { name: '确认写入' }).click()
  await page.waitForTimeout(1200)

  const a2 = await G(page, `2,${ETDCOL}`)
  const a3 = await G(page, `3,${ETDCOL}`)
  const a4 = await G(page, `4,${ETDCOL}`)
  pass('③ 点确认：R3 变成正确日期（整数序列号 46303）', a3 === SERIAL_OK, `读到 ${a3}`)
  pass('③ 点确认：R2 没被动', a2 === SERIAL_OK, `读到 ${a2}`)
  pass('③ 点确认：R4 代理名没被动', a4 === PROXY_TEXT, `读到 ${a4}`)
  pass('③ 条消失（不留僵尸提示）', !(await page.evaluate(() => !!document.querySelector('.schedbar'))))
  const lt = await logs(page)
  pass('③ 日志记了「确认写入」的账', /船期回填（确认写入）：写成功 1 格/.test(lt), (lt.split('\n').filter((x) => /船期/.test(x)) || []).slice(0, 3).join(' | '))
  const cfgRaw = await page.evaluate(() => {
    const st = (window.Application && window.Application.PluginStorage && window.Application.PluginStorage._m) || {}
    const fromPlugin = Object.keys(st).map((k) => st[k])
    let fromLs = []
    try { fromLs = Object.keys(localStorage).map((k) => localStorage.getItem(k) || '') } catch (e) {}
    return fromPlugin.concat(fromLs).filter((v) => String(v).includes('autoEtdEta')).join('')
  })
  pass('③ 勾了「本表以后直接写」→ cfg.autoEtdEta 已存', /"autoEtdEta":true/.test(cfgRaw), cfgRaw.slice(0, 160))
  pass('无页面报错', errs.length === 0, errs.join(' | '))
  await ctx.close()
}

// ===================== 场景 2：跳过本次 =====================
console.log('\n== 场景 2：跳过本次 → 一格不写，日志留痕 ==')
{
  const { ctx, page, errs } = await open()
  await pickColsAndRun(page)
  const gotBar = await waitBar(page)
  pass('① 出了确认条', gotBar)
  await page.getByRole('button', { name: '跳过本次' }).click()
  await page.waitForTimeout(800)
  const s3 = await G(page, `3,${ETDCOL}`)
  pass('② 跳过 → R3 还是脏值（一格没写）', s3 === SERIAL_DIRTY, `读到 ${s3}`)
  pass('② 跳过 → R2/R4 也没动',
    (await G(page, `2,${ETDCOL}`)) === SERIAL_OK && (await G(page, `4,${ETDCOL}`)) === PROXY_TEXT)
  pass('② 条消失', !(await page.evaluate(() => !!document.querySelector('.schedbar'))))
  const lt = await logs(page)
  pass('② 日志记了「用户跳过船期回填 1 行」', /用户跳过船期回填 1 行/.test(lt), (lt.split('\n').filter((x) => /跳过船期/.test(x)) || []).slice(0, 2).join(' | '))
  pass('无页面报错', errs.length === 0, errs.join(' | '))
  await ctx.close()
}

// ===================== 场景 3：本表以后直接写 =====================
console.log('\n== 场景 3：cfg.autoEtdEta=true → 不出条、直接写 ==')
{
  const savedCfg = { numberCol: NUMCOL, outCol: OUTCOL, etdCol: ETDCOL, etaCol: 0, startRow: 2, rows: 3, mode: 'column', autoEtdEta: true }
  const { ctx, page, errs } = await open({ savedCfg })
  // 配置从桥恢复（hydrateCfg），直接点③
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /立即刷新/ }).click()
  // 等这批跑完：R3 变成正确值
  const t0 = Date.now()
  let wrote = false
  while (Date.now() - t0 < 20000) {
    if ((await G(page, `3,${ETDCOL}`)) === SERIAL_OK) { wrote = true; break }
    await page.waitForTimeout(250)
  }
  pass('① 没出确认条（本表已选直接写）', !(await page.evaluate(() => !!document.querySelector('.schedbar'))))
  pass('② R3 直接被写成正确日期', wrote, `读到 ${await G(page, `3,${ETDCOL}`)}`)
  pass('② R2 没被动', (await G(page, `2,${ETDCOL}`)) === SERIAL_OK)
  pass('② R4 代理名没被动', (await G(page, `4,${ETDCOL}`)) === PROXY_TEXT)
  const lt = await logs(page)
  pass('② 日志记了「本表已选以后直接写」', /本表已选「以后直接写」/.test(lt), (lt.split('\n').filter((x) => /船期/.test(x)) || []).slice(0, 3).join(' | '))
  pass('无页面报错', errs.length === 0, errs.join(' | '))
  await ctx.close()
}

await browser.close()
srv.close()
const bad = results.filter((x) => !x).length
console.log(`\n结果：${results.length - bad} 通过 / ${bad} 失败`)
process.exit(bad ? 1 : 0)
