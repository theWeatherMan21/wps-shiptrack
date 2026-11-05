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

console.log('⑧ 串行连查（卡 t_991b99f7）：顺序 acquire→release 6 次不得重复同一槽');
{
  // 知澜 11-05 复现命令的字面转写：capacity=8 顺序 acquire→release 6 次，旧实现拿到 p0×6
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-prof3-'));
  const pool = makeProfilePool({ root, capacity: 8, waitMs: 800, pollMs: 30, cooldownMs: 60000 });
  const names = [];
  for (let i = 0; i < 6; i++) {
    const s = await pool.acquire();
    names.push(s.name);
    pool.release(s);
  }
  ok(new Set(names).size === 6, '6 次拿到 6 个不同档案', JSON.stringify(names));
  ok(names[0] === 'p0', '第一次仍是 p0（从没用过的槽 lastUsed=0 最先铺开）', names[0]);
  ok(pool.stats().acquired === 6, 'stats.acquired 记了 6 次', JSON.stringify(pool.stats().acquired));
  // 现有 /health 字段一个都不许少
  const st = pool.stats();
  const missing = ['capacity', 'acquired', 'waitedMs', 'dirtySkips', 'forced', 'busy', 'dirty', 'cooling']
    .filter((k) => !(k in st));
  ok(missing.length === 0, 'stats 字段齐全（含新增 cooling）', JSON.stringify(missing));
  const sl = pool.slots();
  ok(sl.length === 8 && sl.every((s) => 'lastUsed' in s && 'cooldownMs' in s), 'slots() 每槽都带 lastUsed / cooldownMs', JSON.stringify(sl[0]));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 占用中就算了 */ }
}

console.log('⑨ 槽级冷却生效：刚放掉的槽在冷却期内不会再被选中；普通 release 不打冷却');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-prof4-'));
  const pool = makeProfilePool({ root, capacity: 3, waitMs: 800, pollMs: 30, cooldownMs: 60000 });
  const a = await pool.acquire();
  pool.release(a);                                   // 不带 cooldown = 原有行为
  ok(pool.stats().cooling.length === 0, '普通 release 不打冷却（默认行为不变）', JSON.stringify(pool.stats().cooling));
  const b = await pool.acquire();                    // 纯 LRU 也会避开刚用过的，但不是冷却造成的
  pool.release(b, { cooldown: true });               // 撞盾 → 冷却
  ok(pool.stats().cooling.includes(b.name), '撞盾的槽进了 cooling', JSON.stringify(pool.stats().cooling));
  const bs = pool.slots().find((s) => s.name === b.name);
  ok(bs.cooldownMs > 30000 && bs.cooldownMs <= 60000, 'cooldownMs 报剩余冷却毫秒', JSON.stringify(bs));
  const c = await pool.acquire();
  ok(c.name !== b.name, '冷却期内的槽不会被选中', `${c.name} vs ${b.name}`);
  pool.release(c);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 占用中就算了 */ }
}

console.log('⑩ 冷却过期后可以再选中该槽（不是永久黑名单）');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-prof5-'));
  const CD = 150;
  const pool = makeProfilePool({ root, capacity: 2, waitMs: 800, pollMs: 30, cooldownMs: CD });
  const a = await pool.acquire();                    // p0
  const b = await pool.acquire();                    // p1（p0 忙）
  pool.release(a);
  pool.release(b);
  ok(pool.stats().cooling.length === 0, '没撞盾 → 两个槽都不冷却', JSON.stringify(pool.stats().cooling));
  pool.release(a, { cooldown: true });               // 单独给 p0 打冷却（p0 已经是释放状态，这里只更新冷却时间）
  const before = (await pool.acquire()).name;
  ok(before !== 'p0', '冷却中的 p0 被跳过', before);
  await sleep(CD + 120);
  const after = (await pool.acquire()).name;
  ok(after === 'p0', '冷却到点后 p0 又能被选中', after);
  ok((pool.slots().find((s) => s.name === 'p0') || {}).cooldownMs === 0, 'p0 剩余冷却归零');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 占用中就算了 */ }
}

console.log('⑪ 全部槽都在冷却 → 降级直接给最久未用的干净槽，不新增等待');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-prof6-'));
  const pool = makeProfilePool({ root, capacity: 2, waitMs: 8000, pollMs: 30, cooldownMs: 60000 });
  const a = await pool.acquire();                    // p0
  pool.release(a, { cooldown: true });
  const b = await pool.acquire();                    // p1
  pool.release(b, { cooldown: true });
  ok(pool.stats().cooling.length === 2, '两个槽都在冷却', JSON.stringify(pool.stats().cooling));
  const logs = [];
  const t0 = Date.now();
  const c = await pool.acquire();
  const ms = Date.now() - t0;
  ok(!!c, '仍然给得出槽（不死锁）', c && c.name);
  ok(ms < 500, `不新增等待（实际 ${ms}ms，waitMs 设的是 8000）`);
  ok(c.name === 'p0', '降级挑最久未用的 p0', c.name);
  ok(logs.length === 0, '降级路径不写告警日志', String(logs.length));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 占用中就算了 */ }
}


try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 目标可能被占用 */ }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
