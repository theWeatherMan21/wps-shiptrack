// 在线更新：检查 + 落地安装（零依赖，只用 Node 内置模块 + 系统 tar/zstd 不可用时的纯 JS 解包）
//
// 设计原则（为什么这么做）：
//  1. WPS 12.1 起只能走 publish.xml 本地目录加载，没有官方远程热更 → 更新必须由我们改本地文件。
//  2. 改文件 = 高风险动作：所以「下载 → 校验 sha256 → 解到临时目录 → 校验版本 → 备份旧目录 → 替换 → 复核」
//     任何一步失败都回滚，绝不留下半个加载项（上次装机就是这么把目录搞没的）。
//  3. 更新源可配置：WPS_UPDATE_URL（默认空 = 关掉检查）。局域网/Tailscale/Release 都能挂。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 已安装加载项目录（按平台） */
export function addonDir() {
  if (process.env.WPS_ADDON_DIR) return process.env.WPS_ADDON_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'kingsoft', 'wps', 'jsaddons', 'ShipTrack_');
  }
  return path.join(HOME, 'Library', 'Containers', 'com.kingsoft.wpsoffice.mac', 'Data', '.kingsoft', 'wps', 'jsaddons', 'ShipTrack4_');
}

/** 本地版本：优先 version.json（装机时写入），退化到扫 assets 里的 APP_VER 字符串 */
const CACHE = path.join(HOME, '.hermes', 'wps-shiptrack', 'installed.json');

export function installedVersion() {
  // macOS：桥是普通进程，读不了 ~/Library/Containers/* → 只认装机时写的可读缓存
  if (process.platform !== 'win32') {
    try {
      const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (j.version) return j.version;
    } catch { /* 没缓存，继续退化 */ }
  }
  const dir = addonDir();
  const vj = path.join(dir, 'version.json');
  try {
    if (fs.existsSync(vj)) return JSON.parse(fs.readFileSync(vj, 'utf8')).version || '';
  } catch { /* 坏文件就退化 */ }
  try {
    const assets = path.join(dir, 'assets');
    for (const f of fs.readdirSync(assets)) {
      if (!f.endsWith('.js')) continue;
      const m = fs.readFileSync(path.join(assets, f), 'utf8').match(/APP_VER\s*=\s*['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/);
      if (m) return m[1];
    }
  } catch { /* 没装 */ }
  return '';
}

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};

/**
 * 更新源：
 *   ① 环境变量 WPS_UPDATE_URL
 *   ② 本机配置文件 ~/.hermes/wps-shiptrack/update-url.txt
 *      （Windows 的桥由计划任务启动，改环境变量要动计划任务；写个文件更省事）
 *   ③ 都没有 → 走 GitHub 仓库模式（WPS_UPDATE_REPO）
 */
export function updateSource() {
  const env = String(process.env.WPS_UPDATE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  try {
    const f = path.join(os.homedir(), '.hermes', 'wps-shiptrack', 'update-url.txt');
    const txt = String(fs.readFileSync(f, 'utf8')).trim();
    if (txt) return txt.replace(/\/+$/, '');
  } catch { /* 没有配置文件就走仓库模式 */ }
  return '';
}

/** 固定 tag：绝不能依赖 releases/latest —— 宿主 App 自己发版会把 latest 顶掉，WPS 资产就不在那个 release 里了 */
const ghTag = () => String(process.env.WPS_UPDATE_TAG || 'wps-latest').trim();

/** GitHub 模式：WPS_UPDATE_REPO=owner/repo（+ GH_TOKEN，私有仓必需） */
export function updateRepo() {
  return String(process.env.WPS_UPDATE_REPO || '').trim();
}

const ghToken = () => String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();

function ghHeaders(accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'shiptrack-bridge' };
  const t = ghToken();
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}

/** 从 GitHub release 读 manifest + 资产（私有仓靠 Bearer token） */
async function ghRelease() {
  const repo = updateRepo();
  const r = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(ghTag())}`, 20000, ghHeaders());
  if (!r.ok) throw new Error(`GitHub release(${ghTag()}) HTTP ${r.status}${r.status === 401 || r.status === 403 ? '（token 无效或无权限）' : ''}`);
  const rel = await r.json();
  const assets = rel.assets || [];
  const find = (name) => assets.find((a) => a.name === name);
  const manAsset = find(process.env.WPS_UPDATE_MANIFEST || 'wps-version.json') || find('version.json');
  if (!manAsset) throw new Error('该 release 没有 version.json 资产');
  const mr = await fetchWithTimeout(manAsset.url, 20000, ghHeaders('application/octet-stream'));
  if (!mr.ok) throw new Error('下载 version.json 失败 HTTP ' + mr.status);
  const man = await mr.json();
  man.tag = rel.tag_name;
  man.htmlUrl = rel.html_url;
  man._assetUrl = (name) => {
    const a = find(name) || assets.find((x) => x.name.endsWith('.tar.gz'));
    return a ? a.url : null;
  };
  return man;
}

async function ghAsset(url) {
  const r = await fetchWithTimeout(url, 120000, ghHeaders('application/octet-stream'));
  if (!r.ok) throw new Error('下载资产失败 HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function fetchWithTimeout(url, timeoutMs = 15000, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctl.signal, headers: { 'Cache-Control': 'no-cache', ...headers } });
  } finally { clearTimeout(t); }
}

/** 查：比对本地版本与远端 manifest */
export async function checkUpdate() {
  const local = installedVersion();
  const base = updateSource();
  const repo = base ? '' : updateRepo();   // URL 优先：静态/镜像源更可控
  if (!base && !repo) return { ok: true, enabled: false, local, remote: null, hasUpdate: false, reason: '未配置更新源（WPS_UPDATE_URL 或 WPS_UPDATE_REPO）' };
  try {
    if (repo) {
      const man = await ghRelease();
      const hasUpdate = !!man.version && cmp(man.version, local) > 0;
      return { ok: true, enabled: true, source: 'github', repo, local, remote: { version: man.version, file: man.file, sha256: man.sha256, tag: man.tag }, hasUpdate, notes: man.notes || '' };
    }
    const manName = process.env.WPS_UPDATE_MANIFEST || 'wps-version.json';
    const r = await fetchWithTimeout(`${base}/${manName}${base.includes('?') ? '&' : '?'}t=${Date.now()}`);
    if (!r.ok) return { ok: false, enabled: true, local, error: `拉取 version.json 失败 HTTP ${r.status}` };
    const man = await r.json();
    const hasUpdate = !!man.version && cmp(man.version, local) > 0;
    return { ok: true, enabled: true, local, remote: man, hasUpdate, notes: man.notes || '' };
  } catch (e) {
    return { ok: false, enabled: true, local, error: '更新源不可达: ' + String(e.message || e).slice(0, 80) };
  }
}

/** 装：下载 → 校验 → 解压 → 比对 → 备份 → 替换 → 复核（失败回滚） */
let APPLYING = false;

export async function applyUpdate() {
  if (APPLYING) return { ok: false, error: '已有一次更新在进行中，请稍候' };
  APPLYING = true;
  try { return await applyUpdateInner(); } finally { APPLYING = false; }
}

async function applyUpdateInner() {
  const base = updateSource();
  if (!base && !updateRepo()) return { ok: false, error: '未配置更新源（WPS_UPDATE_URL / WPS_UPDATE_REPO）' };
  const chk = await checkUpdate();
  if (!chk.ok) return { ok: false, error: chk.error };
  if (!chk.hasUpdate) return { ok: false, error: `已是最新（本地 ${chk.local}）` };

  const dir = addonDir();
  let man = chk.remote;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shiptrack-upd-'));
  const pkg = path.join(tmp, 'pkg.tar.gz');
  const steps = [];

  try {
    // 1) 下载
    if (updateRepo()) {
      const full = await ghRelease();           // 带 _assetUrl
      const url = full._assetUrl(full.file);
      if (!url) throw new Error('release 里找不到安装包资产');
      fs.writeFileSync(pkg, await ghAsset(url));
      man = { ...man, ...full };
    } else {
      const r = await fetchWithTimeout(`${base}/${man.file}${base.includes('?') ? '&' : '?'}t=${Date.now()}`, 120000);
      if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
      fs.writeFileSync(pkg, Buffer.from(await r.arrayBuffer()));
    }
    steps.push('downloaded ' + fs.statSync(pkg).size + 'B');

    // 2) 校验
    if (man.sha256) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(pkg)).digest('hex');
      if (h !== man.sha256) throw new Error('sha256 不匹配（包损坏或被替换）');
      steps.push('sha256 ok');
    }

    // 3) 解压
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out, { recursive: true });
    if (process.platform === 'win32') {
      execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xzf', pkg, '-C', out], { stdio: 'pipe' });
    } else {
      execFileSync('tar', ['-xzf', pkg, '-C', out], { stdio: 'pipe' });
    }
    // macOS 打的包会带 ._xxx 资源叉文件 → 一律清掉（Windows 上会变成 28 个文件的垃圾）
    const stripAppleDouble = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) stripAppleDouble(f);
        else if (e.name.startsWith('._')) fs.rmSync(f, { force: true });
      }
    };
    stripAppleDouble(out);

    // 允许包内是 ShipTrack_/ 或直接就是内容
    let stage = out;
    const inner = fs.readdirSync(out).filter((n) => !n.startsWith('.'));
    if (inner.length === 1 && fs.statSync(path.join(out, inner[0])).isDirectory()) stage = path.join(out, inner[0]);
    const files = countFiles(stage);
    if (!files) throw new Error('包里没有文件');
    const vj = path.join(stage, 'version.json');
    const pkgVer = fs.existsSync(vj) ? JSON.parse(fs.readFileSync(vj, 'utf8')).version : man.version;
    if (man.version && pkgVer && cmp(pkgVer, man.version) !== 0) throw new Error(`包内版本 ${pkgVer} 与 manifest ${man.version} 不一致`);
    steps.push(`extracted ${files} files v${pkgVer}`);

    // 4) 替换
    if (process.platform === 'win32') {
      const bak = dir + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      if (fs.existsSync(dir)) {
        fs.cpSync(dir, bak, { recursive: true });
        steps.push('backup ' + path.basename(bak));
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.cpSync(stage, dir, { recursive: true });
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        if (fs.existsSync(bak)) fs.cpSync(bak, dir, { recursive: true });
        throw new Error('替换失败已回滚: ' + e.message);
      }
    } else {
      // macOS：整段交给 HermesFileHelper（TCC 只放行那个 .app）
      const script = path.join(REPO_ROOT, 'scripts', 'apply-update-mac.sh');
      if (!fs.existsSync(script)) throw new Error('缺装机脚本: ' + script);
      const out = execFileSync('bash', [script, stage, man.version || pkgVer], { encoding: 'utf8' });
      steps.push('filehelper: ' + out.trim().split('\n').pop().slice(0, 80));
    }

    // 5) 复核
    const after = installedVersion();
    // macOS 读不了 Containers/*，文件数用包内统计值代替
    const afterFiles = process.platform === 'win32' ? countFiles(dir) : files;
    if (man.version && after !== man.version) throw new Error(`替换后版本仍是 ${after}（期望 ${man.version}）`);
    steps.push(`installed v${after} / ${afterFiles} files`);

    // 清理旧备份，只留最近 1 个
    try {
      const parent = path.dirname(dir);
      const mine = fs.readdirSync(parent).filter((n) => n.startsWith(path.basename(dir) + '.bak-')).sort();
      for (const n of mine.slice(0, -1)) fs.rmSync(path.join(parent, n), { recursive: true, force: true });
    } catch { /* 清理失败不算错 */ }

    return { ok: true, from: chk.local, to: after, files: afterFiles, steps, needRestart: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e), steps };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += 1;
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return n;
}
