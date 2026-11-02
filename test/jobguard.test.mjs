// 派活三条护栏的单测（卡 t_aa0674a9 第二步）
// 跑：node test/jobguard.test.mjs
import { decideBeforeRun, summarizeRun, shouldClaim } from '../src/lib/jobguard.js';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };

console.log('① 已知澜条件 1：表已切换 → 一行不写，直接报废');
{
  const g = decideBeforeRun({ currentDoc: '表B|S2', specDoc: '表A|S1', cols: { number: 2, out: 5 } });
  ok(g.proceed === false, '不放行', JSON.stringify(g));
  ok(g.report && g.report.state === 'failed', 'report.state = failed', JSON.stringify(g.report));
  ok(/doc 已切换/.test(g.report.error), '理由写明「doc 已切换」', g.report.error);

  const g2 = decideBeforeRun({ currentDoc: '表A|S1', specDoc: '表A|S1', cols: { number: 2, out: 5 } });
  ok(g2.proceed === true, '同一张表就放行');

  const g3 = decideBeforeRun({ currentDoc: '表A|S1', specDoc: '', cols: { number: 2, out: 5 } });
  ok(g3.proceed === false && /spec/.test(g3.reason), '没给 doc 也不许跑');
}

console.log('② 列没配 → 也不许跑（不写空列、不写错列）');
{
  const g = decideBeforeRun({ currentDoc: 'A|S', specDoc: 'A|S', cols: { number: 2, out: 0 } });
  ok(g.proceed === false && /列未配置/.test(g.report.error), 'out 没配 → 报废', JSON.stringify(g.report));
  const g2 = decideBeforeRun({ currentDoc: 'A|S', specDoc: 'A|S', cols: {} });
  ok(g2.proceed === false, '两个都没配 → 报废');
}

console.log('③ 知澜条件 2：中途报错 → 已写的保留，未跑完的算失败');
{
  // 10 行任务，跑到第 6 行炸了：成功 4、已写 4
  const r = summarizeRun({ ok: 4, failed: 0, written: 4, total: 10, interrupted: true, error: 'boom' });
  ok(r.written === 4, 'written 报的是**实际写入数**（4），不是 10', String(r.written));
  ok(r.ok === 4, 'ok 保留', String(r.ok));
  ok(r.failed === 6, '没跑到的 6 行算 failed', String(r.failed));
  ok(r.state === 'failed', 'state=failed（不能报 done）');
  ok(r.error === 'boom', '带上错误原因');

  // 正常跑完
  const r2 = summarizeRun({ ok: 8, failed: 2, written: 10, total: 10 });
  ok(r2.state === 'done' && r2.failed === 2 && r2.written === 10, '正常收尾：done + 原样战果', JSON.stringify(r2));

  // 保护：即使传了负数/NaN 也不产生脏报告
  const r3 = summarizeRun({ ok: -5, failed: NaN, written: 'x', total: null });
  ok(r3.ok === 0 && r3.failed === 0 && r3.written === 0 && r3.total === 0, '脏输入一律归 0', JSON.stringify(r3));
}

console.log('④ 知澜条件 3：领活静默原则 —— 任何一个前提不满足就不去打扰');
{
  const base = { jobBusy: false, userBusy: false, flushing: false, bridgeUp: true, currentDoc: 'A|S' };
  ok(shouldClaim(base) === true, '一切正常才领');
  ok(shouldClaim({ ...base, jobBusy: true }) === false, '已有派活在跑 → 跳过');
  ok(shouldClaim({ ...base, userBusy: true }) === false, '用户自己的批次在跑 → 不抢');
  ok(shouldClaim({ ...base, flushing: true }) === false, '正在补写暂存 → 等它');
  ok(shouldClaim({ ...base, bridgeUp: false }) === false, '桥没连上 → 跳过（下次心跳再试）');
  ok(shouldClaim({ ...base, currentDoc: '' }) === false, '没有活动工作表 → 跳过');
}

console.log('⑤ 失败也要能只补失败：report 里三个数各是什么意思');
{
  // 12 行任务：成功 7、写入但失败 3、还有 2 行没跑到就中断了
  const r = summarizeRun({ ok: 7, failed: 3, written: 10, total: 12, interrupted: true });
  ok(r.written === 10, 'written = 实际写进去的格子数（10）', String(r.written));
  ok(r.ok === 7, 'ok = 查成功的行', String(r.ok));
  // failed 含「写失败的 3 行」+「没跑到的 2 行」——知澜要求「剩余标 failed」
  ok(r.failed === 5, 'failed = 3 写失败 + 2 没跑到 = 5', String(r.failed));
  ok(r.total - r.written === 2, 'total - written = 2 行没写进去（下次只补这些）', String(r.total - r.written));
  // 注意：中断时 written ≠ ok + failed，这是设计如此 —— failed 包含了压根没写的行
  ok(r.written !== r.ok + r.failed, '中断时 written 不等于 ok+failed（failed 含未跑到的行）', `${r.written} vs ${r.ok + r.failed}`);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
