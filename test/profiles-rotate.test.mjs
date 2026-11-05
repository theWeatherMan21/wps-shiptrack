// 档案级风控轮换（2026-11-05 知澜定口径）：
//   每个 Chrome 档案连用 maxUses 次后强制冷却 retireMs 再复用 —— 风控是档案级不是 IP 级。
//   关键是「并发不受影响、127 单不会卡成几小时」：8 槽 × 2 次 = 16 次才第一轮全冷，
//   全冷时走「降级复用」路径，不等待。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeProfilePool, PROFILE_MAX_USES, PROFILE_RETIRE_MS } from '../bridge/profiles.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${extra}`); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profrot-'));
let t = 1_000_000;
const clock = () => t;

const mk = (o = {}) => makeProfilePool({ root: fs.mkdtempSync(path.join(root, 'p-')), capacity: 8, waitMs: 200, pollMs: 10, now: clock, ...o });

console.log('① 默认值：连用 2 次、轮换 5 分钟');
{
  ok(PROFILE_MAX_USES === 2, 'maxUses 默认 2', String(PROFILE_MAX_USES));
  ok(PROFILE_RETIRE_MS === 5 * 60 * 1000, 'retireMs 默认 5 分钟', String(PROFILE_RETIRE_MS));
}

console.log('② 同一档案连用 2 次 → 进冷却，且冷却 ≈ retireMs');
{
  const pool = mk();
  const s1 = await pool.acquire();
  const name = s1.name;
  pool.release(s1);
  ok(pool.slots().find((s) => s.name === name).cooldownMs === 0, '第 1 次用完好用（没到上限）');

  const s2 = await pool.acquire();   // LRU 会先挑别人，但这里只有它用过 → 还是可能挑到别人
  pool.release(s2);

  // 直接验证计数逻辑：反复 acquire/release 同一个槽
  const pool2 = mk({ capacity: 1 });
  const a = await pool2.acquire();
  pool2.release(a);
  const b = await pool2.acquire();
  ok(b.name === a.name, '单槽池：第二次还是它（并发=1 没得挑）');
  pool2.release(b);
  const after = pool2.slots()[0];
  ok(after.cooldownMs > 0, '连用 2 次后进冷却', JSON.stringify(after));
  ok(Math.abs(after.cooldownMs - PROFILE_RETIRE_MS) < 1500, '冷却时长 ≈ 5 分钟', String(after.cooldownMs));
  ok(after.consecutive === 0, '计数清零（回来重新算）', String(after.consecutive));
}

console.log('③ 冷却到期后自动可用');
{
  const pool = mk({ capacity: 1 });
  const a = await pool.acquire(); pool.release(a);
  const b = await pool.acquire(); pool.release(b);
  ok(pool.slots()[0].cooldownMs > 0, '现在在冷却');
  t += PROFILE_RETIRE_MS + 1000;
  ok(pool.slots()[0].cooldownMs === 0, '过了 5 分钟自动解封');
  const c = await pool.acquire();
  ok(c.name === 'p0', '解封后能再拿到');
  pool.release(c);
}

console.log('④ 8 槽 × 2 次 = 16 次之后全冷 → 降级复用，不等待、不卡死');
{
  const pool = mk();
  const t0 = Date.now();
  for (let i = 0; i < 16; i++) { const s = await pool.acquire(); pool.release(s); }
  const cooling = pool.slots().filter((s) => s.cooldownMs > 0).length;
  ok(cooling === 8, '16 次后 8 个槽全在冷却', String(cooling));
  const s = await pool.acquire();          // 必须立刻拿到（降级），不能等 5 分钟
  ok(!!s, '第 17 次仍立刻拿到槽（降级复用）');
  ok(Date.now() - t0 < 5000, '16+1 次全程没等待', `${Date.now() - t0}ms`);
  pool.release(s);
}

console.log('⑤ 撞盾冷却优先于轮换（60s 撞盾不被 5 分钟轮换覆盖成更短/更长）');
{
  const pool = mk({ capacity: 1, cooldownMs: 60_000 });
  const a = await pool.acquire();
  pool.release(a, { cooldown: true });
  const left = pool.slots()[0].cooldownMs;
  ok(left > 50_000 && left <= 60_000, '撞盾冷却 = 60s（没被轮换改成 5 分钟）', String(left));
  ok(pool.slots()[0].consecutive === 0, '撞盾后计数清零');
}

console.log('⑥ maxUses=0 → 关掉轮换（退回纯 LRU）');
{
  const pool = mk({ capacity: 1, maxUses: 0 });
  for (let i = 0; i < 5; i++) { const s = await pool.acquire(); pool.release(s); }
  ok(pool.slots()[0].cooldownMs === 0, '用完 5 次也不冷却');
  ok(pool.slots()[0].uses === 5, 'uses 照常累加', String(pool.slots()[0].uses));
}

console.log('⑦ 连用计数在轮换后重新开始（不是永久禁用）');
{
  const pool = mk({ capacity: 1 });
  const a = await pool.acquire(); pool.release(a);
  const b = await pool.acquire(); pool.release(b);
  ok(pool.slots()[0].cooldownMs > 0, '第一轮已冷却');
  t += PROFILE_RETIRE_MS + 1000;
  const c = await pool.acquire();
  pool.release(c);
  ok(pool.slots()[0].cooldownMs === 0, '回来后第 1 次不再冷却（计数从 1 开始）');
  const d = await pool.acquire(); pool.release(d);
  ok(pool.slots()[0].cooldownMs > 0, '再连用 2 次又进冷却');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
