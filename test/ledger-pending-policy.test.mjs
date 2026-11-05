// 待重查队列的收口口径（2026-11-05 知澜定）：
//   死号不进队列 —— no_record / aged_out / bad_format / not_wired
//   站点超时 → stale_timeout，只在 +24h / +72h 各补试一次，第三次仍空转 no_record
//   只有限流 / 网络 / 挑战这类环境性失败 retry_now 每轮查
//
// 背景：67 格待重查里 25 个是「官网真没有」、3 个「引擎没接入」，
// 全堆在队列里每轮白烧时间 —— 队列必须只装「真的值得重试的行」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toRecord, isPendingRecord, pendingState, whyNotRetry,
  STALE_RETRY_HOURS, Ledger,
} from '../bridge/ledger.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };
const rec = (o) => toRecord({ doc: 'T.xlsx', sheet: 'S1', row: 2, number: 'TEST-BL-0001', result: o });

console.log('① 死号分类：官网真没有 / 超期 / 格式错 / 未接入 都不该重试');
{
  ok(whyNotRetry('not-found', 'MSC 查无此号') === 'no_record', 'not-found → no_record');
  ok(whyNotRetry('failed', 'Hapag 官网无此单记录') === 'no_record', '文案「官网无此单」→ no_record');
  ok(whyNotRetry('failed', 'Maersk 官网 2 个站都 404') === 'no_record', '文案 404 → no_record');
  ok(whyNotRetry('failed', 'Hapag 官网仅保留近 12 个月；2025 及更早的单查不到') === 'aged_out', '超 12 个月 → aged_out');
  ok(whyNotRetry('failed', 'Maersk 单号格式不符（当前 10 位）') === 'bad_format', '格式不符 → bad_format');
  ok(whyNotRetry('no-module', '引擎没接入 UGL') === 'not_wired', '没接入 → not_wired');
  ok(whyNotRetry('failed', 'no tracking module for "ugl"') === 'not_wired', 'no tracking module → not_wired');
}

console.log('② 环境性失败该重试');
{
  ok(whyNotRetry('throttled', 'OOCL 站方限流') === null, 'throttled 可重试');
  ok(whyNotRetry('network', 'net::ERR_CONNECTION_CLOSED') === null, 'network 可重试');
  ok(whyNotRetry('challenge', '人机校验') === null, 'challenge 可重试');
  ok(whyNotRetry('timeout', '超时（90s 未出结果）') === null, 'timeout 不算死号（走 stale 流程）');
}

console.log('③ 记录的 state 落得对');
{
  ok(rec({ ok: true }).state === 'ok', '成功 → ok');
  ok(rec({ ok: false, errorKind: 'not-found', error: '查无此单' }).state === 'no_record', 'not-found → no_record');
  ok(rec({ ok: false, errorKind: 'throttled', error: '限流' }).state === 'retry_now', 'throttled → retry_now');
  ok(rec({ ok: false, errorKind: 'timeout', error: '超时' }).state === 'stale_timeout', 'timeout → stale_timeout');
}

console.log('④ 队列过滤：只有 retry_now 立刻进，死号永远不进');
{
  ok(isPendingRecord(rec({ ok: false, errorKind: 'throttled', error: '限流' })) === true, 'throttled 在队列');
  ok(isPendingRecord(rec({ ok: false, errorKind: 'network', error: '网络断了' })) === true, 'network 在队列');
  ok(isPendingRecord(rec({ ok: false, errorKind: 'not-found', error: '查无此单' })) === false, 'no_record 不在队列');
  ok(isPendingRecord(rec({ ok: false, errorKind: 'failed', error: '单号格式不符（当前 10 位）' })) === false, 'bad_format 不在队列');
  ok(isPendingRecord(rec({ ok: false, errorKind: 'failed', error: '官网仅保留近 12 个月' })) === false, 'aged_out 不在队列');
  ok(isPendingRecord(rec({ ok: false, errorKind: 'no-module', error: '引擎没接入 UGL' })) === false, 'not_wired 不在队列');
  ok(isPendingRecord(rec({ ok: true })) === false, '成功行不在队列');
}

console.log('⑤ stale_timeout：刚超时时不进队列（要等 24h）');
{
  const r = rec({ ok: false, errorKind: 'timeout', error: '超时（90s 未出结果）' });
  r.staleTries = 0;
  r.nextAt = Date.now() + 24 * 3600 * 1000;
  ok(isPendingRecord(r, Date.now()) === false, '现在不查');
  ok(isPendingRecord(r, Date.now() + 25 * 3600 * 1000) === true, '24h 后进队列补试');
}

console.log('⑥ 三次超时后自动转 no_record（真桥落盘验证，硬上限 2 次补试）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
  const L = new Ledger(dir);
  const DOC = 'T.xlsx|S1';
  const mk = () => toRecord({ doc: 'T.xlsx', sheet: 'S1', row: 5, number: '1199999999', result: { ok: false, errorKind: 'timeout', error: '超时（90s 未出结果）' } });

  const r1 = mk(); L.append(DOC, [r1]);
  const a1 = L.read(DOC)[0];
  ok(a1.state === 'stale_timeout', '第 1 次超时 → stale_timeout', a1.state);
  ok(a1.staleTries === 0, '第 1 次 staleTries=0', String(a1.staleTries));
  ok(a1.nextAt > Date.now() + 23 * 3600e3, '第 1 次排到 +24h');
  ok(L.pending(DOC).length === 0, '第 1 次不进队列');

  const r2 = mk(); L.append(DOC, [r2]);
  const a2 = L.read(DOC)[0];
  ok(a2.staleTries === 1, '第 2 次 staleTries=1', String(a2.staleTries));
  ok(a2.nextAt > Date.now() + 71 * 3600e3, '第 2 次排到 +72h');

  const r3 = mk(); L.append(DOC, [r3]);
  const a3 = L.read(DOC)[0];
  ok(a3.state === 'no_record', '第 3 次 → 自动转 no_record（不再烧查询）', a3.state);
  ok(a3.why === 'no_record', 'why 同步标 no_record');
  ok(a3.retryable === false, 'retryable=false');
  ok(L.pending(DOC).length === 0, '之后永远不进队列');

  // 顺带：行情性失败在同一本账里照常进队列
  L.append(DOC, [toRecord({ doc: 'T.xlsx', sheet: 'S1', row: 6, number: 'TEST-BL-0002', result: { ok: false, errorKind: 'throttled', error: '限流' } })]);
  ok(L.pending(DOC).length === 1, '限流那行仍在队列里', String(L.pending(DOC).length));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('⑦ 老账本（没有 state/retryable 字段）向后兼容');
{
  const old = { key: 'a|b|1|X', doc: 'a', sheet: 'b', row: 1, number: 'X', kind: 'not-found', err: '查无此单', at: '2026-11-01T00:00:00Z' };
  ok(pendingState(old) === 'no_record', '老记录的 not-found 也算死号');
  ok(isPendingRecord(old) === false, '老记录的死号不进队列');
  const oldT = { ...old, kind: 'throttled', err: '限流' };
  ok(isPendingRecord(oldT) === true, '老记录的限流仍进队列');
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
