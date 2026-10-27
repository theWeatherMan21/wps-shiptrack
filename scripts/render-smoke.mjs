#!/usr/bin/env node
// 渲染冒烟：把构建产物用浏览器真实加载一遍，抓 pageerror / console.error，并检查关键控件都在。
//
// 为什么必须有这一步：2026-10-26 的 colLetter 事故——模板里调用了模块级函数，
// 单测/逻辑探针全绿，面板却在用户点「① 选单号列」之后整块崩掉。
// 逻辑测试看不见模板层，只有真渲染才看得见。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NODE_PATH = process.env.NODE_PATH || '';
const { chromium } = require(NODE_PATH ? path.join(NODE_PATH, 'playwright') : 'playwright');
import { STUB } from '.././scripts/lib/wps-stub.mjs';

const ROOT = path.resolve(process.argv[2] || './wps-addon-build');
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.log(`✗ 没有构建产物: ${ROOT}（先跑 scripts/build.cjs online）`);
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 520, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

// 复用状态机探针的同一套桩（scripts/lib/wps-stub.mjs）——两套桩行为不一致会骗人
await page.addInitScript(STUB, {});   // 必须传参：STUB 是解构参数，无参会抛 reading 'doc'

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(1500);

const checks = [];
const need = ['选单号列', '选输出列', '立即刷新'];
for (const label of need) {
  const ok = await page.getByRole('button', { name: new RegExp(label) }).count() > 0;
  checks.push([`按钮「${label}」存在`, ok]);
}

// 关键一步：点「选单号列」→ 触发 detectHeaderCols / 模板里的港口列显示（colLetter 那次就崩在这里）
try {
  await page.getByRole('button', { name: /选单号列/ }).click({ timeout: 8000 });
  await page.waitForTimeout(1200);
  checks.push(['点「选单号列」后面板仍存活', !errors.length]);
  const body = await page.evaluate(() => document.body.innerText);
  checks.push(['面板仍渲染出步骤区', body.includes('单号列')]);
  checks.push(['港口列状态可见', /起运\/目的港列/.test(body)]);
} catch (e) {
  checks.push(['点「选单号列」后面板仍存活', false]);
}

await browser.close();
srv.close();

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? '✅' : '❌'} ${name}`); }
if (errors.length) { console.log('\n渲染期报错：'); errors.slice(0, 6).forEach((e) => console.log('  ' + e)); }
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
