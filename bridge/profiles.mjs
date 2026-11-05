// 并发查询的 Chrome 档案池 —— 保证每个并发槽拿到「确认没有残留进程」的独立 profile
//
// 为什么需要（2026-11-05 爹地真机 + 知澜对照实验）：
//   旧实现是 `(PROFILE_SEQ++) % MAX_CONCURRENT` 轮转发槽。子进程 'close' 只代表 node 退出，
//   Chromium 孙进程还在收尾（写档案、释放 Singleton 锁）。下一个请求分到同一个 profile 时，
//   Playwright 直接报 "Target page, context or browser has been closed"；而引擎的兜底
//   又会把「另一个进程正在用」的 Chrome SIGKILL 掉 —— 两边一起挂。
//   实测：不隔离 profile 并发 4 → 1 个失败；每进程独立 profile 并发 6 → 5/6 成功。
//   截图里同一个号第一次 5.1s 待手工、第二次 15.2s 成功，就是「撞上就挂、没撞上就过」。
//
// 做法：
//   ① 池子开大到 2× 并发（默认 8 个槽），轮转不再必然回到刚用过的槽；
//   ② **每次分配都现场验证**：锁指向的 Chrome 进程还活着 → 这个槽不算干净，晾着等它退；
//      锁是残留（pid 已死）→ 当场清掉；没锁 → 再确认没有进程带这个 user-data-dir；
//   ③ 全都脏且等到超时才强杀残留（最后一道，正常永远走不到）；
//   ④ 释放不阻塞调用方：后台等进程退完再清锁，加速下一次分配。
//
// ★ 2026-11-05 卡 t_991b99f7（OOCL 连查串行场景没救）：
//   上面那套只解决了「并发抢锁」，串行场景（同船司，见 sched.mjs）永远取到数组第一个干净槽
//   p0 → 同一个 Chrome 档案连查 2 次就撞会话级风控（OOCL 实测：同档案第 2 次必被拦）。
//   所以分配改成 **LRU（最久未用）+ 槽级冷却**：
//     · 选槽 = `!busy && isClean && now >= cooldownUntil` 里 lastUsed 最小的那个；
//       从没用过的槽 lastUsed=0 → 天然最先铺开（第一次仍是 p0）。
//     · 撞盾（release(slot,{cooldown:true})）→ 该槽冷却 N 毫秒（默认 60s，env 可调）。
//     · **冷却只在「还有别的可用槽」时生效**：全都在冷却 / 全脏就降级给 lastUsed 最小的干净槽，
//       绝不新增等待、绝不死锁 —— 单查询场景不允许因为冷却变慢。
//
// 只碰 <root>/p* 这些桥自己的档案目录，绝不碰爹地日常 Chrome。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOCKS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const IS_WIN = process.platform === 'win32';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};

/** SingletonLock 是指向 "<hostname>-<pid>" 的符号链接；读不到 pid 返回 0 */
function lockPid(dir) {
  try {
    const t = fs.readlinkSync(path.join(dir, 'SingletonLock'));
    const m = String(t).match(/-(\d+)$/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

const hasLocks = (dir) => LOCKS.some((n) => { try { fs.lstatSync(path.join(dir, n)); return true; } catch { return false; } });

/** 删锁：macOS/Linux 上是符号链接；Windows 上可能是普通文件/目录 */
export function removeLocks(dir) {
  let n = 0;
  for (const name of LOCKS) {
    const p = path.join(dir, name);
    try { fs.rmSync(p, { recursive: true, force: true }); n++; } catch { /* 不存在或删不掉 */ }
  }
  return n;
}

/** 列出命令行里带本档案目录的 Chrome 进程（ps 全量扫 + 子串精确匹配，不依赖 pgrep）
 *  不用 pgrep -f：pattern 本身含目录名 → pgrep 会匹配到承载它的 shell，永远「有进程占用」。 */
export function pidsUsing(dir, { includeHelpers = true } = {}) {
  try {
    if (IS_WIN) {
      const esc = String(dir).replace(/'/g, "''");
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { $_.ProcessId }`;
      const b64 = Buffer.from(ps, 'utf16le').toString('base64');
      const out = String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8', timeout: 15000 }) || '').trim();
      return out ? out.split(/\s+/).map(Number).filter((x) => Number.isFinite(x) && x > 0) : [];
    }
    const out = String(execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', timeout: 8000 }) || '');
    const hit = [];
    for (const line of out.split('\n')) {
      // ★ 卡 t_991b99f7：ps 的 pid 是右对齐的（`" 5727 /Users/…"`），旧写法按第一个空格切 ⇒ pid=0 ⇒
      //   这个函数永远返回空数组（「没有锁但有进程占着」这条检测形同虚设，单测 ④ 在 HEAD 上一直红）。
      const m = /^\s*(\d+)\s+(\S.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2];
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!cmd.includes(dir)) continue;
      if (!includeHelpers && /Helper|crashpad/.test(cmd)) continue;
      hit.push(pid);
    }
    return hit;
  } catch { return []; }
}

/** 这个槽现在能不能直接用：没有活着的 Chrome 占着它 */
export function isClean(dir) {
  if (!fs.existsSync(dir)) return true;          // 首次用：Playwright 会建
  const pid = lockPid(dir);
  if (pid && alive(pid)) return false;           // 锁指向的 Chrome 还在跑（正在收尾也算）
  if (hasLocks(dir)) removeLocks(dir);            // 锁是残留（pid 已死）→ 清掉
  // 锁被删过 / 平台不写锁 → 再确认一遍没有进程带这个目录
  return pidsUsing(dir).length === 0;
}

/** 强制清场：杀掉占着这个档案的 Chrome（含 Helper），再删锁。只在池子全脏且等超时后用。 */
export function forceClean(dir) {
  const pids = new Set(pidsUsing(dir));
  const lockP = lockPid(dir);
  if (lockP && alive(lockP)) pids.add(lockP);   // 锁指向的进程也算（命令行可能不带目录）
  pids.delete(process.pid);                     // 绝不自杀
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  if (!fs.existsSync(dir)) return pids.size;
  removeLocks(dir);
  return pids.size;
}

/** 槽级冷却默认时长：撞盾后这个 Chrome 档案歇一会儿再用（OOCL 实测 4 分钟足够，60s 起步）
 *  env: WPS_TRACK_PROFILE_COOLDOWN_MS（0 = 关掉冷却，退回纯 LRU） */
export const PROFILE_COOLDOWN_MS = 60 * 1000;
export function resolveCooldownMs(env = process.env) {
  const raw = Number(env && env.WPS_TRACK_PROFILE_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : PROFILE_COOLDOWN_MS;
}

/**
 * @param {{root:string, capacity?:number, waitMs?:number, pollMs?:number,
 *          cooldownMs?:number, now?:()=>number, log?:(m:string)=>void}} o
 * @returns {{acquire:()=>Promise<object>, release:(s:object,o?:{cooldown?:boolean})=>void, stats:()=>object, slots:()=>object[]}}
 */
export function makeProfilePool({
  root, capacity = 8, waitMs = 12000, pollMs = 120,
  cooldownMs = resolveCooldownMs(), now = Date.now, log = () => {},
} = {}) {
  const size = Math.max(1, Math.floor(Number(capacity) || 8));
  const coolMs = Math.max(0, Math.floor(Number(cooldownMs) || 0));
  const clock = typeof now === 'function' ? now : Date.now;
  const slots = [];
  for (let i = 0; i < size; i++) {
    slots.push({
      name: `p${i}`, dir: path.join(root, `p${i}`), busy: false, since: 0, uses: 0,
      lastUsed: 0,        // 上次 acquire/release 的时刻（LRU 排序依据；0 = 从没用过）
      cooldownUntil: 0,   // 冷却到期时刻，now < 它 → 这个槽暂时别用
    });
  }
  const st = { acquired: 0, waitedMs: 0, dirtySkips: 0, forced: 0 };

  // 后台清场：释放后等 Chrome 退出（最多 5s），然后删残留锁。不阻塞调用方。
  async function sweep(slot) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && pidsUsing(slot.dir).length) await sleep(200);
    if (!pidsUsing(slot.dir).length) removeLocks(slot.dir);
  }

  function take(s) {
    s.busy = true; s.since = clock(); s.uses++; s.lastUsed = clock();
    st.acquired++;
    return s;
  }

  async function acquire() {
    const t0 = Date.now();
    for (;;) {
      const free = slots.filter((s) => !s.busy);
      if (free.length) {
        // LRU：lastUsed 最小的先挑（全 0 时靠 sort 稳定性保持 p0→p7 的顺序，首次仍是 p0）
        const order = free.slice().sort((a, b) => a.lastUsed - b.lastUsed);
        const t = clock();
        const ready = order.filter((s) => s.cooldownUntil <= t);
        const cooling = order.filter((s) => s.cooldownUntil > t);
        // 第一轮：不在冷却的槽，第一个干净的就给它
        for (const s of ready) {
          if (isClean(s.dir)) {
            const slot = take(s);
            if (Date.now() - t0 > 0) st.waitedMs += Date.now() - t0;
            if (st.dirtySkips) { log(`[profile] ${s.name} 可用（本次跳过 ${st.dirtySkips} 个未退干净的槽）`); st.dirtySkips = 0; }
            return slot;
          }
          st.dirtySkips++;
        }
        // 第二轮：全都在冷却（或只剩冷却槽干净）→ 降级直接给最久未用的干净槽，**不等待**
        for (const s of cooling) {
          if (isClean(s.dir)) {
            const slot = take(s);
            const left = Math.max(0, Math.round((s.cooldownUntil - t) / 1000));
            log(`[profile] 没有可用新槽 → 降级复用 ${s.name}（冷却还剩 ${left}s，不等待）`);
            if (Date.now() - t0 > 0) st.waitedMs += Date.now() - t0;
            if (st.dirtySkips) st.dirtySkips = 0;
            return slot;
          }
          st.dirtySkips++;
        }
        // 一个干净槽都没有 → 等，等到 waitMs 才强清（原有行为，冷却不许把这条路径拖长）
        if (Date.now() - t0 >= waitMs) {
          const s = free[0];
          const killed = forceClean(s.dir);
          const slot = take(s);
          slot.cooldownUntil = 0;   // 火线救急用完就别再压着它
          st.forced++;
          log(`[profile] 等待 ${Math.round((Date.now() - t0) / 1000)}s 仍无干净槽 → 强制清场 ${s.name}（杀残留 ${killed} 个）`);
          return slot;
        }
        await sleep(pollMs);
      } else {
        // 池子 ≥ 并发闸门，理论上走不到；真走到就等闸门放槽
        await sleep(pollMs);
      }
    }
  }

  /** @param {object} slot  @param {{cooldown?:boolean}} [o] cooldown=true → 这个槽冷却一会儿（撞盾换槽用） */
  function release(slot, o = {}) {
    if (!slot) return;
    slot.busy = false;
    slot.lastUsed = clock();
    if (o && o.cooldown && coolMs > 0) {
      slot.cooldownUntil = slot.lastUsed + coolMs;
      log(`[profile] ${slot.name} 撞盾 → 冷却 ${Math.round(coolMs / 1000)}s`);
    }
    sweep(slot).catch(() => {});
  }

  return {
    acquire,
    release,
    slots: () => slots.map((s) => ({
      name: s.name, dir: s.dir, busy: s.busy, uses: s.uses,
      lastUsed: s.lastUsed,
      cooldownMs: Math.max(0, s.cooldownUntil - clock()),   // 剩余冷却，0 = 可用
    })),
    stats: () => {
      const t = clock();
      return {
        capacity: size, ...st,
        busy: slots.filter((s) => s.busy).length,
        dirty: slots.filter((s) => !s.busy && !isClean(s.dir)).map((s) => s.name),
        cooling: slots.filter((s) => s.cooldownUntil > t).map((s) => s.name),
        cooldownMs: coolMs,
      };
    },
  };
}
