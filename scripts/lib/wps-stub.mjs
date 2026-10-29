// WPS 表格 API 桩（无头测试共用）：状态机探针与渲染冒烟都用它，避免两套桩行为不一致
export const STUB = ({ doc = 'A.xlsx', lead = 0, grid = null, evKind = null, savedCfg = null, header2d = false, bridgeMode = 'ok', last = 6, comMs = 0 }) => {
  // header2d: WPS 真实行为 —— 1 行 × N 列的范围，Value2 回的是 [[c1..cN]]（不是列向量）
  const NUM = 15, OUT = 18
  window.__grid = grid || { [`1,${NUM}`]: 'MBL', [`2,${NUM}`]: '276759780', [`3,${NUM}`]: '802735343', [`4,${NUM}`]: '802735426' }
  window.__last = last      // UsedRange 的末行（真删行时要跟着缩，见 __deleteRow）
  window.__calls = []
  window.__evKind = evKind
  window.__written = []
  window.__sel = { col: NUM, row: 1, rows: 1048576, cols: 1 }
  window.__doc = doc
  window.__readonly = false
  window.__writeBlock = false
  window.__bridgeDown = false
  // 桥的四种现场（H19-H21 用）：
  //   ok      健康
  //   down    8791 无监听（连接被拒）→ 面板应说「进程没在跑」
  //   blocked 端口能连上（no-cors 探针通过），但页面请求被 CSP/跨域拦 → 「加载项被拦」
  //   denied  桥在跑但自报 ok:false（例如 Origin 被拒）→ 原样转述桥的原因
  window.__bridgeMode = bridgeMode
  const bridgeModeNow = () => (window.__bridgeDown ? 'down' : window.__bridgeMode)
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
  // ★ 0.9.42：每次碰表格 API 都记一笔（__ops），并可注入忙等延迟（__comMs）——
  //   「写回阶段多少次同步 COM」是这一轮改造的核心指标，桩里必须能数出来。
  window.__ops = 0
  window.__comMs = comMs || 0
  window.__batchWrites = []     // 多格写入（批量写）记录：{ addr, rows, cols, kind }
  const COM = () => {
    window.__ops++
    if (window.__comMs > 0) {
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + window.__comMs
      while ((typeof performance !== 'undefined' ? performance.now() : Date.now()) < t) { /* 忙等：模拟同步 COM */ }
    }
  }
  // ★ 0.9.41：真删一行 —— 下方整体上移、末行清掉、UsedRange 跟着缩。
  // 只改行号不改 grid 是假场景：被测代码读回的单号会跟真表一致，bug 就测不出来。
  window.__deleteRow = (n) => {
    const lastR = window.__last
    const cols = 40
    for (let r = n; r < lastR; r++) {
      for (let c = 1; c <= cols; c++) {
        const v = window.__grid[`${r + 1},${c}`]
        if (v === undefined) delete window.__grid[`${r},${c}`]
        else window.__grid[`${r},${c}`] = v
      }
    }
    for (let c = 1; c <= cols; c++) delete window.__grid[`${lastR},${c}`]
    window.__last = Math.max(1, lastR - 1)
    return window.__last
  }
  const interior = (r, c, r2) => ({
    Pattern: 1,
    set Color(v) { COM(); for (let rr = r; rr <= (r2 || r); rr++) window.__fills.push([rr, c, v]) },
    set ColorIndex(v) { COM(); for (let rr = r; rr <= (r2 || r); rr++) window.__fills.push([rr, c, v]) }
  })
  const cell = (r, c) => ({
    get Value2() { COM(); return window.__grid[`${r},${c}`] ?? '' },
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
      get UsedRange() { COM(); return { Row: 1, Rows: { Count: window.__last }, Columns: { Count: 13 } } },
      Cells: { Item: (r, c) => { COM(); return cell(r, c) } },
      Range: (addr) => {
        COM()
        const { a, b } = parse(addr)
        return {
          get Value2() {
            COM()
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
            COM()
            if (window.__writeBlock) throw new Error('写入被拒绝（模拟保护/只读）')
            const rows = b.row - a.row + 1
            const cols = b.col - a.col + 1
            if (rows * cols > 1) {
              // ★ 0.9.42：多格写入（批量写）。真实 WPS 认二维数组，部分版本只认一维 —— 两种都收，
              //   形状不对就抛错（正是生产代码要「批量写不可用就退回逐格」的依据）。
              if (!Array.isArray(v)) throw new Error('多格写入必须传数组')
              const kind = Array.isArray(v[0]) ? '2D' : '1D'
              window.__batchWrites.push({ addr, rows, cols, kind })
              if (kind === '2D') {
                if (v.length !== rows) throw new Error(`二维数组行数不符 ${v.length}/${rows}`)
                for (let r = 0; r < rows; r++) {
                  const line = v[r]
                  if (!Array.isArray(line) || line.length !== cols) throw new Error(`第 ${r + 1} 行长度不符`)
                  for (let c = 0; c < cols; c++) {
                    window.__grid[`${a.row + r},${a.col + c}`] = line[c]
                    window.__written.push([a.row + r, a.col + c, line[c]])
                  }
                }
              } else {
                if (v.length !== rows * cols) throw new Error(`一维数组长度不符 ${v.length}/${rows * cols}`)
                for (let r = 0; r < rows; r++) {
                  for (let c = 0; c < cols; c++) {
                    const val = v[r * cols + c]
                    window.__grid[`${a.row + r},${a.col + c}`] = val
                    window.__written.push([a.row + r, a.col + c, val])
                  }
                }
              }
              return
            }
            window.__grid[`${a.row},${a.col}`] = v
            window.__written.push([a.row, a.col, v])
          },
          get Interior() { COM(); return interior(a.row, a.col, b.row) }
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
          const mode = bridgeModeNow()
          if (mode === 'down' || mode === 'blocked') { this.onerror && this.onerror(new Error('network')) }
          else {
            this.responseText = '{"ok":true}'
            this.onload && this.onload()
          }
        }, 5)
      }
    }
  }
  window.fetch = (u, init) => {
    window.__calls.push(String(u))
    const mode = bridgeModeNow()
    // 连接被拒：浏览器层面就是 TypeError（和跨域被拦同一张脸）—— 这正是面板要靠 no-cors 探针区分的原因
    if (mode === 'down') return Promise.reject(new TypeError('Failed to fetch'))
    if (mode === 'blocked') {
      if (init && init.mode === 'no-cors') return Promise.resolve({ type: 'opaque', status: 0, ok: false, json: () => Promise.reject(new TypeError('opaque')) })
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    const s = String(u)
    let body = { ok: true }
    if (mode === 'denied' && s.includes('/health')) body = { ok: false, error: '只接受本机页面调用' }
    else if (s.includes('/health')) body = { ok: true }
    else if (s.includes('/config')) body = { ok: true, cfg: savedCfg, exact: true }
    // ★ 10-29：OOCL 已接入（engine/tracking/oocl.mjs）→ 夹具不许再谎报「未接入」；
    //   兜底分支改用真·没有适配器的 SITC 来演练（引擎 identify.mjs 里 SITC 在 KNOWN_UNTRACKED）
    else if (s.includes('/carriers')) body = { ok: true, count: 3, liveCount: 2, carriers: [
      { id: 'hapag', name: 'Hapag-Lloyd', live: true },
      { id: 'oocl', name: 'OOCL', live: true, manualUrl: 'https://pbservice.moc.oocl.com/party/cargotracking/mobile/mobile_ct_search.jsf?ANONYMOUS_BEHAVIOR=BUILD_UP&ENTRY=MCC&ENTRY_TYPE=OOCL' },
      { id: 'sitc', name: 'SITC', live: false, manualUrl: 'https://www.sitcline.com/' }] }
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
