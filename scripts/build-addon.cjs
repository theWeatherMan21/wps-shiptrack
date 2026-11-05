// 免交互构建：vite build → 同步到 wps-addon-build/
//
// 为什么不用 `wpsjs build`：它是 inquirer 交互菜单（选在线/离线），非 TTY / CI / 脚本里必崩
// ERR_USE_AFTER_CLOSE。这里直接跑 vite，再把 dist 摊进 wps-addon-build —— 结果与
// 「wpsjs build 选 online」一致（index.html + assets + manifest.xml + ribbon.xml）。
//
// 拆仓时这个脚本丢了（只留下 install-verify.sh 引用它所在的目录），
// 于是 `node scripts/build-addon.cjs online` 报 MODULE_NOT_FOUND，而 wps-addon-build
// 还停在上一版 —— 装机校验会拿旧产物装出新版本号，属于最坏的一种「装上了但没生效」。
//
// 用法：node scripts/build-addon.cjs [online]
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'wps-addon-build');
// 这些是加载项骨架，不由 vite 产出，同步时必须保留
const KEEP = ['manifest.xml', 'ribbon.xml', 'images', 'favicon.ico'];

const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  console.error(`❌ 找不到 vite：${viteBin}（先 npm install）`);
  process.exit(1);
}

console.log('== 1) vite build ==');
execFileSync(process.execPath, [viteBin, 'build'], { cwd: ROOT, stdio: 'inherit' });

console.log('== 2) 同步 dist → wps-addon-build（保留 manifest/ribbon）==');
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`❌ ${DIST} 里没有 index.html，vite 没产出？`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
// 先清 assets：不清会把上一版带哈希的 chunk 留在目录里，WPS 可能加载到旧文件
fs.rmSync(path.join(OUT, 'assets'), { recursive: true, force: true });
for (const f of fs.readdirSync(DIST)) {
  fs.cpSync(path.join(DIST, f), path.join(OUT, f), { recursive: true });
}

console.log('== 3) 自检 ==');
const missing = KEEP.filter((f) => !fs.existsSync(path.join(OUT, f)));
if (missing.length) {
  console.error(`❌ wps-addon-build 缺骨架文件：${missing.join(', ')}（这些不由 vite 产出，得从源里补）`);
  process.exit(1);
}
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/assets\/[A-Za-z0-9_-]+\.(?:js|css)/g)].map((m) => m[0]);
const lost = refs.filter((r) => !fs.existsSync(path.join(OUT, r)));
if (!refs.length || lost.length) {
  console.error(`❌ index.html 引用的资源不存在：${lost.join(', ') || '(没解析到引用)'}`);
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// 版本串未必在入口 chunk 里：任务窗格是动态 import 的独立 chunk（TaskPane-*.js），
// 只扫 index.html 引到的那个文件会报「未注入」——那是自检写窄了，不是版本没注入。
const allJs = fs.readdirSync(path.join(OUT, 'assets')).filter((f) => f.endsWith('.js'));
const hitVer = allJs.some((f) => {
  try { return fs.readFileSync(path.join(OUT, 'assets', f), 'utf8').includes(pkg.version); } catch (e) { return false; }
});
console.log(`  入口：${refs.join(' , ')}`);
console.log(`  版本串 ${pkg.version} ${hitVer ? '已注入 ✓' : '⚠️ 未在入口 chunk 里找到（检查 vite define __APP_VERSION__）'}`);
console.log('✅ wps-addon-build 就绪');
