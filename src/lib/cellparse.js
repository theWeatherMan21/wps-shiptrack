// 单元格解析：船司别名、SOC/COC 之类后缀、复合单号（订舱号/提单号同格）
// 纯函数，Node 环境可直接单测（scripts/cellparse-test.mjs）

// 船司别名 → 引擎 carrier id
const ALIAS = [
  [/\bHPL\b|HAPAG|赫伯罗特|HLCU/, 'hapag'],
  [/\bMSK\b|MAERSK|马士基|MAEU/, 'maersk'],
  [/\bMSC\b|地中海航运|地中海/, 'msc'],
  [/\bZIM\b|以星/, 'zim'],
  [/\bCOSCO\b|\bCOS\b|中远/, 'cosco'],
  [/\bCMA\b|CMDU|达飞/, 'cma'],
  [/\bOOCL\b|东方海外/, 'oocl'],
  [/\bONE\b|海洋网联/, 'one'],
  [/\bHMM\b|现代/, 'hmm'],
  [/\bEMC\b|EVERGREEN|长荣|EGLV/, 'evergreen'],
  [/\bYML\b|\bYM\b|阳明/, 'yangming'],
  [/\bAKKON\b|\bAKK\b|AKKON LINES/, 'akkon'],
  // 已知但没适配器（页面没有追踪能力或需登录）——认得出名字，才能给出准确提示
  [/\bWHL\b|WAN ?HAI|万海/, 'wanhai'],
  [/\bSLS\b/, 'sls'],
  [/\bUGL\b/, 'ugl'],
  [/\bMLH\b/, 'mlh'],
  [/\bSITC\b|海丰/, 'sitc'],
  [/\bKMTC\b/, 'kmtc'],
  [/\bMATSON\b|美森/, 'matson'],
  [/\bPIL\b|太平/, 'pil'],
  [/\bHEDE\b|海德/, 'hede'],
]

// 这些词只是运输条款/单据类型，出现与否不影响船司判断
const NOISE = /\b(SOC|COC|SWB|OBL|FCL|LCL|CY|CFS|DOOR|MBL|HBL|SEA\s*WAYBILL|WAYBILL)\b/g

/** 从 S/L 单元格文本里认出船司 id；认不出返回 ''（交给号码识别） */
export function carrierFromSl(text) {
  let t = String(text == null ? '' : text).toUpperCase()
  if (!t.trim()) return ''
  t = t.replace(NOISE, ' ')
  // 中文备注类词直接剔掉，避免干扰
  t = t.replace(/(正本|副本|电放|提单|订舱|箱型|备注|运费|预付|到付)/g, ' ')
  t = t.replace(/[（）()【】\[\]，,、/\\|]+/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  for (const [re, id] of ALIAS) if (re.test(t)) return id
  return ''
}

/**
 * 复合单号拆分：一格写了「订舱号/提单号」时，返回按可信度排序的所有候选。
 * 第一个是最像提单号的；其余留着做兜底（有些船司只认订舱号）。
 */
export function splitParts(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase()
  if (!s) return []
  const parts = s.split(/[\s/|,、;；]+/).map((x) => x.replace(/[^\w-]/g, '')).filter(Boolean)
  if (parts.length <= 1) return parts.length ? [parts[0]] : []
  // 「HLCU EUR25220885E7XX」这种被空格拆开的同一个提单号：前段是纯字母 SCAC 就拼回去
  if (parts.length === 2 && /^[A-Z]{3,4}$/.test(parts[0])) {
    const joined = parts[0] + parts[1]
    if (looksLikeNumber(joined)) return [joined]
  }
  const score = (p) => {
    const letters = (p.match(/[A-Z]/g) || []).length
    const digits = (p.match(/\d/g) || []).length
    let n = 0
    if (letters >= 3) n += 6
    if (letters >= 1 && digits >= 4) n += 3
    if (p.length >= 12) n += 3
    if (/^\d+$/.test(p)) n -= 4
    return n
  }
  return parts.slice().sort((a, b) => score(b) - score(a))
}

/** 单个结果（兼容老调用）：取最可信的那段 */
export function splitComposite(raw) {
  const p = splitParts(raw)
  return p.length ? p[0] : ''
}

/**
 * S/L 单元格看起来像「船司代号」吗？
 * 只认短英文（可带空格/点/&），中文/长句一律不算，避免把备注当船司。
 */
export function looksLikeCarrierToken(text) {
  const t = String(text == null ? '' : text).replace(NOISE, ' ').trim()
  if (!t) return false
  if (/[\u4e00-\u9fa5]/.test(t)) return false
  return /^[A-Za-z][A-Za-z .&\-]{0,14}$/.test(t)
}

/** 号码清洗：去空白/零宽/连字符，转大写 */
export function cleanNumber(s) {
  return String(s == null ? '' : s).replace(/[\s\u200b\u3000\-_]/g, '').toUpperCase()
}

/** 20261023 这种日期不要当成提单号 */
export function looksLikeDate(s) {
  if (!/^20\d{6}$/.test(s)) return false
  const m = Number(s.slice(4, 6))
  const d = Number(s.slice(6, 8))
  return m >= 1 && m <= 12 && d >= 1 && d <= 31
}

/** 形态预筛：只判断「像不像一个单号」，船司归属交给引擎 */
export function looksLikeNumber(s) {
  if (looksLikeDate(s)) return false
  if (!/^[A-Z0-9]{6,30}$/.test(s)) return false
  const digits = (s.match(/\d/g) || []).length
  const letters = (s.match(/[A-Z]/g) || []).length
  if (letters === 0) return digits >= 6
  return digits >= 4 && letters >= 2
}
