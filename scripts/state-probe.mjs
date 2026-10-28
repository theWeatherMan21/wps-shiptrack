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
  pass('H3 桥掉线提示 → 重连后自动消失', /没连上/.test(b1) && !/没连上/.test(b2), `断开时="${b1}" 重连后="${b2 || '(无)'}"`)
  await ctx.close()
}

// ---------- H4 运行时切表 → 不中止、不写错表、切回点「补齐回填」一次补完 ----------
{
  const { ctx, page } = await open({ lead: 3000 })
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
  // 切回原表 → 点补齐
  await page.evaluate((d) => { window.__doc = d }, doc0)
  await click(page, /补齐回填/)
  await page.waitForTimeout(800)
  const wrFlushed = await page.evaluate(() => window.__written.length)
  const stillPending = await page.evaluate(() => document.querySelectorAll('tr.pending').length)
  // 按钮不再是必经路径（0.9.39 起回原表全自动）：有按钮=还在等，没按钮但已补完=更理想
  const ok = (wrAfterSwitch - wrAtSwitch) <= 1 && wrSettled === wrAfterSwitch
    && (hasFlushBtn || stillPending === 0) && wrFlushed > wrAfterSwitch && stillPending === 0
  pass('H4 查询中切表 → 不中止、不写错表、切回补齐', ok,
    `切表前 ${wrAtSwitch} → 切表后 ${wrAfterSwitch}（允许 +1 在飞）→ 稳定后 ${wrSettled}（必须不动）→ 补齐后 ${wrFlushed} 格；按钮=${hasFlushBtn} 待补行=${pendingRows} 补完残留=${stillPending}`)
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

// ---------- H8 S/L 写了未接入船司（OOCL）→ 不发请求，直接给结论 ----------
{
  const grid = { '1,15': 'S/L', '1,16': 'MBL', '2,15': 'OOCL', '2,16': 'OOLU1234567890' }
  const { ctx, page } = await open({ grid })
  await page.evaluate(() => { window.__sel = { col: 16, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选单号列/)
  await page.evaluate(() => { window.__sel = { col: 19, row: 1, rows: 1048576, cols: 1 } })
  await click(page, /选输出列/)
  await tryRun(page)   // 0.9.23 起选完列不再自动开跑
  await waitIdle(page, 15000)
  const calls = await page.evaluate(() => window.__calls)
  const wrote = await page.evaluate(() => Object.entries(window.__grid).filter(([k]) => k.endsWith(',19')).map(([, v]) => v))
  const noTrack = !calls.some((u) => u.includes('/track?number=OOLU'))
  const msg = /暂未接入/.test(wrote.join(' '))
  pass('H8 未接入船司直接给结论', noTrack && msg, `未发 /track=${noTrack}；写入="${wrote.join(' | ')}"`)
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

await browser.close()
srv.close()
const bad = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - bad.length}/${results.length} 通过`)
process.exit(bad.length ? 1 : 0)
