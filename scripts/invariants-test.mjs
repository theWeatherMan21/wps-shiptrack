// 不变量测试：这类「把计划当事实」的错误，必须由测试挡住，而不是等用户撞上。
// 夹具全部取自**真实船司返回**（279885106 实查：柜未装船，只有 3 条 EXPECTED）。
import { stageOf, isExpected, isDepartEvent, isArriveEvent } from '../src/lib/milestone.js'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `　got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

// —— 真实返回：Maersk 279885106（上海 → 格但斯克，柜未装船）——
const mskNotLoaded = [
  // 实查原样（2026-10-27，桥 /track 返回）：三条全是 EXPECTED，柜未装船
  { activity: 'Container Departure', city: 'SHANGHAI', time: '2026-11-01T00:00:00', timeType: 'EXPECTED', vessel: 'MANCHESTER MAERSK' },
  { activity: 'Container Arrival', city: 'WILHELMSHAVEN', time: '2026-12-01T00:00:00', timeType: 'EXPECTED' },
  { activity: 'Container Departure', city: 'WILHELMSHAVEN', time: '2026-12-09T00:00:00', timeType: 'EXPECTED' },
  { activity: 'Container Arrival', city: 'GDANSK', time: '2026-12-12T00:00:00', timeType: 'EXPECTED' },
]

eq('计划事件一律不参与阶段判定（4 条全是 EXPECTED）', mskNotLoaded.filter(isExpected).length, 4)

const st = stageOf(mskNotLoaded, { pol: 'SHANGHAI', pod: 'GDANSK' })
eq('未装船的柜子不能被判成「已到港」', st.stage, 0)
eq('未装船的柜子不能上色（NO_FILL=-4142）', st.color, -4142)

// —— 对照：真的离港了才算 ——
const mskDeparted = [
  { activity: 'Container Departure', city: 'QINGDAO', time: '2026-10-09T00:00:00', timeType: 'ACTUAL' },
  { activity: 'Container Arrival', city: 'GDANSK', time: '2026-11-21T00:00:00', timeType: 'EXPECTED' },
]
eq('真离港（ACTUAL）→ 阶段 1', stageOf(mskDeparted, { pol: 'QINGDAO', pod: 'GDANSK' }).stage, 1)
eq('真离港 → 蓝', stageOf(mskDeparted, { pol: 'QINGDAO', pod: 'GDANSK' }).color, 0xcfe3fa)

// —— 对照：真到港才算绿 ——
const arrived = [
  { activity: 'Container Departure', city: 'QINGDAO', time: '2026-10-09T00:00:00', timeType: 'ACTUAL' },
  { activity: 'Container Arrival', city: 'GDANSK', time: '2026-11-20T00:00:00', timeType: 'ACTUAL' },
]
eq('真到港（ACTUAL）→ 阶段 2', stageOf(arrived, { pol: 'QINGDAO', pod: 'GDANSK' }).stage, 2)

// ---------- 全船司真实夹具（scripts/capture-fixture.mjs 抓取，已脱敏）----------
import fs from 'node:fs'
import path from 'node:path'
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'fixtures')
let fx = []
try { fx = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { /* 没有夹具就跳过 */ }
for (const f of fx) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const evs = d.events || []
  const st = stageOf(evs, { pol: d.origin || '', pod: d.destination || '' })
  const actualDep = evs.some((e) => !isExpected(e) && isDepartEvent(e))
  const actualArr = evs.some((e) => !isExpected(e) && isArriveEvent(e))
  const name = d.carrier || f.replace('.json', '')
  if (!evs.length) {
    // 查不到的单：允许没有起讫港，但绝不能判出阶段/颜色
    eq(`${name}: 无事件 → 阶段 0`, st.stage, 0)
    eq(`${name}: 无事件 → 不上色`, st.color, -4142)
    continue
  }
  eq(`${name}: 有 origin/destination`, [!!d.origin, !!d.destination], [true, true])
  eq(`${name}: 没有 ACTUAL 离港就不能判「已离港」`, actualDep ? true : st.stage === 0, true)
  eq(`${name}: 没有 ACTUAL 到港就不能判「已到港」`, actualArr ? true : st.stage < 2, true)
  eq(`${name}: 判出阶段就必须有颜色`, st.stage > 0 ? st.color !== -4142 : true, true)
}

// ---------- 属性检查：任意「全是计划事件」的列表，阶段必须是 0 ----------
const cities = ['SHANGHAI', 'GDANSK', 'NINGBO', 'ROTTERDAM']
for (let n = 1; n <= 5; n++) {
  const evs = Array.from({ length: n }, (_, i) => ({
    activity: i % 2 ? 'Container Arrival' : 'Container Departure',
    city: cities[i % cities.length],
    time: `2026-11-0${i + 1}T00:00:00`,
    timeType: 'EXPECTED',
  }))
  eq(`属性：${n} 条全是 EXPECTED → 阶段 0`, stageOf(evs, { pol: 'SHANGHAI', pod: 'GDANSK' }).stage, 0)
}

console.log(bad ? `\n${bad} 项不满足` : '\n不变量全部成立')
process.exit(bad ? 1 : 0)
