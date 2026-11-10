// qa/writeback-sim.mjs —— 用假的 WPS 表对象跑 TaskPane 的真实写回代码（★ 2026-11-10）
//
// 目的：不打开 WPS 也能验两条真缺陷的修复（爹地撞到的那两处）：
//   ① 船名列 = 航次列 = P → P 格只写一次 "船名 航次"
//   ② K12:K13 / L12:L13 合并 → 非左上角跳过，报「与 K12:K13 合并」，不报读回不一致
//
// 做法：把 TaskPane.vue 的 <script> 编译成临时 .mjs（放回 src/components 下，相对 import 才解析得到），
//   import 出组件对象，取 methods；不挂载组件（不碰 Vue 渲染 / WPS 全局），直接伪造 this 调用真代码。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, compileScript } from '@vue/compiler-sfc'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const vueFile = path.join(root, 'src/components/TaskPane.vue')
const tmpFile = path.join(root, 'src/components/.sim-TaskPane.mjs')

const src = fs.readFileSync(vueFile, 'utf8')
const { descriptor } = parse(src, { filename: vueFile })
const compiled = compileScript(descriptor, { id: 'sim' })
fs.writeFileSync(tmpFile, compiled.content)

let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`PASS ${label}${extra ? ' · ' + extra : ''}`)
  else { fail++; console.log(`FAIL ${label}${extra ? ' · ' + extra : ''}`) }
}

// ---------- 假 WPS 表：A..Z 全空，只有指定的合并区 ----------
function makeSheet(opts = {}) {
  const merges = opts.merges || []          // [{top:12,left:11,bottom:13,right:11}]
  const cells = new Map()                    // "r|c" -> value
  const kv = (r, c) => `${r}|${c}`
  const mergeOf = (r, c) => merges.find((m) => r >= m.top && r <= m.bottom && c >= m.left && c <= m.right) || null
  const colAddr = (c, r) => `$${colLetter(c)}$${r}`
  const api = {
    cells,
    MergeCells: undefined,
    get Address() { return toAddr() },
    toAddr() { return '' },
  }
  function toAddr() { return `${colAddr(this.__c, this.__r)}` }
  const cellObj = (r, c) => {
    const m = mergeOf(r, c)
    const obj = {
      __r: r, __c: c,
      get MergeCells() { return !!m },
      get MergeArea() {
        if (!m) return null
        return {
          Row: m.top, Column: m.left,
          Address: `$${colLetter(m.left)}$${m.top}:$${colLetter(m.right)}$${m.bottom}`,
        }
      },
      get Value2() { return cells.has(kv(r, c)) ? cells.get(kv(r, c)) : '' },
      set Value2(v) { cells.set(kv(r, c), Array.isArray(v) ? (v[0] && v[0][0] !== undefined ? v[0][0] : v[0]) : v) },
    }
    return obj
  }
  const rangeObj = (a1, a2) => {
    // 支持 Range('K12') / Range('K12:K13') / Range('K12','K13')（真 WPS 三种都收）
    let s1 = String(a1 || '')
    let s2 = a2 == null ? null : String(a2)
    if (s2 == null && s1.includes(':')) { const parts = s1.split(':'); s1 = parts[0]; s2 = parts[1] }
    const p = (s) => {
      const m = String(s).replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/)
      return m ? { c: colNum(m[1]), r: Number(m[2]) } : null
    }
    const A = p(s1), B = p(s2 || s1)
    if (!A || !B) throw new Error('bad range ' + a1 + (a2 == null ? '' : ',' + a2))
    const r1 = Math.min(A.r, B.r), r2 = Math.max(A.r, B.r)
    const c1 = Math.min(A.c, B.c), c2 = Math.max(A.c, B.c)
    const mergedInside = merges.some((m) => m.top >= r1 && m.bottom <= r2 && m.left >= c1 && m.right <= c2)
    const anyMergeTouched = merges.some((m) => !(m.bottom < r1 || m.top > r2 || m.right < c1 || m.left > c2))
    return {
      get MergeCells() {
        if (!anyMergeTouched) return false
        // 和 Excel 一致：整段同状态才返回 true/false，混合返回 null
        const allMergedCells = (r2 - r1 + 1) * (c2 - c1 + 1) === merges.reduce((n, m) => n + (m.bottom - m.top + 1) * (m.right - m.left + 1), 0)
        return allMergedCells ? true : null
      },
      get Value2() {
        if (r1 === r2 && c1 === c2) return cells.has(kv(r1, c1)) ? cells.get(kv(r1, c1)) : null
        const out = []
        for (let r = r1; r <= r2; r++) {
          const row = []
          for (let c = c1; c <= c2; c++) row.push(cells.has(kv(r, c)) ? cells.get(kv(r, c)) : null)
          out.push(row)
        }
        return out
      },
      set Value2(v) {
        if (r1 === r2 && c1 === c2) { cells.set(kv(r1, c1), Array.isArray(v) ? (v[0] && Array.isArray(v[0]) ? v[0][0] : v[0]) : v); return }
        // 二维数组写整段；遇到合并格按 Excel 行为：写左上角，其余丢弃
        let rr = 0
        for (let r = r1; r <= r2; r++, rr++) {
          const row = Array.isArray(v[rr]) ? v[rr] : v
          let cc = 0
          for (let c = c1; c <= c2; c++, cc++) {
            const m = mergeOf(r, c)
            const val = Array.isArray(row) ? row[cc] : row
            if (!m) { cells.set(kv(r, c), val); continue }
            if (r === m.top && c === m.left) cells.set(kv(r, c), val)
            // 非左上角：不进 cells（读回是空）—— 这正是原来误报「读回不一致」的形状
          }
        }
      },
      Cells(r, c) { return cellObj(r, c) },
    }
  }
  const sheet = {
    MergeCells: undefined,
    Cells: (r, c) => cellObj(r, c),
    Range: (a1, a2) => rangeObj(a1, a2),
    get UsedRange() { return rangeObj('A1', 'Z40') },
    get Name() { return '测试表' },
  }
  return { sheet, cells }
}

function colLetter(n) {
  let s = ''
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}
const colNum = (letters) => String(letters).split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)

// ---------- 组装一个够用的 this ----------
const logs = []
const comp = (await import(tmpFile)).default
const M = comp.methods || {}
function makeThis({ sheet, cfg }) {
  const app = { ActiveSheet: sheet, Range: (a1, a2) => sheet.Range(a1, a2), ActiveWorkbook: { ReadOnly: false } }
  const self = {
    cfg,
    logs,
    writeQ: [],
    batch: { id: 'b1', seq: 1, doc: 'doc|测试表', sheet, items: [], cfg, errs: {}, misalignSeen: new Set(), xsheet: {} },
    app() { return app },
    log(m) { logs.push(String(m)) },
    flash() {},
    docKey() { return 'doc|测试表' },
    addr(r, c) { return `${colLetter(c)}${r}` },
    colLetter,
    sameNumber(a, b) { return String(a).replace(/\s/g, '') === String(b).replace(/\s/g, '') },
    readOne(sh, r, c) { const v = sh.Cells(r, c).Value2; return v == null ? '' : v },
    readRangeValues(sh, c, from, to) {
      const values = []
      for (let r = from; r <= to; r++) { const v = sh.Cells(r, c).Value2; values.push(v == null ? '' : v) }
      return { values }
    },
    markMisalign() {},
    _recordWriteFail() {},
    _armWriteFlush() {},
    _yieldToUI() { return Promise.resolve() },
    _writeChunkRows() { return 30 },
    nowMs() { return Date.now() },
    paintRows() { return 0 },
    batchById(id) { return id === 'b1' ? self.batch : null },
    ensureBatch() { return self.batch },
    publishCross() {},
    _accWriteStats() {},
    _deferEntries() { return 0 },
    _sheetUsable() { return true },
    flushingDocs: new Set(),
    cellSeq: new Map(),
  }
  // 把组件里所有真方法挂上来（只覆盖 I/O 与状态相关的那几个）—— 缺方法就补到这里，别在假方法里另抄一套逻辑
  for (const [k, fn] of Object.entries(M)) if (typeof fn === 'function' && self[k] === undefined) self[k] = fn.bind(self)
  return self
}

// ---------- ① 船名列 = 航次列 = P：只写一次 "船名 航次" ----------
{
  const { sheet, cells } = makeSheet()
  const cfg = { numberCol: 2, outCol: 15, vesselCol: 16, voyageCol: 16 }
  const self = makeThis({ sheet, cfg })
  cells.set('12|2', 'DEMO-BL-0001')   // B12 单号
  const it = { number: 'DEMO-BL-0001', numCol: 2, vessel: 'MSC INGY', voyage: 'GT645W', state: 'ok', text: '在途' }
  M.writeResult.call(self, self.batch, it, sheet, 12, 15, false)

  const writes = self.writeQ.filter((w) => w.col === 16)
  ok(writes.length === 1, '船名列=航次列=P → P 只入队 1 次', `len=${writes.length}`)
  ok(writes[0] && writes[0].text === 'MSC INGY GT645W', 'P 格写入值 = "船名 航次"', writes[0] && writes[0].text)
  ok(writes[0] && writes[0].text !== 'GT645W', '不是只剩航次（原 bug）')

  // 真跑一遍写回队列 → 落盘值也要对
  await M._flushWriteQueue.call(self)
  ok(cells.get('12|16') === 'MSC INGY GT645W', '落盘后 P12 = "MSC INGY GT645W"', String(cells.get('12|16')))
}

// ---------- ② 合并格 K12:K13 / L12:L13：非左上角跳过 ----------
{
  const merges = [
    { top: 12, left: 11, bottom: 13, right: 11 },   // K12:K13
    { top: 12, left: 12, bottom: 13, right: 12 },   // L12:L13
  ]
  const { sheet, cells } = makeSheet({ merges })
  const cfg = { numberCol: 2, outCol: 11, vesselCol: 17, voyageCol: 18 }   // 输出列 = K(11)，K/L 是合并区
  const self = makeThis({ sheet, cfg })
  // B12/B13 都有单号（身份校验要过）
  cells.set('12|2', 'DEMO-BL-0001')
  cells.set('13|2', 'DEMO-BL-0002')
  for (const [row, num] of [[12, 'DEMO-BL-0001'], [13, 'DEMO-BL-0002']]) {
    const it = { number: num, numCol: 2, vessel: 'MSC INGY', voyage: 'GT645W', state: 'ok', text: '到港' }
    M.writeResult.call(self, self.batch, it, sheet, row, 11, false)   // 结果列 K：K12 可写、K13 在合并区
  }
  const st = await M._flushWriteQueue.call(self)
  ok(st.merged >= 1, '合并区非左上角被跳过（st.merged>0）', `merged=${st.merged}`)
  const mergedLogs = logs.filter((l) => /合并/.test(l))
  ok(mergedLogs.some((l) => /与 K12:K13 合并/.test(l)), '日志写明「与 K12:K13 合并」', mergedLogs.slice(-2).join(' / '))
  ok(!logs.some((l) => /读回不一致/.test(l)), '没有任何「读回不一致」误报')
  ok(!st.fail, '不算失败（st.fail=0）', `fail=${st.fail}`)
  ok(cells.get('12|11') === '到港', '合并区左上角 K12 正常写入', String(cells.get('12|11')))
  ok(!cells.has('13|11'), 'K13（合并区非左上角）没被写', String(cells.get('13|11')))
}

fs.unlinkSync(tmpFile)
console.log(fail ? `\n${fail} FAIL` : '\nALL PASS')
process.exit(fail ? 1 : 0)
