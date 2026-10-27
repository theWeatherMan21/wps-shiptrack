// 各船司官网「公开查询」的数据保留期。
// 依据见 ShipScheduleHub/docs/CARRIER-TRACE-RETENTION.md（2026-10-26 查证，含原文引用）。
// 用途：查无此单时告诉用户到底是「号码错」还是「过期了」——这两件事对他完全不一样。
export const RETENTION = {
  cma: '还空箱后 15 天',
  maersk: '到还空柜或 ETA+30 天',
  wanhai: '90 天',
  yangming: '订舱资料 1 年',
  hapag: '约 12 个月',
  msc: '依产品（reefer 还空后 30 天）',
  evergreen: '依产品（行程结束 +30 天）',
}

export const retentionOf = (carrier) => RETENTION[String(carrier || '').toLowerCase()] || ''

/** 查无此单时的统一文案：有保留期就点明，没有就只说事实 */
export function notFoundText(carrier, name) {
  const who = name || '船司'
  const ret = retentionOf(carrier)
  return ret ? `${who} 查无此单（官网只保留 ${ret}）` : `${who} 查无此单`
}
