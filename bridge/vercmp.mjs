// 版本号比较 —— 唯一实现（App 引擎与 WPS 桥共用，两份文件字节必须一致）
//
// 为什么单独抽出来：11-05 知澜实测 —— engine/wps-addon.mjs 与 bridge/update.mjs 各有一份
//   split('.').map(Number) 的 cmp，'1.0.0-hotfix3' 得到 [1,0,NaN]；NaN !== NaN 成立但相减为 0
//   → 返回 0 → 装 hotfix4 时判 noop，发布等于白干。
//
// 补丁版语义（爹地 10-30 版本号规矩：小修补不升版本位，加 -hotfixN）：
//   ① 先比 主.次.修 三段数字
//   ② 三段相同：补丁版 > 同号正式版（1.0.0-hotfix3 > 1.0.0）—— hotfixN 是这一版发出去之后
//      的第 N 次修补，内容上永远比裸版本新。反过来（正式版 > 补丁版）会出两个事故：
//      · 更新源还停在上一版（远端 1.0.0、本地 hotfix3）时判「有更新」，点一次就把 hotfix 回退掉；
//      · hotfix 永远追不上同号正式版，只能靠升版本位才能发出去，违背爹地的版本号规矩。
//   ③ 同为补丁版：比 N 的数值，不是字符串（hotfix10 > hotfix9）
//   ④ 返回 <0 / 0 / >0，用法同 strcmp
// 容错：'v' 前缀、缺段（1.0 → 1.0.0）、大小写、首尾空白；解析不出来按 0.0.0 处理。
//
// 同步规矩：本文件是两个仓库里唯一的一份实现，改动后必须字节级同步
//   wps-shiptrack/bridge/vercmp.mjs  ⇄  ShipScheduleHub/engine/lib/vercmp.mjs
//   两边测试都会校验 sha256 相等，分叉会直接红。

const VER_RE = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-_ ]?hotfix[-_.]?(\d+))?$/i;

export function parseVer(v) {
  const raw = String(v == null ? '' : v).trim();
  const m = VER_RE.exec(raw);
  if (!m) return { major: 0, minor: 0, patch: 0, hotfix: null, ok: false, raw };
  return {
    major: Number(m[1]),
    minor: Number(m[2] || 0),
    patch: Number(m[3] || 0),
    hotfix: m[4] === undefined ? null : Number(m[4]),
    ok: true,
    raw,
  };
}

export function cmpVer(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  if (pa.hotfix === pb.hotfix) return 0;
  if (pa.hotfix === null) return -1; // 裸版本低于同号补丁版（补丁是发版之后打的）
  if (pb.hotfix === null) return 1;
  return pa.hotfix - pb.hotfix;
}
