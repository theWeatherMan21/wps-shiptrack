// ETD/ETA 回填确认（★ 11-03 爹地原话：「写入 ETD/ETA，请加一个按钮来确认吧，不要静默替换」）
//
// 病根：船期是**覆盖旧值**的写回，而且以前连「历史脏值（偏一天）」也顺手改掉 ——
//   用户没点任何按钮，格子里的日期就变了，他没法知道被改了什么、改前是什么。
// 做法：查询期只**收集**「旧值 → 新值」，一批收尾才出确认条；确认前一个格子都不动。
//
// 这个文件只放纯函数（可单测）：判定要不要写、旧值怎么显示成人看的短日期、条上怎么汇总。
// COM 读写留在组件里（writeScheduleDates / applyScheduleItems）。

import { isDateish, dateCellIsClean, dateCellWriteValue, SERIAL_MIN, SERIAL_MAX } from './dates.js'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86400000
const EPOCH_UTC = Date.UTC(1899, 11, 30)
const pad2 = (n) => String(n).padStart(2, '0')
const shortOf = (y, m, d) => `${pad2(d)}-${MON[m] || '?'}`

/**
 * 一个格子「该不该被船期覆盖」——**唯一判据**，收集时和确认写入时各跑一遍。
 * 两遍都要跑的原因：收集到确认之间用户可能刚手改过那个格子，
 * 现场重判才不会把「他刚填的代理名」换成日期。
 *
 * @param {*} cur 单元格当前值（COM 的 Value2：可能是 ''、Date、number 序列号、文本）
 * @param {string} val 要写的 'yyyy-mm-dd'
 * @param {string} fmt 单元格的 NumberFormatLocal
 * @returns {{write:boolean, reason:'no-value'|'text'|'clean'|'write', value?:number|string, serial?:boolean}}
 */
export function decideScheduleWrite(cur, val, fmt) {
  if (val == null || String(val).trim() === '') return { write: false, reason: 'no-value' }
  const empty = cur === undefined || cur === null || String(cur).trim() === ''
  // 非空文本 = 别人的数据（代理名/备注/联系方式）→ 绝不覆盖
  if (!empty && !isDateish(cur)) return { write: false, reason: 'text' }
  // 已经干净地等于这一天 → 不重写（但带时分的脏值不算干净，它必须能被修回，只是要过确认）
  if (dateCellIsClean(cur, val)) return { write: false, reason: 'clean' }
  const spec = dateCellWriteValue(val, fmt)
  return { write: true, reason: 'write', value: spec.value, serial: !!spec.serial }
}

/** 旧值给人看的短形态：Date / 序列号 / y-m-d 文本 → 'dd-Mmm'；其它文本原样截断 */
export function shortDateText(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '空'
  if (v instanceof Date) return shortOf(v.getFullYear(), v.getMonth(), v.getDate())
  if (typeof v === 'number') {
    // ★ 序列号显示**向下取整到那一天**（不能用 serialToYmd 的四舍五入）：
    //   46302.6667 是「偏一天 + 多 16 小时」的坏值，表格里就是显示成前一天 ——
    //   条上要让人一眼看出「格子现在是那天、会被改成哪天」，四舍五入会把差异抹平成「看起来没变」。
    const day = Math.floor(v)
    if (day >= SERIAL_MIN && day <= SERIAL_MAX) {
      const t = new Date(EPOCH_UTC + day * DAY_MS)
      return shortOf(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
    }
    return String(v).slice(0, 14)
  }
  const s = String(v).trim()
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s)
  if (m) return shortOf(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return s.length > 14 ? s.slice(0, 14) + '…' : s
}

/** 确认条要显示的东西：行数、ETD/ETA 各几行、前 5 条差异 */
export function summarizeAsk(items) {
  const list = Array.isArray(items) ? items : []
  let etdN = 0
  let etaN = 0
  for (const it of list) { if (String(it && it.label) === 'ETA') etaN++; else etdN++ }
  const preview = list.slice(0, 5).map((it) => ({
    row: it.row,
    label: it.label,
    oldText: it.oldText,
    newText: it.newText,
    text: `R${it.row} ${it.label} ${it.oldText} → ${it.newText}`,
  }))
  return {
    n: list.length,
    etdN,
    etaN,
    preview,
    more: Math.max(0, list.length - 5),
    // 条上那行标题（爹地要的原话口径）
    title: `船期回填：将更新 ${list.length} 行（ETD ${etdN} / ETA ${etaN}）`,
  }
}
