// 写回「读回校验」的唯一口径（★ 10-30 误报修复）
//
// 为什么要有这个模块：写入成功与否，取决于「读回来的东西是不是我写的那个」。
// 但 WPS 会把值按单元格格式存：日期列写 '2026-11-03' 读回是 Date 对象，
// 数值列写 '12.5' 读回是数字 12.5，文本列可能被 trim。旧代码在逐格路径用裸比较
// `String(back) === String(text)`，在批量路径用做归一化的 sameCellText ——
// **两条路径两把尺**，日期列/数值列走逐格必然判「读回不一致」→ fail →
// 红条说「表可能被保护/只读」，把方向指错（爹地 10-30 截图那 3 格）。
//
// 三条铁律：
//   1. **口径只能有一份**：批量写、逐格写、不变量测试全 import 这里，别处不许自己比。
//   2. **类型差 ≠ 写失败**：Date/number/string 的表示差异一律算「写成」。
//   3. **只有「读回来是空」或「还是旧值」才是真没写进去**（WPS 个别版本 Cells() 静默空实现
//      就是这个形状）；COM 抛异常才是「表可能被保护/只读」。别把第三件事说成第一件。

// ★ 11-03 写错数据事故：日期序列号的解释口径只有一份，放在 lib/dates.js
import { serialToYmd } from './dates.js'

const pad2 = (n) => String(n).padStart(2, '0')

/** Date → yyyy-mm-dd（本地时区，不经过 toISOString 免得跨时区差一天） */
export function fmtDate(d) {
  try {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  } catch (e) { return '' }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** 值 → 给人看的文本（Date 按 y-m-d，别把 GMT 那一长串塞进横幅） */
export function cellText(v) {
  if (v === undefined || v === null) return ''
  if (v instanceof Date) return fmtDate(v)
  return String(v)
}

/** 日期口径：Date / Excel 序列号 / 'yyyy-mm-dd' / 'yyyy-mm-dd hh:mm:ss' 都按 y-m-d 比 */
function asDateText(v) {
  if (v instanceof Date) return fmtDate(v)
  // ★ 11-03：WPS 会把日期按 UTC 折成序列号读回来（46303 = 2026-10-08），
  //   只认 Date 和字符串的话，「写进去了但读回是数字」会被判 fail（红条说数值没生效）。
  //   只认 20000–80000 这个区间，12.5 / 0012 这类数字不会被当日期。
  if (typeof v === 'number' && Number.isFinite(v)) return serialToYmd(v)
  const s = cellText(v).trim()
  return DATE_ONLY.test(s.slice(0, 10)) ? s.slice(0, 10) : ''
}

export function sameDate(back, want) {
  const a = asDateText(back)
  const b = asDateText(want)
  return !!a && !!b && a === b
}

function numOf(v) {
  const s = cellText(v).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 数值口径：12.5 / '12.50' 是同一个数（格式不同，但不是没写进去） */
export function sameNum(back, want) {
  const a = numOf(back)
  const b = numOf(want)
  return a !== null && b !== null && a === b
}

export function sameText(back, want) {
  return cellText(back) === cellText(want)
}

/** 是不是「同一个值」（类型差吞掉）—— 批量路径的通过判据 */
export function cellMatches(back, want) {
  return sameText(back, want) || sameDate(back, want) || sameNum(back, want)
}

/**
 * 判一次读回：'ok' | 'format-diff' | 'fail'
 *   ok          → 完全一致，或只差日期/数值的表示（这个差异本来就该吞掉）
 *   format-diff → 值确实写进去了，但读回来的文本形态不同（例：'12.50' 变 12.5、
 *                 文本被 trim、前导零丢了）→ **不许记 fail**，最多记一条备注
 *   fail        → 读回来是空，或者还是写之前那个旧值 → 这次赋值没生效
 *
 * @param {{prev?:any, back:any, want:any}} o
 *   prev 是写之前读到的旧值；能读到就必须传 —— 不传的话「赋值静默无效、
 *   读回旧值」会被误判成 format-diff（这是 WPS 上真实存在的失败形态）。
 */
export function judgeReadback({ prev, back, want } = {}) {
  const b = cellText(back)
  if (!b) return 'fail'                                       // 一格空着 = 没写成
  // 「旧值还在」这一条用**严**口径（文本/数值相等），不吃日期归一：
  //   否则格子里的历史坏值 46302.6667 会被 sameDate 四舍五入成「同一天」，
  //   赋值静默没生效也叫 ok（11-03 那批偏一天的日期就是这么被吞掉的）。
  if (prev !== undefined && cellText(prev) !== '' && cellText(prev) === b &&
      !(sameText(prev, want) || sameNum(prev, want))) {
    return 'fail'                                             // 旧值还在 = 赋值没生效
  }
  // 完全一致、或只差日期表示（Date ⇄ y-m-d）→ ok。
  // 注意数值只认「文本也一致」：12.5 与 '12.50'、'0012' 与 12 都属于表格改了格式，
  // 值虽然对得上，但形态变了（前导零丢了是实打实的保真问题）→ 走 format-diff 留一句备注。
  if (sameText(back, want) || sameDate(back, want)) return 'ok'
  return 'format-diff'
}

/**
 * 逐格写 + 读回校验（降级链：Range.Value2 → Cells.Item → Cells() → App.Range）。
 * 组件里的 writeCell 只是把 sheet/app/addr/readOne 递进来，判定逻辑全在这里 ——
 * 这样不变量测试能用假 sheet 真跑一遍生产代码，而不是另写一份「测试版比较」。
 *
 * @param {{sheet:any, app:any, a1:string, r:number, c:number, value:any,
 *          readOne:(sheet:any,r:number,c:number)=>any}} o
 * @returns {{ok:boolean, via?:string, kind?:'ok'|'format-diff'|'com'|'readback',
 *            error?:string, all?:string[], wrote:string, backText:string}}
 */
export function writeCellCore({ sheet, app, a1, r, c, value, readOne }) {
  const wrote = cellText(value)
  // 写前读一次旧值：只为了分清「赋值没生效（旧值还在）」和「格式不同」。
  // 只在逐格路径（单行段 / 批量写不可用的兜底）发生，代价 1 次 COM，换来不误报也不漏报。
  let prev
  let prevKnown = false
  try { prev = readOne(sheet, r, c); prevKnown = true } catch (e) { prevKnown = false }

  const tries = [
    ['Range.Value2', () => { sheet.Range(a1).Value2 = value }],
    ['Cells.Item', () => { sheet.Cells.Item(r, c).Value2 = value }],
    ['Cells()', () => { sheet.Cells(r, c).Value2 = value }],
    ['App.Range', () => {
      if (!app || typeof app.Range !== 'function') throw new Error('无 Application.Range')
      app.Range(a1).Value2 = value
    }],
  ]
  const errs = []
  let backText = ''
  let noThrowBad = 0     // 赋值没抛错、但读回是空/旧值 → API 没真写
  let threw = 0          // 抛异常 → 才可能是保护/只读
  for (const [name, fn] of tries) {
    try {
      fn()
      let back
      try { back = readOne(sheet, r, c) } catch (e) { back = undefined }
      backText = cellText(back)
      const verdict = judgeReadback({ prev: prevKnown ? prev : undefined, back, want: value })
      if (verdict === 'ok') return { ok: true, via: name, kind: 'ok', wrote, backText }
      if (verdict === 'format-diff') return { ok: true, via: name, kind: 'format-diff', wrote, backText }
      noThrowBad++
      errs.push(`${name}: 读回不一致（${backText === '' ? '空' : backText}）`)
    } catch (e) {
      threw++
      errs.push(`${name}: ${String((e && e.message) || e)}`)
    }
  }
  // 报第一条失败原因（通常最贴近根因），别把最后一条「API 不存在」当结论
  return {
    ok: false,
    error: errs[0] || '写入失败',
    all: errs,
    kind: noThrowBad > 0 ? 'readback' : 'com',
    wrote,
    backText,
  }
}
