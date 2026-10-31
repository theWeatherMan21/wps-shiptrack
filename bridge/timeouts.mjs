// 数值配置的唯一解析入口（纯函数，可单测）。
//
// 为什么单独一个模块：环境变量是用户/LaunchAgent 手写的，写错一个字符
// 裸 Number() 会得到 NaN，然后一路往下传 —— setTimeout(…, NaN) 立刻判超时、
// --timeout NaN 让引擎直接报错、listen(NaN) 退化成随机端口（插件连不上）。
// 这些都不是「报个错给你看」，而是静默变形，所以必须在入口夹一次。

/** 合法正数就用它，否则回默认值（NaN / 0 / 负数 / 空串 / 非数字字符串全回默认） */
export function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 超时配置：默认值 + 上限（上限永远不小于默认，否则夹取会自相矛盾） */
export function resolveTimeouts(env = process.env) {
  const defaultTimeout = num(env.WPS_TRACK_TIMEOUT_MS, 90000);
  const maxTimeout = Math.max(defaultTimeout, num(env.WPS_TRACK_MAX_TIMEOUT_MS, 180000));
  return { defaultTimeout, maxTimeout };
}

/** 单次查询的夹取：非法/缺省 → 默认；正常值夹进 [floor, max] */
export function makeClampTimeout({ defaultTimeout, maxTimeout, floorMs = 3000 }) {
  return (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return defaultTimeout;
    return Math.min(Math.max(n, floorMs), maxTimeout);
  };
}

/** 端口：非整数/越界一律回默认，绝不把 NaN 交给 listen() */
export function resolvePort(env = process.env, fallback = 8791) {
  const n = Number(env.WPS_TRACK_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export function resolveCacheTtl(env = process.env, fallback = 10 * 60 * 1000) {
  return num(env.WPS_TRACK_CACHE_MS, fallback);
}
