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

/** 按船司的超时上限（毫秒）。没列出的家走 defaultTimeout。
 *
 * 为什么要这张表（11-12 实测：Hapag 成功 52 次 + 失败 31 次）：
 *   Hapag 成功全部落在 10.4–19.5 秒，**没有一次超过 20 秒**；
 *   失败的耗时分三簇：
 *     8.0–11.3s   官网无此单记录（正常业务，不是故障）
 *     39.5–50.6s  查到订舱但箱号未分配（业务状态，见 hapag.mjs booking-no-container）
 *     93.0s       被桥 90s 砍断 —— 全部注定失败
 *   所以 90 秒对 Hapag 只意味着「多等 70 秒然后失败」，没有第三种结局。
 *
 * 为什么定 55 秒而不是 30 秒（一度按「成功样本最快」定成 30s，被爹地否掉）：
 *   官网回来的任何提单信息都有用，判断它有没有用不是我的权力。
 *   「45GP / not available」=「订舱已建、箱型 45GP、箱号还没分配」，是业务状态信息，
 *   而它要 39.5–50.6 秒才吐出来 —— 30 秒会把它全部砍成「站点无响应」，那是丢信息，不是省时间。
 *   定超时该看「读到信息要多久」，不是「成功的多快」。55s = 覆盖 50.6s + 余量。
 */
export const PER_CARRIER_TIMEOUT = { hapag: 55000 };

/** 取某家的超时上限；没配置就回 fallback（且绝不放大 fallback） */
export function timeoutForCarrier(carrier, fallback) {
  const n = PER_CARRIER_TIMEOUT[String(carrier || '').toLowerCase()];
  return Number.isFinite(n) && n > 0 ? Math.min(n, fallback) : fallback;
}
