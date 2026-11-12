// test/writeplan.test.mjs —— 船名/航次同列覆盖 + 合并单元格跳过的不变量测试（★ 2026-11-10）
//
// 锁死的三条（爹地撞到的两个真缺陷）：
//   ① 船名列 = 航次列时**只写一次**「船名 空格 航次」；同列写两遍 → 只剩航次（原 bug）
//   ② 合并单元格只有左上角能写；非左上角一律跳过并报「与 K12:K13 合并」，不许报读回不一致
//   ③ 撞结果列/单号列不许写；两个都没查到一格都不动
import { planVesselVoyage, mergeBlockOf, mergeSkipText, isVbaTrue } from '../src/lib/writeplan.js'

let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`PASS ${label}${extra ? ' · ' + extra : ''}`)
  else { fail++; console.log(`FAIL ${label}${extra ? ' · ' + extra : ''}`) }
}
const P = 16   // 列 P
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ① 同列：一次写、拼成「船名 航次」
const same = planVesselVoyage({ vesselCol: P, voyageCol: P, outCol: 15, numCol: 2, vessel: 'MSC INGY', voyage: 'GT645W' })
ok(same.length === 1, '船名列=航次列 → 只产生 1 次写', `len=${same.length}`)
ok(eq(same, [{ col: P, text: 'MSC INGY GT645W' }]), 'P 格值 = "船名 航次"',
  JSON.stringify(same))
ok(same[0].text !== 'GT645W', '不是只剩航次（原 bug 的判据）')

// 同列但只查到航次 → 写航次（不可留空把原值清了）
const onlyVoy = planVesselVoyage({ vesselCol: P, voyageCol: P, outCol: 15, numCol: 2, vessel: '', voyage: 'GT645W' })
ok(eq(onlyVoy, [{ col: P, text: 'GT645W' }]), '同列只有航次 → 写航次', JSON.stringify(onlyVoy))

// ② 分列：各写一格，顺序船名在前
const split = planVesselVoyage({ vesselCol: 17, voyageCol: 18, outCol: 15, numCol: 2, vessel: 'MSC INGY', voyage: 'GT645W' })
ok(eq(split, [{ col: 17, text: 'MSC INGY' }, { col: 18, text: 'GT645W' }]), '分列 → 船名/航次各一格',
  JSON.stringify(split))

// ③ 撞列不写：船名列 = 结果列 / 单号列
ok(planVesselVoyage({ vesselCol: 15, voyageCol: 15, outCol: 15, numCol: 2, vessel: 'X', voyage: 'Y' }).length === 0,
  '同列且撞结果列 → 一格都不写')
ok(planVesselVoyage({ vesselCol: 2, voyageCol: 2, outCol: 15, numCol: 2, vessel: 'X', voyage: 'Y' }).length === 0,
  '同列且撞单号列 → 一格都不写')
ok(planVesselVoyage({ vesselCol: 17, voyageCol: 2, outCol: 15, numCol: 2, vessel: 'X', voyage: 'Y' })
  .every((t) => t.col !== 2), '分列时撞单号列的那一格被剔掉')

// ④ 两个都没查到 → 不动任何格（不许清空原值）
ok(planVesselVoyage({ vesselCol: P, voyageCol: P, outCol: 15, numCol: 2, vessel: '', voyage: '' }).length === 0,
  '船名/航次都没查到 → 不写')

// ⑤ 合并单元格：K12:K13（K=11, 12/13 行）
const blkK13 = mergeBlockOf({ mergeCells: true, topRow: 12, topCol: 11, address: '$K$12:$K$13' }, 13, 11)
ok(blkK13 && blkK13.addr === 'K12:K13', 'K13 在 K12:K13 合并区 → 判为不可写', JSON.stringify(blkK13))
ok(blkK13 && /K12:K13/.test(mergeSkipText(blkK13)), '跳过文案写明「与 K12:K13 合并」', blkK13 && mergeSkipText(blkK13))
ok(!/读回不一致/.test(mergeSkipText(blkK13)), '跳过文案不许说「读回不一致」')
ok(mergeBlockOf({ mergeCells: true, topRow: 12, topCol: 11, address: '$K$12:$K$13' }, 12, 11) === null,
  '合并区左上角 K12 → 可写')
ok(mergeBlockOf({ mergeCells: false }, 13, 11) === null, '非合并格 → 可写')
ok(mergeBlockOf(null, 13, 11) === null, '读不到 MergeArea（老版本）→ 不猜，按可写处理')
// L12:L13 同理（L=12）
ok(mergeBlockOf({ mergeCells: true, topRow: 12, topCol: 12, address: '$L$12:$L$13' }, 13, 12)?.addr === 'L12:L13',
  'L13 在 L12:L13 合并区 → 判为不可写')
// 地址读不到时用行列兜底
ok(mergeBlockOf({ mergeCells: true, topRow: 12, topCol: 11 }, 13, 11)?.addr === 'K12',
  'MergeArea.Address 读不到 → 用左上角行列兜底（K12）')

// ④ WPS/COM 的布尔是 -1/0，不是 true/false —— 判 `=== true` 会静默失效
//    （原 bug：合并检测看着写了，其实一次都没进分支，K13 照写 → 读回空 → 报「赋值没生效」）
console.log('\n-- VBA 布尔 --')
ok(isVbaTrue(-1) === true, 'WPS 的「真」是 -1')
ok(isVbaTrue(0) === false, 'WPS 的「假」是 0')
ok(isVbaTrue(true) === true, 'JS true 也认')
ok(isVbaTrue(false) === false, 'JS false 也认')
ok(isVbaTrue(1) === true, '1 也当真（部分版本返回 1）')
ok(isVbaTrue(null) === false && isVbaTrue(undefined) === false, '读不到 = 假，不猜')
ok(isVbaTrue('true') === true && isVbaTrue('false') === false, '字符串形态也认')
// 端到端：MergeCells 返回 -1 时必须真的判成合并（这就是爹地那 2 格写不进的根因）
ok(mergeBlockOf({ mergeCells: -1, topRow: 12, topCol: 11, address: '$K$12:$K$13' }, 13, 11)?.addr === 'K12:K13',
  'MergeCells=-1（WPS 真实返回）→ 判为不可写')
ok(mergeBlockOf({ mergeCells: 0 }, 13, 11) === null, 'MergeCells=0 → 可写')


// ★ 11-12：没有独立航次列时不许静默丢航次（爹地撞到 P 列 11 行只剩船名）
{
  const r1 = planVesselVoyage({ vesselCol: 16, voyageCol: 0, outCol: 18, numCol: 15,
                               vessel: 'MSC FLORENCE XV', voyage: 'GA645W' })
  ok(r1.length === 1 && r1[0].col === 16 && r1[0].text === 'MSC FLORENCE XV GA645W',
    '① voyageCol=0 但有航次 → 拼进船名列，不丢', JSON.stringify(r1))

  const r2 = planVesselVoyage({ vesselCol: 16, voyageCol: 16, outCol: 18, numCol: 15,
                               vessel: 'MSC FLORENCE XV', voyage: 'GA645W' })
  ok(r2.length === 1 && r2[0].col === 16 && r2[0].text === 'MSC FLORENCE XV GA645W',
    '③ 同格（vesselCol===voyageCol）→ 拼一起写一格，不写第二格', JSON.stringify(r2))

  const r3 = planVesselVoyage({ vesselCol: 16, voyageCol: 17, outCol: 18, numCol: 15,
                               vessel: 'MSC FLORENCE XV', voyage: 'GA645W' })
  ok(r3.length === 2 && r3[0].col === 16 && r3[0].text === 'MSC FLORENCE XV'
     && r3[1].col === 17 && r3[1].text === 'GA645W',
    '真分两列时照旧分开写', JSON.stringify(r3))

  const r4 = planVesselVoyage({ vesselCol: 16, voyageCol: 0, outCol: 18, numCol: 15,
                               vessel: 'MSC FLORENCE XV', voyage: '' })
  ok(r4.length === 1 && r4[0].text === 'MSC FLORENCE XV', '没有航次就只写船名', JSON.stringify(r4))

  const r5 = planVesselVoyage({ vesselCol: 18, voyageCol: 0, outCol: 18, numCol: 15,
                               vessel: 'V', voyage: 'Y' })
  ok(r5.length === 0, '船名列撞输出列 → 不写（blocked 优先于拼航次）', JSON.stringify(r5))
}

console.log(fail ? `\n${fail} FAIL` : '\nALL PASS')
process.exit(fail ? 1 : 0)
