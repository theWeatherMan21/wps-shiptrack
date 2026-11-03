// 派活队列：App 建任务 → 插件领活 → 回填后上报（卡 t_aa0674a9 第一步）
//
// 为什么非得有这一层（不是设计洁癖）：
//   单号只有 WPS 插件能读、单元格只有插件能写。App 读不到用户打开的那张表，
//   也写不进去。所以「在 App 里点一下发起并自动回填」只能靠桥做中转台：
//     App --POST /jobs--> 桥 --GET /jobs/next--> 插件（2.5s 心跳领活）
//     插件读列 → 调 /track（带 doc/sheet/row）→ 写回 → POST /jobs/:id/report
//
// 落盘：~/.hermes/wps-shiptrack/jobs-queue/<jobId>.json
//   每个任务一个文件（原子写 tmp+rename），跟 ledger.mjs 一个路子——
//   桥重启/App 关掉任务都不丢，这是 DoD 里明写的「中途关掉 App，任务不丢」。
//
// 领活必须原子：同一份文档同一时刻只该有一个插件实例在跑（WPS 里同一张表被两个
//   面板同时写 = 互相覆盖）。所以 next() 里把 state 从 queued 改成 running 再返回。

import fs from 'node:fs';
import path from 'node:path';

export const JOB_STATES = ['queued', 'running', 'done', 'failed', 'stopped'];

/** 任务 id：时间戳 + 随机后缀，可排序、可读、不撞 */
function newId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `job-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/** 规整 App 传来的 spec —— 越界/缺字段一律按默认值，不让脏参数进队列 */
export function normalizeSpec(raw = {}) {
  const cols = raw.cols || {};
  const rows = num(raw.rows, 0);
  return {
    doc: String(raw.doc || '').trim(),
    cols: {
      number: num(cols.number, 0),
      out: num(cols.out, 0),
      carrier: num(cols.carrier, 0),
      pol: num(cols.pol, 0),
      pod: num(cols.pod, 0),
    },
    startRow: Math.max(2, num(raw.startRow, 2)),   // 0/1 视为未设：表头占一行，数据从第 2 行起
    rows: Math.min(2000, rows),
    mode: raw.mode === 'range' ? 'range' : 'column',
  };
}

export class JobQueue {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.mem = new Map();      // jobId -> job（读过的缓存）
    this._loadAll();
  }

  _file(id) { return path.join(this.dir, `${id}.json`); }

  _write(job) {
    const f = this._file(job.jobId);
    const tmp = `${f}.tmp${process.pid}`;
    const payload = JSON.stringify(job, null, 2);
    try {
      fs.writeFileSync(tmp, payload);
    } catch (e) {
      // 目录被清理工具扫掉过 → 重建再试一次。
      // 不自愈的后果：这座桥之后**每一次**派活都写不进盘，任务只活在内存里，
      // 一重启全没 —— 而且表面看不出来（列表照样有数据）。
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        try {
          fs.mkdirSync(this.dir, { recursive: true });
          fs.writeFileSync(tmp, payload);
        } catch (e2) {
          throw new Error(`任务落盘失败（已尝试重建目录 ${this.dir}）: ${e2.code || ''} ${e2.message || e2}`);
        }
      } else {
        throw new Error(`任务落盘失败: ${e.code || ''} ${e.message || e}`);
      }
    }
    try {
      fs.renameSync(tmp, f);          // 原子替换：半截文件永远不会被读到
    } catch (e) {
      throw new Error(`任务改名失败: ${e.code || ''} ${e.message || e}`);
    }
    this.mem.set(job.jobId, job);
    return job;
  }

  _loadAll() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch (e) { return; }
    for (const n of names) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
        if (j && j.jobId) this.mem.set(j.jobId, j);
      } catch (e) { /* 坏文件跳过，不影响其它任务 */ }
    }
  }

  /** 读单个任务：内存没有再读盘（外部手写/另一个进程写的也要认） */
  get(id) {
    if (this.mem.has(id)) {
      // 文件可能被改过（另一个桥实例），比对 mtime
      try {
        const st = fs.statSync(this._file(id));
        const cached = this.mem.get(id);
        if (cached._mtime && st.mtimeMs !== cached._mtime) {
          const fresh = JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
          fresh._mtime = st.mtimeMs;
          this.mem.set(id, fresh);
          return fresh;
        }
      } catch (e) { return this.mem.get(id); }
      return this.mem.get(id);
    }
    try {
      const j = JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
      try { j._mtime = fs.statSync(this._file(id)).mtimeMs; } catch (e) {}
      this.mem.set(id, j);
      return j;
    } catch (e) { return null; }
  }

  /** 建任务 */
  create(raw) {
    const spec = normalizeSpec(raw);
    const job = {
      jobId: newId(),
      doc: spec.doc,
      cols: spec.cols,
      startRow: spec.startRow,
      rows: spec.rows,
      mode: spec.mode,
      state: 'queued',
      createdAt: new Date().toISOString(),
      claimedAt: null,
      finishedAt: null,
      progress: { done: 0, total: 0, ok: 0, failed: 0 },
      lastError: null,
      reports: [],
    };
    return this._write(job);
  }

  /**
   * 插件领活：原子把 queued → running。
   * @param {string} doc 文档 key（"工作簿|工作表"）；空 = 不挑，随便给一个
   * @returns {{jobId:string, spec:object}|null}
   */
  next(doc = '') {
    const want = String(doc || '');
    const candidates = [...this.mem.values()]
      .filter((j) => j.state === 'queued')
      .filter((j) => !want || j.doc === want)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const job = candidates[0];
    if (!job) return null;
    job.state = 'running';
    job.claimedAt = new Date().toISOString();
    this._write(job);
    return {
      jobId: job.jobId,
      spec: { doc: job.doc, cols: job.cols, startRow: job.startRow, rows: job.rows, mode: job.mode },
    };
  }

  /** 插件上报进度/结果 */
  report(id, raw = {}) {
    const job = this.get(id);
    if (!job) return null;
    const ok = num(raw.ok, 0);
    const failed = num(raw.failed, 0);
    const total = num(raw.total, ok + failed);
    job.progress = { done: ok + failed, total, ok, failed };
    job.reports.push({
      at: new Date().toISOString(),
      ok, failed, total,
      written: num(raw.written, 0),
      note: raw.note ? String(raw.note).slice(0, 200) : null,
    });
    if (job.reports.length > 50) job.reports = job.reports.slice(-50);   // 防无限增长
    // 上报里带 state 才改状态（进度上报不动状态，避免中途把任务标完成）
    if (raw.state && JOB_STATES.includes(String(raw.state))) {
      job.state = String(raw.state);
      if (job.state === 'done' || job.state === 'failed' || job.state === 'stopped') {
        job.finishedAt = new Date().toISOString();
      }
    }
    if (raw.error) job.lastError = String(raw.error).slice(0, 300);
    return this._write(job);
  }

  /** 某文档的任务列表（App 的进度面板用） */
  list(doc = '') {
    const want = String(doc || '');
    return [...this.mem.values()]
      .filter((j) => !want || j.doc === want)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((j) => ({
        jobId: j.jobId, doc: j.doc, state: j.state, rows: j.rows,
        createdAt: j.createdAt, finishedAt: j.finishedAt, progress: j.progress, lastError: j.lastError,
      }));
  }

  /** 把 running 但插件早死掉的任务放回队列（桥重启后自愈） */
  requeueStale(olderThanMs = 10 * 60 * 1000) {
    const now = Date.now();
    const out = [];
    for (const j of this.mem.values()) {
      if (j.state !== 'running') continue;
      const t = Date.parse(j.claimedAt || j.createdAt || 0);
      if (Number.isFinite(t) && now - t > olderThanMs) {
        j.state = 'queued';
        j.claimedAt = null;
        this._write(j);
        out.push(j.jobId);
      }
    }
    return out;
  }
}
