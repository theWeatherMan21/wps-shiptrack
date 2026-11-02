// 派活队列的单测（卡 t_aa0674a9 第一步）
// 跑：node test/jobs.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue, normalizeSpec } from '../bridge/jobs.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-jobs-'));

console.log('① spec 规整：越界/脏参数一律按默认，不让脏值进队列');
{
  const s = normalizeSpec({ doc: '  表A|Sheet1 ', rows: 99999, startRow: 0, cols: { number: 2, out: 'x' } });
  ok(s.doc === '表A|Sheet1', 'doc 去空白');
  ok(s.rows === 2000, 'rows 封顶 2000', String(s.rows));
  ok(s.startRow === 2, 'startRow 最小 2（表头占一行）', String(s.startRow));
  ok(s.cols.number === 2 && s.cols.out === 0, '坏列号退 0（未选），不塞 NaN', JSON.stringify(s.cols));
  ok(s.mode === 'column', 'mode 默认 column');
}

console.log('② 建任务 → 落盘（重启不丢）');
{
  const q = new JobQueue(dir);
  const j = q.create({ doc: '表A|Sheet1', cols: { number: 2, out: 5 }, startRow: 2, rows: 3, mode: 'column' });
  ok(!!j.jobId && j.jobId.startsWith('job-'), 'jobId 有值', j.jobId);
  ok(j.state === 'queued', '初始状态 queued');
  ok(fs.existsSync(path.join(dir, `${j.jobId}.json`)), '任务文件已落盘');

  const q2 = new JobQueue(dir);          // 模拟桥重启
  const back = q2.get(j.jobId);
  ok(!!back, '重启后还能读到');
  ok(back && back.rows === 3 && back.cols.out === 5, '内容没丢', JSON.stringify(back && back.cols));
}

console.log('③ 领活是原子的：同一任务不会被领两次');
{
  const q = new JobQueue(dir);
  const j = q.create({ doc: '表B|S1', rows: 2 });
  const a = q.next('表B|S1');
  const b = q.next('表B|S1');
  ok(a && a.jobId === j.jobId, '第一次领到', JSON.stringify(a && a.jobId));
  ok(b === null || b.jobId !== j.jobId, '第二次领不到同一个任务', JSON.stringify(b));
  ok(q.get(j.jobId).state === 'running', '领走后状态变 running');
}

console.log('④ 按 doc 领活：拿到的是这份文档的活，不是别人的');
{
  const q = new JobQueue(dir);
  const jx = q.create({ doc: '表X|S1', rows: 1 });
  q.create({ doc: '表Y|S1', rows: 1 });
  const got = q.next('表Y|S1');
  ok(got && got.spec.doc === '表Y|S1', '领到的是表Y 的活', JSON.stringify(got && got.spec.doc));
  const got2 = q.next('表Z|S1');
  ok(got2 === null || got2.spec.doc === '表Z|S1', '表Z 没有任务就不该拿到别人的活', JSON.stringify(got2 && got2.spec.doc));
}

console.log('⑤ 上报：进度累加、带 state 才改状态');
{
  const q = new JobQueue(dir);
  const j = q.create({ doc: '表C|S1', rows: 10 });
  q.next('表C|S1');
  const r1 = q.report(j.jobId, { ok: 4, failed: 1, total: 10, written: 4 });
  ok(r1.progress.done === 5, 'done = ok + failed', String(r1.progress.done));
  ok(r1.state === 'running', '只报进度不改状态', r1.state);
  const r2 = q.report(j.jobId, { ok: 9, failed: 1, total: 10, state: 'done' });
  ok(r2.state === 'done', '带了 state 才改成 done', r2.state);
  ok(!!r2.finishedAt, '完成时记 finishedAt');
  ok(r2.reports.length === 2, '两次上报都留着（时间线）', String(r2.reports.length));
}

console.log('⑥ 列表按文档过滤、按时间倒序');
{
  const q = new JobQueue(dir);
  const list = q.list('表C|S1');
  ok(list.length >= 1 && list.every((x) => x.doc === '表C|S1'), '只返回该文档的任务', String(list.length));
  const all = q.list('');
  ok(all.length > list.length, '不传 doc 返回全部', `${all.length} vs ${list.length}`);
  const times = all.map((x) => x.createdAt);
  ok(JSON.stringify(times) === JSON.stringify([...times].sort().reverse()), '按创建时间倒序');
}

console.log('⑦ 桥重启自愈：running 超时太久 → 放回队列');
{
  const q = new JobQueue(dir);
  const j = q.create({ doc: '表D|S1', rows: 1 });
  q.next('表D|S1');
  const fresh = q.requeueStale(60 * 60 * 1000);
  ok(!fresh.includes(j.jobId), '刚领的不会被抢回', JSON.stringify(fresh));
  const stale = q.requeueStale(-1);          // 负阈值 = 一切都算旧
  ok(stale.includes(j.jobId), '超时的被放回队列', JSON.stringify(stale));
  ok(q.get(j.jobId).state === 'queued', '状态回到 queued');
}

console.log('⑧ 坏文件/不存在的任务不炸');
{
  const q = new JobQueue(dir);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{这不是 JSON');
  const q2 = new JobQueue(dir);
  ok(true, '目录里有坏文件也能起来');
  ok(q2.get('不存在') === null, '查不存在的任务返回 null');
  ok(q2.report('不存在', {}) === null, '给不存在的任务上报返回 null');
  ok(q2.next('空文档|S1') === null, '没活时 next 返回 null');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
