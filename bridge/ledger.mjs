// 断点续查的账本：失败行落盘 + 船司冷却（卡 t_03fc348f）
//
// 为什么要有（不是优化，是能不能用）：
//   App 工作台一上线，人当天就拿它查几十票。没有断点续查 = 一票失败整批重来；
//   更糟的是撞了限流还硬撞 —— OOCL 连查 6–8 次锁 45 分钟，越撞越久。
//
// 两条独立的事：
//   ① 失败行落盘：key = doc|sheet|row|number（**不含 carrier**：同一行重跑时识别出的
//      船司可能变，key 带 carrier 会让「同一行」变成两个 key、续查对不上行）。
//      记录体里必须有 carrier —— 冷却表按 carrier 索引，失败排队分组也读记录体。
//   ② 冷却表：cooldowns[carrier] = 到期时间戳。命中限流/挑战 → 整家冷静，
//      本轮剩余该家直接标「冷却中」，不发请求；到点自动解封（刷新时判断，不靠后台定时器）。
//
// 落盘位置：~/.hermes/wps-shiptrack/ledger/<docKey>.ndjson（追加写，天生可续）
//           ~/.hermes/wps-shiptrack/cooldowns.json（覆盖写）

import fs from 'node:fs';
import path from 'node:path';

export const COOLDOWN_DEFAULT_MS = 45 * 60 * 1000;   // OOCL 实测锁 45 分钟

/** 落盘 key：doc|sheet|row|number（缺值写 '' 但语义上区分「没传」→ null） */
export function recordKey({ doc, sheet, row, number }) {
  const v = (x) => (x === null || x === undefined ? '' : String(x));
  return [v(doc), v(sheet), v(row), v(number)].join('|');
}

/** 哪些失败算「撞盾」→ 该家整家冷却
 *  ★ 卡 t_991b99f7：必须含 `throttled` —— OOCL 实测报的就是 throttled（oocl.mjs「QF8 访问过于频繁」
 *    的 errorKind）和 blocked，**从不报 challenge**。少了它，OOCL 的限流既不会整家冷却、
 *    也不会触发换档案重试 = 那两条防线对 OOCL 永远不生效。 */
const COOLDOWN_KINDS = new Set(['challenge', 'rate-limit', 'blocked', 'cooling', 'throttled']);

export function isCooldownKind(kind) {
  return COOLDOWN_KINDS.has(String(kind || ''));
}

/** 从一次查询结果里抽出要落盘的记录 */
export function toRecord({ doc, sheet, row, number, result }) {
  const r = result || {};
  const errKind = r.errorKind || (r.ok ? null : 'failed');
  return {
    key: recordKey({ doc, sheet, row, number }),
    doc: doc ?? null,
    sheet: sheet ?? null,
    row: row ?? null,
    number: number ?? null,
    carrier: r.carrier ?? null,
    kind: errKind,
    err: r.ok ? null : (r.error || r.msg || null),
    // 死号不进队列：no_record / aged_out / bad_format / not_wired
    why: r.ok ? null : whyNotRetry(errKind, r.error || r.msg),
    state: r.ok ? 'ok' : (whyNotRetry(errKind, r.error || r.msg) || (STALE_TIMEOUT_KINDS.has(String(errKind)) ? 'stale_timeout' : 'retry_now')),
    retryable: r.ok ? false : !whyNotRetry(errKind, r.error || r.msg),
    at: new Date().toISOString(),
  };
}

// ★ 2026-11-05（知澜定的收口口径）：**不是所有失败都值得重查**。
//   实测 67 格待重查里 25 个是「官网真没有」、3 个是「引擎没接入」——
//   把它们留在队列里，每轮都白烧时间，队列永远打转。
//   所以落账时就把「为什么不该重试」定型：
//     no_record  —— 官网查无此单 / 404（业务限制，重查一百次也一样）
//     aged_out   —— 超出官网保留期（Hapag 只留 12 个月）
//     bad_format —— 号码本身写错（少位/多位），要人去核表，不是机器重试
//   只有「限流 / 网络 / 站点超时 / 挑战」这类**环境性**失败才进待重查队列。
const BAD_FORMAT_RE = /格式不符|位数|应为\s*\d+\s*位|格式错误|too short|at least \d+ char/i;
const AGED_RE = /12\s*个月|超过\s*\d+\s*个月|aged\s*out|超期/i;
const NO_RECORD_RE = /无此单|查无此号|查无此单|no records were found|官网无此|\b404\b|no data/i;

const NOT_WIRED_RE = /no tracking module|没接入|未接入|未支持该船司|no module/i;

/** 这条失败为什么不值得每轮重试？返回 'bad_format' / 'aged_out' / 'no_record' / 'not_wired' / null */
export function whyNotRetry(kind, err) {
  const k = String(kind || '');
  const e = String(err || '');
  if (NOT_WIRED_RE.test(k) || NOT_WIRED_RE.test(e) || /no-module/.test(k)) return 'not_wired';
  if (/bad-format|bad-args/.test(k) || BAD_FORMAT_RE.test(e)) return 'bad_format';
  if (AGED_RE.test(e)) return 'aged_out';
  if (/not-found|no-record/.test(k) || NO_RECORD_RE.test(e)) return 'no_record';
  return null;
}

/** 站点超时不算死号，但也不该每轮重查：+24h、+72h 各试一次，第三次仍空就转 no_record。
 *  这样僵尸队列有上限（最多再烧 2 次查询/行），不会永远打转。 */
export const STALE_TIMEOUT_KINDS = new Set(['timeout']);
export const STALE_RETRY_HOURS = [24, 72];   // 第 1、2 次补试的时间点（相对首次超时）

/** 这条记录现在该不该进待重查队列？
 *  - retry_now（限流/网络/挑战）：进，下一轮就查
 *  - stale_timeout：只在到了 +24h / +72h 才进；补试 2 次仍失败 → 调用方转 no_record
 *  - no_record / aged_out / bad_format / not_wired：永远不进
 *  - ok（kind 为空）：不进
 *  老账本没有 state 字段 → 用 kind/err 现算，向后兼容。 */
export function pendingState(rec) {
  if (!rec || rec.kind === null || rec.kind === undefined) return 'ok';
  if (rec.state) return rec.state;
  const why = whyNotRetry(rec.kind, rec.err);
  if (why) return why;
  if (STALE_TIMEOUT_KINDS.has(String(rec.kind))) return 'stale_timeout';
  return 'retry_now';
}

export function isPendingRecord(rec, now = Date.now()) {
  const st = pendingState(rec);
  if (st === 'retry_now') return true;
  if (st !== 'stale_timeout') return false;
  const tries = Number(rec.staleTries || 0);
  if (tries >= STALE_RETRY_HOURS.length) return false;          // 补试次数用尽 → 已转 no_record
  const nextAt = Number(rec.nextAt || 0);
  return !nextAt || now >= nextAt;
}

export class Ledger {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.coolFile = path.join(dir, 'cooldowns.json');
    this._coolMtime = 0;
    this.cooldowns = this._loadCool();
  }

  /** 文件变了就重读：外部（运维手改、另一个桥实例、测试）写的冷却也要认 */
  _refreshCool() {
    try {
      const st = fs.statSync(this.coolFile);
      if (st.mtimeMs !== this._coolMtime) this.cooldowns = this._loadCool();
    } catch (e) { /* 文件不存在 → 用内存里的 */ }
  }

  _loadCool() {
    try {
      const st = fs.statSync(this.coolFile);
      this._coolMtime = st.mtimeMs;
      return JSON.parse(fs.readFileSync(this.coolFile, 'utf8')) || {};
    } catch (e) { return {}; }
  }

  _saveCool() {
    try {
      fs.writeFileSync(this.coolFile, JSON.stringify(this.cooldowns, null, 2));
      try { this._coolMtime = fs.statSync(this.coolFile).mtimeMs; } catch (e) {}
    } catch (e) { /* 冷却丢了不致命 */ }
  }

  _file(docKey) {
    const safe = String(docKey || '_default').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120);
    return path.join(this.dir, `${safe}.ndjson`);
  }

  /** 追加一批记录（每行一个 JSON，天生可续、坏一行不影响前面） */
  /** 这个 key 历史上「站点超时」过几次（含本次之前所有）。用于 stale_timeout 的补试计数。 */
  _countStale(docKey, key) {
    let n = 0;
    try {
      for (const line of fs.readFileSync(this._file(docKey), 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const r = JSON.parse(s);
          if (r && r.key === key && STALE_TIMEOUT_KINDS.has(String(r.kind))) n++;
        } catch (e) { /* 坏行跳过 */ }
      }
    } catch (e) { /* 文件还不存在 */ }
    return n;
  }

  append(docKey, records) {
    if (!records || !records.length) return;
    const f = this._file(docKey);
    for (const rec of records) {
      // ★ 站点超时不是死号，但也不能每轮重查：+24h、+72h 各补试一次，第三次仍空转 no_record。
      //   这样僵尸队列有硬上限（每行最多再烧 2 次查询），不会永远打转。
      if (rec && rec.state === 'stale_timeout') {
        const prev = this._countStale(docKey, rec.key);
        const hours = STALE_RETRY_HOURS[prev];
        rec.staleTries = prev;
        if (hours === undefined) {
          rec.state = 'no_record';       // 补试次数用尽 → 死号，从此不进队列
          rec.why = 'no_record';
          rec.retryable = false;
          rec.nextAt = 0;
        } else {
          rec.nextAt = Date.now() + hours * 3600 * 1000;
        }
      }
    }
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(f, lines);
  }

  /** 读该文档全部记录，按 key 取**最后一条**（后写的覆盖先写的） */
  read(docKey) {
    const f = this._file(docKey);
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return []; }
    const byKey = new Map();
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (r && r.key) byKey.set(r.key, r);
      } catch (e) { /* 坏行跳过 */ }
    }
    return [...byKey.values()];
  }

  /** 该文档下次要补查的行 */
  pending(docKey) {
    const now = Date.now();
    return this.read(docKey).filter((r) => isPendingRecord(r, now));
  }

  /** 命中撞盾 → 整家冷却 */
  cool(carrier, ms = COOLDOWN_DEFAULT_MS) {
    if (!carrier) return;
    this.cooldowns[carrier] = Date.now() + ms;
    this._saveCool();
  }

  /** 该家还要冷静多久（毫秒）；0 = 可以查 */
  cooldownLeft(carrier) {
    this._refreshCool();          // 外部改过冷却文件就先重读，别拿旧内存判断
    const until = this.cooldowns[carrier] || 0;
    const left = until - Date.now();
    if (left <= 0) {
      if (until) { delete this.cooldowns[carrier]; this._saveCool(); }   // 到点自动解封
      return 0;
    }
    return left;
  }

  /** 清掉某文档的账本（用户点「重头查」或全部成功时） */
  clear(docKey) {
    try { fs.unlinkSync(this._file(docKey)); } catch (e) {}
  }
}
