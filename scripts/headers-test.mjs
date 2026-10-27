// 表头识别单测：不同表格形态下都要能认出 POL/POD（不能依赖某一种固定格式）
import { matchPortHeaders } from '../src/lib/headers.js'

const cases = []
const eq = (name, got, want) => cases.push([name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`])

// 1) 爹地的波兰表：代理号/状态栏/…/POL/POD
eq('标准英文表头', matchPortHeaders(['代理号', '状态栏', 'POL', 'POD', 'ETD', 'ETA']).pol, 3)
eq('标准英文表头 POD', matchPortHeaders(['代理号', '状态栏', 'POL', 'POD', 'ETD', 'ETA']).pod, 4)

// 2) 中文表头 + 位置完全不同
const cn = matchPortHeaders(['序号', '装货港', '卸货港', '船名'])
eq('中文表头 pol', cn.pol, 2)
eq('中文表头 pod', cn.pod, 3)

// 3) 英文全称
eq('Port of Loading / Discharge', matchPortHeaders(['#', 'Port of Loading', 'Port of Discharge']).pol, 2)
eq('Port of Loading / Discharge POD', matchPortHeaders(['#', 'Port of Loading', 'Port of Discharge']).pod, 3)

// 4) 合并表头（一格两词）→ 不能撞同一列
const merged = matchPortHeaders(['POL / 起运港', 'POD / 目的港'])
eq('合并表头 pol', merged.pol, 1)
eq('合并表头 pod', merged.pod, 2)

// 5) 干扰项：POLICY 不该命中 POL
eq('POLICY 误伤', matchPortHeaders(['POLICY NO', 'ETA']).pol, 0)

// 6) 完全没有港口列
eq('无港口列', matchPortHeaders(['MBL', 'S/L', 'V/V', '备注']), { pol: 0, pod: 0, scores: { pol: 0, pod: 0 } })

// 7) 大小写/空格/标点杂乱
eq('杂乱写法', matchPortHeaders(['  p.o.l ', ' pod：']).pol, 1)

let bad = 0
for (const [n, ok, d] of cases) {
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : '  ' + d}`)
}
console.log(`\n${cases.length - bad}/${cases.length} 通过`)
process.exit(bad ? 1 : 0)
