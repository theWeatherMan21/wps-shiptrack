// 写回「写哪些格、写什么值」的唯一口径（★ 2026-11-10）
//
// 为什么要单独一个模块：这两条都属于「同一格被写了两遍 / 写了不该写的格」的数据损坏，
// 而它们藏在组件里就没法单测 —— 爹地撞到的是表格里只剩航次、以及合并格报「读回不一致」。
//
// 铁律：
//   1. **船名列 = 航次列时只写一次**，值一律是「船名 空格 航次」；不去读原格猜它是船名还是航次
//      （原格可能已经被旧的 bug 写坏，按它猜会把错误固化）。
//   2. **合并单元格只有左上角能写**：非左上角一律跳过，并把「与 K12 合并」说出来 ——
//      不许写成「读回不一致」（那是把不可写说成写失败，方向全错）。
//   3. 撞结果列 / 单号列一律不写（别把业务结论覆盖掉）。

const letter = (n) => {
  let c = ''
  let x = Number(n || 0)
  while (x > 0) {
    const m = (x - 1) % 26
    c = String.fromCharCode(65 + m) + c
    x = Math.floor((x - 1) / 26)
  }
  return c
}

/**
 * 船名 / 航次要写哪些格、每格写什么。返回 [{ col, text }]。
 * 同列 → 只有一条，text = "船名 航次"；分列 → 最多两条；撞结果列/单号列 → 该格不出现。
 * 两个都没查到 → 返回空数组（一格都不动，别把原值清空）。
 */
export function planVesselVoyage({ vesselCol, voyageCol, outCol, numCol, vessel, voyage }) {
  const vCol = Number(vesselCol || 0)
  const yCol = Number(voyageCol || 0)
  const oCol = Number(outCol || 0)
  const nCol = Number(numCol || 0)
  const blocked = (c) => !!c && (c === oCol || c === nCol)
  const v = String(vessel == null ? '' : vessel).trim()
  const y = String(voyage == null ? '' : voyage).trim()
  if (!v && !y) return []
  if (vCol && vCol === yCol) {
    if (blocked(vCol)) return []
    return [{ col: vCol, text: [v, y].filter(Boolean).join(' ') }]
  }
  const out = []
  if (vCol && v && !blocked(vCol)) out.push({ col: vCol, text: v })
  if (yCol && y && !blocked(yCol)) out.push({ col: yCol, text: y })
  return out
}

/**
 * 合并单元格判定。area = 从 WPS 读出来的 { mergeCells, topRow, topCol, address }（读不到就传 null）。
 * 返回 null = 可写（不是合并格，或正好是左上角）；
 * 返回 { addr, topRow, topCol } = 不可写（非左上角），addr 形如 "K12:K13"。
 */
export function mergeBlockOf(area, row, col) {
  if (!area || !isVbaTrue(area.mergeCells)) return null
  const topRow = Number(area.topRow || 0)
  const topCol = Number(area.topCol || 0)
  if (!topRow || !topCol) return null
  if (topRow === Number(row) && topCol === Number(col)) return null   // 左上角 = 可写
  const addr = String(area.address || '').replace(/\$/g, '') || `${letter(topCol)}${topRow}`
  return { addr, topRow, topCol }
}

/**
 * WPS/COM 的「布尔」不是 JS 布尔：真返回 **-1**，假返回 **0**。
 * 直接写 `x === true` 恒为 false —— 合并单元格检测就是这么静默失效的
 * （代码看着判了，实际一次都没进分支，K13 照写 → 读回空 → 报「赋值没生效」）。
 * 兼容 true/false、-1/0、1/0、'true'/'false'、null/undefined。
 */
export function isVbaTrue(v) {
  if (v === true) return true
  if (v === false || v === null || v === undefined) return false
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  return s === 'true' || s === '-1' || s === '1'
}

/** 跳过时给用户看的一句：「与 K12:K13 合并（不是左上角，这一格不存值）」 */
export function mergeSkipText(block) {
  const a = block && block.addr ? block.addr : '合并区'
  return `与 ${a} 合并，这一格没写`
}
