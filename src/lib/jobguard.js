// 派活执行的三条护栏（卡 t_aa0674a9 第二步）—— 纯函数，组件只调用、不自己判
//
// 为什么单独抽出来：这三条是知澜定的验收条件，写在组件里就只能靠真机碰运气验；
// 抽成纯函数就能单测，而且以后改判据只改一处。
//
// 三条（原文）：
//   ① 领到活但 WPS 表格已经不是那个 doc 了 → 不许写，直接 report {state:'failed', error:'doc 已切换'}
//   ② 回填中途报错 → 已写的行保留，report 里报 written 实际数，剩余标 failed
//   ③ 心跳领活失败（桥不通）→ 静默重试，不弹窗、不打断用户正在编辑的单元格

/** ① 开工前：当前表还是派活时那张吗？ */
export function decideBeforeRun({ currentDoc = '', specDoc = '', cols = {} } = {}) {
  if (!specDoc) return { proceed: false, reason: 'spec 缺 doc', report: { state: 'failed', error: 'spec 缺 doc' } };
  if (String(currentDoc) !== String(specDoc)) {
    return {
      proceed: false,
      reason: 'doc 已切换',
      report: { state: 'failed', error: 'doc 已切换' },
    };
  }
  const number = Number(cols.number || 0);
  const out = Number(cols.out || 0);
  if (!number || !out) {
    return { proceed: false, reason: '列未配置', report: { state: 'failed', error: '列未配置（number/out 都要选）' } };
  }
  return { proceed: true, reason: '', report: null };
}

/** ② 收尾：把实际战果算成要给桥的 report（中途炸了也走这里，别把已写的算成没写） */
export function summarizeRun({ ok = 0, failed = 0, written = 0, total = 0, skipped = 0, interrupted = false, error = '' } = {}) {
  const o = Math.max(0, Number(ok) || 0);
  const w = Math.max(0, Number(written) || 0);
  const t = Math.max(0, Number(total) || 0);
  const s = Math.max(0, Number(skipped) || 0);
  // 中途炸了：没跑到的行算 failed，但**绝不把已写的抹掉**
  const f = interrupted ? Math.max(Number(failed) || 0, t - o - s) : Math.max(0, Number(failed) || 0);
  // skipped = 空行 / 不是单号的行：正常跳过，不算失败，但必须计入「已处理」，
  // 否则 ok+failed 永远小于 total（遍历 14 行、只有 13 行有号）→ 进度条停在 13/14。
  const out = { ok: o, failed: f, written: w, total: t, skipped: s, done: o + f + s, state: interrupted ? 'failed' : 'done' };
  if (error) out.error = String(error).slice(0, 300);
  return out;
}

/** ③ 该不该在这个心跳里领活（静默原则：任何一条不满足就静默跳过，不打扰用户） */
export function shouldClaim({ jobBusy = false, userBusy = false, flushing = false, bridgeUp = false, currentDoc = '' } = {}) {
  if (jobBusy) return false;       // 已经有一个派活在跑
  if (userBusy) return false;      // 用户自己点的批次在跑，别抢
  if (flushing) return false;      // 正在补写暂存
  if (!bridgeUp) return false;     // 桥没连上
  if (!currentDoc) return false;   // 没有活动工作表
  return true;
}

/** 进度上报该不该带 state：中途只报进度，只有收尾才改状态（否则会把任务提前标完成） */
export function isProgressOnly() {
  return true;
}
