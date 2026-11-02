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

/** 哪些失败算「撞盾」→ 该家整家冷却 */
const COOLDOWN_KINDS = new Set(['challenge', 'rate-limit', 'blocked', 'cooling']);

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
    err: r.ok ? null : (r.error || null),
    at: new Date().toISOString(),
  };
}

/** 一条记录是不是「下次要补查的」：失败且不是冷却类（冷却类等解封后再说，仍算待补） */
export function isPendingRecord(rec) {
  return !!rec && rec.kind !== null && rec.kind !== undefined;
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
  append(docKey, records) {
    if (!records || !records.length) return;
    const f = this._file(docKey);
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
    return this.read(docKey).filter(isPendingRecord);
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
