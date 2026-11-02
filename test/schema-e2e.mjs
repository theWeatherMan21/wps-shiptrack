// 桥的契约接口端到端（真起进程、真 HTTP，不碰浏览器）
// 跑法：node test/schema-e2e.mjs
//
// 覆盖 DoD 里的「/health 能读到版本区间（curl 一条命令可见）」和「旧插件不会拿到字段」：
//   · /health → schemaVersion / minSchemaVersion / maxSchemaVersion / supportedSchemaVersions
//   · /track?schema=0（比桥旧）→ 降级桩：只有单号 + 一句人话，events/current/origin 一个都没有
//   · /track-batch?schema=0 → 每行都是降级桩
// 说明：这里**故意不跑**「schema=1 的真查询」——那会开 Chromium 抓船司官网，
// 静默红线（不许窗口出现在屏幕上）之外还会让这个测试依赖网络。真查询由桥的日常质检覆盖。
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT = Number(process.env.SCHEMA_E2E_PORT || 8799)
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

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiptrack-schema-e2e-'))
const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, WPS_TRACK_PORT: String(PORT), SSH_REPO, WPS_TRACK_CONFIG_DIR: cfgDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (b) => { log += b.toString() })
child.stderr.on('data', (b) => { log += b.toString() })

const cleanup = () => { try { child.kill('SIGTERM') } catch {} ; try { fs.rmSync(cfgDir, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)

// 等服务起来（最多 15s）
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

// ① /health：版本区间一条命令可见
{
  let h = null
  try { h = JSON.parse(up.body) } catch (e) { /* 下面判失败 */ }
  check('/health 返回 JSON', !!h, up.body.slice(0, 200))
  if (h) {
    check('/health schemaVersion = 1（与引擎同一来源）', h.schemaVersion === 1, JSON.stringify(h))
    check('/health minSchemaVersion = 1', h.minSchemaVersion === 1, JSON.stringify(h))
    check('/health maxSchemaVersion = 1', h.maxSchemaVersion === 1, JSON.stringify(h))
    check('/health supportedSchemaVersions = [1]', JSON.stringify(h.supportedSchemaVersions) === '[1]', JSON.stringify(h))
  }
}

// ② 比桥旧的插件 → 降级桩（一个业务字段都不给）
{
  const r = await get('/track?number=TEST123456&schema=0')
  let j = null
  try { j = JSON.parse(r.body) } catch (e) {}
  check('/track?schema=0 有响应', !!j, r.body.slice(0, 200))
  if (j) {
    check('降级桩 ok=false + schemaUnsupported=true', j.ok === false && j.schemaUnsupported === true, JSON.stringify(j))
    check('降级桩带回单号', j.number === 'TEST123456', JSON.stringify(j))
    check('降级桩话术：插件版本旧', /插件版本旧/.test(String(j.error || '')), JSON.stringify(j))
    check('降级桩不含任何业务字段', !('events' in j) && !('current' in j) && !('origin' in j) && !('destination' in j), JSON.stringify(j))
  }
  // 桥得把「谁旧」记进日志（事后定位用）
  check('日志记下插件契约版本', /插件契约 v0/.test(log), log.slice(-600))
}

// ③ 批量接口同样逐行降级
{
  const r = await get('/track-batch?numbers=A1,B2&schema=0')
  const lines = r.body.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
  check('/track-batch?schema=0 每单一行', lines.length === 2 && lines.every(Boolean), r.body.slice(0, 300))
  check('批量也是降级桩（无业务字段）', lines.every((x) => x && x.schemaUnsupported === true && !('events' in x)), r.body.slice(0, 300))
}

// ④ 老插件（不带 schema）不该被拦 —— 只记日志；其它接口一律照旧
{
  const r = await get('/config?doc=A.xlsx%7CSheet1')
  const j = (() => { try { return JSON.parse(r.body) } catch { return null } })()
  check('/config 不受契约影响（老插件照可用）', !!j && j.ok === true, r.body.slice(0, 200))
  const r2 = await get('/identify?number=TESTBL0001')
  const j2 = (() => { try { return JSON.parse(r2.body) } catch { return null } })()
  check('/identify 照常应答（单号原样回显）', !!j2 && j2.number === 'TESTBL0001', r2.body.slice(0, 200))
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`)
cleanup()
process.exit(bad === 0 ? 0 : 1)
