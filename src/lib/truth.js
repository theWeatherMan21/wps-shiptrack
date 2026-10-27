// 事件真伪的唯一判定口径 —— 全项目只能从这里判断「已发生 / 计划中」
//
// 2026-10 连续踩坑：同一个病（把船司给的计划事件当成事实）在三个地方各修了一遍
//   milestone 用 kind、显示用 evs[last]、引擎用 timeType —— 口径不一致，修一处漏两处。
// 现在统一从这里取。规则（按可信度从高到低）：
//   1) timeType / kind / eventClassifierCode 有值：ACTUAL 才算已发生，其余一律算计划
//   2) 有值但未知（如 EST、PLANNED）：算计划
//   3) 全都没值：看文案里的 ETA/EXPECTED/预计… → 计划；否则按「已发生」处理（老船司不给字段）
const PLAN_WORDS = /ETA|EXPECT|ESTIMAT|PLANNED|SCHEDUL|PROFORMA|预计|计划|预定/i
const ACTUAL_WORDS = /\bACTUAL\b|已发生|实际/i

export function eventTruth(e) {
  if (!e) return 'planned'
  const tt = String(e.timeType || e.kind || e.eventClassifierCode || '').trim().toUpperCase()
  if (tt) {
    if (tt === 'ACTUAL') return 'actual'
    return 'planned'                     // EXPECTED / ESTIMATED / PLANNED / UNKNOWN… 都按计划
  }
  const txt = `${e.activity || ''} ${e.status || ''}`
  if (ACTUAL_WORDS.test(txt)) return 'actual'
  if (PLAN_WORDS.test(txt)) return 'planned'
  return 'actual'                        // 无字段可依 → 沿用老口径，避免把所有老船司都判成计划
}

export const isPlanned = (e) => eventTruth(e) === 'planned'
export const isActual = (e) => eventTruth(e) === 'actual'
