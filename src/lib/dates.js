// 从船司返回的事件里取「真实 ETD / ETA」
// 规则：实际发生的优先；没有实际发生的，用计划时间（表格里本来就是计划船期）
import { isPlanned } from './truth.js'

const DAY = (t) => String(t || '').slice(0, 10)
const isDep = (e) => /DEPART|DEPARTURE|SAIL|开航|离港/i.test(String((e && e.activity) || ''))
const isArr = (e) => /ARRIV|ARRIVAL|DISCHARG|到港|卸船/i.test(String((e && e.activity) || ''))
const city = (e) => String((e && e.city) || '').trim().toUpperCase()
const same = (a, b) => !!a && !!b && (a.includes(b) || b.includes(a))

// ===================== Excel 日期序列号（★ 11-03 写错数据事故） =====================
//
// 事故形状（爹地 11-03 截图 R2 E 列）：写入 2026-10-08，读回 46302.66666666664。
// 根因：旧代码把 **JS Date 对象**直接交给 COM —— `new Date(y, m - 1, d)`。
// JS Date 是本地时区（UTC+8）的 2026-10-08 00:00 = UTC 2026-10-07 16:00；
// WPS 按 UTC 折成序列号就成了 46302.6667，**整整早一天 + 多 16 小时**。
// 这不是「判错」，是**写错数据**（用户拿着错日期去订舱）。
//
// 铁律：日期绝不传 Date 对象给宿主。日期格写**整数序列号**（纯整数天，没有时区可言），
// 非日期格写 'yyyy-mm-dd' 文本。序列号按 1899-12-30 起算（Excel/WPS 口径）。
const DAY_MS = 86400000
const EPOCH_UTC = Date.UTC(1899, 11, 30)      // 序列号 0
export const SERIAL_MIN = 20000               // ≈1954-10-03，比它小或比它大都当「不是日期」
export const SERIAL_MAX = 80000               // ≈2119-01-05

const pad2 = (n) => String(n).padStart(2, '0')

/** 'yyyy-mm-dd' → Excel 整数序列号（走 Date.UTC，全程不碰本地时区）；不合法返回 0 */
export function ymdToSerial(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd == null ? '' : ymd).trim())
  if (!m) return 0
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const t = new Date(ms)
  // Date.UTC 会把 2026-02-30 滚成 3 月 —— 不合法日期直接不给号，别悄悄改成别的日子
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return 0
  return Math.round((ms - EPOCH_UTC) / DAY_MS)
}

/**
 * 序列号 → 'yyyy-mm-dd'。带时分秒的（如 46302.6667 = 前一天 16:00 UTC）**四舍五入到那一天**：
 * 那个瞬时在本地就是 2026-10-08 00:00，正是当年想写的日子。
 * 不在 20000–80000 → 返回 ''（那是数字，不是日期：12.5 / 0012 之类别被当日期）。
 */
export function serialToYmd(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  const day = Math.round(v)
  if (day < SERIAL_MIN || day > SERIAL_MAX) return ''
  const t = new Date(EPOCH_UTC + day * DAY_MS)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** 单元格数字格式是不是日期格式（沿用原来那条正则，别两处各写一版） */
export function isDateFormat(fmt) {
  return /y{2,}|m{1,2}[-/]d|d{1,2}[-/]m/i.test(String(fmt == null ? '' : fmt))
}

/**
 * 写日期格该给宿主什么值 —— **纯函数，可单测**（组件只管把结果塞进队列）。
 *   日期格式的格子 → 整数序列号（不带时间、不带时区）
 *   其它格子     → 'yyyy-mm-dd' 文本（宿主自己按本地解析，不会偏一天）
 * @returns {{value:number|string, serial:boolean}}
 */
export function dateCellWriteValue(val, format) {
  const serial = ymdToSerial(val)
  if (serial && isDateFormat(format)) return { value: serial, serial: true }
  return { value: String(val == null ? '' : val), serial: false }
}

/**
 * 格子里现有的值是不是「干净的同一天」（用来决定要不要跳过写入）。
 * 比 sameDate 严：**带时分的序列号 / 带时分的 Date 都算脏**（46302.6667 就是这么来的），
 * 所以修完重跑一轮刷新，历史偏一天的格子会被自动改回正确日期。
 */
export function dateCellIsClean(cur, val) {
  if (val == null || val === '') return false
  const want = String(val).trim().slice(0, 10)
  if (cur instanceof Date) {
    const ymd = `${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`
    return ymd === want && cur.getHours() === 0 && cur.getMinutes() === 0 && cur.getSeconds() === 0
  }
  if (typeof cur === 'number') {
    return Number.isInteger(cur) && serialToYmd(cur) === want
  }
  return String(cur).trim().slice(0, 10) === want
}

/**
 * 这个格子现在装的像不像「日期/数字」（= 可以安全被船期覆盖）。
 * 非空**文本**一律当别人的数据（代理名/备注/联系方式），绝不覆盖。
 */
export function isDateish(v) {
  if (v instanceof Date) return true
  if (typeof v === 'number') return true
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(v == null ? '' : v).trim())
}

/**
 * @param {Array} events 船司事件
 * @param {{pod?:string}} opt 目的港（用于挑「到目的港」的那次到达）
 * @returns {{etd:string, eta:string, etdPlanned:boolean, etaPlanned:boolean}}
 */
export function pickEtdEta(events, opt = {}) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && e.time)
  const byTime = list.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)))

  // ETD：最早一次离港；有实际发生的就用实际的
  const deps = byTime.filter(isDep)
  const depActual = deps.find((e) => !isPlanned(e))
  const depAny = depActual || deps[0]

  // ETA：目的港的到达（有 pod 只认 pod）；没有 pod 就取最后一次到达
  const pod = String(opt.pod || '').trim().toUpperCase()
  let arrs = byTime.filter(isArr)
  if (pod) {
    const atPod = arrs.filter((e) => same(city(e), pod))
    if (atPod.length) arrs = atPod
  }
  const arrActual = arrs.find((e) => !isPlanned(e))
  const arrAny = arrActual || arrs[arrs.length - 1]

  return {
    etd: depAny ? DAY(depAny.time) : '',
    eta: arrAny ? DAY(arrAny.time) : '',
    etdPlanned: depAny ? isPlanned(depAny) : false,
    etaPlanned: arrAny ? isPlanned(arrAny) : false,
  }
}
