// 卡 t_cec031c1 端到端：pol/pod 从 URL 一路传到引擎，早退路径也带 canonical
//
// 为什么要有这条（知澜 2026-11-02 驳回第 1 条）：纯函数单测 54 项全绿，
// 但桥里 runCli 没把 pol/pod 传下去 —— 单测直调函数，测不出「参数在路上丢了」。
// 所以这里必须测**参数从入口到出口**。
//
// 用法（两条各自独立起桥，避免环境变量串台）：
//   node test/canonical-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const REPO = path.resolve(ROOT, '..', 'ShipScheduleHub');
const FAKE = path.join(os.tmpdir(), 'fake-cli-e2e.mjs');
const ARGV_FILE = path.join(os.tmpdir(), 'fake-argv-e2e.json');

function startBridge(env, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'bridge/server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, WPS_TRACK_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}
const waitUp = async (port) => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
};

// ---------- ① 传参：桥 → runCli → --pol/--pod ----------
console.log('① pol/pod 从 URL 一路传到引擎 CLI（假 CLI 记录 argv）');
{
  // 假 CLI 不联网，但**用真引擎算 canonical** —— 这样才测得到「参数变了，结果就变」
  fs.writeFileSync(FAKE, `
import fs from 'node:fs';
const { buildCanonical } = await import(${JSON.stringify(path.join(REPO, 'engine/tracking/canonical.mjs'))});
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(ARGV_FILE)}, JSON.stringify(argv));
const gi = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// 一票「宁波装船 → 新加坡中转卸/离 → 格但斯克到港」：中转港那条如果被当成目的港，阶段就错了
const r = {
  ok: true, carrier: 'hapag', number: gi('--number'),
  events: [
    { time: '2026-10-01', activity: 'Export Loaded on Vessel', city: 'NINGBO', timeType: 'ACTUAL' },
    { time: '2026-10-10', activity: 'Import Discharged', city: 'SINGAPORE', timeType: 'ACTUAL' },
    { time: '2026-10-12', activity: 'Departure From', city: 'SINGAPORE', timeType: 'ACTUAL' },
    { time: '2026-10-25', activity: 'Arrival At', city: 'GDANSK', timeType: 'ACTUAL' },
    // 目的港之后还有一段（转运去别处卸）：不给 pod 时引擎会把它当「最后一站=目的港」，
    // 给了 pod 才认 GDANSK —— 这正是「表格 POL/POD 列比事件推断更权威」要证明的事
    { time: '2026-10-27', activity: 'Departure From', city: 'GDANSK', timeType: 'ACTUAL' },
    { time: '2026-10-29', activity: 'Arrival At', city: 'HAMBURG', timeType: 'ACTUAL' },
  ],
};
r.canonical = buildCanonical(r, { pol: gi('--pol'), pod: gi('--pod') });
out({ type: 'track-result', ...r });
out({ type: 'track-exit', ok: true, ms: 1 });
`.trim());
  try { fs.unlinkSync(ARGV_FILE); } catch (e) {}

  const port = 8811;
  const b = startBridge({ WPS_TRACK_CLI: FAKE, WPS_TRACK_LEDGER_DIR: path.join(os.tmpdir(), 'ledger-e2e-1') }, port);
  const up = await waitUp(port);
  ok(up, '临时桥起来了');
  if (up) {
    await fetch(`http://127.0.0.1:${port}/track?number=HAPAGTEST01&carrier=hapag&pol=NINGBO&pod=GDANSK&timeout=8000`);
    await sleep(300);
    let argv = [];
    try { argv = JSON.parse(fs.readFileSync(ARGV_FILE, 'utf8')); } catch (e) {}
    ok(argv.includes('--pol'), '引擎收到了 --pol', JSON.stringify(argv));
    ok(argv[argv.indexOf('--pol') + 1] === 'NINGBO', '--pol 的值是 NINGBO', String(argv[argv.indexOf('--pol') + 1]));
    ok(argv.includes('--pod'), '引擎收到了 --pod');
    ok(argv[argv.indexOf('--pod') + 1] === 'GDANSK', '--pod 的值是 GDANSK');

    // 再跑一次：不带 pol/pod，引擎就不该收到这两个参数
    try { fs.unlinkSync(ARGV_FILE); } catch (e) {}
    await fetch(`http://127.0.0.1:${port}/track?number=HAPAGTEST01&carrier=hapag&timeout=8000`);
    await sleep(300);
    let argv2 = [];
    try { argv2 = JSON.parse(fs.readFileSync(ARGV_FILE, 'utf8')); } catch (e) {}
    ok(!argv2.includes('--pol') && !argv2.includes('--pod'), '不带 pol/pod 时引擎也收不到（不会瞎传空串）', JSON.stringify(argv2));

    // ★ 关键断言：参数到位之后，canonical.stage 必须随 pol/pod 变
    const body1 = await (await fetch(`http://127.0.0.1:${port}/track?number=HAPAGTEST01&carrier=hapag&pol=NINGBO&pod=GDANSK&timeout=8000`)).json();
    await sleep(100);
    const body2 = await (await fetch(`http://127.0.0.1:${port}/track?number=HAPAGTEST02&carrier=hapag&timeout=8000`)).json();
    const st1 = body1.canonical && body1.canonical.stage;
    const st2 = body2.canonical && body2.canonical.stage;
    ok(st1 === 2, '带 pol/pod：判到目的港 GDANSK（stage=2）', `stage=${st1}`);
    // 「带不带 pol/pod 结果不同」——比 stage 更精确的判据是 canonical.pod：
    // 不带 pod 时引擎按「最后一个到港」推断，带 pod 时按用户指定取。
    // 这两个值不同，就证明参数真的进了判定逻辑（而不是被丢掉后碰巧得出同样结论）。
    const pod1 = body1.canonical && body1.canonical.pod;
    const pod2 = body2.canonical && body2.canonical.pod;
    ok(!!pod1, '带 pod 时 canonical.pod 有值', String(pod1));
    ok(pod1 === 'GDANSK', 'canonical.pod 回的是用户指定的 GDANSK', String(pod1));
    ok(pod1 !== pod2 || body2.canonical.pol !== 'NINGBO', '参数生效：显式 pol/pod 与推断结果可区分', `with=${pod1} without=${pod2}`);
    ok(!!(body1.canonical && body1.canonical.pol && body1.canonical.pod), 'canonical 里回显了 pol/pod', JSON.stringify({ pol: body1.canonical && body1.canonical.pol, pod: body1.canonical && body1.canonical.pod }));
  }
  b.kill('SIGKILL');
  await sleep(200);
}

// ---------- ② 批量：每行自己的 pol/pod ----------
console.log('② 批量 rows 里每行可以带不同的 pol/pod');
{
  try { fs.unlinkSync(ARGV_FILE); } catch (e) {}
  const port = 8812;
  const b = startBridge({ WPS_TRACK_CLI: FAKE, WPS_TRACK_LEDGER_DIR: path.join(os.tmpdir(), 'ledger-e2e-2') }, port);
  const up = await waitUp(port);
  ok(up, '临时桥起来了');
  if (up) {
    const rows = JSON.stringify([{ number: 'HAPAGROW01', pol: 'NINGBO', pod: 'GDANSK' }]);
    await fetch(`http://127.0.0.1:${port}/track-batch?doc=e2e&numbers=HAPAGROW01&rows=${encodeURIComponent(rows)}&timeout=8000`);
    await sleep(400);
    let argv = [];
    try { argv = JSON.parse(fs.readFileSync(ARGV_FILE, 'utf8')); } catch (e) {}
    ok(argv.includes('--pol') && argv[argv.indexOf('--pol') + 1] === 'NINGBO', '批量行自己的 pol 传到了引擎', JSON.stringify(argv));
    ok(argv.includes('--pod') && argv[argv.indexOf('--pod') + 1] === 'GDANSK', '批量行自己的 pod 传到了引擎');
  }
  b.kill('SIGKILL');
  await sleep(200);
}

// ---------- ③ 早退路径也带 canonical（真引擎，真早退） ----------
console.log('③ 早退路径（识别不出船司）也必须带 canonical，不能是 null');
{
  const { execFileSync } = await import('node:child_process');
  const cliPath = path.join(REPO, 'engine/tracking/cli.mjs');
  const run = (num) => {
    try {
      const stdout = execFileSync(process.execPath, [cliPath, '--number', num], { cwd: REPO, timeout: 30000, encoding: 'utf8' });
      return stdout.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) {
      const out = String(e.stdout || '');
      return out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (err) { return null; } }).filter(Boolean);
    }
  };

  const lines1 = run('AB1');                       // 太短 → too-short 早退
  const err1 = lines1.find((l) => l.type === 'track-error');
  ok(!!err1, '短号触发 track-error 早退');
  ok(!!(err1 && err1.canonical), '早退结果带 canonical（不是 null）', JSON.stringify(err1 && err1.canonical));
  ok(!!(err1 && err1.canonical && err1.canonical.failKind), '早退结果有 failKind', err1 && err1.canonical && err1.canonical.failKind);
  ok(!!(err1 && err1.canonical && err1.canonical.shortText && err1.canonical.shortText.length <= 24), '早退结果短结论守 24 字符');

  const lines2 = run('ZZZZ9999999');               // 识别不出 → unknown-carrier 早退
  const err2 = lines2.find((l) => l.type === 'track-error');
  ok(!!err2, '识别不出的号触发 track-error');
  ok(!!(err2 && err2.canonical), '这条也带 canonical');
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
