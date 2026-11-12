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
//   POST /detect-columns {rows,sheet}  -> Excel 行列自动识别（表头语义 + 内容特征 + 同格/分格 + 置信分档）
//   GET /track?number=XXX[&carrier=]   -> 真查询，返回归一化结果；[&timeout=120000]
//   GET /track-batch?numbers=a,b,c     -> 批量查（同船司串行 / 跨船司并行），NDJSON 流式回传每行结果
//
// 约定：一律 200 + {ok:false,...} 表达业务失败；4xx 只用于参数错。
import http from 'node:http';
import { makeKeyedMutex } from './sched.mjs';
import { Ledger, toRecord, isCooldownKind, COOLDOWN_DEFAULT_MS } from './ledger.mjs';
import { JobQueue } from './jobs.mjs';
import { checkUpdate, applyUpdate } from './update.mjs';
import { profile as netProfile, childEnv, isConnectionLevel } from './net.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { resolveTimeouts, makeClampTimeout, resolvePort, resolveCacheTtl, timeoutForCarrier, describeTimeoutChoice, QUERY_TOTAL_BUDGET_MS } from './timeouts.mjs';
import { makeContract } from './schema.mjs';
import { makeProfilePool, resolveCooldownMs } from './profiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Windows 上不能直接 import('C:\\a\\b.mjs')（ESM 只认 file:// URL）——统一走这个
const dynImport = (p) => import(pathToFileURL(p).href);
const REPO = process.env.SSH_REPO
  || path.resolve(os.homedir(), 'dev', 'ShipScheduleHub');
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
let PROFILE_SEQ = 0;   // 仅用于日志计数（真正的槽位由 profiles.mjs 的池子发）
const MAX_CONCURRENT = Math.max(1, Math.min(8, Number(process.env.WPS_TRACK_CONCURRENCY || 4)));
// ★ 2026-11-05（爹地真机 6 行待手工 + 知澜对照实验）：旧实现按 `(PROFILE_SEQ++) % MAX_CONCURRENT` 轮转，
//   子进程 close 时 Chromium 孙进程还在收尾 → 下一个请求分到同一个 profile 就抢 Singleton 锁
//   （"Target page, context or browser has been closed"），引擎兜底再把对方 Chrome 杀掉。
//   现在改成档案池：容量 2×并发，每次分配都验证「没有活着的 Chrome 占着这个槽」，
//   脏槽晾着等它退干净，只有全脏且等超时才强杀残留。见 ./profiles.mjs。
const PROFILE_ROOT = process.env.WPS_TRACK_PROFILE_ROOT || path.join(os.homedir(), '.hermes', 'wps-shiptrack', 'chrome');
const profilePool = makeProfilePool({
  root: PROFILE_ROOT,
  capacity: Math.max(MAX_CONCURRENT, Number(process.env.WPS_TRACK_PROFILE_POOL || 0) || MAX_CONCURRENT * 2),
  // ★ 卡 t_991b99f7：撞盾的槽冷却多久（默认 60s，WPS_TRACK_PROFILE_COOLDOWN_MS 可调，0 = 关）
  cooldownMs: resolveCooldownMs(),
  log: (m) => console.error(m),
});

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

// ---------- 派活队列（卡 t_aa0674a9）----------
// App --POST /jobs--> 桥 <--GET /jobs/next-- 插件（2.5s 心跳领活）
// 落盘在 ~/.hermes/wps-shiptrack/jobs-queue/，桥重启/App 关掉任务都不丢。
const JOBS_DIR = process.env.WPS_TRACK_JOBS_DIR || path.join(os.homedir(), '.hermes', 'wps-shiptrack', 'jobs-queue');
const jobs = new JobQueue(JOBS_DIR);
try {
  const re = jobs.requeueStale();
  if (re.length) console.error(`[jobs] 上次未跑完的任务已放回队列: ${re.join(', ')}`);
} catch (e) { console.error('[jobs] requeue 失败:', String(e.message || e).slice(0, 120)); }

// POST body 读取（限 64KB，防误发大包）
function readJsonBody(req, res, cb) {
  let body = '';
  req.on('data', (b) => {
    body += b;
    if (body.length > 64 * 1024) {
      try { req.destroy(); } catch (e) {}
      send(res, 413, { ok: false, error: 'body 太大' });
    }
  });
  req.on('end', () => {
    // ★ 解析错误和处理错误必须分开报 —— 写盘失败被套成「body 不是合法 JSON」，
    //   读的人第一反应会以为是自己请求写错了（知澜 2026-11-02 实撞）。
    let parsed;
    try { parsed = JSON.parse(body || '{}'); }
    catch (e) { return send(res, 200, { ok: false, error: 'body 不是合法 JSON: ' + String(e.message || e) }); }
    try { cb(parsed); }
    catch (e) { return send(res, 200, { ok: false, error: '服务端处理失败: ' + String((e && e.message) || e) }); }
  });
}

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
function runCli({ number, carrier, timeoutMs, forceDirect = false, onSpawn = null, pol = '', pod = '', doc = '', sheet = '', row = 0, retry = false, slotCooldown = null, noCache = false }) {
  return new Promise(async (resolve) => {
    const release = await slot();
    const args = [CLI, '--number', number];
    if (carrier) args.push('--carrier', carrier);
    // ★ 2026-11-05：待重查的行重试时给引擎更长的站点窗口（Maersk 首查 8s，重试 20s）。
    //   首查要快（一批几十行），重试是「上次没抓到」的行，宁可慢也要抓到。
    if (retry) args.push('--retry');
    // ★ 2026-11-05：?nocache=1 → 引擎跳过 20 分钟结果缓存。
    //   没有这个口子，「重查救回率」永远测不出来：第 2 轮起全命中上一轮的失败缓存，秒回同一个错。
    if (noCache) args.push('--no-cache');
    // ★ 卡 t_cec031c1：里程碑判定在引擎里，pol/pod 只有调用方知道（用户选了哪两列港口）。
    //   不往引擎传 = buildCanonical 收到空串 → 阶段退回纯事件推断，中转港会被当目的港。
    if (pol) args.push('--pol', String(pol).slice(0, 64));
    if (pod) args.push('--pod', String(pod).slice(0, 64));
    // ★ 10-30：台账（jobs-YYYY-MM-DD.ndjson）里 doc/sheet/row 全是空/0 时，事后定位只能靠内存日志。
    //   引擎的 jobMeta 早就会读 --doc/--sheet/--row，这里只是把插件上报的那三个参数递下去。
    //   **不能过 clean()**：那会把工作簿名大写化、删空格，读回来对不上原表。
    const metaDoc = String(doc || '').trim().slice(0, 200);
    const metaSheet = String(sheet || '').trim().slice(0, 60);
    const metaRow = Math.max(0, Math.floor(Number(row) || 0));
    if (metaDoc) args.push('--doc', metaDoc);
    if (metaSheet) args.push('--sheet', metaSheet);
    if (metaRow) args.push('--row', String(metaRow));
    // 让引擎比桥的硬上限早 8s 自己收尾：这样超时能带回 steps（诊断用），而不是被 SIGKILL
    args.push('--timeout', String(Math.max(10000, timeoutMs - 8000)));
    const t0 = Date.now();
    let out = '', err = '', killed = false;
    // 每个并发查询用「确认已退干净」的独立 Chrome 档案（池子见 ./profiles.mjs）：
    // 共用同一个 profile 时，多个进程同时 launchPersistentContext 会抢 Singleton 锁 →
    // 报 "Target page, context or browser has been closed"，表格里就是一堆失败行。
    let profSlot = null;
    try { profSlot = await profilePool.acquire(); } catch { profSlot = null; }
    const profDir = (profSlot && profSlot.dir) || path.join(PROFILE_ROOT, 'p0');
    console.error(`[bridge] profile=${profSlot ? profSlot.name : '(fallback p0)'}`);
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
    // ★ 11-12：超时按船司。auto 时一开始不知道是哪家，收到 track-started 才收紧（见下面的 stdout 处理）。
    //   Hapag 成功上界 19.5s、失败全在 93s（桥砍）——90 秒对它只是多等 70 秒，见 timeouts.mjs 的表。
    let effTimeout = timeoutMs;
    let timedOutCarrier = String(carrier || '').toLowerCase() || null;
    if (timedOutCarrier) {
      effTimeout = timeoutForCarrier(timedOutCarrier, timeoutMs);
      // 手选船司这条路原来一行日志都没有：调用方传 20000、家配置 55000 时，
      // 55000 这趟根本没参与，事后完全看不出来。跟 auto 那条一样留痕。
      const note = describeTimeoutChoice(timedOutCarrier, timeoutMs);
      if (note) console.error(`[bridge] ${number} ${note}`);
    }
    const killNow = () => { killed = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 3000); };
    let timer = setTimeout(killNow, effTimeout);

    child.stdout.on('data', (b) => {
      const chunk = b.toString();
      out += chunk;
      // auto 模式：引擎自报船司后才收紧，避免「先按 90s 起表、30s 才改」也能省下 60s
      if (!carrier && chunk.includes('track-started')) {
        try {
          const startedEvt = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .find((e) => e && e.type === 'track-started');
          const cid = String((startedEvt && startedEvt.carrier) || '').toLowerCase();
          if (cid) {
            timedOutCarrier = cid;
            const per = timeoutForCarrier(cid, timeoutMs);
            if (per < effTimeout) {
              const spent = Date.now() - t0;
              effTimeout = per;
              clearTimeout(timer);
              timer = setTimeout(killNow, Math.max(5000, per - spent));
              console.error(`[bridge] ${number} 按船司收紧超时 ${timeoutMs}ms → ${per}ms（${cid}，已用 ${spent}ms）`);
            } else {
              // 家上限 ≥ 调用方上限 → 家配置这一趟没参与，只留痕不告警（正常降配）
              const note = describeTimeoutChoice(cid, timeoutMs);
              if (note) console.error(`[bridge] ${number} ${note}`);
            }
          }
        } catch { /* 解析不出来就按原超时跑 */ }
      }
    });
    child.stderr.on('data', (b) => { err += b.toString(); });

    let settled = false;
    const finish = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = (obj && typeof obj === 'object') ? obj : { ok: false, error: String(obj) };
      // ★ 卡 t_991b99f7：结果里带上用的是哪个档案（串行连查的排障证据：日志/表格能看见 pX）
      out.profile = profSlot ? profSlot.name : null;
      // 档案放回池子：后台等 Chromium 孙进程真退出再清锁（acquire 侧还会二次验证）
      // ★ 撞盾（限流/被拦/挑战）→ 这个档案冷却一会儿，下一个请求自然换到别的槽
      let cool = false;
      try { cool = !!(slotCooldown && profSlot && slotCooldown(out)); } catch { cool = false; }
      try { profilePool.release(profSlot, { cooldown: cool }); } catch { /* 池子异常不许影响结果 */ }
      release();
      resolve(out);
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
      if (killed) {
        // ★ 11-12：Hapag 的「超时」几乎都是 CF 挑战没过，说「超时」会让人以为是网络问题。
        //   文案必须直接说是站点无响应，爹地才知道该等还是该换渠道手工查。
        const cid = timedOutCarrier || String(carrier || started?.carrier || '').toLowerCase() || null;
        const isHapag = cid === 'hapag';
        const secs = Math.round(effTimeout / 1000);
        return finish({
          ok: false, number, carrier: cid,
          error: isHapag
            ? `Hapag 站点无响应（CF 挑战未通过，${secs}s 内无结果）`
            : `超时（${secs}s 未出结果）`,
          timeout: true, timedOutCarrier: cid, ms,
          canonical: fallbackCanonical({
            carrier: cid,
            failKind: isHapag ? 'blocked' : 'network',   // CF 墙是「被拦」不是「网络不通」
            shortText: isHapag ? 'Hapag 站点无响应（稍后重试或手工查）' : '查询超时（稍后重试）',
            error: 'timeout',
          }),
        });
      }
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
// ★ 2026-11-05（复验实测）：SPA 在 8s 窗口内没发出 XHR（引擎报「页面有内容但没发请求」）也该重来一次——
//   同一个号 8s 窗口连挂两次、20s 窗口 9~12s 就成功（两个不同提单号各复现一次）。
//   这类错误文案不带 ERR_/超时，旧正则漏掉 → 桥一次都不重试，直接落「待手工」。
const RETRY_WORTHY = new RegExp(`${TRANSIENT.source}|没抓到追踪数据|没发请求|页面空白`, 'i');
// ★ 卡 t_991b99f7：撞盾判据 —— 这个结果该不该让「刚才用的 Chrome 档案」歇一会儿。
//   走 ledger 的 isCooldownKind（已补 throttled）：OOCL 报的是 throttled/blocked，从不报 challenge。
const isShieldResult = (res) => !!res && !res.ok && isCooldownKind(res.errorKind);
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
const clean = (s) => String(s || '').replace(/[\s\u200b\u3000]/g, '').toUpperCase();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  // 只接受本机页面（WPS 的 file:// 页面发 Origin: null）；浏览器跨站请求一律拒绝
  // ★ 卡 t_aa0674a9 第三步：Tauri 的 WebView 发的是 `tauri://localhost`（macOS）或
  //   `http://tauri.localhost`（Windows）—— 之前没放行，App 直连桥一律 403，
  //   只能在 Rust 里再包一层转发。放行这两种 origin 后 WebView 可以直连，少一道墙。
  //   安全性：这两个 scheme 只有本机 Tauri 应用能伪造，公网页面发不出来。
  const origin = req.headers.origin;
  const isTauri = /^tauri:\/\//i.test(String(origin || '')) || /^https?:\/\/tauri\.localhost(:\d+)?$/i.test(String(origin || ''));
  if (origin && origin !== 'null' && !isTauri && !/^file:\/\//.test(origin) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return send(res, 403, { ok: false, error: '只接受本机页面调用' });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === '/health') {
    return send(res, 200, {
      ok: true, service: 'wps-shiptrack-bridge', repo: REPO, port: PORT,
      concurrency: MAX_CONCURRENT, busy: running, cached: cache.size,
      // ★ 2026-11-05：Chrome 档案池状态 —— 「脏槽」= 上个查询的 Chromium 还没退干净，
      //   验收并发改动的第一手证据（正常情况下 dirty 最多一两个、且很快清空）
      // ★ 卡 t_991b99f7：再加每槽的 lastUsed / cooldownMs —— 串行连查是否真的换了档案，
      //   看这三个数字递增就够了（不再靠猜）。
      profilePool: { ...profilePool.stats(), slots: profilePool.slots() },
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

  // ★ 2026-11-11（卡 t_a72fba24）：Excel 行列自动识别
  //   样本由插件用 COM 读 A1:AZ30 后 POST 进来（桥读磁盘文件拿到的是未保存前的旧版，不能用）。
  //   规则库在桥侧：detect-columns.mjs（表头词表）+ engine/tracking/detect.mjs→identify.mjs（单号校验）。
  if (url.pathname === '/detect-columns' && req.method === 'POST') {
    let body = '';
    req.on('data', (b) => {
      body += b;
      // 30 行 × 52 列 × 每格 ≤ 64 字符 → 上限 1MB 足够，超了就是被塞东西
      if (body.length > 1024 * 1024) { try { req.destroy(); } catch (e) {} send(res, 413, { ok: false, error: '样本太大（>1MB）' }); }
    });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const rows = Array.isArray(j.rows) ? j.rows : [];
        if (!rows.length) return send(res, 400, { ok: false, error: '缺 rows（插件读出的 A1:AZ30 样本）' });
        const mod = await dynImport(path.join(HERE, 'detect-columns.mjs'));
        // 内容校验器：detectCarrier 判归属 + containerCheck 判箱号校验位（单一事实来源在 engine/tracking/identify.mjs）
        let idmod = null, ruleSource = '形态兜底（引擎不可用）';
        try {
          const d = await detector();
          const id = await dynImport(path.join(REPO, 'engine/tracking/identify.mjs'));
          idmod = { detectCarrier: d.detectCarrier, containerCheck: id.containerCheck };
          ruleSource = 'engine/tracking/identify.mjs';
        } catch (e) {
          console.error('[detect-columns] 识别器不可用，按纯形态判:', String(e.message || e).slice(0, 120));
        }
        const det = mod.detectColumns({
          rows,
          sheet: String(j.sheet || ''),
          headerRow: typeof j.headerRow === 'number' ? j.headerRow : undefined,
          identify: idmod,
        });
        return send(res, 200, { ok: true, ...det, ruleSource });
      } catch (e) {
        return send(res, 200, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  if (url.pathname === '/track') {
    const number = clean(url.searchParams.get('number'));
    const carrier = clean(url.searchParams.get('carrier')) || '';
    const timeoutMs = clampTimeout(url.searchParams.get('timeout'));
    if (!number) return send(res, 400, { ok: false, error: '缺 number' });
    // ★ 卡 t_8a6689dc：插件上报它自己认得的契约版本（?schema=N），桥记到日志里，
    //   事后能一眼看出「这一票是哪个年代的插件问的」。太旧 → 只回降级桩。
    const rawSchema = url.searchParams.get('schema');
    const pj = CONTRACT.judgePlugin(rawSchema);
    // ★ 11-12：四态分开写。原来「没传 schema」也走 !pj.known → 写成「旧插件」，
    //   curl / CLI / 探针每打一次就造一条假警报。没有插件 ≠ 插件旧。
    const callerKind = CONTRACT.classifyCaller(rawSchema);
    if (callerKind === 'direct') {
      console.error(`[track] ${number} 直连调用（未带插件契约）· 桥支持 v${CONTRACT.version ?? '?'}`);
    } else if (callerKind === 'unparsable') {
      console.error(`[track] ${number} 插件契约版本无法解析（schema=${String(rawSchema).slice(0, 20)}）→ 按旧插件处理 · 桥支持 v${CONTRACT.version ?? '?'}`);
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
    // ★ 10-30：插件上报它查的是哪张表哪一行 → 台账里带上，失败行事后能直接定位回表格
    const docMeta = String(url.searchParams.get('doc') || '').trim();
    const sheetMeta = String(url.searchParams.get('sheet') || '').trim();
    const rowMeta = Number(url.searchParams.get('row')) || 0;
    // ★ 2026-11-05：?retry=1 = 这是「待重查」队列里的行 → 引擎给更长的站点窗口（Maersk 8s → 20s）
    const retryHint = url.searchParams.get('retry') === '1' || url.searchParams.get('retry') === 'true';
    // ★ 2026-11-05：?nocache=1 = 不吃也不写结果缓存（跑对照实验、验重查救回率用）
    const noCache = url.searchParams.get('nocache') === '1' || url.searchParams.get('nocache') === 'true';
    // ★ 卡 t_991b99f7：撞盾（challenge / rate-limit / throttled / blocked）→ 这个 Chrome 档案冷却。
    //   实测依据：OOCL 报的是 throttled（QF8 限流）和 blocked，**从不报 challenge** ——
    //   所以判据必须走 ledger 的 isCooldownKind（已补 throttled），不能只匹配字面 challenge。
    const shieldCool = isShieldResult;
    const runArgs = { number, carrier, timeoutMs, pol, pod, doc: docMeta, sheet: sheetMeta, row: rowMeta, noCache };
    let r = await runCli({
      ...runArgs, retry: retryHint, slotCooldown: shieldCool,
      onSpawn: (kill) => req.on('close', () => { if (!res.writableEnded) { console.error(`[bridge] 客户端中断 ${number} → 杀子进程`); kill(); } }),
    });
    let runs = 1;   // 子进程计数：网络级重试 + 换槽重试合计不超过 2 次额外子进程
    // ★ 卡 t_991b99f7 ②：撞盾 → 该槽已经带着冷却放回池子，这里换另一个档案重跑一次。
    //   为什么值得多跑一次：同档案第 2 次必被拦（OOCL 实测，117s 烧满预算），
    //   而换新档案 + 冷却后马上就恢复；原槽硬撞只是把预算烧光。
    // ★ 11-12：Hapag 撞 CF 墙超时 → 该槽冷却，换另一个档案再试一次（知澜批复）。
    //   同档案硬撞只是把 30 秒预算烧两遍（OOCL 实测同档案第 2 次必被拦），换槽才有意义。
    const hapagWall = r.timeout && String(r.timedOutCarrier || r.carrier || '').toLowerCase() === 'hapag';
    // ★ 11-12（总预算）：单次上限只管「一次尝试等多久」，换槽重试每换一个档案就重新起表 ——
    //   实测一次查询能烧到 116 秒（p0 20s 撞墙 → p1 20s FAIL → p2 55s 撞墙 → p3 55s FAIL）。
    //   爹地的痛点是「90 秒干等」，这样最坏反而翻倍。所以换槽前先问「剩下的够不够完整跑一次」，
    //   不是「还剩没剩」：只剩 35s 换槽也读不到要 40–50s 的 not available，白烧预算还多等。
    const nextSingle = timeoutForCarrier(String(r.timedOutCarrier || r.carrier || carrier || ''), timeoutMs);
    const budgetLeft = QUERY_TOTAL_BUDGET_MS - (Date.now() - t0);
    const canAffordRetry = budgetLeft >= nextSingle;
    if (!r.ok && (isCooldownKind(r.errorKind) || hapagWall) && r.profile && runs < 3 && !canAffordRetry) {
      console.error(`[bridge] ${number} 总预算不够换槽（剩 ${Math.round(budgetLeft / 1000)}s < 下次单次 ${Math.round(nextSingle / 1000)}s）→ 不重试，直接报`);
    }
    if (!r.ok && (isCooldownKind(r.errorKind) || hapagWall) && r.profile && runs < 3 && canAffordRetry) {
      const from = r.profile;
      console.error(`[bridge] ${number} ${hapagWall ? '撞 CF 墙超时' : `撞盾 ${r.errorKind}`} → ${from} 冷却并换档案重试`);
      const r2 = await runCli({ ...runArgs, retry: true, slotCooldown: shieldCool });
      runs++;
      // 打标给插件/日志看：这次结果是换过档案才拿到的
      r2.slotRetried = true;
      r2.slotSwapped = `${from}→${r2.profile || '(fallback)'}`;
      console.error(`[bridge] 换槽重试 ${number} ${r2.slotSwapped} ${r2.ok ? 'ok' : `FAIL ${String(r2.errorKind || r2.error || '').slice(0, 60)}`}`);
      r = r2;
    }
    const hardDown = r.error && /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(String(r.error));
    // 连接不上（断网 / 代理没开）→ 立刻重试毫无意义，只是再开一个浏览器空烧
    // ★ 11-12：这条网络重试原来用「已用 < 60s」当闸 —— 首次跑了 55s 仍满足 55<60，
    //   再跑 55s 就是 110s。改成跟换槽同一条判据：剩余预算够不够完整跑一次。
    if (!r.ok && r.error && RETRY_WORTHY.test(r.error) && !r.timeout && runs < 3
        && QUERY_TOTAL_BUDGET_MS - (Date.now() - t0) >= timeoutForCarrier(String(r.carrier || carrier || ''), timeoutMs)) {
      // 连接级失败：先判断是不是「网络姿势」问题 —— 换个极性（走代理 ⇄ 强制直连）再试一次
      const conn = isConnectionLevel(r.error);
      const net = await netProfile().catch(() => null);
      const direct = !!(net && net.proxyOn);
      console.error(`[bridge] 重试 ${number}（首次: ${String(r.error).slice(0, 80)}）${conn ? ` → 换极性 forceDirect=${direct}` : ''} · 放宽站点窗口`);
      // ★ 2026-11-05：桥自己的第二次尝试也走「重试窗口」——8s 窗口下 SPA 常见「页面有内容但没发请求」，
      //   第二次还是 8s 只是把同样的失败重演一遍（802735343 就是这么连挂两次的）。
      r = await runCli({ ...runArgs, forceDirect: conn ? direct : false, retry: true, slotCooldown: shieldCool });
      runs++;
      r.retried = true;
      if (conn) r.netRetriedWith = direct ? 'direct' : 'proxy';
    }
    const elapsed = Date.now() - t0;
    r = withSchema(r);
    console.error(`[track] ${number} ${carrier || 'auto'} ${r.ok ? 'ok' : 'FAIL'} ${elapsed}ms profile=${r.profile || '-'}${r.slotSwapped ? ` swapped=${r.slotSwapped}` : ''} ${r.ok ? '' : String(r.error || '').slice(0, 80)}`);
    if (r.ok && !noCache) cacheSet(key, r);
    // ★ 2026-11-05 根因修复：`/pending` 一直是 count 0 —— 因为插件/App **全部走单号 `/track`**，
    //   而账本只由 `/track-batch` 写（grep 实读：TaskPane 里 `/track-batch` 0 次、`/track?` 2 次）。
    //   结果 M2「断点续查 / 只补失败」的账本从来没被真实查询写过，爹地那 67 格待重查全在插件自己的 retry 数组里。
    //   这里补上：只要调用方给了 doc（插件总会给），单号结果也进账本。
    if (docMeta) {
      const docKey = sheetMeta ? `${docMeta}|${sheetMeta}` : docMeta;
      try {
        ledger.append(docKey, [toRecord({ doc: docMeta, sheet: sheetMeta || null, row: rowMeta || null, number, result: r })]);
      } catch (e) { console.error(`[track] 落账本失败 ${number}: ${e.message}`); }
    }
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

  // ---------- 派活（卡 t_aa0674a9 第一步）----------
  // App --POST /jobs--> 桥 <--GET /jobs/next-- 插件心跳领活 --POST /jobs/:id/report--> 桥
  // 为什么在桥里做而不加 Rust 命令：WebView 前端本来就能 fetch 127.0.0.1（CORS 已开），
  // 多一层 Rust 转发只是多一道要维护的墙。

  // ⓪ 有哪些文档配过列（App 的「发起查询」要让人先选哪张表）
  //    配置文件在 ~/.hermes/wps-shiptrack/<encodeURIComponent(doc)>.json
  if (url.pathname === '/docs') {
    let names = [];
    try { names = fs.readdirSync(CFG_DIR).filter((n) => n.endsWith('.json')); } catch (e) { names = []; }
    const docs = [];
    for (const n of names) {
      // 台账/冷却/队列这些不是列配置，跳过
      if (/^(cooldowns|bridge-listen-failures)/.test(n)) continue;
      let doc = '';
      try { doc = decodeURIComponent(n.replace(/\.json$/, '')); } catch (e) { doc = n.replace(/\.json$/, ''); }
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(path.join(CFG_DIR, n), 'utf8')); } catch (e) { cfg = null; }
      if (!cfg || !cfg.numberCol) continue;          // 没选过单号列的不算可用
      docs.push({ doc, cols: { number: cfg.numberCol || 0, out: cfg.outCol || 0, carrier: cfg.carrierCol || 0, pol: cfg.polCol || 0, pod: cfg.podCol || 0 }, mode: cfg.mode || 'column', startRow: cfg.startRow || 2, rows: cfg.rows || 0 });
    }
    docs.sort((a, b) => String(a.doc).localeCompare(String(b.doc)));
    return send(res, 200, { ok: true, count: docs.length, docs });
  }

  // ① 建任务
  if (url.pathname === '/jobs' && req.method === 'POST') {
    return readJsonBody(req, res, (j) => {
      if (!j || !j.doc) return send(res, 400, { ok: false, error: '缺 doc（"工作簿|工作表"）' });
      // ★ 驳回 1：only:'pending' = 只补上次失败的行。失败行在 ledger 里（带 row + number），
      //   桥直接取出来塞进 spec，插件照着跑；App 不用自己记哪几行失败了。
      if (j.only === 'pending') {
        const pend = ledger.pending(j.doc).filter((r) => r.number);
        if (!pend.length) return send(res, 200, { ok: false, error: '这份文档上次没有失败行，无需补查' });
        j.pendingRows = pend.map((r) => ({ row: r.row || null, number: String(r.number) }));
        j.rows = j.pendingRows.length;
        console.error(`[jobs] 只补失败：${j.doc} 取到 ${j.pendingRows.length} 行`);
      }
      const job = jobs.create(j);
      console.error(`[jobs] 建任务 ${job.jobId} doc=${job.doc} rows=${job.rows} mode=${job.mode}`);
      return send(res, 200, { ok: true, jobId: job.jobId, job });
    });
  }

  // ② 列表（App 进度面板轮询用）
  if (url.pathname === '/jobs' && req.method === 'GET') {
    const doc = String(url.searchParams.get('doc') || '').trim();
    const list = jobs.list(doc);
    return send(res, 200, { ok: true, count: list.length, jobs: list });
  }

  // ③ 插件领活：原子把 queued → running（同一张表不能两个实例同时写）
  //    注意必须排在 /jobs/:id 之前，否则 "next" 会被当成任务 id
  if (url.pathname === '/jobs/next') {
    const doc = String(url.searchParams.get('doc') || '').trim();
    const got = jobs.next(doc);
    if (!got) return send(res, 200, { ok: true, jobId: null });
    console.error(`[jobs] 领活 ${got.jobId} doc=${got.spec.doc} rows=${got.spec.rows}`);
    return send(res, 200, { ok: true, jobId: got.jobId, spec: got.spec });
  }

  // ④ 插件上报进度/结果
  const mReport = url.pathname.match(/^\/jobs\/([\w.-]+)\/report$/);
  if (mReport && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      const job = jobs.report(mReport[1], body || {});
      if (!job) return send(res, 404, { ok: false, error: '没有这个任务: ' + mReport[1] });
      console.error(`[jobs] 上报 ${job.jobId} ${job.progress.ok}/${job.progress.total} 失败 ${job.progress.failed} state=${job.state}`);
      return send(res, 200, { ok: true, jobId: job.jobId, state: job.state, progress: job.progress });
    });
  }

  // ⑤ 单任务状态
  const mJob = url.pathname.match(/^\/jobs\/([\w.-]+)$/);
  if (mJob && req.method === 'GET') {
    const job = jobs.get(mJob[1]);
    if (!job) return send(res, 404, { ok: false, error: '没有这个任务: ' + mJob[1] });
    return send(res, 200, { ok: true, job });
  }

  // ★ 卡 t_03fc348f：断点续查 —— 拿到某个文档上次失败、要补查的行
  // ★ 2026-11-05：账本 key 是 `工作簿|工作表`，写侧由 /track 的 doc+sheet 拼。
  //   读侧原来只认拼好的整串，于是「传工作簿名查不到、传 工作簿|工作表 才查到」——
  //   知澜按工作簿名查卡了半小时。这里两种传法都认：给了 sheet 就拼，没给当整串。
  const ledgerDocKey = () => {
    const docQ = String(url.searchParams.get('doc') || '').trim();     // 不能过 clean()：会大写化、删空格
    const sheetQ = String(url.searchParams.get('sheet') || '').trim();
    if (docQ && sheetQ && !docQ.includes('|')) return `${docQ}|${sheetQ}`;
    return docQ || '_default';
  };
  if (url.pathname === '/pending') {
    const docKey = ledgerDocKey();
    const rows = ledger.pending(docKey).map((r) => ({
      number: r.number, doc: r.doc, sheet: r.sheet, row: r.row,
      carrier: r.carrier, kind: r.kind, err: r.err, at: r.at,
      cooldownLeftMs: r.carrier ? ledger.cooldownLeft(r.carrier) : 0,
    }));
    return send(res, 200, { ok: true, doc: docKey, count: rows.length, rows });
  }

  // 清账本（用户点「重头查」时）—— 只删这一份文档的记录，不动别的表
  if (url.pathname === '/ledger/clear') {
    const docKey = ledgerDocKey();
    ledger.clear(docKey);
    return send(res, 200, { ok: true, doc: docKey, cleared: true });
  }

  if (url.pathname === '/track-batch') {
    const numbers = (url.searchParams.get('numbers') || '').split(/[,\s]+/).map(clean).filter(Boolean).slice(0, 200);
    if (!numbers.length) return send(res, 400, { ok: false, error: '缺 numbers' });
    const timeoutMs = clampTimeout(url.searchParams.get('timeout'));
    // ★ 2026-11-05：批量也能带 retry=1（待重查批次整批放宽站点窗口）
    const retryHint = url.searchParams.get('retry') === '1' || url.searchParams.get('retry') === 'true';
    const noCache = url.searchParams.get('nocache') === '1' || url.searchParams.get('nocache') === 'true';
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
        const r0 = hit ? { ...hit, cached: true } : await runCli({ number: n, carrier, timeoutMs, pol, pod, retry: retryHint, slotCooldown: isShieldResult, noCache });
        const r = withSchema(r0);
        if (!hit && r.ok && !noCache) cacheSet(key, r);
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
