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
      const i = line.indexOf(' ');
      if (i < 0) continue;
      const pid = Number(line.slice(0, i));
      const cmd = line.slice(i + 1);
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

/**
 * @param {{root:string, capacity?:number, waitMs?:number, pollMs?:number, log?:(m:string)=>void}} o
 * @returns {{acquire:()=>Promise<object>, release:(s:object)=>void, stats:()=>object, slots:()=>object[]}}
 */
export function makeProfilePool({ root, capacity = 8, waitMs = 12000, pollMs = 120, log = () => {} } = {}) {
  const size = Math.max(1, Math.floor(Number(capacity) || 8));
  const slots = [];
  for (let i = 0; i < size; i++) slots.push({ name: `p${i}`, dir: path.join(root, `p${i}`), busy: false, since: 0, uses: 0 });
  const st = { acquired: 0, waitedMs: 0, dirtySkips: 0, forced: 0 };

  // 后台清场：释放后等 Chrome 退出（最多 5s），然后删残留锁。不阻塞调用方。
  async function sweep(slot) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && pidsUsing(slot.dir).length) await sleep(200);
    if (!pidsUsing(slot.dir).length) removeLocks(slot.dir);
  }

  async function acquire() {
    const t0 = Date.now();
    for (;;) {
      const free = slots.filter((s) => !s.busy);
      if (free.length) {
        for (const s of free) {
          if (isClean(s.dir)) {
            s.busy = true; s.since = Date.now(); s.uses++;
            st.acquired++;
            if (Date.now() - t0 > 0) st.waitedMs += Date.now() - t0;
            if (st.dirtySkips) { log(`[profile] ${s.name} 可用（本次跳过 ${st.dirtySkips} 个未退干净的槽）`); st.dirtySkips = 0; }
            return s;
          }
          st.dirtySkips++;
        }
        if (Date.now() - t0 >= waitMs) {
          const s = free[0];
          const killed = forceClean(s.dir);
          s.busy = true; s.since = Date.now(); s.uses++;
          st.forced++;
          log(`[profile] 等待 ${Math.round((Date.now() - t0) / 1000)}s 仍无干净槽 → 强制清场 ${s.name}（杀残留 ${killed} 个）`);
          return s;
        }
        await sleep(pollMs);
      } else {
        // 池子 ≥ 并发闸门，理论上走不到；真走到就等闸门放槽
        await sleep(pollMs);
      }
    }
  }

  function release(slot) {
    if (!slot) return;
    slot.busy = false;
    sweep(slot).catch(() => {});
  }

  return {
    acquire,
    release,
    slots: () => slots.map((s) => ({ name: s.name, dir: s.dir, busy: s.busy, uses: s.uses })),
    stats: () => ({
      capacity: size, ...st,
      busy: slots.filter((s) => s.busy).length,
      dirty: slots.filter((s) => !s.busy && !isClean(s.dir)).map((s) => s.name),
    }),
  };
}
