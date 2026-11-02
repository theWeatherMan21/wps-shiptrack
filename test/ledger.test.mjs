// 卡 t_03fc348f：断点续查账本的单测（失败行落盘 + 整家冷却）
// 跑：node test/ledger.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, recordKey, toRecord, isCooldownKind, isPendingRecord } from '../bridge/ledger.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-ledger-'));

console.log('① 落盘 key：doc|sheet|row|number，缺值算空但不能乱位');
{
  ok(recordKey({ doc: 'A.xlsx', sheet: 'S1', row: 7, number: 'X1' }) === 'A.xlsx|S1|7|X1', '四段齐全');
  ok(recordKey({ doc: 'A.xlsx', number: 'X1' }) === 'A.xlsx|||X1', '缺 sheet/row 留空位');
  // key 不含 carrier（同一行重跑识别可能变，带 carrier 会变两个 key）
  const k = recordKey({ doc: 'd', sheet: 's', row: 1, number: 'n', carrier: 'oocl' });
  ok(k === 'd|s|1|n', 'key 不含 carrier', k);
}

console.log('② 记录体：缺值写 null，不写空串（事后能分清「没传」和「传了空」）');
{
  const r = toRecord({ number: 'X1', result: { ok: false, carrier: 'oocl', errorKind: 'challenge', error: 'QF8' } });
  ok(r.doc === null && r.sheet === null && r.row === null, '没传的行号是 null');
  ok(r.carrier === 'oocl', '记录体含 carrier');
  ok(r.kind === 'challenge', 'kind 取自 errorKind');
  const s = toRecord({ doc: 'd', sheet: 's', row: 3, number: 'X2', result: { ok: true, carrier: 'hapag' } });
  ok(s.err === null && s.kind === null, '成功记录不写 err/kind');
}

console.log('③ append / read / pending：后写覆盖前写');
{
  const L = new Ledger(tmp);
  L.append('docA', [
    toRecord({ doc: 'docA', sheet: 's', row: 1, number: 'N1', result: { ok: false, carrier: 'oocl', errorKind: 'timeout', error: '超时' } }),
    toRecord({ doc: 'docA', sheet: 's', row: 2, number: 'N2', result: { ok: true, carrier: 'hapag' } }),
  ]);
  ok(L.read('docA').length === 2, '两条都读回来');
  ok(L.pending('docA').length === 1, '只有失败那条进 pending', JSON.stringify(L.pending('docA').map((r) => r.number)));

  // 同一行重跑成功 → 覆盖之前的失败
  L.append('docA', [toRecord({ doc: 'docA', sheet: 's', row: 1, number: 'N1', result: { ok: true, carrier: 'oocl' } })]);
  ok(L.pending('docA').length === 0, '同 key 后写的成功覆盖了之前的失败', JSON.stringify(L.pending('docA')));
  ok(L.read('docA').length === 2, 'read 按 key 去重，不是按行数累加', `实际 ${L.read('docA').length}`);
}

console.log('④ 不同文档互不干扰');
{
  const L = new Ledger(tmp);
  L.append('docB', [toRecord({ doc: 'docB', number: 'N9', result: { ok: false, carrier: 'msc', errorKind: 'failed' } })]);
  ok(L.pending('docB').length === 1, 'docB 有自己的账本');
  ok(L.pending('docA').length === 0, 'docA 不受影响');
}

console.log('⑤ 撞盾类判据：challenge / rate-limit / blocked / cooling');
{
  for (const k of ['challenge', 'rate-limit', 'blocked', 'cooling']) ok(isCooldownKind(k), `${k} 算撞盾`);
  for (const k of ['timeout', 'network', 'failed', 'not-found', null, undefined]) ok(!isCooldownKind(k), `${k} 不算撞盾`);
}

console.log('⑥ 冷却：设了就有剩余，到点自动解封并落盘清理');
{
  const L = new Ledger(tmp);
  L.cool('oocl', 150);
  ok(L.cooldownLeft('oocl') > 0, '刚设完有剩余');
  ok(L.cooldownLeft('hapag') === 0, '没设过的船司不受影响');
  // 冷却是落盘的：新实例读得到
  const L2 = new Ledger(tmp);
  ok(L2.cooldownLeft('oocl') > 0, '冷却跨实例保留（重启桥不丢）');
  await new Promise((r) => setTimeout(r, 220));
  ok(L.cooldownLeft('oocl') === 0, '到点自动解封');
  ok(L.cooldownLeft('oocl') === 0, '解封后再问仍是 0（不会反复重置）');
}

console.log('⑦ 坏行跳过，不影响同文件其它记录');
{
  const L = new Ledger(tmp);
  L.append('docC', [toRecord({ doc: 'docC', number: 'GOOD', result: { ok: false, carrier: 'x', errorKind: 'timeout' } })]);
  fs.appendFileSync(path.join(tmp, 'docC.ndjson'), '这不是 JSON\n{坏}\n');
  ok(L.pending('docC').length === 1, '坏行被跳过，好行还在', JSON.stringify(L.pending('docC').map((r) => r.number)));
}

console.log('⑧ clear 只清该文档');
{
  const L = new Ledger(tmp);
  L.clear('docC');
  ok(L.pending('docC').length === 0, 'docC 已清空');
  ok(L.pending('docB').length === 1, 'docB 还在');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
