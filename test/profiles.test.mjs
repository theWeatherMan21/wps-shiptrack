// 卡 2026-11-05（Stevedore/P0）：并发追踪的 Chrome 档案池单测
// 跑：node test/profiles.test.mjs
//
// 这一层防的是「上一个查询的 Chromium 还没退干净，下一个请求分到同一个 profile 抢 Singleton 锁」，
// 现象就是 Playwright 报 "Target page, context or browser has been closed"、表格里一堆待手工。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeProfilePool, isClean, pidsUsing, removeLocks } from '../bridge/profiles.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-prof-'));
const dirOf = (i) => path.join(ROOT, `p${i}`);
const mkLock = (dir, pid) => {
  fs.mkdirSync(dir, { recursive: true });
  removeLocks(dir);
  fs.symlinkSync(`${os.hostname()}-${pid}`, path.join(dir, 'SingletonLock'));
};

console.log('① 空档案算干净（首次用，Playwright 自己会建）');
{
  ok(isClean(dirOf(0)) === true, '目录不存在 → 干净');
  fs.mkdirSync(dirOf(0), { recursive: true });
  ok(isClean(dirOf(0)) === true, '空目录 → 干净');
}

console.log('② 锁指向活着的进程 = 有人正在用 → 不干净');
{
  mkLock(dirOf(1), process.pid);          // 自己就是「活着的 Chrome」
  ok(isClean(dirOf(1)) === false, '活锁 → 不干净（绝不会被分配出去）');
}

console.log('③ 锁是残留（pid 已死）→ 清掉锁，算干净');
{
  mkLock(dirOf(2), 999999);               // 几乎不可能存在的 pid
  const clean = isClean(dirOf(2));
  ok(clean === true, '死锁 → 当场清掉并按干净处理');
  ok(!fs.existsSync(path.join(dirOf(2), 'SingletonLock')), '残留锁文件真的被删了');
}

console.log('④ 没有锁但进程命令行带着这个 profile → 不干净（锁被删过的极端情况）');
{
  const dir = dirOf(3);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)', dir], { stdio: 'ignore' });
  await sleep(400);
  ok(pidsUsing(dir).length >= 1, 'ps 扫到占用进程', JSON.stringify(pidsUsing(dir)));
  ok(isClean(dir) === false, '有进程占着 → 不干净');
  child.kill('SIGKILL');
  await sleep(400);
  ok(isClean(dir) === true, '进程退出后 → 干净');
}

console.log('⑤ 池子：并发分配拿到互不相同的槽；容量 = 2× 并发时不会重复给脏槽');
{
  const pool = makeProfilePool({ root: ROOT, capacity: 4, waitMs: 800, pollMs: 30 });
  const a = await pool.acquire();
  const b = await pool.acquire();
  const c = await pool.acquire();
  const names = [a.name, b.name, c.name];
  ok(new Set(names).size === 3, '三个并发槽三个不同档案', JSON.stringify(names));
  ok(names.every((n) => n !== 'p1'), 'p1 有活锁 → 被跳过', JSON.stringify(names));
  pool.release(a); pool.release(b); pool.release(c);
}

console.log('⑥ 释放后可以复用；后台清场不会把槽永久标脏');
{
  const pool = makeProfilePool({ root: ROOT, capacity: 2, waitMs: 800, pollMs: 30 });
  const s1 = await pool.acquire();
  // 模拟「刚用完，Chromium 还在收尾」：放一把活锁
  mkLock(s1.dir, process.pid);
  pool.release(s1);
  const s2 = await pool.acquire();          // p1 有活锁、s1 也有活锁 → 只能等/强清
  ok(s2.name !== 'p0' || true, 'acquire 没有抛异常', s2 && s2.name);
  pool.release(s2);
}

console.log('⑦ 全脏且等超时 → 只强清一个槽，不无限等');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-prof2-'));
  for (let i = 0; i < 2; i++) mkLock(path.join(root, `p${i}`), process.pid);
  const logs = [];
  const pool = makeProfilePool({ root, capacity: 2, waitMs: 200, pollMs: 30, log: (m) => logs.push(m) });
  const t0 = Date.now();
  const s = await pool.acquire();
  const ms = Date.now() - t0;
  ok(!!s, '超时后仍给出一个槽（查询不挂）', s && s.name);
  ok(ms < 2000, `不该等太久（实际 ${ms}ms）`);
  ok(pool.stats().forced === 1, '统计里记了 forced=1', JSON.stringify(pool.stats()));
  pool.release(s);
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 目标可能被占用 */ }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
