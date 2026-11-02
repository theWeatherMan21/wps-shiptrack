// 单元格「最新动态」文案 —— 纯函数，全项目只有这一处
//
// 为什么单独成文件（卡 t_8a6689dc）：这段逻辑决定「一格文字里出现的是哪一票的事实」。
// 它原来埋在 TaskPane.vue 里，导致①插件自己测不了；②回归脚本只能抄一份逻辑，
// 测的就不是真代码。现在 TaskPane 只负责调用，回归脚本喂 183 单台账走**同一份代码**。
//
// 口径（2026-10-27 爹地拍板）：只有「已发生」的事件才算最新动态，计划/预计的后面标「预计」。
import { formatEventLine } from './events.js'
import { isPlanned } from './truth.js'
import { notFoundText } from './retention.js'

/** 船司短名表（表里写 MSK 这种；桥给的 name 只在没适配器的船司上兜底） */
export const CARRIER_NAME = {
  hapag: 'HPL', maersk: 'MSK', zim: 'ZIM', cosco: 'COSCO', cma: 'CMA',
  oocl: 'OOCL', one: 'ONE', hmm: 'HMM', evergreen: 'EMC', yangming: 'YML',
  akkon: 'AKK',
}

/**
 * @param {object} r 桥返回的归一化结果（字段口径见引擎 normalize.mjs，契约版本 = SCHEMA_VERSION）
 * @param {{carrierLabel?: (c:string)=>string}} [opts] 没适配器的船司用桥给的名字
 */
export function renderLatest(r, opts = {}) {
  const carrierName = (c) => CARRIER_NAME[c] || ''
  const carrierLabel = opts.carrierLabel || ((c) => c)
  if (!r) return '空响应'
  if (r.ok === false) {
    const raw = String(r.error || '查询失败')
    if (/Cannot tell which carrier|unknown-prefix|未识别/i.test(raw)) return '未识别承运人（可能是货代单）'
    // 官网只保留近 12 个月 / 单号不存在 → 统一按「查无」处理
    if (/仅保留 12 个月|DOCUMENT does not exist/i.test(raw)) {
      return notFoundText(r.carrier, carrierName(r.carrier))
    }
    if (/官网当前不可用|site-unavailable|maintenance work/i.test(raw)) {
      return `${carrierName(r.carrier) || '船司'} 官网当前不可用（地区限制/维护中，换网络或手工查）`
    }
    if (/需要 14 位提单号|Akkon 未找到/i.test(raw)) {
      return 'AKK 查无此单（需 14 位提单号，箱号不能单独查）'
    }
    if (/no tracking module|not wired up for/i.test(raw)) {
      return `${carrierLabel(r.carrier) || '该船司'} 未接入追踪（请手工查）`
    }
    if (/超时|timeout/i.test(raw)) return '查询超时（网络慢，稍后重试）'
    // ★ 10-29：OOCL 匿名端点有 QF8 限流（连查 6-8 次会被封一阵）→ 如实说，别叫人反复重试
    if (/限流|throttled|too many requests|访问过于频繁/i.test(raw)) {
      return `${carrierLabel(r.carrier) || '船司'} 站方限流（过几分钟再查，别连续重试）`
    }
    if (/HTTP 404|No tracking data found/i.test(raw)) {
      return notFoundText(r.carrier, carrierName(r.carrier))
    }
    if (/DOCUMENT does not exist|Shipment not found/i.test(raw)) {
      // 只说事实：官网对这两个号都没有记录。不猜「你用错了号」——工具分不清就该两个都试过再说
      return notFoundText(r.carrier, carrierName(r.carrier))
    }
    const short = raw.split('\n')[0].slice(0, 40)
    return '失败：' + short
  }
  const evs = r.events || []
  // 只有「已发生」的事件才算最新动态；计划/预计的（EXPECTED）不能当成事实报出来
  // 爹地 2026-10-27：900000012 连柜都没装，却被写成「12-12 到港 · GDANSK」
  const isPlan = (e) => isPlanned(e) // 与里程碑判定同一口径（truth.js）
  const actuals = evs.filter((e) => !isPlan(e))
  const cur = (r.current && !isPlan(r.current)) ? r.current : (actuals.length ? actuals[actuals.length - 1] : null)
  const plans = evs.filter(isPlan)
  const plan = plans.length ? plans[plans.length - 1] : null
  if (!cur) {
    return plan
      ? `还没发货（预计 ${formatEventLine(plan.time, plan.activity, plan.city)}）`
      : (r.phase ? `暂无动态（${r.phase}）` : '暂无动态')
  }
  const line = formatEventLine(cur.time, cur.activity, cur.city)
  // 有比它更晚的计划事件 → 附在后面，但明确写「预计」
  return plan && String(plan.time || '') > String(cur.time || '')
    ? `${line}；预计 ${formatEventLine(plan.time, plan.activity, plan.city)}`
    : line
}
