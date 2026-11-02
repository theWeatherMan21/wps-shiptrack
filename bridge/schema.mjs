// canonical 契约（schemaVersion）的桥侧部分 —— 纯函数，单测直接喂，不启服务、不连网
//
// 单一来源：引擎 engine/tracking/normalize.mjs 的 SCHEMA_VERSION。桥只读那一份，
// **绝不在这里再写一个数字**——两处各写一份就会慢慢漂移，正是这个版本号要防的事。
//
// 桥的两个职责：
//   1. /health 报出自己支持的最低/最高契约版本（插件据此判断「桥是不是老桥」）
//   2. /track 收到插件上报的 schema 后：插件太旧 → 只回「单号 + 一句人话」的降级桩，
//      一个业务字段都不给。因为旧插件不看版本号，给了字段它就敢照着渲染。

export const MSG_PLUGIN_OLD = '插件版本旧，请更新加载项'

/**
 * @param {number|null|undefined} engineVersion 引擎导出的 SCHEMA_VERSION（读不到就传 null/undefined）
 */
export function makeContract(engineVersion) {
  const v = Number.isInteger(engineVersion) ? engineVersion : null

  return {
    version: v,
    min: v,
    max: v,

    /** /health 上要摊开的字段（curl 一条命令就能看见区间） */
    health() {
      return {
        schemaVersion: v,
        minSchemaVersion: v,
        maxSchemaVersion: v,
        supportedSchemaVersions: v === null ? [] : [v],
      }
    },

    /**
     * 判断插件上报的契约版本。
     * @param {string|number|null} raw 请求里的 schema 参数
     * @returns {{known:boolean, version:number|null, tooOld:boolean, tooNew:boolean, bridgeUnknown:boolean}}
     */
    judgePlugin(raw) {
      const s = raw == null ? '' : String(raw).trim()
      const base = { known: false, version: null, tooOld: false, tooNew: false, bridgeUnknown: false }
      if (!/^\d+$/.test(s)) return base
      const n = Number(s)
      // 桥自己都不知道契约版本（引擎没导出）→ 不敢拦，照常放行并留日志
      if (v === null) return { ...base, known: true, version: n, bridgeUnknown: true }
      return { ...base, known: true, version: n, tooOld: n < v, tooNew: n > v }
    },

    /** 降级桩：只有单号 + 一句人话，业务字段一个都不给 */
    refusal(number, carrier) {
      return {
        ok: false,
        schemaUnsupported: true,
        schemaVersion: v,
        number,
        carrier: carrier || null,
        error: `${MSG_PLUGIN_OLD}（桥契约 v${v === null ? '未知' : v}）`,
      }
    },
  }
}
