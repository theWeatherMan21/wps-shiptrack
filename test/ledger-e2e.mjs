// 卡 t_03fc348f 端到端：断点续查 + 整家冷却（打真桥，不 mock）
// 用法：先起临时桥 WPS_TRACK_PORT=8802 WPS_TRACK_LEDGER_DIR=/tmp/ledger-e2e node bridge/server.mjs
//      再 node test/ledger-e2e.mjs
const BASE = process.env.BRIDGE || 'http://127.0.0.1:8802';
const DOC = '工作簿A.xlsx|Sheet1';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };

const get = async (p) => (await fetch(BASE + p)).text();
const ndjson = (txt) => txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 三条必失败（识别不出船司 → unknown-carrier，稳定、不联网、不撞真站）
const numbers = ['FAKEA001', 'FAKEB002', 'FAKEC003'];
const rows = numbers.map((n, i) => ({ number: n, doc: '工作簿A.xlsx', sheet: 'Sheet1', row: 10 + i }));
const qs = `doc=${encodeURIComponent(DOC)}&numbers=${numbers.join(',')}&timeout=8000&rows=${encodeURIComponent(JSON.stringify(rows))}`;

console.log('① 第一轮：全部失败 → 落盘');
{
  const lines = ndjson(await get(`/track-batch?${qs}`));
  ok(lines.length === 3, '三条都回来了', `实际 ${lines.length}`);
  ok(lines.every((r) => r.ok === false), '三条都是失败');
}

console.log('② /pending 拿到三条失败，且带 doc/sheet/row（不是 null）');
{
  const j = JSON.parse(await get(`/pending?doc=${encodeURIComponent(DOC)}`));
  ok(j.count === 3, 'pending 有 3 条', `实际 ${j.count}`);
  ok(j.rows.every((r) => r.doc === '工作簿A.xlsx' && r.sheet === 'Sheet1' && typeof r.row === 'number'),
    'doc/sheet/row 都落盘了', JSON.stringify(j.rows[0]));
  ok(j.rows.every((r) => r.kind), 'kind 有值');
}

console.log('③ only=pending：只重查上次失败的，不重头来');
{
  const lines = ndjson(await get(`/track-batch?${qs}&only=pending`));
  ok(lines.length === 3, '还是这 3 条', `实际 ${lines.length}`);
  // 全成功的新单跑 only=pending 应该一条都不查
  const other = ndjson(await get(`/track-batch?doc=${encodeURIComponent(DOC)}&numbers=OTHER999&only=pending&timeout=5000`));
  ok(other.length === 0, '不在 pending 里的号一条都不查', `实际 ${other.length}`);
}

console.log('④ 整家冷却：设了冷却 → 该家一律不发请求，直接回 cooling');
{
  // 手工写冷却（模拟撞盾；真撞 429 要等站点，测试里不等）
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/ledger-e2e/cooldowns.json', JSON.stringify({ hapag: Date.now() + 60000 }));
  const lines = ndjson(await get(`/track-batch?doc=${encodeURIComponent(DOC)}&numbers=HLCU0000001&timeout=8000`));
  ok(lines.length === 1, '回来一条');
  ok(lines[0].errorKind === 'cooling', 'errorKind=cooling（没去撞站）', JSON.stringify(lines[0]).slice(0, 160));
  ok(typeof lines[0].coolingLeftMs === 'number' && lines[0].coolingLeftMs > 0, '带回剩余冷却时间');
  ok(/冷却中/.test(lines[0].error || ''), '文案说明冷却中');
}

console.log('⑤ 冷却到期自动解封（不靠后台定时器）');
{
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/ledger-e2e/cooldowns.json', JSON.stringify({ hapag: Date.now() - 1 }));
  const j = JSON.parse(await get('/pending?doc=' + encodeURIComponent(DOC)));
  const row = j.rows.find((r) => r.carrier === 'hapag') || j.rows[0];
  ok((row.cooldownLeftMs || 0) === 0, '过期的冷却报 0', `${row.cooldownLeftMs}`);
}

console.log('⑥ clear 只清这份文档');
{
  await get(`/ledger/clear?doc=${encodeURIComponent(DOC)}`);
  const j = JSON.parse(await get(`/pending?doc=${encodeURIComponent(DOC)}`));
  ok(j.count === 0, '清完 pending 归零', `实际 ${j.count}`);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
