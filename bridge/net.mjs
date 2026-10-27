// 网络环境探测 + 兜底策略
//
// 痛点（2026-10-26 爹地反馈）：同一套代码在不同网络下表现天差地别——
//   直连时 Maersk/MSC 偶发 ERR_CONNECTION_CLOSED；开了 Clash 又可能连 TLS 都被重置。
//   界面只报「查询失败」，用户不知道是「网络不对」还是「船司没数据」。
//
// 这里只做三件事：
//   1) 认清当前环境：环境变量代理 / 本机 Clash 端口 / 关键站点能否连通
//   2) 给出一条明确的建议（该开代理还是该关代理）
//   3) 提供「强制直连 / 强制走代理」两套 env，让调用方可以按需重试
import net from 'node:net';
import os from 'node:os';

const CLASH_PORTS = [7890, 7897, 1087, 6152, 8889];   // 常见 Clash/ClashX/Clash Verge 混合端口
const HOSTS = [
  { id: 'maersk', host: 'www.maersk.com' },
  { id: 'hapag', host: 'www.hapag-lloyd.com' },
  { id: 'msc', host: 'www.msc.com' },
  { id: 'github', host: 'github.com' },
];

const tcp = (host, port, timeout = 2500) => new Promise((resolve) => {
  const s = new net.Socket();
  const t0 = Date.now();
  const done = (ok, err) => { try { s.destroy(); } catch { /* ignore */ } resolve({ ok, ms: Date.now() - t0, err: err || '' }); };
  s.setTimeout(timeout);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false, 'timeout'));
  s.once('error', (e) => done(false, e.code || e.message));
  s.connect(port, host);
});

let cached = { at: 0, value: null };
const TTL = 60 * 1000;

function envProxy() {
  const e = process.env;
  const pick = (v) => String(v || '').trim();
  const http = pick(e.HTTP_PROXY || e.http_proxy);
  const https = pick(e.HTTPS_PROXY || e.https_proxy);
  const noProxy = pick(e.NO_PROXY || e.no_proxy);
  return { http, https, noProxy };
}

/** 探测本机代理端口是否在监听（Clash 系列） */
async function clashListening() {
  for (const p of CLASH_PORTS) {
    const r = await tcp('127.0.0.1', p, 600);
    if (r.ok) return p;
  }
  return 0;
}

/** 当前网络画像（缓存 60s，避免每次查询都探一遍） */
export async function profile(force = false) {
  if (!force && cached.value && Date.now() - cached.at < TTL) return cached.value;

  const env = envProxy();
  const clashPort = await clashListening();
  const reach = {};
  await Promise.all(HOSTS.map(async ({ id, host }) => {
    const r = await tcp(host, 443, 3000);
    reach[id] = r;
  }));

  const okCount = Object.values(reach).filter((r) => r.ok).length;
  const allFail = okCount === 0;
  const proxyOn = !!(env.http || env.https || clashPort);

  let advice = '';
  let mode = 'direct';
  if (allFail) {
    advice = proxyOn
      ? '所有目标都连不上，但检测到本机代理在跑 —— 可能是代理规则漏了这些域名（本项目会自动换线重试，不需要你改设置）。'
      : '所有目标都连不上，也没有代理 —— 像是断网（本项目会在可用线路间自动重试）。';
  } else if (!proxyOn && okCount < HOSTS.length) {
    advice = '部分站点直连不通（' + Object.entries(reach).filter(([, r]) => !r.ok).map(([k]) => k).join('/') + '）—— 本项目对这些站会走备用域名/换线重试。';
    mode = 'partial-direct';
  } else if (proxyOn) {
    mode = 'proxied';
  }

  const value = {
    env,
    clashPort,
    proxyOn,
    reach,
    okCount,
    total: HOSTS.length,
    allFail,
    mode,
    advice,
    hostname: os.hostname(),
    at: new Date().toISOString(),
  };
  cached = { at: Date.now(), value };
  return value;
}

/** 给子进程用的两套环境：强制直连 / 沿用当前（含代理） */
export function childEnv(forceDirect) {
  const env = { ...process.env };
  if (forceDirect) {
    // undici/Chromium 都认这三个；NO_PROXY=* 表示全部直连
    env.HTTP_PROXY = '';
    env.HTTPS_PROXY = '';
    env.http_proxy = '';
    env.https_proxy = '';
    env.NO_PROXY = '*';
    env.no_proxy = '*';
  }
  return env;
}

/** 一次连接级失败后，值不值得换个网络姿势重试 */
export function isConnectionLevel(errorText) {
  return /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i
    .test(String(errorText || ''));
}
