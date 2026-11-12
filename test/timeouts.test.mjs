// 数值配置解析的守门测试（纯函数、毫秒级、不启服务、不连网）。
// 跑法：node test/timeouts.test.mjs
//
// 为什么要有它：环境变量是手写的，写错一个字符（WPS_TRACK_TIMEOUT_MS=abc）
// 裸 Number() 会得 NaN 并一路静默变形 —— setTimeout(…, NaN) 立刻判超时、
// --timeout NaN 引擎报错、listen(NaN) 随机端口导致插件连不上。
import {
  num, resolveTimeouts, makeClampTimeout, resolvePort, resolveCacheTtl,
  timeoutForCarrier, PER_CARRIER_TIMEOUT,
} from '../bridge/timeouts.mjs';

let bad = 0;
const check = (name, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
};

// ① num：非法输入一律回默认
for (const [raw, want, label] of [
  [undefined, 90000, '缺省'], [null, 90000, 'null'], ['', 90000, '空串'],
  ['abc', 90000, '非数字'], [0, 90000, '0'], [-5, 90000, '负数'],
  ['30000', 30000, '数字串'], [150000, 150000, '正数'],
]) {
  const got = num(raw, 90000);
  check(`num(${JSON.stringify(raw)}) → ${want}（${label}）`, got === want, `实得 ${got}`);
}

// ② 环境变量写错：整条链必须保持有限数（这条是本次修的根因）
{
  const normal = resolveTimeouts({});
  check('env 缺省 → 90000/180000', normal.defaultTimeout === 90000 && normal.maxTimeout === 180000,
    JSON.stringify(normal));

  const badMax = resolveTimeouts({ WPS_TRACK_MAX_TIMEOUT_MS: 'abc' });
  check('WPS_TRACK_MAX_TIMEOUT_MS=abc → 上限仍是有限数',
    Number.isFinite(badMax.maxTimeout) && badMax.maxTimeout === 180000, JSON.stringify(badMax));

  const badDefault = resolveTimeouts({ WPS_TRACK_TIMEOUT_MS: 'abc' });
  check('WPS_TRACK_TIMEOUT_MS=abc → 默认仍是有限数',
    Number.isFinite(badDefault.defaultTimeout) && badDefault.defaultTimeout === 90000, JSON.stringify(badDefault));

  const bothBad = resolveTimeouts({ WPS_TRACK_TIMEOUT_MS: 'abc', WPS_TRACK_MAX_TIMEOUT_MS: 'xyz' });
  check('两个 env 都写错 → 两个都有限数',
    Number.isFinite(bothBad.defaultTimeout) && Number.isFinite(bothBad.maxTimeout), JSON.stringify(bothBad));

  // 上限不许小于默认，否则夹取自相矛盾（min 会赢，默认值永远拿不到）
  const inverted = resolveTimeouts({ WPS_TRACK_TIMEOUT_MS: '120000', WPS_TRACK_MAX_TIMEOUT_MS: '60000' });
  check('上限 < 默认时自动抬高到默认（不自相矛盾）',
    inverted.maxTimeout >= inverted.defaultTimeout && inverted.maxTimeout === 120000, JSON.stringify(inverted));
}

// ③ clampTimeout：入参各种形态
{
  const { defaultTimeout, maxTimeout } = resolveTimeouts({});
  const clamp = makeClampTimeout({ defaultTimeout, maxTimeout });
  for (const [raw, want] of [
    [undefined, 90000], [null, 90000], ['', 90000], ['abc', 90000], [0, 90000],
    [30000, 30000], [150000, 150000], [999999, 180000], [100, 3000], ['150000', 150000],
  ]) {
    const got = clamp(raw);
    check(`clampTimeout(${JSON.stringify(raw)}) → ${want}`, got === want, `实得 ${got}`);
  }
}

// ④ 端口：NaN 绝不能交给 listen()
for (const [raw, want, label] of [
  [undefined, 8791, '缺省'], ['abc', 8791, '非数字'], [70000, 8791, '越界'],
  [0, 8791, '0'], [8792, 8792, '正常'], ['8792', 8792, '数字串'],
]) {
  const got = resolvePort({ WPS_TRACK_PORT: raw });
  check(`resolvePort(${JSON.stringify(raw)}) → ${want}（${label}）`, got === want, `实得 ${got}`);
}
check('resolveCacheTtl(abc) → 有限数', Number.isFinite(resolveCacheTtl({ WPS_TRACK_CACHE_MS: 'abc' })));


// ⑤ 按船司超时（11-12 加）：Hapag 30s，其余家不受影响，且绝不放大 fallback
{
  check('Hapag 收紧到 55s', timeoutForCarrier('hapag', 90000) === 55000, String(timeoutForCarrier('hapag', 90000)));
  check('大写 HAPAG 同样收紧', timeoutForCarrier('HAPAG', 90000) === 55000, String(timeoutForCarrier('HAPAG', 90000)));
  check('Maersk 不受影响', timeoutForCarrier('maersk', 90000) === 90000);
  check('未知家回 fallback', timeoutForCarrier('nosuch', 90000) === 90000);
  check('空串回 fallback', timeoutForCarrier('', 90000) === 90000);
  check('null 回 fallback', timeoutForCarrier(null, 90000) === 90000);
  // 保命条：fallback 比表里还小的时候不许放大（调用方已经自己夹过一次了）
  check('不放大 fallback', timeoutForCarrier('hapag', 20000) === 20000, String(timeoutForCarrier('hapag', 20000)));
  check('Hapag 值就是 55000', PER_CARRIER_TIMEOUT.hapag === 55000);
  // 依据（爹地 11-12 定的原则）：官网返回的任何信息都有用，超时要够读到它，不是够读到「成功」。
  // 「45GP / not available」要 39.5–50.6s 才出来 —— 低于 51s 就会把这批信息砍成「站点无响应」。
  check('Hapag 值覆盖 not available 上界 50.6s', PER_CARRIER_TIMEOUT.hapag >= 51000, String(PER_CARRIER_TIMEOUT.hapag));
  check('Hapag 值不低于成功上界 20s', PER_CARRIER_TIMEOUT.hapag >= 20000);
}

console.log(bad === 0 ? '\n全部通过' : `\n失败 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
