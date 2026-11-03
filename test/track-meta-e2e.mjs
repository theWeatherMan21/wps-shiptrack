// ★ 10-30 端到端：doc / sheet / row 从插件 URL 一路传到引擎，并且真的落进台账
//
// 为什么要这条：爹地看台账（~/.hermes/wps-shiptrack/jobs/*.ndjson）时 doc/sheet/row 全是空/0，
// 事后定位失败行只能靠内存里的 writeFailLog —— 而 /track 早就支持这三个参数。
// 纯函数单测能全绿、地板照样丢：**参数在路上丢**是这一层的专有 bug（同 canonical-e2e 的教训）。
//
// 跑：node test/track-meta-e2e.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${extra}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')
const REPO = path.resolve(ROOT, '..', 'ShipScheduleHub')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'track-meta-'))
const FAKE = path.join(TMP, 'fake-cli.mjs')
const ARGV_FILE = path.join(TMP, 'argv.json')
const JOBS_DIR = path.join(TMP, 'jobs')

// 假 CLI：不联网，但用**真的台账写入器**（引擎的 journal.mjs）落一行 —— 这样断言的是
// 「台账里到底有没有行号」，而不是「我们记得传了」。
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
import { journalJob } from ${JSON.stringify(path.join(REPO, 'engine/tracking/journal.mjs'))};
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(ARGV_FILE)}, JSON.stringify(argv));
const gi = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
const r = { ok: true, carrier: 'hapag', number: gi('--number'), events: [], canonical: { shortText: 'AAU · 在途 · NINGBO' } };
journalJob(r, { ms: 1, cached: false, doc: gi('--doc') || '', sheet: gi('--sheet') || '', row: Number(gi('--row')) || 0 });
process.stdout.write(JSON.stringify({ type: 'track-result', ...r }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'track-exit', ok: true, ms: 1 }) + '\\n');
`.trim())

const port = 8812
const br = spawn(process.execPath, [path.join(ROOT, 'bridge/server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, WPS_TRACK_PORT: String(port), WPS_TRACK_CLI: FAKE, WPS_JOBS_DIR: JOBS_DIR, WPS_TRACK_LEDGER_DIR: path.join(TMP, 'ledger') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
br.stdout.on('data', () => {})
br.stderr.on('data', () => {})

const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true } catch (e) {}
    await sleep(150)
  }
  return false
}
const readArgs = () => { try { return JSON.parse(fs.readFileSync(ARGV_FILE, 'utf8')) } catch (e) { return null } }
const readJournal = () => {
  const f = fs.readdirSync(JOBS_DIR)[0]
  return fs.readFileSync(path.join(JOBS_DIR, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}
const track = (qs) => fetch(`http://127.0.0.1:${port}/track?${qs}`).then((r) => r.json())

try {
  ok(await waitUp(), '临时桥起来了')

  console.log('① doc/sheet/row 一路传到引擎 CLI')
  {
    try { fs.unlinkSync(ARGV_FILE) } catch (e) {}
    const r = await track('number=ZZTEST0001&schema=1&doc=' + encodeURIComponent('报价表2026.xlsx') + '&sheet=' + encodeURIComponent('价格') + '&row=12')
    ok(r && r.ok === true, '/track 正常返回', JSON.stringify(r).slice(0, 120))
    const argv = readArgs() || []
    const gi = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
    ok(gi('--doc') === '报价表2026.xlsx', '--doc 到了引擎（中文/空格不被改形）', String(gi('--doc')))
    ok(gi('--sheet') === '价格', '--sheet 到了引擎', String(gi('--sheet')))
    ok(gi('--row') === '12', '--row 到了引擎', String(gi('--row')))

    console.log('② 台账（journal）里真的有这张表这一行')
    const lines = readJournal()
    const rec = lines[lines.length - 1]
    ok(rec && rec.doc === '报价表2026.xlsx', '台账 doc = 报价表2026.xlsx', JSON.stringify(rec && rec.doc))
    ok(rec && rec.sheet === '价格', '台账 sheet = 价格', JSON.stringify(rec && rec.sheet))
    ok(rec && rec.row === 12, '台账 row = 12（数字，不是 "12" 也不是 0）', JSON.stringify(rec && rec.row))
  }

  console.log('③ 老插件不带这三个参数时照旧能查（只是台账留空，不许因此报错）')
  {
    try { fs.unlinkSync(ARGV_FILE) } catch (e) {}
    const r = await track('number=ZZTEST0002&schema=1')
    ok(r && r.ok === true, '不带 doc/sheet/row 也能查', JSON.stringify(r).slice(0, 120))
    const argv = readArgs() || []
    ok(!argv.includes('--doc') && !argv.includes('--row'), '没传就不往 CLI 塞空参数', JSON.stringify(argv))
    const lines = readJournal()
    const rec = lines[lines.length - 1]
    ok(rec && rec.doc === '' && rec.row === 0, '台账仍是空/0（兼容老插件）', JSON.stringify({ doc: rec && rec.doc, row: rec && rec.row }))
  }
} finally {
  try { br.kill('SIGKILL') } catch (e) {}
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
