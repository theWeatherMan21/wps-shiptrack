// 表头识别：从一行单元格里认出「起运港 / 目的港」列。
// 为什么不写死列位或精确表头匹配：客户表格千奇百怪——列位会变、
// 表头可能是 "POL"、"Port of Loading"、"起运港"、"POL / 起运港"，也可能夹在别的字里。
// 这里只做「关键词命中 + 打分」，认不出就返回 null，交给调用方用事件本身兜底。

const CLEAN = (s) => String(s == null ? '' : s)
  .replace(/[\s\u3000]+/g, ' ')
  .replace(/[|｜/／\\、,，:：;；()（）\[\]【】]+/g, ' ')
  .trim()
  .toUpperCase()

// 命中即算候选；越靠前权重越高（排前面的是更常见的叫法）
const POL_WORDS = [
  'PORT OF LOADING', 'POL', 'LOADING PORT', 'ORIGIN PORT', 'ORIGIN',
  '起运港', '装货港', '装运港', '起运地', '出发港', '始发港',
]
const POD_WORDS = [
  'PORT OF DISCHARGE', 'POD', 'DISCHARGE PORT', 'DESTINATION PORT', 'DEST PORT', 'DESTINATION',
  '目的港', '卸货港', '到达港', '目的地', '到货港', '终到港',
]

/** 单词命中要防误伤：POL 不能命中 "POLICY"/"POLAR"，用词边界 */
function hit(text, word) {
  if (!text || !word) return false
  if (/^[A-Z ]+$/.test(word)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Z])${esc}([^A-Z]|$)`).test(text)
  }
  return text.includes(word)
}

function score(text, words) {
  for (let i = 0; i < words.length; i++) {
    if (hit(text, words[i])) return words.length - i + 10   // 越靠前的词分越高
  }
  return 0
}

/**
 * @param {string[]} cells 一行的单元格文本（1 维数组，索引 0 = A 列）
 * @returns {{pol:number, pod:number, scores:{pol:number,pod:number}}} 列号从 1 开始，找不到为 0
 */
export function matchPortHeaders(cells) {
  let pol = 0, pod = 0, polScore = 0, podScore = 0
  const list = Array.isArray(cells) ? cells : []
  for (let i = 0; i < list.length; i++) {
    const t = CLEAN(list[i])
    if (!t || t.length > 40) continue
    // 紧凑形式再试一遍：P.O.L / P O L / P-O-L 都要能认出
    const tc = t.replace(/[^A-Z0-9\u4e00-\u9fa5]/g, '')
    const sp = Math.max(score(t, POL_WORDS), score(tc, POL_WORDS))
    const sd = Math.max(score(t, POD_WORDS), score(tc, POD_WORDS))
    // 同一格里两样都像（"POL/POD" 合并表头）→ 取分值高的那个，另一个留给别列
    if (sp && sp > polScore) { pol = i + 1; polScore = sp }
    if (sd && sd > podScore) { pod = i + 1; podScore = sd }
  }
  if (pol && pod && pol === pod) {          // 撞到同一列：保留分高的
    if (polScore >= podScore) pod = 0
    else pol = 0
  }
  return { pol, pod, scores: { pol: polScore, pod: podScore } }
}
