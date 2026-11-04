// 自更新的「降级保护」守门测试（不启服务、不连真网，全 mock）
// 跑法：node test/update-guard.test.mjs
//
// 为什么要有它：11-05 实测 —— 远端 release 的 manifest 还停在 1.0.0（hotfix4 未发布），
//   本地已装 1.0.0-hotfix3。修好 cmp 之后 cmp('1.0.0','1.0.0-hotfix3') > 0，
//   于是「安装/更新」会把爹地已经用上的 hotfix 回退成正式版。
// 契约：远端版本低于本地 → hasUpdate=false、remote.isOlder=true，applyUpdate 直接拒绝，不下载不落盘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let bad = 0;
const check = (name, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
};

// 1) 先把 HOME 挪到临时目录，并写一份「本地已装 hotfix3」的可读缓存
//    （update.mjs 顶层就取了 os.homedir()，所以必须在 import 之前改环境）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shiptrack-guard-'));
process.env.HOME = TMP;
process.env.WPS_UPDATE_URL = 'https://example.invalid/wps-latest';
delete process.env.WPS_UPDATE_DIR;
fs.mkdirSync(path.join(TMP, '.hermes', 'wps-shiptrack'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, '.hermes', 'wps-shiptrack', 'installed.json'),
  JSON.stringify({ version: '1.0.0-hotfix3', installedAt: '2026-11-03T07:23:16Z' })
);

// 2) mock fetch：只回 manifest，记录被请求过的 URL
let manifest = { version: '1.0.0', file: 'shiptrack-1.0.0.tar.gz', sha256: 'x', size: 1 };
const hits = [];
globalThis.fetch = async (url) => {
  hits.push(String(url));
  return { ok: true, status: 200, json: async () => manifest, arrayBuffer: async () => new ArrayBuffer(0) };
};

const { checkUpdate, applyUpdate } = await import('../bridge/update.mjs');

// 3) 远端旧于本地 → 不报更新、标记 isOlder
let r = await checkUpdate();
check('远端 1.0.0 < 本地 1.0.0-hotfix3 → hasUpdate 应为 false', r.hasUpdate === false, JSON.stringify(r));
check('…且 remote.isOlder = true', r.remote && r.remote.isOlder === true, JSON.stringify(r.remote));
check('…且 reason 说明「更新源落后」', /更新源落后/.test(r.reason || ''), String(r.reason));

// 4) applyUpdate 必须拒绝，且不进入下载
hits.length = 0;
let a = await applyUpdate();
check('applyUpdate 拒绝降级', a.ok === false && /拒绝降级/.test(a.error || ''), JSON.stringify(a));
check('…且只拉了 manifest 一次（没有下载安装包）', hits.length === 1, JSON.stringify(hits));

// 5) 正常前进：远端 hotfix4 > 本地 hotfix3 → 报有更新、不标 isOlder
manifest = { version: '1.0.0-hotfix4', file: 'shiptrack-1.0.0-hotfix4.tar.gz', sha256: 'y', size: 2 };
r = await checkUpdate();
check('远端 hotfix4 > 本地 hotfix3 → hasUpdate 应为 true', r.hasUpdate === true, JSON.stringify(r));
check('…且不标 isOlder', !(r.remote && r.remote.isOlder), JSON.stringify(r.remote));

// 6) 同版 → 不算更新（现场：远端 hotfix3、本地 hotfix3 时不能反复提示）
manifest = { version: '1.0.0-hotfix3', file: 'x.tar.gz', sha256: 'z', size: 3 };
r = await checkUpdate();
check('同版 → hasUpdate=false 且不是 isOlder', r.hasUpdate === false && !r.remote.isOlder, JSON.stringify(r));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(bad ? `\n❌ ${bad} 项失败` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
