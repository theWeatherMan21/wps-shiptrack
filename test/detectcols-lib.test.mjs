// test/detectcols-lib.test.mjs —— 面板侧「自动识别粘合层」的不变量（★ 2026-11-11）
//
// 锁死的四条（DoD 2/5/6 靠它们）：
//   ① 样本规整：WPS 的三种返回形态都变成 30×52 矩阵，缺的补空，不许错位
//   ② 落 cfg：识别出的列 === 写进 cfg 的列（认 B 写 B），行数/起始行按整表算
//   ③ 首认知情：中置信且没确认过 → 走预览；确认过 → 之后静默
//   ④ 变化检测：列变了才提示；行数变多不算；手工覆盖过就不再打扰
import {
  sampleToMatrix, detSummary, cfgFromDetection, positionsOf, compareToConfirmed, needsPreview, previewText,
} from '../src/lib/detectcols.js'

let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`PASS ${label}${extra ? ' · ' + extra : ''}`)
  else { fail++; console.log(`FAIL ${label}${extra ? ' · ' + extra : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── ① 样本规整 ────────────────────────────────────────────────────────────
{
  const m = sampleToMatrix([['提单号', 'X'], ['TESTMAE0123457', 'Y']], 4, 3)
  ok(m.length === 4 && m[0].length === 3, '2D 输入补成 4×3')
  ok(eq(m[0], ['提单号', 'X', '']) && eq(m[1], ['TESTMAE0123457', 'Y', '']), '2D 值原样落位')
  ok(eq(m[3], ['', '', '']), '缺的行补空')

  const flat = sampleToMatrix(['a', 'b', 'c', 'd'], 4, 2)
  ok(eq(flat.map((r) => r[0]), ['a', 'b', 'c', 'd']) && flat[0][1] === '', '一维且长度=行数 → 当单列')

  const rowVals = sampleToMatrix(['提单号', '船名', '航次'], 2, 3)
  ok(eq(rowVals[0], ['提单号', '船名', '航次']), '一维且长度≠行数 → 当单行（表头行常见）')

  const single = sampleToMatrix('只有一格', 2, 2)
  ok(single[0][0] === '只有一格' && single[1][1] === '', '单值 → 落左上角')

  const nulls = sampleToMatrix([[null, undefined, 0, 12]], 1, 4)
  ok(eq(nulls[0], ['', '', '0', '12']), 'null/undefined → 空串，数字转字符串')

  const big = sampleToMatrix(new Array(40).fill(new Array(60).fill('x')), 30, 52)
  ok(big.length === 30 && big[0].length === 52, '多出来的行列截掉（固定 30×52）')
}

// ── ② 识别结果 → cfg ──────────────────────────────────────────────────────
const DET = {
  ok: true, headerRow: 0, numberCol: 2, outCol: 11, carrierCol: 3, polCol: 4, podCol: 5,
  vesselCol: 6, voyageCol: 0, vesselMode: 'single', confidence: 0.97, tier: 'auto',
}
{
  const cfg = cfgFromDetection(DET, { startRow: 2, rows: 12 })
  ok(cfg.numberCol === DET.numberCol && cfg.outCol === DET.outCol, 'cfg 用的是识别出的列（认 B 写 B）', `${cfg.numberCol}/${cfg.outCol}`)
  ok(cfg.vesselCol === 6 && cfg.vesselMode === 'single', '船名同格配置落进 cfg')
  ok(cfg.startRow === 2 && cfg.rows === 12, '起始行/行数按整表传进来（不用样本里的 30 行）')
  ok(cfg.mode === 'column', '跟随表格长（新增行下次一起查）')
  ok(!!cfg.detSig && !!cfg.detConfirmed, '存了签名与确认位置')
  ok(eq(positionsOf(DET), cfg.detConfirmed), '确认位置 = 识别位置')
  ok(cfgFromDetection({ ok: false }) === null, '识别失败 → 不产出 cfg（一格都不改）')
}

// ── ③ 首认知情 / 确认后静默 ───────────────────────────────────────────────
{
  const previewDet = { ...DET, tier: 'preview', confidence: 0.6 }
  ok(needsPreview({}, previewDet) === true, '中置信 + 没见过这张表 → 首次预览')
  ok(needsPreview({ detConfirmed: positionsOf(previewDet) }, previewDet) === false, '确认过 → 之后静默（零点击）')
  ok(needsPreview({}, { ...previewDet, tier: 'auto' }) === false, '高置信 → 直接写，不预览')
  ok(needsPreview({ detManual: true }, previewDet) === false, '手工覆盖过 → 不弹预览')
  ok(previewText({ numCol: 2, outCol: 11, rows: 12 }) === '单号 B 列 · 输出 K 列 · 12 行', '预览条文案', previewText({ numCol: 2, outCol: 11, rows: 12 }))
}

// ── ④ 变化检测 ────────────────────────────────────────────────────────────
{
  const cfg = cfgFromDetection(DET, { startRow: 2, rows: 12 })
  const same = compareToConfirmed(cfg, { ...DET, sampleRows: 28 })
  ok(same.changed === false, '同样的表再识别一次 → 静默（不打扰）', JSON.stringify(same))

  const shifted = compareToConfirmed(cfg, { ...DET, numberCol: 4, outCol: 13 })
  ok(shifted.changed === true && shifted.text.includes('单号列') && shifted.text.includes('B') && shifted.text.includes('D'),
    '单号列换了 → 报变化（B→D）', shifted.text)

  const grows = compareToConfirmed(cfg, { ...DET, sampleRows: 30 })
  ok(grows.changed === false, '行数变多不算不信（新增订单是常态）')

  ok(compareToConfirmed({}, DET).changed === false, '没见过这张表 → 不报变化（交给置信分层）')
  ok(compareToConfirmed({ detManual: true, detConfirmed: positionsOf(DET) }, { ...DET, numberCol: 4 }).changed === false,
    '手工覆盖过的表 → 不再拿识别结果打扰')
}

// ── ⑤ 面板那一行字 ────────────────────────────────────────────────────────
ok(detSummary(DET) === '单号 B 列 → 输出 K · 船名航次同格', '识别条文案（同格）', detSummary(DET))
ok(detSummary({ ...DET, vesselCol: 6, voyageCol: 7, vesselMode: 'split' }) === '单号 B 列 → 输出 K · 船名/航次两列', '识别条文案（分列）')
ok(detSummary({ ok: false }) === '', '没识别成功 → 不出识别条')

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
