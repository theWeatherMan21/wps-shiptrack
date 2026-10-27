// WPS 表格 API 桩（无头测试共用）：状态机探针与渲染冒烟都用它，避免两套桩行为不一致
export const STUB = ({ doc = 'A.xlsx', lead = 0, grid = null, evKind = null, savedCfg = null, header2d = false }) => {
  // header2d: WPS 真实行为 —— 1 行 × N 列的范围，Value2 回的是 [[c1..cN]]（不是列向量）
  const NUM = 15, OUT = 18, LAST = 6
  window.__grid = grid || { [`1,${NUM}`]: 'MBL', [`2,${NUM}`]: '276759780', [`3,${NUM}`]: '802735343', [`4,${NUM}`]: '802735426' }
  window.__calls = []
  window.__evKind = evKind
  window.__written = []
  window.__sel = { col: NUM, row: 1, rows: 1048576, cols: 1 }
  window.__doc = doc
  window.__readonly = false
  window.__writeBlock = false
  window.__bridgeDown = false
  window.__wantStop = false
  const parse = (addr) => {
    const p = String(addr).split(':')
    const one = (a) => {
      const m = /^([A-Z]+)(\d+)$/.exec(a.trim().toUpperCase())
      let col = 0
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
      return { col, row: Number(m[2]) }
    }
    const a = one(p[0]); return { a, b: p[1] ? one(p[1]) : a }
  }
  window.__fills = []
  const interior = (r, c) => ({
    Pattern: 1,
    set Color(v) { window.__fills.push([r, c, v]) },
    set ColorIndex(v) { window.__fills.push([r, c, v]) }
  })
  const cell = (r, c) => ({
    get Value2() { return window.__grid[`${r},${c}`] ?? '' },
    set Value2(v) {
      if (window.__writeBlock) throw new Error('写入被拒绝（模拟保护/只读）')
      window.__grid[`${r},${c}`] = v
      window.__written.push([r, c, v])
    },
    get Interior() { return interior(r, c) }
  })
  window.Application = {
    Version: '12.1', Build: '1', Name: 'WPS 表格',
    ActiveDocument: { Name: 'x.xlsx' },
    get ActiveWorkbook() { return { Name: window.__doc, ReadOnly: window.__readonly, ProtectStructure: false } },
    get Selection() {
      const s = window.__sel
      return { Column: s.col, Row: s.row, Rows: { Count: s.rows }, Columns: { Count: s.cols || 1 },
        Value2: [[window.__grid[`1,${s.col}`] || '']], Text: window.__grid[`1,${s.col}`] || '' }
    },
    ActiveSheet: {
      Name: 'Sheet1', ProtectContents: false,
      UsedRange: { Row: 1, Rows: { Count: LAST }, Columns: { Count: 13 } },
      Cells: { Item: (r, c) => cell(r, c) },
      Range: (addr) => {
        const { a, b } = parse(addr)
        return {
          get Value2() {
            if (a.row === b.row && a.col === b.col) return window.__grid[`${a.row},${a.col}`] ?? ''
            if (header2d && a.row === b.row && b.col > a.col) {
              // 单行多列：真实 WPS 回 [[c1, c2, ...]]，历史上就是这里把表头读没了
              const row = []
              for (let c = a.col; c <= b.col; c++) row.push(window.__grid[`${a.row},${c}`] ?? '')
              return [row]
            }
            const out = []
            for (let r = a.row; r <= b.row; r++) out.push([window.__grid[`${r},${a.col}`] ?? ''])
            return out
          },
          get Text() {
            const o = []
            for (let r = a.row; r <= b.row; r++) o.push(window.__grid[`${r},${a.col}`] ?? '')
            return o.join('\n')
          },
          set Value2(v) {
            if (window.__writeBlock) throw new Error('写入被拒绝（模拟保护/只读）')
            window.__grid[`${a.row},${a.col}`] = v
            window.__written.push([a.row, a.col, v])
          },
          get Interior() { return interior(a.row, a.col) }
        }
      }
    },
    PluginStorage: { _m: {}, getItem(k) { return this._m[k] ?? null }, setItem(k, v) { this._m[k] = String(v) } }
  }
  // 兜底 XHR 也要跟着 __bridgeDown 走，否则会打真桥（本机 8791 真在跑）
  window.XMLHttpRequest = function () {
    return {
      timeout: 0,
      open() {}, setRequestHeader() {},
      send() {
        setTimeout(() => {
          if (window.__bridgeDown) { this.onerror && this.onerror(new Error('network')) }
          else {
            this.responseText = '{"ok":true}'
            this.onload && this.onload()
          }
        }, 5)
      }
    }
  }
  window.fetch = (u) => {
    window.__calls.push(String(u))
    if (window.__bridgeDown) return Promise.reject(new Error('ECONNREFUSED'))
    const s = String(u)
    let body = { ok: true }
    if (s.includes('/health')) body = { ok: true }
    else if (s.includes('/config')) body = { ok: true, cfg: savedCfg, exact: true }
    else if (s.includes('/carriers')) body = { ok: true, count: 12, liveCount: 11, carriers: [
      { id: 'hapag', name: 'Hapag-Lloyd', live: true }, { id: 'oocl', name: 'OOCL', live: false }] }
    else if (s.includes('/identify')) body = { ok: true, carrier: null, candidates: [] }
    else if (s.includes('/track')) {
      const num = new URL(s).searchParams.get('number') || ''
      const EV = {
        // 在途：离港后还没到
        at_sea: [{ time: '2026-10-02T00:00:00Z', activity: 'Export Loaded on Vessel', city: 'QINGDAO' },
                 { time: '2026-10-03T00:00:00Z', activity: 'Departure From', city: 'QINGDAO' }],
        // 已到目的港
        arrived: [{ time: '2026-10-03T00:00:00Z', activity: 'Departure From', city: 'QINGDAO' },
                  { time: '2026-11-01T00:00:00Z', activity: 'Arrival In', city: 'ISTANBUL' }],
        // 已还空箱
        empty: [{ time: '2026-11-01T00:00:00Z', activity: 'Arrival In', city: 'ISTANBUL' },
                { time: '2026-11-05T00:00:00Z', activity: 'Empty Received At Cy', city: 'ISTANBUL' }]
      }
      if (/^HLCU/.test(num)) body = { ok: false, number: num, carrier: 'hapag', error: 'DOCUMENT does not exist. (Format : HLCUEUR2510CFF08BXX)' }
      else if (window.__evByNumber && window.__evByNumber[num]) body = { ok: true, number: num, events: window.__evByNumber[num] }   // 按号给不同事件（双列测试用）
      else body = { ok: true, number: num, events: EV[window.__evKind || 'at_sea'] }
      if (window.__evKind) { /* 每条都按当前设定 */ }
    }
    return new Promise((res) => setTimeout(() => res({ json: () => Promise.resolve(body) }), lead))
  }
}
