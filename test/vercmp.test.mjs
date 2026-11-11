// 版本号比较守门测试（纯函数、不启服务、不连网）
// 跑法：node test/vercmp.test.mjs
//
// 为什么要有它：11-05 实测 —— '1.0.0-hotfix3'.split('.').map(Number) 得 [1,0,NaN]，
// NaN !== NaN 成立但相减为 0，cmp 返回 0 → 插件自更新判「已是最新」，hotfix 发不出去。
// 契约：三段数字 → 补丁版 > 同号正式版（hotfix 是发版后打的）→ 补丁序号按数值比（hotfix10 > hotfix9）。
// 另：本仓 bridge/vercmp.mjs 与 ShipScheduleHub/engine/lib/vercmp.mjs 必须字节一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cmpVer } from '../bridge/vercmp.mjs';

let bad = 0;
const check = (name, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
};
const sgn = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const eq = (a, b, want, label) => check(`${label || ''} ${a} vs ${b} = ${want}`, sgn(cmpVer(a, b)) === want, `实际 ${cmpVer(a, b)}`);

// 三段数字
eq('1.0.1', '1.0.0', 1, '小版本');
eq('0.9.41', '1.0.0', -1, '主版本');
eq('2.0.0', '10.0.0', -1, '数值比不是字符串比');
// 补丁版 > 同号正式版（否则远端还停在 1.0.0 时会把本地 hotfix 判成「可更新」而回退）
eq('1.0.0-hotfix4', '1.0.0', 1, '补丁高于同号正式版');
eq('1.0.0', '1.0.0-hotfix4', -1, '正式版低于同号补丁');
eq('1.0.0-hotfix1', '1.0.0', 1, '一次补丁也比裸版本新');
eq('1.0.1', '1.0.0-hotfix3', 1, '小版本优先于后缀');
// 补丁序号
eq('1.0.0-hotfix4', '1.0.0-hotfix3', 1, '现场：hotfix4 必须判有更新');
eq('1.0.0-hotfix10', '1.0.0-hotfix9', 1, 'hotfix10 > hotfix9');
eq('1.0.0-hotfix9', '1.0.0-hotfix10', -1, 'hotfix9 < hotfix10');
// 同版
for (const v of ['1.0.0', '1.0.0-hotfix4', '0.9.41', '1.0']) eq(v, v, 0, '自反');
// 容错
eq('v1.0.0', '1.0.0', 0, 'v 前缀');
eq('1.0', '1.0.0', 0, '缺段');
eq('1.0.0-HOTFIX4', '1.0.0-hotfix4', 0, '后缀大小写');
eq(' 1.0.0-hotfix4 ', '1.0.0-hotfix4', 0, '空白');

// 反对称 + 传递
const S = ['0.9.41', '1.0.0', '1.0.0-hotfix1', '1.0.0-hotfix3', '1.0.0-hotfix4',
  '1.0.0-hotfix9', '1.0.0-hotfix10', '1.0.1', 'v1.6.5'];
for (const a of S) for (const b of S) {
  const r1 = sgn(cmpVer(a, b)), r2 = sgn(cmpVer(b, a));
  check(`反对称 ${a}/${b}`, r1 === -r2 || (r1 === 0 && r2 === 0), `${r1} vs ${r2}`);
}
for (const a of S) for (const b of S) for (const c of S) {
  if (cmpVer(a, b) <= 0 && cmpVer(b, c) <= 0) check(`传递 ${a}≤${b}≤${c}`, cmpVer(a, c) <= 0);
}

// 与 App 侧那份必须字节一致（不在本机就跳过，不假装通过）
const ENGINE = process.env.SHIP_HUB_DIR || path.join(os.homedir(), 'dev', 'ShipScheduleHub');
const engineFile = path.join(ENGINE, 'engine', 'lib', 'vercmp.mjs');
const mine = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bridge', 'vercmp.mjs');
if (fs.existsSync(engineFile)) {
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  check('两份实现字节一致', h(engineFile) === h(mine), `${engineFile} ≠ ${mine}`);
} else {
  console.log(`SKIP  未找到 ${engineFile}，跳过字节一致校验`);
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 条失败`);
process.exit(bad === 0 ? 0 : 1);
