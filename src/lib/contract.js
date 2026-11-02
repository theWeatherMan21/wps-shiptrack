// canonical 结果契约（schemaVersion）—— 插件侧的闸门
//
// 病根（卡 t_8a6689dc）：桥与插件分别安装、分别升级。旧插件拿到新桥的结果时，
// 字段名/含义变了也照样渲染 → **静默渲染错**：把 A 的文案写到 B 的位置，用户看不出来。
// 所以「本插件认不认得这份结果」必须在渲染之前回答；答不上来就**不许猜字段**，
// 只显示单号 + 一句「插件版本旧，请更新加载项」，并在面板顶部挂横幅。
//
// 版本规则（写死，别改）：**只加不改**。
//   · 加字段 → 升版本（旧插件忽略新字段，安全）
//   · 改字段含义 / 删字段 → 必须升版本（旧插件会渲染错，正是这个版本号要防的事）
// 插件认得的区间就是下面这两个常量；引擎换了语义、桥照旧透传时，这里会拦住。

/** 插件自己认得的（也是上报给桥的）契约版本 */
export const PLUGIN_SCHEMA_VERSION = 1
export const PLUGIN_MIN_SCHEMA = 1
export const PLUGIN_MAX_SCHEMA = 1

export const MSG_PLUGIN_OLD = '插件版本旧，请更新加载项'
export const MSG_BRIDGE_OLD = '本地桥/引擎版本旧，请更新桥后再查'

const isInt = (v) => Number.isInteger(v)
const fmt = (v) => (isInt(v) ? 'v' + v : '未知')

/**
 * 判定一份 /track 结果能不能按本插件的字段口径渲染。
 *
 * @param {object|null} r            桥返回的结果对象
 * @param {number|null} bridgeSchema 桥在 /health 里自报的契约版本（老桥没有 → null）
 * @returns {{ok:boolean, code:string, short?:string, detail?:string, version?:number}}
 *   ok=false 时调用方必须走「降级渲染」：只写单号 + short，不碰任何其他字段
 */
export function checkResultSchema(r, bridgeSchema) {
  const bridge = isInt(bridgeSchema) ? bridgeSchema : null
  if (!r || typeof r !== 'object') return { ok: true, code: 'empty' }

  // 桥主动降级：它已经判定本插件认不了这份结果，只回了单号
  if (r.schemaUnsupported === true) {
    return {
      ok: false, code: 'bridge-refused', short: MSG_PLUGIN_OLD,
      detail: `桥判定本插件认不了这份结果（桥契约 ${fmt(r.schemaVersion)}，本插件支持 v${PLUGIN_MIN_SCHEMA}–v${PLUGIN_MAX_SCHEMA}）→ 已停止回填，避免字段错位`,
    }
  }

  const v = r.schemaVersion
  if (isInt(v)) {
    if (v < PLUGIN_MIN_SCHEMA) {
      return {
        ok: false, code: 'bridge-old', short: MSG_BRIDGE_OLD,
        detail: `结果是旧契约 v${v}，本插件要 v${PLUGIN_MIN_SCHEMA}–v${PLUGIN_MAX_SCHEMA} → 已停止回填，避免字段错位`,
      }
    }
    if (v > PLUGIN_MAX_SCHEMA) {
      return {
        ok: false, code: 'plugin-old', short: MSG_PLUGIN_OLD,
        detail: `桥给的是新契约 v${v}，本插件只认到 v${PLUGIN_MAX_SCHEMA} → 已停止回填，避免字段错位`,
      }
    }
    return { ok: true, code: 'ok', version: v }
  }

  // 失败行只用 error 一个字段，不涉及字段错位 → 不必拦
  if (r.ok === false) return { ok: true, code: 'error-row' }

  // 桥自称有契约版本，结果里却没有 → 协议不一致，宁可停
  if (bridge !== null) {
    return {
      ok: false, code: 'missing-version', short: MSG_BRIDGE_OLD,
      detail: `桥自报契约 v${bridge}，但结果里没有 schemaVersion → 已停止回填，避免字段错位`,
    }
  }

  // 老桥（1.6.4 那代还没上报契约版本）：字段集与 v1 完全一致（只加不改），按 v1 渲染
  return { ok: true, code: 'legacy' }
}
