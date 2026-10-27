// 里程碑判定单测：事件写法来自 DCSA / Hapag EDI 315 / Maersk / MSC 真实样本
import { stageOf, STAGE, samePlace, isExpected } from '../src/lib/milestone.js'

const cases = []
const eq = (name, got, want) => cases.push([name, got === want, `got=${got} want=${want}`])
const ev = (activity, city, time, kind) => ({ activity, city, time: time || '2026-10-01T00:00:00Z', kind })

// ---- 真实 Hapag 样本（HLCUEUR259DD22132XX，14 条，最后是离港 ISTANBUL）----
const hapag = [
  ev('Load', 'PORT SAID', '2026-10-05T00:00:00Z'),
  ev('Departure From', 'PORT SAID', '2026-10-06T00:00:00Z'),
  ev('Arrival In', 'ISTANBUL', '2026-10-11T00:00:00Z'),
  ev('Discharged', 'ISTANBUL', '2026-10-12T00:00:00Z'),
  ev('Departure From', 'ISTANBUL', '2026-10-21T00:00:00Z'),
]
eq('Hapag 全流程 → 已到目的港', stageOf(hapag, { pol: 'PORT SAID', pod: 'ISTANBUL' }).stage, STAGE.ARRIVED)

// ---- 只有装船/离港：未到目的港 ----
const atSea = [
  ev('Gate In', 'QINGDAO'),
  ev('Export Loaded on Vessel', 'QINGDAO', '2026-10-02T00:00:00Z'),
  ev('Departure From', 'QINGDAO', '2026-10-03T00:00:00Z'),
  ev('Arrival In', 'ISTANBUL', '2026-11-20T00:00:00Z', 'EXPECTED'), // ETA 不算
]
eq('在途（ETA 不算到达）', stageOf(atSea, { pol: 'QINGDAO', pod: 'ISTANBUL' }).stage, STAGE.DEPARTED)

// ---- 还空箱（MSC / Hapag 两种写法）----
eq('Empty Received At Cy → 还空',
  stageOf([ev('Discharged', 'ISTANBUL'), ev('Empty Received At Cy', 'ISTANBUL', '2026-10-25T00:00:00Z')], { pod: 'ISTANBUL' }).stage,
  STAGE.EMPTY_RETURNED)
eq('Delivered to empty depot → 还空',
  stageOf([ev('Discharged', 'ISTANBUL'), ev('Delivered to empty depot', 'ISTANBUL', '2026-10-25T00:00:00Z')], { pod: 'ISTANBUL' }).stage,
  STAGE.EMPTY_RETURNED)
eq('Empty Container Return → 还空', stageOf([ev('Empty Container Return', 'ISTANBUL')]).stage, STAGE.EMPTY_RETURNED)

// ---- 还在起运港（只订舱/进闸/装箱）----
eq('只有进闸装船前 → 未离港', stageOf([ev('Gate In', 'QINGDAO'), ev('Loaded', 'QINGDAO')], { pol: 'QINGDAO' }).stage, STAGE.NONE)

// ---- 目的港对不上：不能因为别的港口中转就判到港 ----
eq('中转港到港≠目的港', stageOf([ev('Arrival In', 'SINGAPORE')], { pol: 'QINGDAO', pod: 'ISTANBUL' }).stage, STAGE.NONE)

// ---- 序列/大小写/标点 ----
eq('全小写也能认', stageOf([ev('departure from', 'qingdao')], { pol: 'QINGDAO' }).stage, STAGE.DEPARTED)
eq('港口带国家码', samePlace('QINGDAO, CN', 'QINGDAO'), true)
eq('港口带前缀', samePlace('PORT OF ISTANBUL', 'ISTANBUL'), true)
eq('不同港口', samePlace('SINGAPORE', 'ISTANBUL'), false)
eq('ETA 识别', isExpected(ev('Arrival (eta)', 'X')), true)
eq('ACTUAL 不算 ETA', isExpected(ev('Arrival', 'X', '', 'ACTUAL')), false)

// ---- 空事件 ----
eq('无事件 → 未离港', stageOf([]).stage, STAGE.NONE)
eq('null 容错', stageOf(null).stage, STAGE.NONE)

// ---- 颜色 ----
eq('蓝=在途', stageOf(atSea, { pol: 'QINGDAO', pod: 'ISTANBUL' }).color, 0xcfe3fa)
eq('绿=到港', stageOf(hapag, { pol: 'PORT SAID', pod: 'ISTANBUL' }).color, 0xd5f0dc)
eq('灰=还空', stageOf([ev('Empty Container Return', 'X')]).color, 0xe6e6e6)



// ---- 爹地 2026-10-26 实测表格（波兰2026.xlsx）复现的两个 bug ----
const msxCn = [                                  // MSC：新港出、厦门中转、伊斯坦布尔卸
  ev('Export Loaded On Vessel', 'XINGANG', '2026-10-08T00:00:00Z'),
  ev('Import Discharged', 'XIAMEN', '2026-10-19T00:00:00Z'),   // 中转港卸船，不是目的港
  ev('Export Loaded On Vessel', 'XIAMEN', '2026-10-20T00:00:00Z'),
]
eq('POL 写 TIANJIN / 事件写 XINGANG → 仍判已离港', stageOf(msxCn, { pol: 'TIANJIN', pod: 'GDANSK' }).stage, STAGE.DEPARTED)
eq('中转港 Xiamen 卸船不能刷成「已到港」', stageOf(msxCn, { pol: 'TIANJIN', pod: 'GDANSK' }).stage === STAGE.ARRIVED, false)
eq('别名：XINGANG = TIANJIN', samePlace('XINGANG', 'TIANJIN'), true)
eq('别名：XIANMEN = XIAMEN', samePlace('XIANMEN', 'XIAMEN'), true)
eq('别名：PORT OF QINGDAO = QINGDAO', samePlace('PORT OF QINGDAO', 'QINGDAO'), true)
eq('非同港：XINGANG ≠ GDANSK', samePlace('XINGANG', 'GDANSK'), false)

const msxDest = [
  ...msxCn,
  ev('Import Discharged', 'GDANSK', '2026-11-19T00:00:00Z'),
]
eq('真正到达 POD(GDANSK) → 已到港', stageOf(msxDest, { pol: 'TIANJIN', pod: 'GDANSK' }).stage, STAGE.ARRIVED)

const withEta = [
  ...msxCn,
  ev('Estimated Time Of Arrival', 'GDANSK', '2026-11-19T00:00:00Z', 'EXPECTED'),
]
eq('ETA 不能染色', stageOf(withEta, { pol: 'TIANJIN', pod: 'GDANSK' }).stage, STAGE.DEPARTED)

const emptyAtPod = [
  ...msxDest,
  ev('Empty Container Return', 'GDANSK', '2026-11-25T00:00:00Z'),
]
eq('目的港还空 → 灰', stageOf(emptyAtPod, { pol: 'TIANJIN', pod: 'GDANSK' }).stage, STAGE.EMPTY_RETURNED)

// 没有 POL/POD 时的退化判断：中转港卸船后还有离港 → 不算到港
eq('无港口信息：中转港卸船后仍离港 → 不算到港', stageOf(msxCn).stage, STAGE.DEPARTED)


// ---- 2026-10-26 实测：引擎回的是 timeType，ETA 必须被过滤掉 ----
const mskEta = [
  { activity: 'Container Departure', city: 'SHANGHAI', time: '2026-10-25T00:00:00', timeType: 'ACTUAL' },
  { activity: 'Container Arrival', city: 'WILHELMSHAVEN', time: '2026-11-25T00:00:00', timeType: 'EXPECTED' },
  { activity: 'Container Arrival', city: 'GDANSK', time: '2026-12-05T00:00:00', timeType: 'EXPECTED' },
]
eq('EXPECTED(timeType) 的到港不能染绿', stageOf(mskEta, { pol: 'SHANGHAI', pod: 'GDANSK' }).stage, STAGE.DEPARTED)
eq('同一条：颜色应为蓝', stageOf(mskEta, { pol: 'SHANGHAI', pod: 'GDANSK' }).color, 0xcfe3fa)
eq('isExpected 认 timeType=EXPECTED', isExpected({ activity: 'Container Arrival', timeType: 'EXPECTED' }), true)
eq('isExpected 不误杀 ACTUAL', isExpected({ activity: 'Container Arrival', timeType: 'ACTUAL' }), false)


// ---- 2026-10-27 头程驳船：重庆驳船接上海大船 ----
const feeder = [
  { activity: 'Gate-out', city: 'CHONGQING', time: '2026-10-01T00:00:00', timeType: 'ACTUAL' },
  { activity: 'Vessel Departure', city: 'SHANGHAI', time: '2026-10-04T00:00:00', timeType: 'ACTUAL' },
  { activity: 'Container Arrival', city: 'GDANSK', time: '2026-11-20T00:00:00', timeType: 'EXPECTED' },
]
const fr = stageOf(feeder, { pol: 'CHONGQING', pod: 'GDANSK' })
eq('头程驳船：表格 POL=重庆、实际在上海开船 → 仍算已离起运港', fr.stage, STAGE.DEPARTED)
eq('头程驳船：标记 feeder', fr.feeder, true)


// ---- 驳船是通用逻辑：不认港口名，只认「有没有在 POL 离港」+ 装船/离港事件 ----
const feederCases = [
  ['武汉 → 宁波', 'WUHAN', 'NINGBO', '2026-10-02', '2026-10-05'],
  ['张家港 → 上海', 'ZHANGJIAGANG', 'SHANGHAI', '2026-10-01', '2026-10-03'],
  ['南京 → 太仓', 'NANJING', 'TAICANG', '2026-09-28', '2026-09-30'],
  ['泸州 → 重庆 → 上海', 'LUZHOU', 'SHANGHAI', '2026-09-20', '2026-10-01'],
]
for (const [name, polPort, seaPort, d1, d2] of feederCases) {
  const evs = [
    { activity: 'Gate-out', city: polPort, time: `${d1}T00:00:00`, timeType: 'ACTUAL' },
    { activity: 'Vessel Departure', city: seaPort, time: `${d2}T00:00:00`, timeType: 'ACTUAL' },
    { activity: 'Container Arrival', city: 'GDANSK', time: '2026-11-20T00:00:00', timeType: 'EXPECTED' },
  ]
  const r = stageOf(evs, { pol: polPort, pod: 'GDANSK' })
  eq(`驳船 ${name}：按装船/大船离港判已离起运港`, r.stage, STAGE.DEPARTED)
}

let bad = 0
for (const [n, ok, d] of cases) {
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : '  ' + d}`)
}
console.log(`\n${cases.length - bad}/${cases.length} 通过`)
process.exit(bad ? 1 : 0)
