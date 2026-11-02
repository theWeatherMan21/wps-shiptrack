// 卡 t_228d289b：同船司串行 / 跨船司并行的调度单测
// 跑：node test/sched.test.mjs
import { makeKeyedMutex, groupByCarrier } from '../bridge/sched.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('① 同一船司严格串行（不出现交错）');
{
  const m = makeKeyedMutex();
  const log = [];
  const job = (id) => m.run('OOCL', async () => {
    log.push(`in${id}`);
    await sleep(30);
    log.push(`out${id}`);
  });
  await Promise.all([job(1), job(2), job(3)]);
  // 串行时日志必然是 in/out 成对相邻：in1,out1,in2,out2,in3,out3
  const paired = log.every((v, i) => (i % 2 === 0 ? v.startsWith('in') : v.startsWith('out')));
  ok(paired, '没有两条同司任务交错', JSON.stringify(log));
  ok(log.length === 6, '三个任务都跑完了', `实际 ${log.length}`);
}

console.log('② 跨船司真并行（总耗时 ≈ 最慢那家，不是相加）');
{
  const m = makeKeyedMutex();
  const t0 = Date.now();
  await Promise.all([
    m.run('OOCL', () => sleep(120)),
    m.run('MAERSK', () => sleep(120)),
    m.run('HAPAG', () => sleep(120)),
  ]);
  const ms = Date.now() - t0;
  ok(ms < 220, `三家并行应在 120ms 量级（不是 360ms）`, `实际 ${ms}ms`);
}

console.log('③ 同司排队但不同司并行：2 家 × 2 票');
{
  const m = makeKeyedMutex();
  const log = [];
  const t0 = Date.now();
  const job = (c, id) => m.run(c, async () => { log.push(`in_${c}${id}`); await sleep(60); log.push(`out_${c}${id}`); });
  await Promise.all([job('OOCL', 1), job('OOCL', 2), job('MAERSK', 1), job('MAERSK', 2)]);
  const ms = Date.now() - t0;
  ok(ms < 220, '两家各两票应在 ~120ms（各司内部串行、司间并行）', `实际 ${ms}ms`);
  // 同一家的两票不能交错
  const oocl = log.filter((v) => v.includes('OOCL'));
  ok(oocl[0].startsWith('in') && oocl[1].startsWith('out'), 'OOCL 两票内部串行', JSON.stringify(oocl));
}

console.log('④ 前一个任务抛错，后面排队的仍然执行');
{
  const m = makeKeyedMutex();
  const done = [];
  const p1 = m.run('X', async () => { throw new Error('boom'); }).catch(() => done.push(1));
  const p2 = m.run('X', async () => { done.push(2); });
  await Promise.all([p1, p2]);
  ok(done.includes(2), '第一条失败没有把第二条卡死', JSON.stringify(done));
}

console.log('⑤ 队尾跑完会清掉 key（长期运行不涨内存）');
{
  const m = makeKeyedMutex();
  await m.run('A', () => sleep(5));
  await m.run('B', () => sleep(5));
  await sleep(10);
  ok(m.size() === 0, '没有残留的 carrier 链', `size=${m.size()}`);
}

console.log('⑥ 识别不出船司的归到同一个串行桶');
{
  const groups = groupByCarrier(['AAA111', 'BBB222', 'HAPAGTICKET'], (n) => (n.startsWith('HAPAG') ? 'hapag' : ''));
  ok(groups.get('_unknown').length === 2, '两个未识别号同桶', JSON.stringify([...groups.keys()]));
  ok(groups.get('hapag').length === 1, '识别出的单独一桶');
}

console.log('⑦ detect 抛异常也不让整批挂掉');
{
  const groups = groupByCarrier(['A1', 'B2'], () => { throw new Error('detector down'); });
  ok(groups.get('_unknown').length === 2, '异常时全部归 _unknown', JSON.stringify([...groups.keys()]));
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
