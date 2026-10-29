// 状态机探针（无头）：把面板当成状态机，逐条走「异常路径」，断言 UI 与副作用
// 目的：消灭「提示粘住 / 无反馈 / 无出路」这类蠢问题
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
// playwright 未装在本仓时回落到引擎侧已装的 playwright-core
const { chromium } = (() => {
  try { return require('playwright') }
  catch {
    const os = require('node:os')
    const fb = process.env.PLAYWRIGHT_CORE || path.join(os.homedir(), 'Documents/trae_projects/ShipScheduleHub/engine/node_modules/playwright-core')
    return require(fb)
  }
})()
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
const URL0 = `http://127.0.0.1:${srv.address().port}/index.html#/taskpane`

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const results = []
const pass = (n, ok, d) => { results.push([n, ok]); console.log(`${ok ? '✅' : '❌'} ${n}\n     ${d}`) }

import { STUB } from './lib/wps-stub.mjs'

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 820 } })
  await ctx.addInitScript(`(${STUB.toString()})(${JSON.stringify(opts)})`)
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForTimeout(500)
  return { ctx, page, errs }
}
const click = (p, re) => p.getByRole('button', { name: re }).click()
// 按 ③ 开跑；按钮不可用（配置没齐/正在跑）时静默跳过
const tryRun = async (p) => {
  try { await p.getByRole('button', { name: /③ 立即刷新/ }).click({ timeout: 3000, force: true }) } catch (e) { /* 跳过 */ }
  await p.waitForTimeout(300)
}
const waitIdle = async (p, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await p.waitForTimeout(200)
    const busy = await p.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('立即刷新'))
      return b ? b.disabled : false
    })
    if (!busy) return
  }
}
const banner = (p) => p.evaluate(() => {
  const el = document.querySelector('.err, .warn')
  return el ? el.innerText.replace(/\n/g, ' ') : ''
})
// ★ 0.9.43 批次队列：等所有批次跑完（探针靠面板自己暴露的 __SHIPTRACK_BATCHES__ 判断）
const waitBatches = async (p, ms = 90000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const st = await p.evaluate(() => window.__SHIPTRACK_BATCHES__ || [])
    if (st.length && st.every((b) => b.state === 'done' || b.state === 'stopped' || b.state === 'error')) return st
    await p.waitForTimeout(250)
  }
  return await p.evaluate(() => window.__SHIPTRACK_BATCHES__ || [])
}
// 单表写入审计：每条写入的行号，在该表「单号列」上必须还是这条结果的单号（零串表/零错位）
const checkSheet = (writes, grid, numCol, outCol) => {
  const bad = []
  let n = 0
  for (const [row, col, val] of writes || []) {
    if (col !== outCol) continue
    n++
    const have = String(grid[`${row},${numCol}`] || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
    const m = String(val).match(/TESTBL[A-Z]?\d{3,4}/)
    if (!m) { bad.push(`R${row} 写入内容没带单号标记：${String(val).slice(0, 24)}`); continue }
    if (have !== m[0]) bad.push(`R${row} 写的是 ${m[0]}，该行单号现在是 ${have || '(空)'}`)
  }
  return { n, bad }
}

// ---------- H1 写入被拒：横幅说明 + 不丢数据 ----------
{
  const { ctx, page } = await open()
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__writeBlock = true })
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page)
  const b = await banner(page)
  const w = await page.evaluate(() => window.__written.length)
  pass('H1 写入被拒 → 有提示且不假装成功', /写入失败|写不进去/.test(b) && w === 0, `横幅="${b}" 写入次数=${w}`)
  await ctx.close()
}

// ---------- H2 只读工作簿：提前拦住，不写格 ----------
{
  const { ctx, page } = await open()
  await page.evaluate(() => { window.__readonly = true })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page)
  const b = await banner(page)
  const w = await page.evaluate(() => window.__written.length)
  pass('H2 只读工作簿 → 明确提示且零写入', /只读/.test(b) && w === 0, `横幅="${b}" 写入次数=${w}`)
  await ctx.close()
}

// ---------- H3 桥断开 → 重连后横幅自动消失 ----------
{
  const { ctx, page } = await open()
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page)
  await page.evaluate(() => { window.__bridgeDown = true })
  await click(page, /立即刷新/)
  await page.waitForTimeout(900)
  const b1 = await banner(page)
  await page.evaluate(() => { window.__bridgeDown = false })
  await click(page, /重连/)
  await page.waitForTimeout(700)
  const b2 = await banner(page)
  pass('H3 桥掉线提示 → 重连后自动消失', /没在跑/.test(b1) && !/没在跑/.test(b2), `断开时="${b1}" 重连后="${b2 || '(无)'}"`)
  await ctx.close()
}

// ---------- H4 (b) 现场：非活动表摸不到 → 不中止、不写错表、切回自动补齐 ----------
// ★ 0.9.43：多表并行后「切表能不能继续写」取决于 WPS 版本（(a)/(b)）。
// 这条专测保守路径：__crossSheetBlock = true（写非活动表抛错）→ 必须自动回落「攒着等切回」。
{
  const { ctx, page } = await open({ lead: 3000 })
  await page.evaluate(() => { window.__crossSheetBlock = true })
  const doc0 = await page.evaluate(() => window.__doc)
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  // 等真的开始跑（进度条出现），再切表
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100)
    if (await page.evaluate(() => !!document.querySelector('.bar'))) break
  }
  await page.waitForTimeout(300)
  // 切表与采样必须在同一个 evaluate 里原子完成：分开做时，中间完成的 2~3 个并发写
  // 会被算到「切表后」头上（它们其实写在原表、在切表之前，合法）
  const wrAtSwitch = await page.evaluate(() => { window.__doc = 'A.xlsx|Sheet2'; return window.__written.length })
  await waitIdle(page, 20000)
  const wrAfterSwitch = await page.evaluate(() => window.__written.length)
  // 切表那一刻可能有并发（4 路）的写正在飞，允许最多 1 格；之后必须彻底不动
  await page.waitForTimeout(1500)
  const wrSettled = await page.evaluate(() => window.__written.length)
  const hasFlushBtn = await page.evaluate(() => /补齐回填\s*\d/.test(document.body.innerText))
  const pendingRows = await page.evaluate(() => document.querySelectorAll('tr.pending').length)
  // 切回原表 → 点补齐（没按钮就说明自动补齐已经干完了）
  await page.evaluate((d) => { window.__doc = d }, doc0)
  const canFlush = await page.evaluate(() => !![...document.querySelectorAll('button')].find((x) => /补齐回填/.test(x.textContent)))
  if (canFlush) { try { await click(page, /补齐回填/) } catch (e) { /* 已被自动补齐清掉 */ } }
  await page.waitForTimeout(1500)
  const wrFlushed = await page.evaluate(() => window.__written.length)
  const stillPending = await page.evaluate(() => document.querySelectorAll('tr.pending').length)
  // 按钮不再是必经路径（0.9.39 起回原表全自动）：有按钮=还在等，没按钮但已补完=更理想
  const ok = (wrAfterSwitch - wrAtSwitch) <= 1 && wrSettled === wrAfterSwitch
    && (hasFlushBtn || stillPending === 0) && wrFlushed > wrAfterSwitch && stillPending === 0
  pass('H4 查询中切表 → 不中止、不写错表、切回补齐', ok,
    `切表前 ${wrAtSwitch} → 切表后 ${wrAfterSwitch}（允许 +1 在飞）→ 稳定后 ${wrSettled}（必须不动）→ 补齐后 ${wrFlushed} 格；按钮=${hasFlushBtn} 待补行=${pendingRows} 补完残留=${stillPending}`)
  await ctx.close()
}

// ---------- H4b 整轮没跑完、切回原表 → 自己补上，一下都不点 ----------
// 这条才是「拦住 autoFlush 被 busy 挡住」的用例：H4 会点按钮，手动路径也能过，
// 所以 H4 单独存在时拦不住那个 bug（红-绿证明见 wps-addon 技能验收段）。
{
  const grid = {}
  // 16 行 = 4 批：前两批完成时后两批还在跑 → 既能攒到 pending，整轮又没结束
  const nums = ['276759780', '802735343', '802735426', '279415121', '279847842', '279885106', '280324807', '280814801',
                '280815902', '280816103', '280817204', '280818305', '280819406', '280820507', '280821608', '280822709']
  nums.forEach((n, i) => { grid[`${i + 2},17`] = n })
  const { ctx, page } = await open({ grid, lead: 4000 })
  await page.evaluate(() => { window.__crossSheetBlock = true })   // (b) 现场：写非活动表抛错
  const doc0 = await page.evaluate(() => window.__doc)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })   // 单号在 Q 列
  await page.evaluate(() => { window.__grid['1,17'] = 'MBL' })                                  // 表头，避免被当单号
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100)
    if (await page.evaluate(() => !!document.querySelector('.bar'))) break
  }
  await page.waitForTimeout(600)                                    // 刚开跑就切走（第一批还在飞）
  await page.evaluate(() => { window.__doc = 'A.xlsx|Sheet2' })
  // ★ 0.9.43：切走时不再显示别的表的行（表格是空的），待补条数从「补齐回填 N」按钮读
  const pendingBtn = async () => {
    const t = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /补齐回填/.test(x.textContent))
      return b ? b.textContent : ''
    })
    const m = String(t).match(/(\d+)/)
    return m ? Number(m[1]) : 0
  }
  // 等到「切走之后有结果攒起来（待补>0）且整轮还没跑完」——这正是 H4b 的场景，不能靠死等
  let pendingBefore = 0
  let stillRunningBefore = false
  for (let i = 0; i < 120; i++) {
    pendingBefore = await pendingBtn()
    stillRunningBefore = await page.evaluate(() => (window.__SHIPTRACK_BATCHES__ || []).some((b) => b.state === 'running'))
    if (pendingBefore > 0 && stillRunningBefore) break
    await page.waitForTimeout(250)
  }
  const wrBeforeBack = await page.evaluate(() => window.__written.length)
  await page.evaluate((d) => { window.__doc = d }, doc0)            // 切回，什么都不点
  await page.waitForTimeout(3400)                                   // 等 2.5s 定时器
  const wrAfterAuto = await page.evaluate(() => window.__written.length)
  const pendingAfter = await pendingBtn()
  const stillRunning = await page.evaluate(() => (window.__SHIPTRACK_BATCHES__ || []).some((b) => b.state === 'running'))
  // 判据核心 = pending 队列被清掉（只有 autoFlush 会清）+ 写入数涨 + 整轮没结束。
  // 只看「写入数涨」不够：新到期的行也会正常写，分不清是补齐还是新行。
  const ok = pendingBefore > 0 && pendingAfter < pendingBefore && wrAfterAuto > wrBeforeBack && stillRunning
  pass('H4b 整轮未跑完时切回 → 自动补齐（不点按钮）', ok,
    `切走期间待补=${pendingBefore} 写入=${wrBeforeBack} → 切回后待补=${pendingAfter} 写入=${wrAfterAuto} · 整轮仍在跑=${stillRunning}`)
  await ctx.close()
}

// ---------- H5 停止：未查的行标「已停止」 ----------
{
  // 关键：号码数要大于并发数（4），否则根本来不及有"排队的行"
  const grid = {}
  const nums = ['276759780', '802735343', '802735426', '279415121', '279847842', '279885106', '280324807', '280814801']
  nums.forEach((n, i) => { grid[`${i + 2},17`] = n })
  const { ctx, page } = await open({ grid, lead: 3000 })
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await page.waitForTimeout(600)
  await click(page, /停止/)
  await waitIdle(page, 20000)
  const t = await page.evaluate(() => document.querySelector('table') ? document.querySelector('table').innerText : '')
  const hasStop = /已停止/.test(t), hasRunning = /查询中/.test(t)
  pass('H5 停止后不留「查询中…」', !hasRunning && hasStop, `已停止=${hasStop} 查询中=${hasRunning}`)
  await ctx.close()
}

// ---------- H6 两个文档的配置互不覆盖 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 520, height: 820 } })
  await ctx.exposeFunction('noop', () => {})
  const mk = async (doc) => {
    const p = await ctx.newPage()
    await p.addInitScript(`(${STUB.toString()})(${JSON.stringify({ doc })})`)
    // PluginStorage 落 localStorage，才能跨 reload 保留
    await p.addInitScript(() => {
      window.Application.PluginStorage = {
        getItem: (k) => localStorage.getItem('ps:' + k),
        setItem: (k, v) => localStorage.setItem('ps:' + k, String(v))
      }
    })
    await p.goto(URL0, { waitUntil: 'load' })
    await p.waitForTimeout(500)
    return p
  }
  const A1 = await mk('A.xlsx')
  await click(A1, /选单号列/)                       // A: 单号列 O
  const B1 = await mk('B.xlsx')
  await click(B1, /选单号列/)                       // B: 也不同文档，再点 ①
  await page_setSel(B1, 18)
  await click(B1, /选输出列/)
  await waitIdle(B1)
  const A2 = await mk('A.xlsx')                     // 重新打开 A
  const aText = await A2.evaluate(() => [...document.querySelectorAll('.step')].map((x) => x.innerText.replace(/\n/g, ' ')).join(' | '))
  const hasO = /单号列 O/.test(aText)
  pass('H6 多文档配置互不覆盖', hasO, `重新打开 A 后配置：${aText.replace(/\n/g, ' | ').slice(0, 90) || '(空)'}`)
  await ctx.close()
}

async function page_setSel(p, col) {
  await p.evaluate((c) => { window.__sel = { col: c, row: 1, rows: 1048576, cols: 1 } }, col)
}

// ---------- H7 复合单号 + S/L 船司列（爹地表里的真实形态）----------
{
  const grid = {
    '1,15': 'S/L', '1,16': 'MBL',
    '2,15': 'HPL SOC', '2,16': '11527275/HLCUEUR25220885E7XX',
    '3,15': 'HPL COC', '3,16': '10723207',
    '4,15': 'MSK',     '4,16': '255051059'
  }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => { window.__sel = { col: 16, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  const cfgText = await page.evaluate(() => (document.querySelector('.cfg') || {}).innerText || '')
  await page.evaluate(() => { window.__sel = { col: 19, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page, 15000)
  const calls = await page.evaluate(() => window.__calls)
  const track = calls.filter((u) => u.includes('/track'))
  const splitOk = track.some((u) => u.includes('number=HLCUEUR25220885E7XX'))
  const hapagOk = track.filter((u) => u.includes('number=HLCUEUR25220885E7XX') || u.includes('number=10723207'))
    .every((u) => u.includes('carrier=hapag'))
  const stepsText = await page.evaluate(() => [...document.querySelectorAll('.step')].map((x) => x.innerText.replace(/\n/g, ' ')).join(' | '))
  const autoCol = /船司列 O/.test(stepsText)
  pass('H7 复合单号拆分 + S/L 自动认列', splitOk && hapagOk && autoCol,
    `自动认列=${autoCol}；拆分=${splitOk}；HPL 行都用 hapag=${hapagOk}\n     track 调用: ${JSON.stringify(track.map((u) => u.replace(/^.*\/track\?/, '')).slice(0, 4))}`)
  await ctx.close()
}

// ---------- H8 S/L 写了没有适配器的船司（SITC）→ 不发请求，直接给结论 ----------
{
  const grid = { '1,15': 'S/L', '1,16': 'MBL', '2,15': 'SITC', '2,16': 'SITC12345678901' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => { window.__sel = { col: 16, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 19, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page, 15000)
  const calls = await page.evaluate(() => window.__calls)
  const wrote = await page.evaluate(() => Object.entries(window.__grid).filter(([k]) => k.endsWith(',19')).map(([, v]) => v))
  const noTrack = !calls.some((u) => u.includes('/track?number=SITC'))
  const msg = /未接入追踪/.test(wrote.join(' '))
  pass('H8 未接入船司直接给结论', noTrack && msg, `未发 /track=${noTrack}；写入="${wrote.join(' | ')}"`)
  await ctx.close()
}

// ---------- H8b S/L 写了 OOCL（已接入）→ 照常查，绝不再出现「暂未接入/需滑块验证」----------
{
  const grid = { '1,15': 'S/L', '1,16': 'MBL', '2,15': 'OOCL', '2,16': 'OOLU1234567890' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => { window.__sel = { col: 16, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 19, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await waitIdle(page, 15000)
  const calls = await page.evaluate(() => window.__calls)
  const wrote = await page.evaluate(() => Object.entries(window.__grid).filter(([k]) => k.endsWith(',19')).map(([, v]) => v))
  const tracked = calls.some((u) => u.includes('/track?number=OOLU1234567890') && u.includes('carrier=oocl'))
  const stale = /暂未接入|滑块|验证码/.test(wrote.join(' '))
  // 反向断言：必须真的发出了查询并写回一行结果，防「什么都不做也算通过」
  const gotResult = wrote.length > 0 && /离港|装船|到港|QINGDAO|ISTANBUL/i.test(wrote.join(' '))
  pass('H8b OOCL 已接入照常查（旧「未接入/需滑块」文案已清）', tracked && !stale && gotResult,
    `发 /track?carrier=oocl=${tracked}；旧文案残留=${stale}；写入="${wrote.join(' | ')}"`)
  await ctx.close()
}

// ---------- H9 先点②再点①：全程不该出现红条（点错列只是短暂提示）----------
{
  const { ctx, page } = await open()
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await page.waitForTimeout(300)
  const afterOut = await banner(page)
  await page.evaluate(() => { window.__sel = { col: 15, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await waitIdle(page, 15000)
  const afterNum = await banner(page)
  const steps = await page.evaluate(() => (document.querySelector('.steps') || {}).innerText || '')
  pass('H9 先②后①全程无红条', afterOut === '' && afterNum === '' && /② 输出列/.test(steps) && /| R|/.test(steps),
    `点②后横幅="${afterOut || '(无)'}"；点①后横幅="${afterNum || '(无)'}"\n     三步清单="${steps.replace(/\n/g, ' | ')}"`)
  await ctx.close()
}

// ---------- H10 订舱号/提单号同格：提单号查无 → 自动换订舱号再试 ----------
{
  const grid = { '1,15': 'S/L', '1,16': 'MBL', '2,15': 'HPL COC', '2,16': '38095103/HLCUEUR2594708ABFXX' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => { window.__sel = { col: 16, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 19, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page, 20000)
  const calls = await page.evaluate(() => window.__calls.filter((u) => u.includes('/track')))
  const wrote = await page.evaluate(() => Object.entries(window.__grid).filter(([k]) => k.endsWith(',19')).map(([, v]) => v).join(' | '))
  const triedBoth = calls.some((u) => u.includes('HLCUEUR2594708ABFXX')) && calls.some((u) => u.includes('number=38095103'))
  pass('H10 提单号查无→自动换订舱号', triedBoth && /·/.test(wrote),
    `两次查询=${calls.length}（${calls.map((u) => (u.match(/number=([^&]+)/) || [])[1]).join(' → ')}）；写入="${wrote}"`)
  await ctx.close()
}

// ---------- H11 里程碑着色：在途蓝 / 到港绿 / 还空灰 ----------
{
  const got = {}
  for (const kind of ['at_sea', 'arrived', 'empty']) {
    const grid = {
      '1,10': 'POL', '1,11': 'POD', '1,15': 'S/L', '1,16': 'MBL',
      '2,10': 'QINGDAO', '2,11': 'ISTANBUL',
      '2,15': 'MSK', '2,16': '276759780'
    }
    const { ctx, page } = await open({ grid, evKind: kind })
    await page.evaluate(() => { window.__sel = { col: 16, row: 1, rows: 1048576, cols: 1 } })
    await click(page, /选单号列/)
    await page.evaluate(() => { window.__sel = { col: 19, row: 1, rows: 1048576, cols: 1 } })
    await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
    await waitIdle(page, 20000)
    await page.waitForTimeout(1200)
    const fills = await page.evaluate(() => window.__fills.filter(([r]) => r === 2))  // 整行填充：记录在行首列
    got[kind] = fills.length ? fills[fills.length - 1][2] : null
    await ctx.close()
  }
  const hex = (v) => (v === null ? 'null' : '0x' + v.toString(16))
  const ok = got.at_sea === 0xcfe3fa && got.arrived === 0xd5f0dc && got.empty === 0xe6e6e6
  pass('H11 里程碑着色（蓝/绿/灰）', ok,
    `在途=${hex(got.at_sea)}（应 0xcfe3fa） · 到港=${hex(got.arrived)}（应 0xd5f0dc） · 还空=${hex(got.empty)}（应 0xe6e6e6）`)
}

// ---------- H12 重启后自动恢复列设置（不再每次重选）----------
{
  const grid = { '1,15': 'S/L', '1,16': 'MBL', '1,17': 'V/V', '1,19': '' }
  const savedCfg = { numberCol: 16, outCol: 19, startRow: 1, rows: 6, mode: 'column', carrierCol: 15 }
  const { ctx, page } = await open({ grid, savedCfg })
  await page.waitForTimeout(1500)
  const steps = await page.evaluate(() => (document.querySelector('.steps') || {}).innerText || '')
  const ok = /① 单号列/.test(steps) && /P/.test(steps) && /② 输出列/.test(steps) && /S/.test(steps)
  pass('H12 重启后自动恢复列设置', ok, `未点任何按钮时的三步清单：${steps.replace(/\n/g, ' | ')}`)
  await ctx.close()
}

// ---------- H13 单行多列 2D 表头（WPS 真实形态）也要认出 POL/POD ----------
{
  const grid = { '1,9': 'POL', '1,10': 'POD', '1,14': 'S/L', '1,15': 'MBL',
                 '2,9': 'TIANJIN', '2,10': 'GDANSK', '2,14': 'MSK', '2,15': '276759780' }
  const { ctx, page } = await open({ grid, header2d: true })
  await page.evaluate(() => { window.__sel = { col: 15, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.waitForTimeout(1200)
  const body = await page.evaluate(() => document.body.innerText)
  const m = body.match(/起运\/目的港列：([^\n]*)/)
  const ok = !!m && /I\s*\/\s*J/.test(m[1])
  pass('H13 单行多列(2D)表头仍能认出 POL/POD', ok, ok ? '起运 I / 目的 J' : String(m ? m[1] : '未找到该行'))
  await ctx.close()
}

// ---------- H14 没查到结果 → 自动重查 ----------
{
  const grid = { '1,14': 'S/L', '1,15': 'MBL', '2,15': 'ONEY0000000001' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => {
    window.__bridgeDown = true                 // 模拟网络挂：这一轮的查询必然失败
    window.__SHIPTRACK_RETRY_MS__ = 1500       // 把 30 分钟缩短成 1.5 秒
  })
  await page.evaluate(() => { window.__sel = { col: 15, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 19, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page, 25000)
  const afterRun = await page.evaluate(() => document.body.innerText)
  const calls1 = await page.evaluate(() => (window.__calls || []).filter((u) => u.includes('/track')).length)
  await page.waitForTimeout(5000)
  const calls2 = await page.evaluate(() => (window.__calls || []).filter((u) => u.includes('/track')).length)
  const afterRetry = await page.evaluate(() => document.body.innerText)
  // 日志面板在不同版本里可能折叠，行为判据直接用「是否真的又发了一次查询」
  pass('H14 查不到→30 分钟后自动重查', calls2 > calls1,
    `请求次数 ${calls1}→${calls2}\n     日志=${afterRetry.slice(-260).replace(/\n/g, ' | ')}`)
  await ctx.close()
}

// ---------- H15 表格有 ETD/ETA 列 → 用真实船期覆盖 ----------
{
  const grid = { '1,14': 'ETD', '1,15': 'ETA', '1,16': 'S/L', '1,17': 'MBL',
                 '2,14': '1-Nov', '2,15': '30-Nov', '2,16': 'HPL', '2,17': 'ONEY0000000002' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => { window.__evKind = 'arrived' })   // 离港 10-03 / 到港 11-01
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page, 20000)
  const etd = await page.evaluate(() => String((window.__grid || {})['2,14'] || ''))
  const eta = await page.evaluate(() => String((window.__grid || {})['2,15'] || ''))
  const dump = await page.evaluate(() => {
    const out = {}
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/cfg|ship/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 200) } } catch (e) {}
    return out
  })
  const outText = await page.evaluate(() => String((window.__grid || {})['2,18'] || ''))
  const bodyTxt = await page.evaluate(() => document.body.innerText.slice(-300).replace(/\n/g, ' | '))
  pass('H15 ETD/ETA 列被真实船期覆盖', /2026-10-03/.test(etd) && /2026-11-01/.test(eta),
    `ETD=${etd} ETA=${eta} 输出列=${outText}\n     尾巴=${bodyTxt}`)
  await ctx.close()
}

// ---------- H16 选完列不许自己开跑（0.9.23 回归） ----------
{
  const grid = { '1,16': 'S/L', '1,17': 'MBL', '2,17': 'ONEY0000000003' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await page.waitForTimeout(2500)
  const calls1 = await page.evaluate(() => (window.__calls || []).filter((u) => u.includes('/track')).length)
  await tryRun(page)
  await waitIdle(page, 15000)
  const calls2 = await page.evaluate(() => (window.__calls || []).filter((u) => u.includes('/track')).length)
  pass('H16 选完两列不自动开跑，按③才查', calls1 === 0 && calls2 > 0, `点②后请求=${calls1}，点③后=${calls2}`)
  await ctx.close()
}

// ---------- H17 双列：先查提单号，查无再查订舱号 ----------
{
  // A：提单号有动态（10-01），订舱号更新的（11-20）→ 仍用提单号，且只发 1 个请求
  const grid = { '1,17': '提单号', '1,19': '订舱号', '2,17': 'ONEY0000000010', '2,19': 'ONEY0000000011' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => {
    window.__evByNumber = {
      ONEY0000000010: [{ time: '2026-09-01T00:00:00Z', activity: 'Departure From', city: 'QINGDAO' },
                       { time: '2026-10-01T00:00:00Z', activity: 'Arrival In', city: 'GDANSK' }],
      ONEY0000000011: [{ time: '2026-11-20T00:00:00Z', activity: 'Arrival In', city: 'GDANSK' }],
    }
  })
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await waitIdle(page, 20000)
  const out = await page.evaluate(() => String((window.__grid || {})['2,18'] || ''))
  const calls = await page.evaluate(() => (window.__calls || []).filter((u) => u.includes('/track')).length)
  pass('H17 提单号有动态 → 不再查订舱号', /2026-10-01/.test(out) && calls === 1, `输出=${out} 请求=${calls}`)
  await ctx.close()
}
{
  // B：提单号查无动态，订舱号有 → 自动补查订舱号
  const grid = { '1,17': '提单号', '1,19': '订舱号', '2,17': 'ONEY0000000020', '2,19': 'ONEY0000000021' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => {
    window.__evByNumber = {
      ONEY0000000020: [],
      ONEY0000000021: [{ time: '2026-11-20T00:00:00Z', activity: 'Arrival In', city: 'GDANSK' }],
    }
  })
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await waitIdle(page, 20000)
  const out = await page.evaluate(() => String((window.__grid || {})['2,18'] || ''))
  const calls = await page.evaluate(() => (window.__calls || []).filter((u) => u.includes('/track')).length)
  pass('H17b 提单号查无 → 自动补查订舱号', /2026-11-20/.test(out) && calls >= 2, `输出=${out} 请求=${calls}`)
  await ctx.close()
}

// ---------- H18 港口列已识别也不能跳过「单号两列」识别 ----------
{
  const grid = { '1,3': '起运港', '1,4': '目的港', '1,9': '提单号', '1,11': '订舱号',
                 '2,3': 'SHANGHAI', '2,4': 'GDANSK', '2,9': 'ONEY0000000030', '2,11': '42084242' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => {
    window.__evByNumber = {
      ONEY0000000030: [],
      '42084242': [{ time: '2026-11-20T00:00:00Z', activity: 'Arrival In', city: 'GDANSK' }],
    }
  })
  await page.evaluate(() => { window.__sel = { col: 9, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await waitIdle(page, 20000)
  const out = await page.evaluate(() => String((window.__grid || {})['2,18'] || ''))
  const calls = await page.evaluate(() => (window.__calls || []).filter((u) => u.includes('/track')).length)
  pass('H18 港口列已认出时仍识别订舱号列并补查', /2026-11-20/.test(out) && calls >= 2, `输出=${out} 请求=${calls}`)
  await ctx.close()
}

// ---------- H19 桥进程没起：横幅必须说「进程没在跑」并给可复制的启动命令 ----------
{
  const { ctx, page } = await open({ bridgeMode: 'down' })
  await page.waitForTimeout(600)
  const b = await banner(page)
  const hasPing = await page.getByRole('button', { name: /重连/ }).count()
  const hasCopy = await page.getByRole('button', { name: /复制命令/ }).count()
  pass('H19 8791 无监听 → 说清「进程没在跑」+ 给启动命令',
    /进程没在跑/.test(b) && /8791/.test(b) && /bridge\.sh start|start-win\.ps1/.test(b) && hasPing > 0 && hasCopy > 0,
    `横幅="${b}" 重连按钮=${hasPing} 复制按钮=${hasCopy}`)
  await ctx.close()
}

// ---------- H20 桥活着但自报 ok:false → 原样转述桥的原因，不误报「没在跑」 ----------
{
  const { ctx, page } = await open({ bridgeMode: 'denied' })
  await page.waitForTimeout(600)
  const b = await banner(page)
  pass('H20 桥返回 ok:false → 转述桥自报原因', /只接受本机页面调用/.test(b) && !/进程没在跑/.test(b), `横幅="${b}"`)
  await ctx.close()
}

// ---------- H21 端口通但请求被拦 → 说「加载项被拦」，与「没在跑」区分 ----------
{
  const { ctx, page } = await open({ bridgeMode: 'blocked' })
  await page.waitForTimeout(600)
  const b = await banner(page)
  pass('H21 端口通但请求被拦 → 说「加载项被拦」', /加载项被拦/.test(b) && !/进程没在跑/.test(b), `横幅="${b}"`)
  await ctx.close()
}

// ---------- 行身份审计（H22/H23 共用）----------
// 判据不看读回值，只看「写动作落在哪一格」：每条写入的 row，删行之后该行单号列必须还是它的单号。
const normNum = (s) => String(s == null ? '' : s).replace(/[^A-Z0-9]/gi, '').toUpperCase()
function auditWrites(written, gridAfter, numCol, outCol) {
  const bad = []
  let n = 0
  for (const [row, col, val] of written) {
    if (col !== outCol) continue
    n++
    const have = normNum(gridAfter[`${row},${numCol}`])
    const m = String(val).match(/TESTBL\d{4}/)
    const want = m ? m[0] : ''
    if (!have) { bad.push(`第 ${row} 行单号列是空的，却写了「${String(val).slice(0, 26)}」`); continue }
    if (!want) { bad.push(`第 ${row} 行写的内容没带单号标记，无法核对：${String(val).slice(0, 26)}`); continue }
    if (have !== want) bad.push(`第 ${row} 行写的是 ${want} 的结果，可这行单号现在是 ${have}`)
  }
  return { n, bad }
}

// ---------- H22 查询跑到一半删掉中间一行 → 绝不许写到单号对不上的行 ----------
{
  const grid = { '1,17': 'MBL' }
  const nums = ['TEST-BL-0001', 'TEST-BL-0002', 'TEST-BL-0003', 'TEST-BL-0004', 'TEST-BL-0005', 'TEST-BL-0006']
  nums.forEach((n, i) => { grid[`${i + 2},17`] = n })
  const evBy = {}
  nums.forEach((n) => { const k = n.replace(/-/g, ''); evBy[k] = [{ time: '2026-10-01T00:00:00Z', activity: 'Departure From', city: k }] })
  const { ctx, page } = await open({ grid, lead: 3000, last: 7 })
  await page.evaluate((e) => { window.__evByNumber = e }, evBy)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100)
    if (await page.evaluate(() => !!document.querySelector('.bar'))) break
  }
  await page.waitForTimeout(700)
  // 删掉第 3 行（TEST-BL-0002）：下面整体上移，第 7 行空出来 —— 真删，不是只改行号
  await page.evaluate(() => window.__deleteRow(3))
  await waitIdle(page, 40000)
  const gridAfter = await page.evaluate(() => window.__grid)
  const written = await page.evaluate(() => window.__written)
  const { n, bad } = auditWrites(written, gridAfter, 17, 18)
  const b = await banner(page)
  const hint = /错位|表格行变了/.test(b)
  const after = [2, 3, 4, 5, 6, 7].map((r) => `${r}:${String(gridAfter[`${r},17`] || '(空)')}`).join(' ')
  pass('H22 查询中删一行 → 不写错位行 + 有错位提示', bad.length === 0 && hint,
    `删行后单号列 ${after}；写入 ${n} 格；冲突 ${bad.length}${bad.length ? '：' + bad.join('；') : ''}\n     横幅="${b}"`)
  await ctx.close()
}

// ---------- H23 单号列是空行的格 → 无论如何保持空（含跑到一半被清空的行）----------
{
  // 第 4 行单号列故意空着（真实表里 115–127 就是这种）；第 3 行跑到一半被清空
  const grid = { '1,17': 'MBL', '2,17': 'TEST-BL-0011', '3,17': 'TEST-BL-0012', '5,17': 'TEST-BL-0013', '6,17': 'TEST-BL-0014' }
  const evBy = {}
  ;['0011', '0012', '0013', '0014'].forEach((k) => {
    evBy[`TESTBL${k}`] = [{ time: '2026-10-02T00:00:00Z', activity: 'Departure From', city: `TESTBL${k}` }]
  })
  const { ctx, page } = await open({ grid, lead: 3000, last: 6 })
  await page.evaluate((e) => { window.__evByNumber = e }, evBy)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100)
    if (await page.evaluate(() => !!document.querySelector('.bar'))) break
  }
  await page.waitForTimeout(700)
  await page.evaluate(() => { delete window.__grid['3,17'] })   // 第 3 行单号被清空（行号不变）
  await waitIdle(page, 40000)
  const gridAfter = await page.evaluate(() => window.__grid)
  const written = await page.evaluate(() => window.__written)
  const { n, bad } = auditWrites(written, gridAfter, 17, 18)
  const b = await banner(page)
  const hint = /错位|表格行变了/.test(b)
  const emptyRowsTouched = written.filter(([r, c]) => c === 18 && !normNum(gridAfter[`${r},17`])).map(([r]) => r)
  // 反向断言：该写的（单号还在的行）必须真写到了，证明校验没变成「一律不写」
  const okRows = written.filter(([r, c]) => c === 18 && normNum(gridAfter[`${r},17`])).map(([r]) => r)
  pass('H23 单号列为空的行保持空（范围里的空行 + 跑到一半被清空的行）',
    bad.length === 0 && hint && emptyRowsTouched.length === 0 && okRows.length >= 2,
    `写入 ${n} 格；空行被写=${JSON.stringify(emptyRowsTouched)}（必须空）；正常行写入=${JSON.stringify(okRows)}；冲突 ${bad.length}${bad.length ? '：' + bad.join('；') : ''}\n     横幅="${b}"`)
  await ctx.close()
}

// ---------- H24 批量写路径：删中间一行 → 一格都不许写到错位行（且确实走了批量写）----------
// 和 H22 的区别：H22 只有 1 格合法写入（都在删除点上方），根本走不到批量写。
// 这条把删除点放在数据区偏下（第 9 行）：前一批（2–5 行）批量写落地，后一批里 6–8 行仍然合法（也批量写），
// 第 9 行及以下被顶下来的行必须一格不写 —— 批量写如果漏了身份校验，就会整段写错行。
{
  const grid = { '1,17': 'MBL' }
  const nums = []
  for (let i = 0; i < 11; i++) nums.push('TEST-BL-' + String(201 + i).padStart(4, '0'))   // 第 2–12 行（补齐 4 位：单号形态筛要求字母≥2、数字≥4）
  nums.forEach((n, i) => { grid[`${i + 2},17`] = n })
  const evBy = {}
  nums.forEach((n) => { const k = n.replace(/-/g, ''); evBy[k] = [{ time: '2026-10-01T00:00:00Z', activity: 'Departure From', city: k }] })
  const { ctx, page } = await open({ grid, lead: 900, last: 13 })
  await page.evaluate((e) => { window.__evByNumber = e }, evBy)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  // 等第一批（2–5 行）真的批量写进表，再删行 —— 这样「批量写」这条路确实被走过
  let firstBatch = false
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100)
    firstBatch = await page.evaluate(() => (window.__batchWrites || []).some((b) => b.rows > 1))
    if (firstBatch) break
  }
  await page.evaluate(() => window.__deleteRow(9))     // 数据区中间删一行：下面整体上移
  await waitIdle(page, 40000)
  await page.waitForTimeout(500)
  const gridAfter = await page.evaluate(() => window.__grid)
  const written = await page.evaluate(() => window.__written)
  const batchWrites = await page.evaluate(() => window.__batchWrites || [])
  const stats = await page.evaluate(() => window.__SHIPTRACK_STATS__ || null)
  const { n, bad } = auditWrites(written, gridAfter, 17, 18)
  const b = await banner(page)
  const hint = /错位|表格行变了/.test(b)
  const multi = batchWrites.filter((x) => x.rows > 1)
  const maxRun = batchWrites.reduce((m, x) => Math.max(m, x.rows), 0)
  // 反向断言：删除点上方仍该照写（证明校验没变成「一律不写」）
  const okRows = written.filter(([r, c]) => c === 18 && normNum(gridAfter[`${r},17`])).map(([r]) => r)
  const touchedAfterDelete = written.filter(([r, c]) => c === 18 && r >= 9).map(([r]) => r)
  pass('H24 批量写路径下删中间一行 → 不写错位行（且确实用到批量写）',
    firstBatch && multi.length >= 1 && maxRun >= 2 && bad.length === 0 && hint && okRows.length >= 3,
    `批量写 ${batchWrites.length} 次（多行段 ${multi.length} 个，最大段长 ${maxRun}）· 写入 ${n} 格 · 合法行=${JSON.stringify(okRows)} · 删除点及以下被写=${JSON.stringify(touchedAfterDelete)} · 冲突 ${bad.length}${bad.length ? '：' + bad.join('；') : ''}`
      + `\n     写回统计=${JSON.stringify(stats)}\n     横幅="${b}"`)
  await ctx.close()
}

// ---------- H26 同一工作簿两张表并行：(a) 现场（能写非活动表）----------
// 爹地 2026-10-29 的原始诉求：A 表在跑，切到 B 表还能再点，两批一起推进、各自进度、互不阻塞。
// 判据：① 采样到两批同时 running 且都在推进；② 每张表的写入只落在自己的表、且行号与单号对得上（零串表）。
{
  const N = 8
  const gridA = { '1,17': 'MBL' }, gridB = { '1,17': 'MBL' }
  const numA = [], numB = [], evBy = {}
  for (let i = 0; i < N; i++) {
    const a = 'TEST-BL-4' + String(i + 1).padStart(3, '0')
    const b = 'TEST-BL-5' + String(i + 1).padStart(3, '0')
    numA.push(a); numB.push(b)
    gridA[`${i + 2},17`] = a
    gridB[`${i + 2},17`] = b
    evBy[a.replace(/-/g, '')] = [{ time: '2026-10-02T00:00:00Z', activity: 'Departure From', city: a.replace(/-/g, '') }]
    evBy[b.replace(/-/g, '')] = [{ time: '2026-10-03T00:00:00Z', activity: 'Departure From', city: b.replace(/-/g, '') }]
  }
  const { ctx, page } = await open({ sheets: [{ name: 'Sheet1', grid: gridA }, { name: 'Sheet2', grid: gridB }], lead: 1500, last: N + 1 })
  await page.evaluate((e) => { window.__evByNumber = e }, evBy)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)                                     // 第一批发车（Sheet1）
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__setSheet('Sheet2')) // 切到第二张表
  await page.waitForTimeout(1400)                        // 等面板认出切表（900ms 轮询）并载入该表配置
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)                                     // 第二批发车（Sheet2）—— 第一轮还在跑
  // 采样：两批有没有同时在跑、并且都在推进
  let both = false, peak = 0
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => window.__SHIPTRACK_BATCHES__ || [])
    const run = st.filter((b) => b.state === 'running')
    peak = Math.max(peak, run.length)
    if (run.length >= 2 && run.every((b) => b.done > 0)) { both = true; break }
    await page.waitForTimeout(150)
  }
  const final = await waitBatches(page, 90000)
  const grids = await page.evaluate(() => window.__grids)
  const bySheet = await page.evaluate(() => window.__writesBySheet || {})
  const cross = await page.evaluate(() => window.__SHIPTRACK_CROSS__ || {})
  const auditA = checkSheet(bySheet.Sheet1, grids.Sheet1, 17, 18)
  const auditB = checkSheet(bySheet.Sheet2, grids.Sheet2, 17, 18)
  const doneA = final.filter((b) => b.doc === 'A.xlsx|Sheet1' && b.state === 'done')
  const doneB = final.filter((b) => b.doc === 'A.xlsx|Sheet2' && b.state === 'done')
  const ok = both && peak >= 2 && doneA.length === 1 && doneB.length === 1
    && doneA[0].done === N && doneB[0].done === N
    && auditA.bad.length === 0 && auditB.bad.length === 0
    && auditA.n >= N && auditB.n >= N
  pass('H26 同工作簿两张表并行（各跑各的进度、零串表）', ok,
    `同时在跑峰值=${peak} · 两批都在推进=${both} · 批次=${JSON.stringify(final.map((b) => [b.doc, b.state, b.done + '/' + b.total]))}`
    + `\n     Sheet1 写入 ${auditA.n} 格、Sheet2 写入 ${auditB.n} 格 · 串表/错位 ${auditA.bad.length + auditB.bad.length}`
    + `${[...auditA.bad, ...auditB.bad].slice(0, 3).join('；')} · 跨表写 ${JSON.stringify({ ok: cross.ok, fail: cross.fail })}`)
  await ctx.close()
}

// ---------- H27 (b) 现场：非活动表摸不到 → 自动回落「攒着等切回」，切回去自动补 ----------
// 这是 (a)/(b) 自答的实测口：crossSheetWrite.fail > 0 就说明这个 WPS 版本是 (b)，代码已在保守路径上。
{
  const N = 6
  const gridA = { '1,17': 'MBL' }, gridB = { '1,17': 'MBL' }
  const evBy = {}
  for (let i = 0; i < N; i++) {
    const a = 'TEST-BL-6' + String(i + 1).padStart(3, '0')
    const b = 'TEST-BL-7' + String(i + 1).padStart(3, '0')
    gridA[`${i + 2},17`] = a
    gridB[`${i + 2},17`] = b
    evBy[a.replace(/-/g, '')] = [{ time: '2026-10-02T00:00:00Z', activity: 'Departure From', city: a.replace(/-/g, '') }]
    evBy[b.replace(/-/g, '')] = [{ time: '2026-10-03T00:00:00Z', activity: 'Departure From', city: b.replace(/-/g, '') }]
  }
  const { ctx, page } = await open({ sheets: [{ name: 'Sheet1', grid: gridA }, { name: 'Sheet2', grid: gridB }], lead: 900, last: N + 1 })
  await page.evaluate(() => { window.__crossSheetBlock = true })
  await page.evaluate((e) => { window.__evByNumber = e }, evBy)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)                                        // Sheet1 开跑
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__setSheet('Sheet2'))    // 切走：Sheet1 后面的结果只能攒着
  await page.waitForTimeout(1500)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)                                        // Sheet2 开跑（活着的表不受影响）
  let final = await waitBatches(page, 90000)
  const crossMid = await page.evaluate(() => window.__SHIPTRACK_CROSS__ || {})
  const pendingMid = await page.evaluate(() => document.querySelectorAll('tr.pending').length)
  const bySheetMid = await page.evaluate(() => window.__writesBySheet || {})
  // 切回 Sheet1 → 自动补齐（不点按钮）
  await page.evaluate(() => window.__setSheet('Sheet1'))
  await page.waitForTimeout(3600)
  const bySheet = await page.evaluate(() => window.__writesBySheet || {})
  const grids = await page.evaluate(() => window.__grids)
  const auditA = checkSheet(bySheet.Sheet1, grids.Sheet1, 17, 18)
  const auditB = checkSheet(bySheet.Sheet2, grids.Sheet2, 17, 18)
  const pendingAfter = await page.evaluate(() => document.querySelectorAll('tr.pending').length)
  const ok = (crossMid.fail || 0) > 0 && auditA.bad.length === 0 && auditB.bad.length === 0
    && auditA.n >= N && auditB.n >= N && pendingAfter === 0
  pass('H27 (b) 现场：跨表写不可用 → 自动回落攒着，切回升效补齐', ok,
    `跨表写计数 ${JSON.stringify({ ok: crossMid.ok, fail: crossMid.fail })} · 切走期间待补行=${pendingMid}`
    + ` · 切回后 Sheet1 写入 ${auditA.n} 格 / Sheet2 ${auditB.n} 格 · 残留待补=${pendingAfter} · 串表/错位 ${auditA.bad.length + auditB.bad.length}`
    + `${[...auditA.bad, ...auditB.bad].slice(0, 3).join('；')}`)
  await ctx.close()
}

// ---------- H28 两批并发 + 中途来回切表 → 零错位、零串表 ----------
{
  const N = 6
  const gridA = { '1,17': 'MBL' }, gridB = { '1,17': 'MBL' }
  const evBy = {}
  for (let i = 0; i < N; i++) {
    const a = 'TEST-BL-8' + String(i + 1).padStart(3, '0')
    const b = 'TEST-BL-9' + String(i + 1).padStart(3, '0')
    gridA[`${i + 2},17`] = a
    gridB[`${i + 2},17`] = b
    evBy[a.replace(/-/g, '')] = [{ time: '2026-10-02T00:00:00Z', activity: 'Departure From', city: a.replace(/-/g, '') }]
    evBy[b.replace(/-/g, '')] = [{ time: '2026-10-03T00:00:00Z', activity: 'Departure From', city: b.replace(/-/g, '') }]
  }
  const { ctx, page } = await open({ sheets: [{ name: 'Sheet1', grid: gridA }, { name: 'Sheet2', grid: gridB }], lead: 1200, last: N + 1 })
  await page.evaluate((e) => { window.__evByNumber = e }, evBy)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__setSheet('Sheet2'))
  await page.waitForTimeout(1400)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  // 两批都在跑的时候来回切三次
  for (const sh of ['Sheet1', 'Sheet2', 'Sheet1', 'Sheet2']) {
    await page.waitForTimeout(700)
    await page.evaluate((s) => window.__setSheet(s), sh)
  }
  await waitBatches(page, 90000)
  await page.waitForTimeout(3600)          // 给自动补齐留时间
  const bySheet = await page.evaluate(() => window.__writesBySheet || {})
  const grids = await page.evaluate(() => window.__grids)
  const auditA = checkSheet(bySheet.Sheet1, grids.Sheet1, 17, 18)
  const auditB = checkSheet(bySheet.Sheet2, grids.Sheet2, 17, 18)
  const final = await page.evaluate(() => window.__SHIPTRACK_BATCHES__ || [])
  const ok = auditA.bad.length === 0 && auditB.bad.length === 0 && auditA.n >= N && auditB.n >= N
  pass('H28 两批并发 + 中途来回切表 → 零错位零串表', ok,
    `批次=${JSON.stringify(final.map((b) => [b.doc, b.state, b.done + '/' + b.total]))}`
    + ` · Sheet1 写入 ${auditA.n} 格 / Sheet2 ${auditB.n} 格 · 串表/错位 ${auditA.bad.length + auditB.bad.length}`
    + `${[...auditA.bad, ...auditB.bad].slice(0, 3).join('；')}`)
  await ctx.close()
}

// ---------- H29 同一张表两批 → 后写覆盖前写，无重复残留 ----------
{
  const N = 4
  const grid = { '1,17': 'MBL' }
  for (let i = 0; i < N; i++) grid[`${i + 2},17`] = 'TEST-BL-A' + String(i + 1).padStart(4, '0')
  const { ctx, page } = await open({ grid, lead: 1500, last: N + 1 })
  await page.evaluate(() => { window.__evKind = 'at_sea' })     // 第一批：QINGDAO（离港）
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await page.waitForTimeout(350)                                 // 第一批的 4 个请求已经在飞
  await page.evaluate(() => { window.__evKind = 'arrived' })      // 第二批：ISTANBUL（到港）
  await click(page, /再开一批/)                                   // 同一张表再开一批
  const final = await waitBatches(page, 90000)
  await page.waitForTimeout(600)
  const vals = await page.evaluate((n) => { const o = []; for (let r = 2; r <= n + 1; r++) o.push(String(window.__grid[`${r},18`] || '')); return o }, N)
  const wrote = await page.evaluate((n) => { const o = []; for (let r = 2; r <= n + 1; r++) o.push(String(window.__grid[`${r},17`] || '')); return o }, N)
  const allNew = vals.every((v) => /ISTANBUL/.test(v))
  const noOld = vals.every((v) => !/QINGDAO/.test(v))
  const identity = wrote.every((n, i) => n === 'TEST-BL-A' + String(i + 1).padStart(4, '0'))
  const two = final.filter((b) => b.doc === 'A.xlsx|Sheet1').length >= 2
  pass('H29 同表两批 → 后写覆盖前写、无重复残留', two && allNew && noOld && identity,
    `批次=${JSON.stringify(final.map((b) => [b.state, b.done + '/' + b.total]))} · 后一批结果全落表=${allNew}（应 true）`
    + ` · 旧值残留=${!noOld}（应 false）· 单号列未被改动=${identity}\n     写回内容=${JSON.stringify(vals.map((v) => v.slice(0, 28)))}`)
  await ctx.close()
}

// ---------- H30 失败隔离：一批造错，另一批仍然全部成功 ----------
{
  const N = 4
  const gridA = { '1,17': 'MBL' }, gridB = { '1,17': 'MBL' }
  for (let i = 0; i < N; i++) {
    gridA[`${i + 2},17`] = 'TEST-BL-C' + String(i + 1).padStart(4, '0')
    gridB[`${i + 2},17`] = 'TEST-BL-D' + String(i + 1).padStart(4, '0')
  }
  const { ctx, page } = await open({ sheets: [{ name: 'Sheet1', grid: gridA }, { name: 'Sheet2', grid: gridB }], lead: 300 })
  await page.evaluate(() => {
    // Sheet1 的号全部打挂（站点报错），Sheet2 正常
    window.__trackFail = {}
    for (let i = 0; i < 4; i++) window.__trackFail['TESTBLC000' + (i + 1)] = 'HTTP 500 站点错误'
  })
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  await page.waitForTimeout(200)
  await page.evaluate(() => window.__setSheet('Sheet2'))
  await page.waitForTimeout(1400)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)
  const final = await waitBatches(page, 60000)
  const grids = await page.evaluate(() => window.__grids)
  const aCol = [], bCol = []
  for (let r = 2; r <= N + 1; r++) { aCol.push(String(grids.Sheet1[`${r},18`] || '')); bCol.push(String(grids.Sheet2[`${r},18`] || '')) }
  const bAllOk = bCol.every((v) => /QINGDAO|ISTANBUL|离港|到港/.test(v))
  // 出错那批：写进去的只能是「失败：…」这类结论（不许出现成功文案），而且绝不能影响另一批
  const aNoSuccess = aCol.every((v) => !/QINGDAO|ISTANBUL|离港|到港/.test(v))
  const bySheet = await page.evaluate(() => window.__writesBySheet || {})
  const noCross = Object.entries(bySheet).every(([sh, list]) => list.every(([, , val]) => {
    if (sh === 'Sheet1') return !/TESTBLD\d{4}/.test(String(val))
    return !/TESTBLC\d{4}/.test(String(val))
  }))
  const bothDone = final.length >= 2 && final.every((b) => b.state === 'done')
  pass('H30 一批故意造错，另一批仍全部成功（失败隔离）', bothDone && bAllOk && aNoSuccess && noCross,
    `批次=${JSON.stringify(final.map((b) => [b.doc, b.state, b.done + '/' + b.total]))} · 出错表写入=${JSON.stringify(aCol.map((v) => v.slice(0, 14)))}（不许出现成功文案）· 正常表=${JSON.stringify(bCol.map((v) => v.slice(0, 20)))} · 串表=${!noCross}`)
  await ctx.close()
}

// ---------- H31 收尾写回：不再停在「97/97 · 剩约 0 秒」，写回有独立进度、主线程会还手 ----------
// 爹地 2026-10-29 真机截图：97 行查完，进度条停在「97/97 · 剩约 0 秒」，界面像卡住了。
// 判据（120 行大表 + 每格注入同步 COM 忙等，模拟真机主线程开销）：
//   ① 全程进度条文本从没出现「剩约 0 秒」
//   ② 收尾写回阶段真的出现过「写回 x/y」——这条只有主线程让出过才能在屏幕上画出来
//   ③ 页面心跳（20ms）最大间隔 < 400ms：写回不许独占主线程
//   ④ 跑完进度条消失，120 行全部按行身份写对
{
  const N = 120
  const grid = { '1,17': 'MBL' }
  const evBy = {}
  for (let i = 0; i < N; i++) {
    const n = 'TEST-BL-7' + String(i + 1).padStart(3, '0')
    grid[`${i + 2},17`] = n
    evBy[n.replace(/-/g, '')] = [{ time: '2026-10-05T00:00:00Z', activity: 'Departure From', city: n.replace(/-/g, '') }]
  }
  const { ctx, page } = await open({ grid, lead: 40, last: N + 1, comMs: 15 })
  await page.evaluate((e) => {
    window.__evByNumber = e
    window.__SHIPTRACK_WRITE_CHUNK__ = 3           // 段长压到 3 行：让「写回写到一半」这一步一定能被心跳采到
    // 心跳：10ms 一次，顺手记下当时的进度条文本 + 写回条数 + COM 次数
    window.__samples = []
    window.__hb = setInterval(() => {
      const el = document.querySelector('.bar-t')
      window.__samples.push({ t: performance.now(), bar: el ? el.innerText : '', wr: (window.__written || []).length, ops: window.__ops || 0 })
    }, 10)
  }, evBy)
  await page.evaluate(() => { window.__sel = { col: 17, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 18, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  // 让最后 10 条结果一起到：这样收尾这一次写回必然是 10 行（不是「碰巧只剩 2 行」），
  // 「写回写到一半」那一步才稳定可采，不靠运气。
  await page.evaluate(() => {
    const f = window.fetch
    window.fetch = (u, init) => {
      const m = /number=TEST-BL-7(\d{3})/.exec(String(u))
      const p = f(u, init)
      if (m && Number(m[1]) > 110) return new Promise((res) => setTimeout(() => res(p), 2500))
      return p
    }
  })
  await tryRun(page)
  const seenBar = []
  let sawWriteProg = false
  let sawZeroEta = false
  for (let i = 0; i < 900; i++) {
    const t = await page.evaluate(() => { const el = document.querySelector('.bar-t'); return el ? el.innerText : '' })
    if (t) {
      if (!seenBar.includes(t)) seenBar.push(t)
      if (/写回\s*\d+\/\d+/.test(t)) sawWriteProg = true
      if (/剩约\s*0\s*秒/.test(t)) sawZeroEta = true
    }
    const st = await page.evaluate(() => window.__SHIPTRACK_BATCHES__ || [])
    if (st.length && st.every((b) => b.state !== 'running' && b.state !== 'queued')) break
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(300)
  await page.evaluate(() => clearInterval(window.__hb))
  // 只看「收尾写回」这段窗口里主线程被独占多久（扫描/查询阶段的老开销不在这张卡的账上）
  const samples = await page.evaluate(() => window.__samples || [])
  let maxGap = 0, writeOps = 0
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    if (!/写回/.test(a.bar) && !/写回/.test(b.bar)) continue
    const g = b.t - a.t
    if (g > maxGap) { maxGap = g; writeOps = b.ops - a.ops }
  }
  const final = await waitBatches(page, 60000)
  const writeTexts = new Set(samples.filter((s) => /写回/.test(s.bar)).map((s) => s.bar))
  // 「写回 x/y，且 0 < x < y」= 写回写到一半时界面真的重绘过（这就是每 30 行让出主线程的直接证据）
  const midWrite = samples.some((s) => {
    const m = /写回\s*(\d+)\/(\d+)/.exec(s.bar)
    return m && Number(m[1]) > 0 && Number(m[1]) < Number(m[2])
  })
  const barGone = await page.evaluate(() => !document.querySelector('.bar'))
  const gridAfter = await page.evaluate(() => window.__grid);
  const written = await page.evaluate(() => window.__written || []);
  const audit = auditWrites(written, gridAfter, 17, 18)
  const done = final.filter((b) => b.state === 'done' && b.done === N && b.total === N)
  const ok = !sawZeroEta && sawWriteProg && maxGap > 0 && maxGap < 400 && barGone
    && midWrite && done.length === 1 && audit.bad.length === 0 && audit.n >= N
  pass('H31 收尾写回：没有「剩约 0 秒」+ 独立写回进度 + 写回不独占主线程（120 行）', ok,
    `出现「剩约 0 秒」=${sawZeroEta} · 采样到「写回 x/y」=${sawWriteProg}（写到一半重绘=${midWrite}）· 写回阶段心跳最大间隔 ${Math.round(maxGap)}ms（<400ms，区间内 COM ${writeOps} 次）`
    + ` · 跑完进度条消失=${barGone} · 批次=${JSON.stringify(final.map((b) => [b.state, b.done + '/' + b.total]))}`
    + ` · 写入 ${audit.n} 格/错位 ${audit.bad.length}${audit.bad.slice(0, 2).join('；')}`
    + `\n     写回进度采样：${[...writeTexts].slice(0, 8).join(' | ')}`)
  await ctx.close()
}

await browser.close()
srv.close()
const bad = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - bad.length}/${results.length} 通过`)
process.exit(bad.length ? 1 : 0)
