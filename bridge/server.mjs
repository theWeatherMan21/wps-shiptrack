#!/usr/bin/env node
// 船期追踪本地桥 —— 把 ShipScheduleHub 的追踪 CLI 包成一个给 WPS 加载项用的 HTTP JSON 接口
//
// 为什么需要它：WPS 加载项跑在 file:// 沙盒里，调不动 Node 进程；只能走 HTTP（技能 wps-addin §7 通路②）。
//
// 用法：node bridge/server.mjs            # 默认 127.0.0.1:8791
//       WPS_TRACK_PORT=8792 node bridge/server.mjs
//
// 接口：
//   GET /health                        -> {ok, repo, port, carriers?}
//   GET  /config?doc=<key>             -> 读该文档上次的列设置（插件记忆，落盘在 ~/.hermes/wps-shiptrack/）
//   POST /config {doc,cfg}             -> 存列设置
//   GET /carriers                      -> 支持哪些船司（识别规则表 + 已装适配器）
//   GET /identify?number=XXX           -> 只做离线识别（船司归属），不联网
//   GET /track?number=XXX[&carrier=]   -> 真查询，返回归一化结果；[&timeout=120000]
//   GET /track-batch?numbers=a,b,c     -> 顺序查（并发 1），NDJSON 流式回传每行结果
//
// 约定：一律 200 + {ok:false,...} 表达业务失败；4xx 只用于参数错。
import http from 'node:http';
import { checkUpdate, applyUpdate } from './update.mjs';
import { profile as netProfile, childEnv, isConnectionLevel } from './net.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Windows 上不能直接 import('C:\\a\\b.mjs')（ESM 只认 file:// URL）——统一走这个
const dynImport = (p) => import(pathToFileURL(p).href);
const REPO = process.env.SSH_REPO
  || path.resolve(os.homedir(), 'Documents', 'trae_projects', 'ShipScheduleHub');
const CLI = path.join(REPO, 'engine/tracking/cli.mjs');
const PORT = Number(process.env.WPS_TRACK_PORT || 8791);
const HOST = process.env.WPS_TRACK_HOST || '127.0.0.1';
const DEFAULT_TIMEOUT = Number(process.env.WPS_TRACK_TIMEOUT_MS || 120000);
const CACHE_TTL = Number(process.env.WPS_TRACK_CACHE_MS || 10 * 60 * 1000);
// 插件配置落盘：WPS 的 PluginStorage 在开发模式加载项里不保证持久，走本地文件最稳
const CFG_DIR = process.env.WPS_TRACK_CONFIG_DIR || path.join(os.homedir(), '.hermes', 'wps-shiptrack');
const MAX_CONCURRENT = Number(process.env.WPS_TRACK_CONCURRENCY || 2);

if (!fs.existsSync(CLI)) {
  console.error(`[bridge] 找不到追踪 CLI: ${CLI}`);
  process.exit(1);
}

// ---------- 动态 import 识别器（纯本地，无网络） ----------
let detectMod = null;
async function detector() {
  if (!detectMod) detectMod = await dynImport(path.join(REPO, 'engine/tracking/detect.mjs'));
  return detectMod;
}

// ---------- 并发闸门 ----------
let running = 0;
const queue = [];
function slot() {
  return new Promise((resolve) => {
    const tryRun = () => {
      if (running < MAX_CONCURRENT) { running++; resolve(() => { running--; if (queue.length) queue.shift()(); }); }
      else queue.push(tryRun);
    };
    tryRun();
  });
}

// ---------- 查询缓存 ----------
const cache = new Map(); // key -> {at, value}
const cacheGet = (k) => { const e = cache.get(k); if (e && Date.now() - e.at < CACHE_TTL) return e.value; return null; };
const cacheSet = (k, v) => { cache.set(k, { at: Date.now(), value: v }); if (cache.size > 500) cache.delete(cache.keys().next().value); };

// ---------- 跑一次 CLI，收 NDJSON ----------
function runCli({ number, carrier, timeoutMs, forceDirect = false }) {
  return new Promise(async (resolve) => {
    const release = await slot();
    const args = [CLI, '--number', number];
    if (carrier) args.push('--carrier', carrier);
    // 让引擎比桥的硬上限早 8s 自己收尾：这样超时能带回 steps（诊断用），而不是被 SIGKILL
    args.push('--timeout', String(Math.max(10000, timeoutMs - 8000)));
    const t0 = Date.now();
    let out = '', err = '', killed = false;
    const child = spawn(process.execPath, args, { cwd: REPO, env: childEnv(forceDirect), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const killTree = (sig) => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, sig);   // 负号 = 整个进程组（含 Chromium 孙进程）
      } catch (e) {
        try { child.kill(sig); } catch (e2) {}
      }
    };
    const timer = setTimeout(() => { killed = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 3000); }, timeoutMs);

    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });

    let settled = false;
    const finish = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      resolve(obj);
    };
    child.on('close', (code) => {
      clearTimeout(timer);
      const evts = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const result = evts.find((e) => e.type === 'track-result');
      const error = evts.find((e) => e.type === 'track-error');
      const started = evts.find((e) => e.type === 'track-started');
      const exit = evts.find((e) => e.type === 'track-exit');
      const ms = Date.now() - t0;

      if (killed) return finish({ ok: false, number, carrier: carrier || started?.carrier || null, error: `超时（${Math.round(timeoutMs / 1000)}s 未出结果）`, timeout: true, ms });
      if (error) return finish({ ok: false, number, carrier: carrier || null, error: error.msg || '追踪器报错', code: error.code, ms });
      if (!result) return finish({ ok: false, number, carrier: carrier || started?.carrier || null, error: `没有结果（exit ${code}）${err ? ': ' + err.trim().slice(0, 200) : ''}`, ms });
      finish({ ...result, detected: started?.detected || null, ms, exitCode: code });
    });
    // 注意：spawn 失败时 Node 会先 'error' 再 'close' —— 用 finish 保证 release 只执行一次
    child.on('error', (e) => finish({ ok: false, number, error: '进程启动失败: ' + e.message, ms: Date.now() - t0 }));
  });
}

if (!detectMod) { /* 惰性 */ }

// ---------- HTTP ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'no-store',
};

// ---------- 列设置持久化 ----------
const cfgFile = (doc) => path.join(CFG_DIR, encodeURIComponent(String(doc || 'default')).slice(0, 120) + '.json');
function readCfg(doc) {
  try { return JSON.parse(fs.readFileSync(cfgFile(doc), 'utf8')); } catch { return null; }
}
function writeCfg(doc, cfg) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(cfgFile(doc), JSON.stringify(cfg, null, 2));
}
// 同一个文件的不同工作表：找不到精确的就退回该文件最近一次
function readCfgLoose(doc) {
  const exact = readCfg(doc);
  if (exact) return { cfg: exact, exact: true };
  const wb = String(doc || '').split('|')[0];
  if (!wb) return { cfg: null, exact: false };
  try {
    const files = fs.readdirSync(CFG_DIR).filter((f) => f.startsWith(encodeURIComponent(wb + '|')));
    let best = null;
    for (const f of files) {
      const st = fs.statSync(path.join(CFG_DIR, f));
      const cfg = readCfg(decodeURIComponent(f.replace(/\.json$/, '')));
      if (cfg && (!best || st.mtimeMs > best.at)) best = { cfg, at: st.mtimeMs };
    }
    return { cfg: best ? best.cfg : null, exact: false };
  } catch { return { cfg: null, exact: false }; }
}
// 网络抖动类错误：自动重试一次（2026-10-23 实测：Maersk/MSC 偶发 ERR_CONNECTION_CLOSED，隔几秒再跑就通）
const TRANSIENT = /ERR_CONNECTION|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|非 JSON|被拦|timeout|超时|net::ERR_/i;
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
const clean = (s) => String(s || '').replace(/[\s\u200b\u3000]/g, '').toUpperCase();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  // 只接受本机页面（WPS 的 file:// 页面发 Origin: null）；浏览器跨站请求一律拒绝
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !/^file:\/\//.test(origin) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return send(res, 403, { ok: false, error: '只接受本机页面调用' });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'wps-shiptrack-bridge', repo: REPO, port: PORT, concurrency: MAX_CONCURRENT, busy: running, cached: cache.size });
  }

  if (url.pathname === '/net') {
    try { return send(res, 200, { ok: true, ...(await netProfile(url.searchParams.get('refresh') === '1')) }); }
    catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/update/check') {
    try { return send(res, 200, await checkUpdate()); }
    catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/update/apply' && req.method === 'POST') {
    // 自定义头 = 浏览器跨站「简单请求」带不了。
    // file:// 的 WPS 面板（Origin: null）允许无头调用 —— 兼容旧版面板；本机 http 页面必须带头。
    const fromFilePage = !origin || origin === 'null' || /^file:\/\//i.test(String(origin));
    if (req.headers['x-shiptrack'] !== '1' && !fromFilePage) {
      return send(res, 403, { ok: false, error: '缺少 X-Shiptrack 头（本机网页不允许触发更新）' });
    }
    try { return send(res, 200, await applyUpdate()); }
    catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/config') {
    const doc = url.searchParams.get('doc') || '';
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (b) => {
        body += b;
        if (body.length > 64 * 1024) { try { req.destroy(); } catch (e) {} send(res, 413, { ok: false, error: 'body 太大' }); }
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          if (!j.doc) return send(res, 400, { ok: false, error: '缺 doc' });
          writeCfg(j.doc, j.cfg || {});
          send(res, 200, { ok: true, saved: j.doc });
        } catch (e) {
          send(res, 200, { ok: false, error: String(e.message || e) });
        }
      });
      return;
    }
    const r = readCfgLoose(doc);
    return send(res, 200, { ok: true, doc, cfg: r.cfg, exact: r.exact });
  }

  if (url.pathname === '/carriers') {
    try {
      const d = await detector();
      const idmod = await dynImport(path.join(REPO, 'engine/tracking/identify.mjs'));
      const live = (await dynImport(path.join(REPO, 'engine/tracking/registry.mjs'))).availableCarriers();
      const carriers = (d.CARRIERS || idmod.CARRIERS || []).map((c) => ({
        id: c.id, name: c.name, live: live.includes(c.id), tracking: c.tracking,
      }));
      return send(res, 200, { ok: true, count: carriers.length, liveCount: carriers.filter((c) => c.live).length, carriers });
    } catch (e) {
      return send(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (url.pathname === '/identify') {
    const number = clean(url.searchParams.get('number'));
    if (!number) return send(res, 400, { ok: false, error: '缺 number' });
    try {
      const d = await detector();
      return send(res, 200, { ok: true, number, ...d.detectCarrier(number), shape: d.describeShape(number) });
    } catch (e) { return send(res, 200, { ok: false, number, error: String(e.message || e) }); }
  }

  if (url.pathname === '/track') {
    const number = clean(url.searchParams.get('number'));
    const carrier = clean(url.searchParams.get('carrier')) || '';
    const timeoutMs = Math.min(Math.max(Number(url.searchParams.get('timeout') || DEFAULT_TIMEOUT), 3000), DEFAULT_TIMEOUT);
    if (!number) return send(res, 400, { ok: false, error: '缺 number' });
    const key = number + '|' + carrier;
    const hit = cacheGet(key);
    if (hit) return send(res, 200, { ...hit, cached: true });
    const t0 = Date.now();
    let r = await runCli({ number, carrier, timeoutMs });
    const elapsed = Date.now() - t0;
    const hardDown = r.error && /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(String(r.error));
    // 连接不上（断网 / 代理没开）→ 立刻重试毫无意义，只是再开一个浏览器空烧
    if (!r.ok && r.error && TRANSIENT.test(r.error) && !r.timeout && elapsed < 60000) {
      // 连接级失败：先判断是不是「网络姿势」问题 —— 换个极性（走代理 ⇄ 强制直连）再试一次
      const conn = isConnectionLevel(r.error);
      const net = await netProfile().catch(() => null);
      const direct = !!(net && net.proxyOn);
      console.error(`[bridge] 重试 ${number}（首次: ${String(r.error).slice(0, 80)}）${conn ? ` → 换极性 forceDirect=${direct}` : ''}`);
      r = await runCli({ number, carrier, timeoutMs, forceDirect: conn ? direct : false });
      r.retried = true;
      if (conn) r.netRetriedWith = direct ? 'direct' : 'proxy';
    }
    if (r.ok) cacheSet(key, r);
    return send(res, 200, { ...r, cached: false });
  }

  if (url.pathname === '/track-batch') {
    const numbers = (url.searchParams.get('numbers') || '').split(/[,\s]+/).map(clean).filter(Boolean).slice(0, 200);
    if (!numbers.length) return send(res, 400, { ok: false, error: '缺 numbers' });
    const timeoutMs = Math.min(Math.max(Number(url.searchParams.get('timeout') || DEFAULT_TIMEOUT), 3000), DEFAULT_TIMEOUT);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', ...CORS });
    for (const n of numbers) {
      const key = n + '|';
      const hit = cacheGet(key);
      const r = hit ? { ...hit, cached: true } : await runCli({ number: n, carrier: '', timeoutMs });
      if (!hit && r.ok) cacheSet(key, r);
      res.write(JSON.stringify(r) + '\n');
    }
    return res.end();
  }

  send(res, 404, { ok: false, error: '未知路径: ' + url.pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening http://${HOST}:${PORT}  repo=${REPO}`);
});
