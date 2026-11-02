// canonical 契约（schemaVersion）的守门测试 —— 纯函数、毫秒级、不启服务、不连网。
// 跑法：node test/schema.test.mjs
//
// 为什么要有它（卡 t_8a6689dc）：
//   桥与插件分别安装、分别升级。旧插件拿到新桥的结果，字段名/含义变了也照样渲染
//   → 把 A 的文案静默写到 B 的位置，用户看不出来。这个闸门一旦漏判，就是「错的但看起来正常」，
//   比报错危险得多，所以四种组合（相等 / 太新 / 太旧 / 没版本号）必须逐条钉死。
import {
  checkResultSchema, PLUGIN_SCHEMA_VERSION, PLUGIN_MIN_SCHEMA, PLUGIN_MAX_SCHEMA,
  MSG_PLUGIN_OLD, MSG_BRIDGE_OLD,
} from '../src/lib/contract.js'
import { makeContract, MSG_PLUGIN_OLD as BRIDGE_MSG } from '../bridge/schema.mjs'

let bad = 0
const check = (name, cond, detail = '') => {
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ← ' + detail}`)
}

// ── ① 插件侧闸门 ───────────────────────────────────────────────────────────
check('插件契约版本是 1', PLUGIN_SCHEMA_VERSION === 1, `实得 ${PLUGIN_SCHEMA_VERSION}`)
check('区间自洽（min ≤ 自身 ≤ max）', PLUGIN_MIN_SCHEMA <= PLUGIN_SCHEMA_VERSION && PLUGIN_SCHEMA_VERSION <= PLUGIN_MAX_SCHEMA)

{
  const ok = checkResultSchema({ ok: true, schemaVersion: 1, number: 'X', events: [] }, 1)
  check('v1 结果 + v1 桥 → 放行', ok.ok === true && ok.code === 'ok', JSON.stringify(ok))
}
{
  const g = checkResultSchema({ ok: true, schemaVersion: 2, number: 'X', events: [] }, 2)
  check('桥给 v2（插件只认到 v1）→ 拦住', g.ok === false && g.code === 'plugin-old', JSON.stringify(g))
  check('拦住时的话术是「插件版本旧」', g.short === MSG_PLUGIN_OLD, g.short)
  check('拦住时带人话原因（含双方版本）', /v2/.test(g.detail) && /v1/.test(g.detail), g.detail)
}
{
  const g = checkResultSchema({ ok: true, schemaVersion: 0, number: 'X', events: [] }, 0)
  check('桥给 v0（比插件要求旧）→ 拦住', g.ok === false && g.code === 'bridge-old', JSON.stringify(g))
  check('桥旧时话术是「更新桥」', g.short === MSG_BRIDGE_OLD, g.short)
}
{
  const g = checkResultSchema({ ok: true, schemaUnsupported: true, schemaVersion: 2, number: 'X' }, 2)
  check('桥主动降级（schemaUnsupported）→ 拦住且话术统一', g.ok === false && g.code === 'bridge-refused' && g.short === MSG_PLUGIN_OLD, JSON.stringify(g))
}
{
  const g = checkResultSchema({ ok: true, number: 'X', events: [] }, 1)
  check('桥自报有版本、结果却没带 → 拦住（协议不一致）', g.ok === false && g.code === 'missing-version', JSON.stringify(g))
}
{
  const g = checkResultSchema({ ok: true, number: 'X', events: [] }, null)
  check('老桥（没上报版本）+ 结果没版本 → 按 v1 兼容放行', g.ok === true && g.code === 'legacy', JSON.stringify(g))
}
{
  const g = checkResultSchema({ ok: false, number: 'X', error: '查无此单' }, 1)
  check('失败行没有版本号 → 不拦（只用 error 字段，不涉及错位）', g.ok === true && g.code === 'error-row', JSON.stringify(g))
}
{
  const g = checkResultSchema({ ok: true, schemaVersion: '1', number: 'X' }, 1)
  check('版本号是字符串 "1"（不是整数）→ 不当作 v1，按缺失处理拦住', g.ok === false && g.code === 'missing-version', JSON.stringify(g))
}
{
  const g = checkResultSchema(null, 1)
  check('空结果 → 不拦（由网络层报错）', g.ok === true && g.code === 'empty', JSON.stringify(g))
}

// ── ② 桥侧契约（/health 区间 + 上报判定 + 降级桩）────────────────────────────
{
  const c = makeContract(1)
  const h = c.health()
  check('/health 报出 schemaVersion=1', h.schemaVersion === 1, JSON.stringify(h))
  check('/health 报出最低/最高（min=max=1）', h.minSchemaVersion === 1 && h.maxSchemaVersion === 1, JSON.stringify(h))
  check('/health 报出 supportedSchemaVersions=[1]', JSON.stringify(h.supportedSchemaVersions) === '[1]', JSON.stringify(h))

  const j1 = c.judgePlugin('1')
  check('插件上报 1 → 不降级', j1.known === true && j1.tooOld === false && j1.tooNew === false, JSON.stringify(j1))
  const j0 = c.judgePlugin('0')
  check('插件上报 0 → 判太旧', j0.known === true && j0.tooOld === true, JSON.stringify(j0))
  const j2 = c.judgePlugin('2')
  check('插件上报 2 → 判比桥新（不拦，桥只回 v1）', j2.known === true && j2.tooNew === true && j2.tooOld === false, JSON.stringify(j2))
  const jn = c.judgePlugin(null)
  check('插件没上报（老插件）→ known=false，不拦（只记日志）', jn.known === false, JSON.stringify(jn))
  const jx = c.judgePlugin('abc')
  check('插件上报垃圾值 → known=false，不拦', jx.known === false, JSON.stringify(jx))

  const ref = c.refusal('ABC123', 'msc')
  check('降级桩只给单号 + 一句人话', ref.number === 'ABC123' && ref.ok === false && ref.schemaUnsupported === true, JSON.stringify(ref))
  check('降级桩不含任何业务字段', !('events' in ref) && !('current' in ref) && !('origin' in ref) && !('destination' in ref), JSON.stringify(ref))
  check('降级桩话术与插件侧同一句', String(ref.error).startsWith(BRIDGE_MSG) && BRIDGE_MSG === MSG_PLUGIN_OLD, String(ref.error))
}
{
  // 引擎没导出 SCHEMA_VERSION（旧引擎/装错目录）：桥不能崩，也不能编一个数字出来
  const c = makeContract(undefined)
  const h = c.health()
  check('读不到引擎版本 → /health 报 null + 空区间', h.schemaVersion === null && h.supportedSchemaVersions.length === 0, JSON.stringify(h))
  const j = c.judgePlugin('1')
  check('读不到引擎版本时插件上报 → 不拦（bridgeUnknown）', j.known === true && j.tooOld === false && j.bridgeUnknown === true, JSON.stringify(j))
  const jn = c.judgePlugin(null)
  check('读不到引擎版本时插件没上报 → 也不拦', jn.known === false, JSON.stringify(jn))
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
