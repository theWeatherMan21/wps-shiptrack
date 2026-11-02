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
//   GET /track-batch?numbers=a,b,c     -> 批量查（同船司串行 / 跨船司并行），NDJSON 流式回传每行结果
//
// 约定：一律 200 + {ok:false,...} 表达业务失败；4xx 只用于参数错。
import http from 'node:http';
import { makeKeyedMutex } from './sched.mjs';
import { Ledger, toRecord, isCooldownKind, COOLDOWN_DEFAULT_MS } from './ledger.mjs';
import { checkUpdate, applyUpdate } from './update.mjs';
import { profile as netProfile, childEnv, isConnectionLevel } from './net.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { resolveTimeouts, makeClampTimeout, resolvePort, resolveCacheTtl } from './timeouts.mjs';
import { makeContract } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Windows 上不能直接 import('C:\\a\\b.mjs')（ESM 只认 file:// URL）——统一走这个
const dynImport = (p) => import(pathToFileURL(p).href);
const REPO = process.env.SSH_REPO
  || path.resolve(os.homedir(), 'Documents', 'trae_projects', 'ShipScheduleHub');
// 可用 WPS_TRACK_CLI 覆盖 —— 端到端测试要注入假 CLI，验证「参数从入口到出口」真的传下去了
const CLI = process.env.WPS_TRACK_CLI || path.join(REPO, 'engine/tracking/cli.mjs');
// ★ 数值配置统一走 ./timeouts.mjs（纯函数、可单测）：
//   环境变量是手写的，裸 Number() 遇错字会得 NaN 并一路静默变形
//   （setTimeout(…, NaN) 立刻超时 / --timeout NaN / listen(NaN) 随机端口连不上）。
const PORT = resolvePort();
const HOST = process.env.WPS_TRACK_HOST || '127.0.0.1';
const { defaultTimeout: DEFAULT_TIMEOUT, maxTimeout: MAX_TIMEOUT } = resolveTimeouts();
// 调用方可显式指定更长超时（慢站），但要有硬上限防手滑传 1e9 把连接挂死。
// 以前上限直接复用 DEFAULT_TIMEOUT → 只能调低不能调高（语义错），慢站想放宽没有口子。
const clampTimeout = makeClampTimeout({ defaultTimeout: DEFAULT_TIMEOUT, maxTimeout: MAX_TIMEOUT });
const CACHE_TTL = resolveCacheTtl();
// ── 引擎 canonical 契约版本（★ 10-30，卡 t_8a6689dc）────────────────────
// 单一来源在引擎 engine/tracking/normalize.mjs 的 SCHEMA_VERSION，桥只读一次并对外报出，
// **绝不在这里再写一个数字**——两处各写一份就会慢慢漂移，正是本版本号要防的事。
// 读不到就报 null（不让 /health 崩），插件据此降级。
let ENGINE_SCHEMA_VERSION = null;
// 兜底：引擎早退路径（如号码格式不符）可能没带版本号，插件靠它校验 → 通讯层补齐。
// 只在缺失时补，**不覆盖**引擎给的值（引擎才是单一来源）。
const withSchema = (r) => (r && typeof r === 'object' && r.schemaVersion === undefined && ENGINE_SCHEMA_VERSION !== null)
  ? { ...r, schemaVersion: ENGINE_SCHEMA_VERSION }
  : r;
try {
  const norm = await dynImport(path.join(REPO, 'engine/tracking/normalize.mjs'));
  if (Number.isInteger(norm.SCHEMA_VERSION)) ENGINE_SCHEMA_VERSION = norm.SCHEMA_VERSION;
  else console.error('[bridge] 引擎没有导出 SCHEMA_VERSION，契约版本报 null');
} catch (e) {
  console.error('[bridge] 读不到引擎 SCHEMA_VERSION:', String(e.message || e).slice(0, 120));
}
// ★ 契约（schemaVersion）的判定逻辑全在 ./schema.mjs（纯函数、可单测）。
//   桥只做两件事：/health 摊开支持区间；/track 收到插件上报的版本后决定「照常回」还是「只回降级桩」。
const CONTRACT = makeContract(ENGINE_SCHEMA_VERSION);
// 插件配置落盘：WPS 的 PluginStorage 在开发模式加载项里不保证持久，走本地文件最稳
const CFG_DIR = process.env.WPS_TRACK_CONFIG_DIR || path.join(os.homedir(), '.hermes', 'wps-shiptrack');
// 并发：默认 4（实测 2 时一批 96 单要十几分钟）。可用 WPS_TRACK_CONCURRENCY 覆盖。
// 注意：每个查询会起一个 Chrome，机器弱就调回 2~3。
let PROFILE_SEQ = 0;
const MAX_CONCURRENT = Math.max(1, Math.min(8, Number(process.env.WPS_TRACK_CONCURRENCY || 4)));

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

// ---------- 按船司的互斥（同船司串行，跨船司并行）----------
// 为什么：OOCL 连查 6–8 次就锁 45 分钟，同一船司并发只会把出口打进冷却；
// 而不同船司之间并行是安全的（各自独立的站点和限流）。
// 互斥压在 slot() 之外：先拿船司锁，再进全局槽位 —— 不另造信号量，全局并发仍由 slot() 管。
// 实现放在 ./sched.mjs（纯函数、可单测）。
const carrierSched = makeKeyedMutex();
const withCarrierMutex = (carrier, fn) => carrierSched.run(carrier, fn);

// ---------- 断点续查账本（卡 t_03fc348f）----------
// 失败行落盘 + 撞盾整家冷却。落盘在 ~/.hermes/wps-shiptrack/ledger/，冷却到点自动解封。
const LEDGER_DIR = process.env.WPS_TRACK_LEDGER_DIR || path.join(os.homedir(), '.hermes', 'wps-shiptrack');
const ledger = new Ledger(LEDGER_DIR);
const COOLDOWN_MS = Math.max(60000, Number(process.env.WPS_TRACK_COOLDOWN_MS || COOLDOWN_DEFAULT_MS));

// 引擎来不及出 canonical 时的最小兜底（超时/进程启动失败）。
// 字段与引擎 canonical 对齐，插件只认字段、不认来源。
function fallbackCanonical({ carrier = null, failKind = 'other', shortText = '查询失败', error = '' } = {}) {
  const LABEL = { expired: '已过期', blocked: '站点拦截', format: '号码格式', network: '网络', notfound: '官网查无', notwired: '未接入', other: '其他' };
  return {
    schemaVersion: 1, ok: false,
    shortText: String(shortText).slice(0, 24),
    failKind, kindLabel: LABEL[failKind] || '其他',
    stage: 0, stageLabel: '未离起运港', stageColor: -4142, stageHits: [], stageInferred: true, feeder: false,
    pol: null, pod: null, latestEvent: null, eventCount: 0,
    manualUrl: null, carrier, carrierLabel: null, eta: null,
    queriedAt: new Date().toISOString(),
    fallback: true, error: String(error).slice(0, 200),
  };
}

// ---------- 查询缓存 ----------
const cache = new Map(); // key -> {at, value}
const cacheGet = (k, skip = false) => { if (skip) return null; const e = cache.get(k); if (e && Date.now() - e.at < CACHE_TTL) return e.value; return null; };
const cacheSet = (k, v) => { cache.set(k, { at: Date.now(), value: v }); if (cache.size > 500) cache.delete(cache.keys().next().value); };

// ---------- 跑一次 CLI，收 NDJSON ----------
function runCli({ number, carrier, timeoutMs, forceDirect = false, onSpawn = null, pol = '', pod = '' }) {
  return new Promise(async (resolve) => {
    const release = await slot();
    const args = [CLI, '--number', number];
    if (carrier) args.push('--carrier', carrier);
    // ★ 卡 t_cec031c1：里程碑判定在引擎里，pol/pod 只有调用方知道（用户选了哪两列港口）。
    //   不往引擎传 = buildCanonical 收到空串 → 阶段退回纯事件推断，中转港会被当目的港。
    if (pol) args.push('--pol', String(pol).slice(0, 64));
    if (pod) args.push('--pod', String(pod).slice(0, 64));
    // 让引擎比桥的硬上限早 8s 自己收尾：这样超时能带回 steps（诊断用），而不是被 SIGKILL
    args.push('--timeout', String(Math.max(10000, timeoutMs - 8000)));
    const t0 = Date.now();
    let out = '', err = '', killed = false;
    // 每个并发槽用独立 Chrome profile：
    // 共用同一个 profile 时，多个进程同时 launchPersistentContext 会抢 Singleton 锁 →
    // 报 "browserType.launchPersistentContext: Fail..."，表格里就是一堆失败行。
    const profSlot = (PROFILE_SEQ++) % MAX_CONCURRENT;
    const profDir = path.join(os.homedir(), '.hermes', 'wps-shiptrack', 'chrome', `p${profSlot}`);
    console.error(`[bridge] profile=${profDir}`);
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: { ...childEnv(forceDirect), SSH_PROFILE_DIR: profDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const killTree = (sig) => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, sig);   // 负号 = 整个进程组（含 Chromium 孙进程）
      } catch (e) {
        try { child.kill(sig); } catch (e2) {}
      }
    };
    // 客户端点了「停止」→ 前端 abort 请求 → 这里立刻杀掉子进程（含 Chromium 孙进程），不等超时
    if (onSpawn) {
      try {
        onSpawn(() => {
          killed = true;
          killTree('SIGTERM');
          setTimeout(() => killTree('SIGKILL'), 2000);
        });
      } catch (e) { /* ignore */ }
    }
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

      // ★ 卡 t_cec031c1：超时是桥这一层杀的进程，引擎来不及出 canonical —— 本地造一个最小的，
      //   否则插件又得自己拼文案（「同一票两个界面文案不同」就是这么来的）。
      if (killed) return finish({
        ok: false, number, carrier: carrier || started?.carrier || null,
        error: `超时（${Math.round(timeoutMs / 1000)}s 未出结果）`, timeout: true, ms,
        canonical: fallbackCanonical({ carrier: carrier || started?.carrier || null, failKind: 'network', shortText: '查询超时（稍后重试）', error: 'timeout' }),
      });
      // ★ 10-28：原来只挑 msg/code，把引擎带出的 manualUrl/manualLabel 丢了 → 插件就没法给「手工查」链接
      // ★ 卡 t_cec031c1：同理，引擎算好的 canonical 必须原样透传，不能在这一层重建对象把它丢掉
      if (error) return finish({
        ok: false, number, carrier: carrier || null,
        error: error.msg || '追踪器报错', code: error.code, ms,
        ...(error.manualUrl ? { manualUrl: error.manualUrl, manualLabel: error.manualLabel || null } : {}),
        ...(error.canonical ? { canonical: error.canonical } : {}),
        ...(error.schemaVersion ? { schemaVersion: error.schemaVersion } : {}),
      });
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
const TRANSIENT = /ERR_CONNECTION|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|非 JSON|被拦|timeout|超时|net::ERR_|has been closed|Target page, context or browser|两个入口都不可用|无查询表单/i;
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
    return send(res, 200, {
      ok: true, service: 'wps-shiptrack-bridge', repo: REPO, port: PORT,
      concurrency: MAX_CONCURRENT, busy: running, cached: cache.size,
      // ★ 插件按这两个字段校验：不认识这个版本就别猜字段，降级 + 提示更新加载项
      schemaVersion: ENGINE_SCHEMA_VERSION,
      supportedSchemaVersions: ENGINE_SCHEMA_VERSION ? [ENGINE_SCHEMA_VERSION] : [],
      // ★ 卡 t_8a6689dc：最低/最高支持区间（curl 一条命令就能看见）——
      //   插件太旧时桥会降级回「只有单号 + 一句人话」，所以区间必须是桥自己说的，不是猜的
      ...CONTRACT.health(),
    });
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
        manualUrl: c.manualUrl || null,   // ★ 10-28：未接入也要给一条能点的路（插件「手工查」用）
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
    const timeoutMs = clampTimeout(url.searchParams.get('timeout'));
    if (!number) return send(res, 400, { ok: false, error: '缺 number' });
    // ★ 卡 t_8a6689dc：插件上报它自己认得的契约版本（?schema=N），桥记到日志里，
    //   事后能一眼看出「这一票是哪个年代的插件问的」。太旧 → 只回降级桩。
    const pj = CONTRACT.judgePlugin(url.searchParams.get('schema'));
    if (!pj.known) {
      console.error(`[track] ${number} 插件未上报契约版本（旧插件）· 桥支持 v${CONTRACT.version ?? '?'}`);
    } else if (pj.tooOld) {
      console.error(`[track] ${number} 拒绝：插件契约 v${pj.version} < 桥 v${CONTRACT.min} → 降级桩`);
      return send(res, 200, CONTRACT.refusal(number, carrier));
    } else {
      console.error(`[track] ${number} 插件契约 v${pj.version}${pj.tooNew ? `（比桥新，桥只回 v${CONTRACT.version}）` : ''}`);
    }
    const key = number + '|' + carrier;
    const hit = cacheGet(key, url.searchParams.get('fresh') === '1');
    if (hit) return send(res, 200, { ...hit, cached: true });
    const t0 = Date.now();
    const pol = String(url.searchParams.get('pol') || '').trim();
    const pod = String(url.searchParams.get('pod') || '').trim();
    let r = await runCli({
      number, carrier, timeoutMs, pol, pod,
      onSpawn: (kill) => req.on('close', () => { if (!res.writableEnded) { console.error(`[bridge] 客户端中断 ${number} → 杀子进程`); kill(); } }),
    });
    const elapsed = Date.now() - t0;
    r = withSchema(r);
    console.error(`[track] ${number} ${carrier || 'auto'} ${r.ok ? 'ok' : 'FAIL'} ${elapsed}ms ${r.ok ? '' : String(r.error || '').slice(0, 80)}`);
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

  // ★ 10-28（爹地拍板）：手工兜底解析 —— 实现只有一处（engine/tracking/manual-parse.mjs），
  //   插件只负责显示；以后改解析口径不用重装插件。
  if (url.pathname === '/parse-manual' && req.method === 'POST') {
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 200_000) break; }
    } catch { /* 读流失败按空处理 */ }
    let text = '';
    try { text = String((JSON.parse(body || '{}') || {}).text || ''); } catch { return send(res, 400, { ok: false, error: 'body 不是 JSON' }); }
    if (!text.trim()) return send(res, 400, { ok: false, error: '缺 text' });
    try {
      const mod = await dynImport(path.join(REPO, 'engine/tracking/manual-parse.mjs'));
      const events = mod.parseManualText(text);
      console.error(`[parse-manual] ${text.length} 字 → ${events.length} 条`);
      return send(res, 200, {
        ok: true,
        parsed: events.length > 0,
        events,
        raw: events.length ? undefined : text.slice(0, 4000),   // 解析不出就把原文交回，插件原样显示
      });
    } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
  }

  // ★ 卡 t_03fc348f：断点续查 —— 拿到某个文档上次失败、要补查的行
  if (url.pathname === '/pending') {
    const docKey = String(url.searchParams.get('doc') || '').trim() || '_default';   // 不能过 clean()：会大写化、删空格
    const rows = ledger.pending(docKey).map((r) => ({
      number: r.number, doc: r.doc, sheet: r.sheet, row: r.row,
      carrier: r.carrier, kind: r.kind, err: r.err, at: r.at,
      cooldownLeftMs: r.carrier ? ledger.cooldownLeft(r.carrier) : 0,
    }));
    return send(res, 200, { ok: true, doc: docKey, count: rows.length, rows });
  }

  // 清账本（用户点「重头查」时）—— 只删这一份文档的记录，不动别的表
  if (url.pathname === '/ledger/clear') {
    const docKey = String(url.searchParams.get('doc') || '').trim() || '_default';   // 不能过 clean()：会大写化、删空格
    ledger.clear(docKey);
    return send(res, 200, { ok: true, doc: docKey, cleared: true });
  }

  if (url.pathname === '/track-batch') {
    const numbers = (url.searchParams.get('numbers') || '').split(/[,\s]+/).map(clean).filter(Boolean).slice(0, 200);
    if (!numbers.length) return send(res, 400, { ok: false, error: '缺 numbers' });
    const timeoutMs = clampTimeout(url.searchParams.get('timeout'));
    // ★ 卡 t_03fc348f：断点续查的两个入参（都可选，不带就是原来的行为）
    //   doc  文档 key（插件传 "工作簿|工作表"），分账本用
    //   rows 可选 JSON [{number, doc, sheet, row}]，带上才能落 doc/sheet/row 三字段
    const docKey = String(url.searchParams.get('doc') || '').trim() || '_default';   // 不能过 clean()：会大写化、删空格
    const rowMeta = {};
    try {
      const raw = url.searchParams.get('rows');
      if (raw) for (const it of JSON.parse(raw)) if (it && it.number) rowMeta[String(it.number)] = it;
    } catch (e) { console.error('[track-batch] rows 参数解析失败:', String(e.message || e).slice(0, 120)); }
    // ★ 卡 t_8a6689dc：批量接口也认 plugin 版本 —— 太旧的插件逐行回降级桩（不查、不给字段）
    const bj = CONTRACT.judgePlugin(url.searchParams.get('schema'));
    if (bj.tooOld) {
      console.error(`[track-batch] 拒绝 ${numbers.length} 单：插件契约 v${bj.version} < 桥 v${CONTRACT.min} → 降级桩`);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', ...CORS });
      for (const n of numbers) res.write(JSON.stringify(CONTRACT.refusal(n, '')) + '\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', ...CORS });
    // ★ 卡 t_228d289b：跨船司并行 + 同船司串行。
    //   船司先本地识别（纯同步、不联网），拿到 carrier 才能分组；识别不出的归 '_unknown' 一起串。
    //   全局并发仍由 runCli 里的 slot() 管，这里只负责「同船司排队」——不另造信号量。
    let d = null;
    try { d = await detector(); } catch (e) { console.error('[track-batch] 识别器不可用，按未识别串行:', String(e.message || e).slice(0, 120)); }
    // ★ 卡 t_03fc348f：断点续查 —— doc 分账本，rows 带行号，only=pending 只补上次失败的
    let pendingSet = null;
    if (url.searchParams.get('only') === 'pending') {
      pendingSet = new Set(ledger.pending(docKey).map((r) => String(r.number)));
      console.error(`[track-batch] 断点续查：${numbers.length} 单里上次失败 ${[...numbers].filter((n) => pendingSet.has(n)).length} 单`);
    }
    const jobs = numbers
      .filter((n) => !pendingSet || pendingSet.has(String(n)))
      .map((n) => {
        let carrier = '';
        try { const id = d && d.detectCarrier(n); if (id && id.ok && id.carrier) carrier = id.carrier; } catch (e) {}
        const meta = rowMeta[String(n)] || {};
        // ★ 卡 t_cec031c1：每行港口各不相同（同一批里两条船起运港可能不一样），
        //   所以 pol/pod 必须按行走 rows，不能整批用同一个。
        const rpol = String(meta.pol || url.searchParams.get('pol') || '').trim();
        const rpod = String(meta.pod || url.searchParams.get('pod') || '').trim();
        return { n, carrier, doc: meta.doc ?? null, sheet: meta.sheet ?? null, row: meta.row ?? null, pol: rpol, pod: rpod };
      });
    // 每行单独 write —— Node 的 write 是原子的，并发写不会把两条结果拼成半行；
    // 插件按 number 匹配行，不依赖返回顺序，所以按完成顺序回传是安全的。
    await Promise.all(jobs.map(({ n, carrier, doc, sheet, row, pol, pod }) => withCarrierMutex(carrier, async () => {
      const meta = { doc, sheet, row };
      try {
        // ① 冷却检查（拿锁之后做，避免并发抢同一家）
        const left = ledger.cooldownLeft(carrier);
        if (left > 0) {
          const r = withSchema({
            ok: false, number: n, carrier, errorKind: 'cooling',
            error: `${carrier || '该船司'} 冷却中（还剩 ${Math.ceil(left / 60000)} 分钟），到点自动重试`,
            coolingLeftMs: left,
          });
          ledger.append(docKey, [toRecord({ ...meta, number: n, result: r })]);
          if (!res.writableEnded) res.write(JSON.stringify(r) + '\n');
          return;
        }
        // ② 正常查询
        const key = n + '|' + carrier;
        const hit = cacheGet(key);
        const r0 = hit ? { ...hit, cached: true } : await runCli({ number: n, carrier, timeoutMs, pol, pod });
        const r = withSchema(r0);
        if (!hit && r.ok) cacheSet(key, r);
        // ③ 落盘（成功也记：下次刷新才知道这行已经查过了）
        ledger.append(docKey, [toRecord({ ...meta, number: n, result: r })]);
        // ④ 撞盾 → 整家冷却，本轮剩余该家不再发请求
        if (!r.ok && isCooldownKind(r.errorKind)) {
          ledger.cool(carrier, COOLDOWN_MS);
          console.error(`[track-batch] ${carrier} 命中 ${r.errorKind} → 整家冷却 ${Math.round(COOLDOWN_MS / 60000)} 分钟`);
        }
        if (!res.writableEnded) res.write(JSON.stringify(r) + '\n');
      } catch (e) {
        // 客户端中断 / 写失败：不能让一个任务炸掉整批
        if (!res.writableEnded) res.write(JSON.stringify(withSchema({ ok: false, number: n, carrier, error: String(e.message || e) })) + '\n');
      }
    })));
    return res.end();
  }

  send(res, 404, { ok: false, error: '未知路径: ' + url.pathname });
});

// ---------- 启动/运行期自检：起不来、监听丢了，都要留下可读原因并以非 0 退出 ----------
// 为什么：以前端口被占只会吐一段 node 栈，守护进程（LaunchAgent / 计划任务）重启它
// 也留不下「为什么起不来」；用户看到的就是面板一句「桥没连上」，无从下手。
const STATE_DIR = process.env.WPS_TRACK_CONFIG_DIR || path.join(os.homedir(), '.hermes', 'wps-shiptrack');
const FAIL_FILE = path.join(STATE_DIR, 'bridge-listen-failures.json');
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const say = (msg) => console.error(`[bridge ${stamp()}] ${msg}`);

function healthOnce(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 4000) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// 端口被别人占了：连续 3 次以上就停下，别每 30 秒写一行日志永远循环
function noteForeignOccupant(detail) {
  let st = { count: 0, first: 0, last: 0 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(FAIL_FILE, 'utf8')) }; } catch { /* 没有就新建 */ }
  const now = Date.now();
  if (!st.first || now - st.first > 10 * 60 * 1000) st = { count: 0, first: now, last: now };
  st.count += 1; st.last = now;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(FAIL_FILE, JSON.stringify(st)); } catch { /* 写不了就算了 */ }
  const giveUp = st.count >= 3;
  say(`端口 ${PORT} 被别的进程占着（不是本桥）：${detail}`);
  say(`  查是谁：lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  if (giveUp) {
    say(`连续 ${st.count} 次被占（10 分钟内）→ 停止自动重启，先手工清掉占用者；本进程退出码 0（守护进程不再拉起）`);
    return 0;
  }
  say(`  第 ${st.count}/3 次，守护进程会按 ThrottleInterval 重试；本进程退出码 1`);
  return 1;
}

server.on('error', async (e) => {
  if (e && e.code === 'EADDRINUSE') {
    const h = await healthOnce();
    if (h && h.service === 'wps-shiptrack-bridge') {
      say(`已经有一个本桥在 ${HOST}:${PORT} 上跑（pid 不在本进程），本进程直接退出，不重复起`);
      process.exit(0);
    }
    process.exit(noteForeignOccupant(h ? JSON.stringify(h) : String(e.message || e)));
  }
  say(`监听失败（${(e && e.code) || 'unknown'}）：${(e && e.message) || e}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try { fs.unlinkSync(FAIL_FILE); } catch { /* 清掉上次的失败计数 */ }
  say(`listening http://${HOST}:${PORT}  pid=${process.pid}  node=${process.version}  repo=${REPO}`);
});

// 运行期监听丢了（被关掉 / 内部出错）→ 非 0 退出，交给守护进程重启
setInterval(() => {
  if (!server.listening) {
    say('监听已丢失（server.listening=false）→ 退出等守护进程重启');
    process.exit(1);
  }
}, 60 * 1000).unref();

// 未捕获异常：本来就会让进程死，这里先落一行人能看懂的原因，退出码 1
process.on('uncaughtException', (e) => {
  say(`未捕获异常，退出等守护进程重启：${(e && e.stack) || e}`);
  process.exit(1);
});
// 未处理的 Promise 拒绝：只记不杀 —— 一批查询跑一半时杀进程会丢掉在飞的结果
process.on('unhandledRejection', (e) => {
  say(`未处理的 Promise 拒绝（不退出）：${(e && e.stack) || e}`);
});
