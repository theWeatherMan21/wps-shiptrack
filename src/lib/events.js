// 船期事件名 → 中文（顺序即优先级：越具体的写在越前面）
// 词表来自真实单据里出现过的写法（Maersk/MSC/ONE/Hapag/HMM/ZIM/Akkon 等）
export const EVENT_ZH = [
  // 空箱流转
  [/empty received at (cy|container yard|cfs)|empty received|empty redelivery/i, '空箱进场（CY）'],
  [/empty container return|empty return|container return/i, '还空箱'],
  [/empty pick[- ]?up|empty pickup/i, '提空箱'],
  [/stripping|devanning|unstuffing|拆箱/i, '拆箱'],
  // 提货/放货
  [/pick[- ]?up by merchant|merchant haulage pickup/i, '货主提货'],
  [/container release|release to consignee|放箱/i, '放箱'],
  // 闸口
  [/gate out|full container gate out/i, '出闸'],
  [/gate in|full import container received|full export container received/i, '进闸/进场'],
  // 船期主事件
  [/discharged and waiting|waiting for transshipment/i, '卸船待中转'],
  [/discharge|unloading/i, '卸船'],
  [/export loaded|loaded on vessel|on board|load \(fcl\)|loaded/i, '装船'],
  [/trans-?ship/i, '中转'],
  [/received \(fcl\)|cargo received/i, '进港收货'],
  [/arrival|arrived|vessel arrived/i, '到港'],
  [/departure|departed|sailed|vessel departed/i, '离港'],
  // 其它
  [/booking confirm|confirmed/i, '订舱确认'],
  [/customs/i, '海关'],
  [/rolled|rollover/i, '甩柜'],
  [/shipped on board/i, '已装船'],
  [/delivery|delivered/i, '交付'],
]

/** 事件名转中文；认不出的保留原文（不瞎翻） */
export function zhEvent(s) {
  const t = String(s == null ? '' : s).trim()
  if (!t) return ''
  for (const [re, label] of EVENT_ZH) if (re.test(t)) return label
  return t
}

/** 港口/城市名清洗：去掉括号注释、国家码、结尾标点 */
export function cleanCity(s) {
  return String(s == null ? '' : s)
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/,\s*[A-Z]{2}$/, '')
    .replace(/[.。,，;；\s]+$/, '')
    .trim()
}

/** 拼一格结果：日期 · 事件 · 港口 */
export function formatEventLine(time, activity, city) {
  const d = time ? String(time).slice(0, 10) : ''
  return [d, zhEvent(activity), cleanCity(city)].filter(Boolean).join(' · ')
}
