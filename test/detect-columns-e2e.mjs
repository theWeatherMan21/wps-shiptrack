// 桥 /detect-columns 端到端（真起进程、真 HTTP；不开浏览器、不碰网络）
// 跑法：node test/detect-columns-e2e.mjs
//
// 验的三件事：
//   ① 插件读出来的样本矩阵 → HTTP → 桥 → 识别结果（列号 1-based，跟 TaskPane 的 cfg 对齐）
//   ② 识别用的规则库真的是桥侧的 engine/tracking/identify.mjs（ruleSource 明说，不是插件猜的）
//   ③ 脏入参（空 rows / 非法 JSON / 超大 body）不许把桥搞挂
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT = Number(process.env.DETECT_E2E_PORT || 8797)
const SSH_REPO = process.env.SSH_REPO || path.resolve(os.homedir(), 'Documents', 'trae_projects', 'ShipScheduleHub')

let bad = 0
const check = (name, cond, detail = '') => {
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ← ' + detail}`)
}

const get = (p) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (res) => {
    let b = ''
    res.on('data', (c) => { b += c })
    res.on('end', () => resolve({ status: res.statusCode, body: b }))
  })
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }) })
  req.on('error', () => resolve({ status: 0, body: '' }))
})

const post = (p, obj, raw = null) => new Promise((resolve) => {
  const body = raw != null ? raw : JSON.stringify(obj)
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', timeout: 8000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let b = ''
    res.on('data', (c) => { b += c })
    res.on('end', () => resolve({ status: res.statusCode, body: b }))
  })
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }) })
  req.on('error', () => resolve({ status: 0, body: '' }))
  req.write(body)
  req.end()
})

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiptrack-detect-e2e-'))
const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, WPS_TRACK_PORT: String(PORT), SSH_REPO, WPS_TRACK_CONFIG_DIR: cfgDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (b) => { log += b.toString() })
child.stderr.on('data', (b) => { log += b.toString() })
const cleanup = () => { try { child.kill('SIGTERM') } catch (e) {} ; try { fs.rmSync(cfgDir, { recursive: true, force: true }) } catch (e) {} }
process.on('exit', cleanup)

let up = null
for (let i = 0; i < 60; i++) {
  const r = await get('/health')
  if (r.status === 200) { up = r; break }
  await new Promise((s) => setTimeout(s, 250))
}
if (!up) {
  console.log('FAIL  桥没起来（15s）——日志：\n' + log.slice(-1500))
  process.exit(1)
}
check('/health 起来了', !!up && up.body.includes('wps-shiptrack-bridge'))

// ① 标准样本：中文表头 + 单号 B 列 + 船名航次同格 + 右侧空列 K
const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'detect', '01-header-zh-single-vv.json'), 'utf8'))
const r1 = await post('/detect-columns', { rows: fx.rows, sheet: fx.sheet })
let j1 = null
try { j1 = JSON.parse(r1.body) } catch (e) {}
check('POST /detect-columns 返回 200', r1.status === 200, `status=${r1.status}`)
check('识别出单号列 = B(2)', j1 && j1.numberCol === 2, JSON.stringify(j1 && { n: j1.numberCol, o: j1.outCol }))
check('识别出输出列 = K(11)', j1 && j1.outCol === 11, String(j1 && j1.outCol))
check('识别出船名航次同格', j1 && j1.vesselMode === 'single' && j1.vesselCol === 6, JSON.stringify(j1 && { v: j1.vesselCol, m: j1.vesselMode }))
check('置信度 >= 0.8 → 直接写档', j1 && j1.confidence >= 0.8 && j1.tier === 'auto', `${j1 && j1.confidence}/${j1 && j1.tier}`)
check('规则库来自 engine/tracking/identify.mjs', j1 && String(j1.ruleSource).includes('identify'), String(j1 && j1.ruleSource))
check('表名原样回显', j1 && j1.sheet === fx.sheet, String(j1 && j1.sheet))
check('reason 是人话', j1 && typeof j1.reason === 'string' && j1.reason.length > 6, String(j1 && j1.reason))

// ② 中置信样本：没有表头 → 首次预览档
const fx10 = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'detect', '10-no-header-content-only.json'), 'utf8'))
const r2 = await post('/detect-columns', { rows: fx10.rows, sheet: fx10.sheet })
let j2 = null
try { j2 = JSON.parse(r2.body) } catch (e) {}
check('无表头样本 → tier=preview（首次预览，不静默写）', j2 && j2.tier === 'preview', `${j2 && j2.confidence}/${j2 && j2.tier}`)
check('无表头样本仍认出单号列 B(2)', j2 && j2.numberCol === 2, String(j2 && j2.numberCol))

// ③ 脏入参不许升级成 500 / 崩
const r3 = await post('/detect-columns', {})
check('空 rows → 400 且桥不崩', r3.status === 400, `status=${r3.status}`)
const r4 = await post('/detect-columns', null, 'not-json{')
check('非法 JSON → 200 + ok:false（业务失败不占 5xx）', r4.status === 200 && r4.body.includes('"ok":false'), `status=${r4.status} body=${r4.body.slice(0, 80)}`)
const r5 = await post('/detect-columns', null, JSON.stringify({ rows: [['x'.repeat(100)]], pad: 'y'.repeat(1100 * 1024) }))
check('超大 body → 413', r5.status === 413 || r5.status === 0, `status=${r5.status}`)

// ④ 崩了也要能再服务（同一进程连续调用）
const r6 = await post('/detect-columns', { rows: fx.rows, sheet: 'again' })
check('脏入参之后仍然正常工作', r6.status === 200 && r6.body.includes('"ok":true'), `status=${r6.status}`)

// ⑤ 不阻塞：两个请求并发都回
const [a, b] = await Promise.all([
  post('/detect-columns', { rows: fx.rows, sheet: 'p1' }),
  post('/detect-columns', { rows: fx.rows, sheet: 'p2' }),
])
check('两个请求并发都返回', a.status === 200 && b.status === 200, `${a.status}/${b.status}`)

console.log(bad ? `\n${bad} FAILED` : '\nALL PASS')
child.kill('SIGTERM')
process.exit(bad ? 1 : 0)
