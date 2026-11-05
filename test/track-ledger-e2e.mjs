// 端到端：真实 /track 带 doc/sheet/row → 账本里必须真有这行（2026-11-05 知澜要求）
//
// 为什么要有这条：M2 的账本曾经整整一层空转 —— 单测 33/33、ledger-e2e 13/13 全绿，
// 但插件和 App 全走单号 `/track`，而账本只由 `/track-batch` 写，于是 `/pending` 永远 count 0。
// **纯函数全绿 + 端到端自测全绿，仍然可以是死链路**：自测自己造数据喂自己，测不出「真实入口有没有写」。
// 所以这条测试**不直接调 Ledger、不直接调 /track-batch**，一律从 `/track` 这个真实入口打进去，
// 再去读落盘文件 —— 谁把 /track 的落账删了，这条立刻红。
//
// 不联网、不用真单号：靠 WPS_TRACK_CLI 指向假引擎（number 以 FAIL 开头的返回失败）。
//
// 用法：node test/track-ledger-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const FAKE = path.join(os.tmpdir(), 'fake-cli-ledger.mjs');
const LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'track-ledger-'));

// 假引擎：不发网络请求，靠号码前缀决定成功/失败
fs.writeFileSync(FAKE, `
const argv = process.argv.slice(2);
const gi = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const number = gi('--number');
const carrier = gi('--carrier') || 'maersk';
if (String(number).startsWith('FAIL')) {
  out({ type: 'track-result', ok: false, carrier, number, errorKind: 'failed', error: '假引擎：故意失败' });
  out({ type: 'track-exit', ok: false, ms: 1 });
} else {
  out({ type: 'track-result', ok: true, carrier, number, events: [{ time: '2026-10-25', activity: 'Arrival At', city: 'GDANSK' }] });
  out({ type: 'track-exit', ok: true, ms: 1 });
}
`.trim());

const PORT = 8813;
function startBridge() {
  const p = spawn(process.execPath, [path.join(ROOT, 'bridge/server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, WPS_TRACK_PORT: String(PORT), WPS_TRACK_CLI: FAKE, WPS_TRACK_LEDGER_DIR: LEDGER_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  return p;
}
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
};
const track = async (q) => (await fetch(`http://127.0.0.1:${PORT}/track?${q}`)).json();
const ledgerFiles = () => { try { return fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.ndjson')); } catch (e) { return []; } };
const readLedger = (f) => {
  try { return fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { return []; }
};

const br = startBridge();
const up = await waitUp();
console.log('① 临时桥起来了（真 /track 入口 + 假引擎 + 独立账本目录）');
ok(up, '桥 /health 通');
if (!up) { br.kill('SIGKILL'); process.exit(1); }

const DOC = '端到端表.xlsx', SHEET = 'S1';
const Q = (extra) => `carrier=maersk&timeout=8000&doc=${encodeURIComponent(DOC)}&sheet=${encodeURIComponent(SHEET)}${extra}`;

console.log('② 成功行：/track 带 doc → 账本里有这行，kind=null');
{
  const r = await track(`number=PASS000001&row=7&${Q('')}`);
  ok(r.ok === true, '/track 返回成功', JSON.stringify(r).slice(0, 120));
  await sleep(250);
  const files = ledgerFiles();
  ok(files.length === 1, '账本目录生成了 1 个文件', JSON.stringify(files));
  const recs = readLedger(files[0] || '');
  const rec = recs.find((x) => x.number === 'PASS000001');
  ok(!!rec, '账本里有 PASS000001 这一行', JSON.stringify(recs.map((x) => x.number)));
  ok(rec && rec.kind === null, '成功行 kind=null（不进重查队列）', JSON.stringify(rec && rec.kind));
  ok(rec && rec.doc === DOC && rec.sheet === SHEET && rec.row === 7, 'doc/sheet/row 都落对了', JSON.stringify(rec));
  ok(rec && rec.key === `${DOC}|${SHEET}|7|PASS000001`, 'key = doc|sheet|row|number', String(rec && rec.key));
}

console.log('③ 失败行：/track 带 doc → /pending 立刻能拿到（这是 M2 空转的那一环）');
{
  const r = await track(`number=FAIL000002&row=9&${Q('')}`);
  ok(r.ok === false, '/track 返回失败', JSON.stringify(r).slice(0, 120));
  await sleep(250);
  const j = await (await fetch(`http://127.0.0.1:${PORT}/pending?doc=${encodeURIComponent(`${DOC}|${SHEET}`)}`)).json();
  ok(j.count === 1, '/pending count=1（只有失败那行）', String(j.count));
  const row = (j.rows || [])[0] || {};
  ok(row.number === 'FAIL000002', '拿到的就是刚失败的那个号', String(row.number));
  ok(row.doc === DOC && row.sheet === SHEET && row.row === 9, 'doc/sheet/row 一并带回来', JSON.stringify(row));
  ok(!!row.kind, 'kind 有值（可判断失败类型）', String(row.kind));
}

console.log('④ 成功行不该被当待补（上一步只 1 条，再补一条成功的仍要是 1）');
{
  await track(`number=PASS000003&row=11&${Q('')}`);
  await sleep(250);
  const j = await (await fetch(`http://127.0.0.1:${PORT}/pending?doc=${encodeURIComponent(`${DOC}|${SHEET}`)}`)).json();
  ok(j.count === 1, '成功行没进队列', String(j.count));
}

console.log('⑤ 裸调用（不带 doc）不落账 —— 手动 curl 不污染业务账本');
{
  const before = ledgerFiles().length;
  await track('number=PASS000009&carrier=maersk&timeout=8000');
  await sleep(250);
  const all = ledgerFiles().flatMap(readLedger);
  ok(!all.some((r) => r.number === 'PASS000009'), '不带 doc 的查询没写账本');
  ok(ledgerFiles().length === before, '没多出文件', JSON.stringify(ledgerFiles()));
}

console.log('⑥ /track 和 /track-batch 写同一个 key（两条入口不能分账）');
{
  const rows = JSON.stringify([{ number: 'FAIL000010', doc: DOC, sheet: SHEET, row: 12 }]);
  await fetch(`http://127.0.0.1:${PORT}/track-batch?doc=${encodeURIComponent(`${DOC}|${SHEET}`)}&numbers=FAIL000010&rows=${encodeURIComponent(rows)}&timeout=8000`);
  await sleep(300);
  const j = await (await fetch(`http://127.0.0.1:${PORT}/pending?doc=${encodeURIComponent(`${DOC}|${SHEET}`)}`)).json();
  ok(j.count === 2, 'batch 的失败行也进了同一本账（1+1=2）', String(j.count));
}

console.log('⑦ /pending 与 /ledger/clear 认「工作簿」+「工作表」分开传');
{
  const onlyDoc = await (await fetch(`http://127.0.0.1:${PORT}/pending?doc=${encodeURIComponent(DOC)}`)).json();
  ok(onlyDoc.count === 0, '只给工作簿名 → 0（账本 key 是 工作簿|工作表）', String(onlyDoc.count));
  const withSheet = await (await fetch(`http://127.0.0.1:${PORT}/pending?doc=${encodeURIComponent(DOC)}&sheet=${encodeURIComponent(SHEET)}`)).json();
  ok(withSheet.count === 2, '补上 sheet 就查到 2 条', String(withSheet.count));
  const cl = await (await fetch(`http://127.0.0.1:${PORT}/ledger/clear?doc=${encodeURIComponent(DOC)}&sheet=${encodeURIComponent(SHEET)}`)).json();
  ok(cl.doc === `${DOC}|${SHEET}`, 'clear 也按拼好的 key 清', String(cl.doc));
  const after = await (await fetch(`http://127.0.0.1:${PORT}/pending?doc=${encodeURIComponent(`${DOC}|${SHEET}`)}`)).json();
  ok(after.count === 0, '清完归零', String(after.count));
}

br.kill('SIGKILL');
fs.rmSync(LEDGER_DIR, { recursive: true, force: true });
try { fs.unlinkSync(FAKE); } catch (e) {}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
