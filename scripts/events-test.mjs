// 事件翻译单测：用的全是爹地真实单据里出现过的原文（apps/Mediterranean Worksheet）
import { zhEvent, cleanCity, formatEventLine } from '../src/lib/events.js'

const cases = []
const eq = (name, got, want) => cases.push([name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`])

// ---- 表里真实事件（出现频次最高的两个以前没翻译）----
eq('Empty Received At Cy', zhEvent('Empty Received At Cy'), '空箱进场（CY）')
eq('Container Return', zhEvent('Container Return'), '还空箱')
eq('Empty Return', zhEvent('Empty Return'), '还空箱')
eq('Empty Pick Up', zhEvent('Empty Pick-Up'), '提空箱')
eq('Stripping', zhEvent('Stripping'), '拆箱')
eq('Export Loaded on Vessel', zhEvent('Export Loaded on Vessel'), '装船')
eq('Import Loaded on Vessel', zhEvent('Import Loaded on Vessel'), '装船')
eq('Gate In', zhEvent('Gate In'), '进闸/进场')
eq('Gate Out', zhEvent('Gate Out'), '出闸')
eq('Discharged', zhEvent('Discharged from Vessel'), '卸船')
eq('Arrival (eta)', zhEvent('Arrival (eta)'), '到港')
eq('Vessel Departure', zhEvent('Vessel Departure'), '离港')
eq('Rolled', zhEvent('Rolled'), '甩柜')
// 认不出的保留原文，不瞎翻
eq('未识别事件保留原文', zhEvent('Some New Event X'), 'Some New Event X')
eq('空事件', zhEvent(''), '')

// ---- 城市清洗（表里出现过 DERINCE.）----
eq('去结尾句点', cleanCity('DERINCE.'), 'DERINCE')
eq('去括号注释', cleanCity('SHANGHAI (CN)'), 'SHANGHAI')
eq('去国家码', cleanCity('XINGANG, CN'), 'XINGANG')
eq('多重清理', cleanCity('AMBARLI MARPORT (TR). '), 'AMBARLI MARPORT')

// ---- 整行 ----
eq('整行拼装', formatEventLine('2026-10-16T04:46:00.000Z', 'Export Loaded on Vessel', 'SHANGHAI, CN'), '2026-10-16 · 装船 · SHANGHAI')
eq('整行-还空箱带句点', formatEventLine('2025-08-20T00:00:00Z', 'Empty Received At Cy', 'ISTANBUL.'), '2025-08-20 · 空箱进场（CY） · ISTANBUL')

let bad = 0
for (const [n, ok, d] of cases) {
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : '  ' + d}`)
}
console.log(`\n${cases.length - bad}/${cases.length} 通过`)
process.exit(bad ? 1 : 0)
