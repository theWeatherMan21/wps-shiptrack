// 面板侧的「自动识别」粘合层（纯函数，可单测）★ 2026-11-11
//
// 为什么单独一层：识别规则在桥（bridge/detect-columns.mjs，单一事实来源），组件只负责
//   「把 COM 读出来的样本规整成矩阵 → 发出去 → 把结果落成 cfg」。
// 落成 cfg 的规则必须能单测 —— 一旦这里写错，就会出现「认 B 列、写 C 列」。
import { detectSignature, diffDetection, colLetter } from '../../bridge/detect-columns.mjs'

/**
 * WPS Range.Value2 的返回 → 规整的二维字符串矩阵。
 * 实测三种形态都得接（不同 WPS 版本/选区形状不一样）：
 *   · 2D 数组 [30][52]（最常见）
 *   · 一维数组（单行/单列被压平）
 *   · 单值（区域只有一格）
 * 缺的行列补 ''，多的截掉 —— 识别永远拿到「30 行 × 52 列」的固定形状，
 * 不会因为某个版本少返回一行就把列错位。
 */
export function sampleToMatrix(raw, nRows = 30, nCols = 52) {
  const out = []
  for (let r = 0; r < nRows; r++) out.push(new Array(nCols).fill(''))
  if (raw == null) return out
  const one = (v) => (v == null ? '' : String(v))
  if (!Array.isArray(raw)) { out[0][0] = one(raw); return out }
  // 一维：长度正好等于行数 → 单列；否则当单行
  const is2D = raw.length && Array.isArray(raw[0])
  if (!is2D) {
    const vals = raw
    if (vals.length === nRows) { for (let r = 0; r < nRows; r++) out[r][0] = one(vals[r]) }
    else { for (let c = 0; c < Math.min(vals.length, nCols); c++) out[0][c] = one(vals[c]) }
    return out
  }
  for (let r = 0; r < Math.min(raw.length, nRows); r++) {
    const row = Array.isArray(raw[r]) ? raw[r] : [raw[r]]
    for (let c = 0; c < Math.min(row.length, nCols); c++) out[r][c] = one(row[c])
  }
  return out
}

/** 识别结果 → 面板上那一行字（默认状态只显示这一行）*/
export function detSummary(det) {
  if (!det || !det.ok || !det.numberCol) return ''
  const num = colLetter(det.numberCol)
  const out = det.outCol ? colLetter(det.outCol) : '—'
  const vv = det.vesselMode === 'single' ? ' · 船名航次同格'
    : det.vesselMode === 'split' ? ' · 船名/航次两列' : ''
  return `单号 ${num} 列 → 输出 ${out}${vv}`
}

/** 识别结果 → cfg 补丁（列号 1-based；startRow/rows 由组件按整表算出来再传进来）*/
export function cfgFromDetection(det, { startRow = 1, rows = 1 } = {}) {
  if (!det || !det.ok || !det.numberCol) return null
  return {
    numberCol: det.numberCol,
    outCol: det.outCol || 0,
    carrierCol: det.carrierCol || 0,
    polCol: det.polCol || 0,
    podCol: det.podCol || 0,
    vesselCol: det.vesselCol || 0,
    voyageCol: det.voyageCol || 0,
    vesselMode: det.vesselMode || 'absent',
    startRow: Math.max(1, Number(startRow) || 1),
    rows: Math.max(1, Number(rows) || 1),
    mode: 'column',            // 跟随表格长：新增行下次一起查
    detSig: detectSignature(det),
    detTier: det.tier,
    detConf: det.confidence,
    detHeaderRow: det.headerRow,
    detConfirmed: positionsOf(det),   // ★ 之后每次识别都拿它比对新结果（一致就静默）
  }
}

/** 只留「位置关系」——比对/确认用；不含行数（新增订单不算格式变了）*/
export function positionsOf(det) {
  if (!det) return null
  return {
    numberCol: Number(det.numberCol || 0),
    outCol: Number(det.outCol || 0),
    vesselCol: Number(det.vesselCol || 0),
    voyageCol: Number(det.voyageCol || 0),
    vesselMode: String(det.vesselMode || 'absent'),
    headerRow: Number(det.headerRow == null ? -1 : det.headerRow),
  }
}

/**
 * 本次识别 vs 上次确认配置（DoD 6）
 * @returns {{changed:boolean, text:string}}
 *   没有确认过（没见过这张表）→ changed:false（交给置信分层决定写还是预览）
 *   手工覆盖过列（detManual）→ changed:false（人说了算，不再打扰）
 */
export function compareToConfirmed(cfg, det) {
  if (!cfg || cfg.detManual) return { changed: false, text: '' }
  const prev = cfg.detConfirmed
  if (!prev || !prev.numberCol) return { changed: false, text: '' }
  return diffDetection(prev, det)
}

/** 该不该走「首次预览」：中置信 且 这张表还没确认过 */
export function needsPreview(cfg, det) {
  if (!cfg || cfg.detManual) return false
  const prev = cfg.detConfirmed
  if (prev && prev.numberCol) return false       // 已确认过 → 之后静默
  return !!det && det.ok && det.tier === 'preview'
}

/** 面板上的预览确认条文案：「单号 B 列 · 输出 K 列 · 12 行」*/
export function previewText({ numCol, outCol, rows }) {
  const n = colLetter(numCol)
  const o = colLetter(outCol)
  return `单号 ${n} 列 · 输出 ${o} 列 · ${Number(rows) || 0} 行`
}

export { colLetter, detectSignature, diffDetection }
