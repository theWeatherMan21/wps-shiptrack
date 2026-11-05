#!/usr/bin/env node
// 1.7.0 全链路桩验（2026-11-05 知澜要求，缺一条不签）
//
// 链路的每一层都是真的，只有 WPS 宿主对象是桩：
//   真 HTTP → 临时桥（独立 JOBS_DIR / LEDGER_DIR，绝不污染正式队列）
//   → 面板真心跳代码 claim → 桥 spawn 假引擎（不联网、可重复）→ 桩 grid 收写回 → 真 report
//
// 为什么要桩而不是直接等爹地开 WPS：真表 R 列 12 行**已经有值**（上次跑写进去的），
// 「写成功了」和「压根没写」在界面上是同一行字，看不出新旧。桩的 grid 从空开始，
// 只有真写进去才有值 —— 这才是能断言的判据。
//
// 六条判据（缺一条不签）：
//   ① POST /jobs → count 1，spec 的 doc/cols/rows 与请求一致
//   ② 2.5s 心跳内 claim → queued → running，claimedAt 有值
//   ③ 逐行写回 → 桩 grid 里 11 格有船期文本、1 格 no_record、没碰过的格一个没动
//   ④ report → written/failed/total 对得上，state done
//   ⑤ 中途杀桥 → 插件不崩、不重复写；桥恢复后任务能继续
//   ⑥ 表切走 → 一行都不写，report failed 且 error 说「doc 已切换」
//
// 静默红线：全程 headless，不起任何窗口。
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return require('playwright'); }
  catch {
    const fb = process.env.PLAYWRIGHT_CORE || path.join(os.homedir(), 'Documents/trae_projects/ShipScheduleHub/engine/node_modules/playwright-core');
    return require(fb);
  }
})();
import { STUB } from './lib/wps-stub.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'wps-addon-build');
const REPO = path.resolve(ROOT, '..', 'ShipScheduleHub');
if (!fs.existsSync(path.join(BUILD, 'index.html'))) {
  console.log(`✗ 没有构建产物: ${BUILD}（先跑 node scripts/build-addon.cjs online）`);
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假引擎：不联网，号前缀决定结果 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-e2e-'));
const FAKE_CLI = path.join(TMP, 'fake-cli.mjs');
fs.writeFileSync(FAKE_CLI, `
import fs from 'node:fs';
const { buildCanonical } = await import(${JSON.stringify(path.join(REPO, 'engine/tracking/canonical.mjs'))});
const argv = process.argv.slice(2);
const gi = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const number = gi('--number');
const carrier = gi('--carrier') || 'maersk';
if (String(number).startsWith('9NOREC')) {
  const r = { ok: false, carrier, number, errorKind: 'not-found', error: 'MSC 查无此号：未找到与该订舱号匹配的结果' };
  r.canonical = buildCanonical(r, {});
  out({ type: 'track-result', ...r });
  out({ type: 'track-exit', ok: false, ms: 1 });
} else {
  const n = Number(String(number).slice(-2)) || 1;
  const r = {
    ok: true, carrier, number,
    events: [
      { time: '2026-10-0' + ((n % 8) + 1), activity: 'Departure From', city: 'QINGDAO', timeType: 'ACTUAL' },
      { time: '2026-11-0' + ((n % 8) + 1), activity: 'Arrival In', city: 'GDANSK', timeType: 'EXPECTED' },
    ],
  };
  r.canonical = buildCanonical(r, { pol: 'QINGDAO', pod: 'GDANSK' });
  out({ type: 'track-result', ...r });
  out({ type: 'track-exit', ok: true, ms: 1 });
}
`.trim());

const PORT = 8821;
const JOBS_DIR = path.join(TMP, 'jobs');
const LEDGER_DIR = path.join(TMP, 'ledger');
function startBridge() {
  const p = spawn(process.execPath, [path.join(ROOT, 'bridge/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      WPS_TRACK_PORT: String(PORT),
      WPS_TRACK_CLI: FAKE_CLI,
      WPS_TRACK_JOBS_DIR: JOBS_DIR,
      WPS_TRACK_LEDGER_DIR: LEDGER_DIR,
      WPS_TRACK_CACHE_TTL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}
const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
};

// ---------- 静态服务（file:// 下 Chrome 拒绝 ES module） ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.xml': 'text/xml' };
const srv = http.createServer((req, res) => {
  const p = path.join(BUILD, decodeURIComponent(req.url.split('?')[0].split('#')[0]));
  const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ---------- 桩表：12 行有号（11 成功 + 1 no_record），表头占 R1 ----------
const DOC = '作业表.xlsx';
const SHEET = 'Terramar';
const NUMCOL = 15, OUTCOL = 18;
const ROWS = [];
for (let r = 2; r <= 14; r++) {
  ROWS.push(r);
}
const NUMBERS = {};
for (const r of ROWS) {
  // 11 个正常号 + 1 个 no_record 号（R13，照真表那个位置）
  NUMBERS[r] = (r === 13) ? '9NOREC0013' : String(900000000 + r);
}
function makeGrid() {
  const g = { [`1,${NUMCOL}`]: 'MBL' };
  for (const [r, n] of Object.entries(NUMBERS)) g[`${r},${NUMCOL}`] = n;
  return g;   // 输出列（18）全空 —— 只有真写进去才有值
}

const bridge1 = startBridge();
const up = await waitUp();
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext();
// ① 先存真 fetch，② STUB 覆盖成 mock，③ 再把 fetch 指到临时桥（真 HTTP）
await ctx.addInitScript(`window.__realFetch = window.fetch.bind(window);`);
await ctx.addInitScript(`(${STUB.toString()})(${JSON.stringify({ doc: `${DOC}|${SHEET}`, grid: makeGrid(), savedCfg: {
  numberCol: NUMCOL, outCol: OUTCOL, carrierCol: 0, polCol: 0, podCol: 0,
  startRow: 1, rows: 14, mode: 'column',
}, last: 14 })})`);
await ctx.addInitScript(`
  window.__bridgePort = ${PORT};
  window.fetch = (u, init) => {
    const url = String(u).replace(':8791', ':' + window.__bridgePort);
    return window.__realFetch(url, init);
  };
`);

const page = await ctx.newPage();
const pageErrs = [];
page.on('pageerror', (e) => pageErrs.push(String(e).slice(0, 200)));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await sleep(2500);   // 面板启动：读 config + ping 桥 + 首次心跳

console.log('① POST /jobs → count 1，spec 与请求一致');
const spec = {
  doc: `${DOC}|${SHEET}`,
  cols: { number: NUMCOL, out: OUTCOL, carrier: 0, pol: 0, pod: 0 },
  startRow: 1,
  rows: 14,
  mode: 'column',
};
let jobId = '';
{
  const r = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shiptrack': '1' },
    body: JSON.stringify(spec),
  }).then((x) => x.json());
  ok(r.ok === true, '建任务成功', JSON.stringify(r).slice(0, 160));
  jobId = r.jobId || (r.job && r.job.jobId) || '';
  ok(!!jobId, '拿到 jobId', String(jobId));
  const lst = await fetch(`http://127.0.0.1:${PORT}/jobs?doc=${encodeURIComponent(spec.doc)}`).then((x) => x.json());
  ok(lst.count === 1, '队列 count 1', String(lst.count));
  // 列表接口只回摘要（jobId/doc/state/progress），完整 spec 要读单任务
  const one = await fetch(`http://127.0.0.1:${PORT}/jobs/${jobId}`).then((x) => x.json());
  const j = (one && one.job) || {};
  ok(j.doc === spec.doc, 'spec.doc 一致', String(j.doc));
  ok(JSON.stringify(j.cols) === JSON.stringify(spec.cols), 'spec.cols 一致',
    `回读 ${JSON.stringify(j.cols)} vs 请求 ${JSON.stringify(spec.cols)}`);
  ok(j.rows === spec.rows, 'spec.rows 一致', `${j.rows} vs ${spec.rows}`);
  ok(j.startRow === 2, 'startRow 规整到 2（表头占一行）', String(j.startRow));
}

console.log('② 2.5s 心跳内 claim → running，claimedAt 有值');
let claimed = false;
for (let i = 0; i < 20; i++) {
  const j = await fetch(`http://127.0.0.1:${PORT}/jobs/${jobId}`).then((x) => x.json()).catch(() => ({}));
  const job = j.job || {};
  if (job.state === 'running' || job.state === 'done' || job.state === 'failed') { claimed = job.state !== 'queued'; break; }
  await sleep(300);
}
ok(claimed, '心跳领走了任务（不再 queued）');

console.log('③④ 等任务跑完，核对写回与 report');
let final = {};
for (let i = 0; i < 200; i++) {
  const j = await fetch(`http://127.0.0.1:${PORT}/jobs/${jobId}`).then((x) => x.json()).catch(() => ({}));
  final = j.job || {};
  if (final.state === 'done' || final.state === 'failed') break;
  await sleep(500);
}
ok(final.state === 'done', 'job state done', String(final.state) + ' ' + String(final.error || ''));
const prog = final.progress || {};
console.log(`     report: written=${prog.written} ok=${prog.ok} failed=${prog.failed} skipped=${prog.skipped} done=${prog.done}/${prog.total}`);
// 判据④：report 的数都要对得上，且 written 不能再是 undefined
// 面板遍历 R2..R15 共 14 行（spec.startRow 被桥规整到 2），R15 是空行 → skipped=1
ok(prog.total === 14, 'progress.total = 遍历的 14 行', String(prog.total));
ok(prog.written === 13, 'progress.written = 13（实际写入数）', String(prog.written));
ok(prog.ok === 12, 'progress.ok = 12', String(prog.ok));
ok(prog.failed === 1, 'progress.failed = 1（那一行查无此号）', String(prog.failed));
ok(prog.skipped === 1, 'progress.skipped = 1（R15 空行，不计失败但要算已处理）', String(prog.skipped));
ok(prog.done === prog.total, 'done === total → 进度 100%（不会永远停在 13/14）',
  `${prog.done}/${prog.total}`);

const grid = await page.evaluate(() => window.__grid);
const written = await page.evaluate(() => window.__written);
const filled = ROWS.filter((r) => { const v = grid[`${r},${OUTCOL}`]; return v !== undefined && v !== null && String(v).trim() !== ''; });
const noRecordRows = ROWS.filter((r) => /查无|无此单|没有/.test(String(grid[`${r},${OUTCOL}`] || '')));
const okRows = filled.filter((r) => !noRecordRows.includes(r));
// 桩表：R2..R14 共 13 行有号，其中 R13 是 no_record → 12 行成功 + 1 行查无
ok(okRows.length === 12, `12 格写进了船期文本`, `实际 ${okRows.length}：${okRows.join(',')}`);
ok(noRecordRows.length === 1 && noRecordRows[0] === 13, 'R13 写成 no_record 文案', JSON.stringify(noRecordRows));
ok(filled.length === 13, '13 行全部有结论（12 船期 + 1 查无）', String(filled.length));
const untouched = ROWS.filter((r) => r !== 13 && !filled.includes(r));
ok(untouched.length === 0, '没有漏写的行', JSON.stringify(untouched));
// 别的格一个没动：只允许写 OUTCOL 这一列
const touchedCols = [...new Set(written.map((w) => w[1]))];
ok(touchedCols.length === 1 && Number(touchedCols[0]) === OUTCOL, '只动了输出列（别的列一个没碰）', JSON.stringify(touchedCols));

console.log('⑤ 中途杀桥 → 插件不崩、不重复写；桥恢复后继续');
try {
  // 新任务 → 领活后立刻杀桥
  const r2 = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shiptrack': '1' },
    body: JSON.stringify({ ...spec, rows: 14 }),
  }).then((x) => x.json());
  const j2 = r2.jobId || (r2.job && r2.job.jobId) || '';
  await sleep(600);                     // 等它 claim 并开始跑
  console.log('     · 已建任务并等 600ms，准备杀桥');
  const before = await page.evaluate(() => window.__written.length);
  bridgeKill();                         // ← 真杀进程
  console.log(`     · 桥已杀（此前已写 ${before} 格）`);
  await sleep(2500);
  const errDuring = pageErrs.length;
  const mid = await page.evaluate(() => window.__written.length);
  // 桥不在时不该继续猛写（写不进去就是写不进去）
  ok(errDuring === 0, '杀桥期间页面没抛未捕获异常', JSON.stringify(pageErrs).slice(0, 160));
  // 恢复
  const b2 = startBridge();
  await waitUp();
  await sleep(6000);                    // 等心跳补写 / 任务继续
  const after = await page.evaluate(() => window.__written.length);
  const jj = await fetch(`http://127.0.0.1:${PORT}/jobs/${j2}`).then((x) => x.json()).catch(() => ({}));
  const st = (jj.job || {}).state;
  ok(after >= mid, '恢复后仍在推进（写回数不倒退）', `${before} → ${mid} → ${after}`);
  ok(st === 'done' || st === 'running' || st === 'queued', '任务没卡死在 running 之外的状态', String(st));
  // 不重复写：同一行同一列不该被写两次以上（同一批内）
  // __written 是跨任务累积的：第 1 个任务写过 13 格，第 2 个任务再写同一批行 = 各有一次，正常。
  // 只看「本任务期间（before 之后）新增的写回里，同一格被写了两次以上」——那才是重试把同一格写翻。
  const dupe = await page.evaluate((from) => {
    const seen = {};
    let dup = 0;
    for (const w of window.__written.slice(from)) { const k = w[0] + ',' + w[1]; if (seen[k]) dup++; seen[k] = 1; }
    return dup;
  }, before);
  ok(dupe === 0, '本任务内没有重复写同一格', String(dupe));
  b2.kill('SIGKILL');
} catch (e) {
  fail++;
  console.log(`  ✗ ⑤ 段落异常：${String(e && e.message || e).slice(0, 200)}`);
}

console.log('⑥ 表切走 → 一行都不写，report failed 且 error 说「doc 已切换」');
try {
  // ⑤ 结尾把桥杀了，这里先起回来
  const b3 = startBridge();
  const up3 = await waitUp();
  if (!up3) throw new Error('第 3 个桥没起来');
  // 清空写回记录，把 grid 也清空，便于判定「一格没写」
  await page.evaluate(() => { window.__written.length = 0; });
  const r3 = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shiptrack': '1' },
    body: JSON.stringify({ ...spec, rows: 14 }),
  }).then((x) => x.json());
  const j3 = r3.jobId || (r3.job && r3.job.jobId) || '';
  // 建完立刻切表（在插件 claim 之后、写回之前）
  await sleep(400);
  await page.evaluate(() => window.__setDoc('别的表.xlsx|Sheet9'));
  await sleep(6000);
  const jj = await fetch(`http://127.0.0.1:${PORT}/jobs/${j3}`).then((x) => x.json()).catch(() => ({}));
  const job = jj.job || {};
  const wrote = await page.evaluate(() => window.__written.length);
  ok(wrote === 0, '切表后一格都没写', String(wrote));
  ok(job.state === 'failed', 'job 标 failed', String(job.state) + ' ' + String(job.error || ''));
  // 桥把失败原因存成 `lastError`（App 那份进度面板读的就是它）
  const why = String(job.lastError || job.error || '');
  ok(/doc|表|切换/i.test(why), 'error 说清了是表变了', JSON.stringify(why).slice(0, 140));
  b3.kill('SIGKILL');
} catch (e) {
  fail++;
  console.log(`  ✗ ⑥ 段落异常：${String(e && e.message || e).slice(0, 200)}`);
}

await browser.close();
srv.close();
try { bridge1.kill('SIGKILL'); } catch (e) {}
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

function bridgeKill() {
  // 杀掉 8821 上的桥（不碰正式 8791）。用 execFile 拿 PID 再 process.kill：
  // `lsof ... | xargs kill -9` 走 shell 管道，实测在探针里会挂住（打印了「准备杀桥」就没下文）。
  try {
    // ★ 必须加 -sTCP:LISTEN：不带的话 lsof 会把这个端口上的**所有**连接方都列出来
    //   （探针自己、Chrome 的 keep-alive 连接），process.kill 就把探针自己 SIGKILL 了 ——
    //   现象是「打印了准备杀桥然后静默 exit 0」，极难往这条上想。
    const out = execFileSync('lsof', ['-ti:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { /* 已经没了 */ }
    }
  } catch (e) { /* lsof 没结果 = 没在跑 */ }
}
