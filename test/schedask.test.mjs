// 不变量测试：ETD/ETA 回填确认（★ 11-03 爹地原话「写入 ETD/ETA，请加一个按钮来确认吧，不要静默替换」）
//
// 只断言「绝不能让发生的事」，而且全部走生产代码（lib/schedask.js + lib/dates.js）：
//   ① 空 / 日期 / 数字 → 可以写；非空文本（代理名）→ 一律不写
//   ② 已经干净等于目标日 → 不重写；带时分的脏序列号（46302.6667）→ 必须允许修回，但要走确认
//   ③ 写出去的值：日期格是**整数序列号**，非日期格是 'yyyy-mm-dd' 文本（绝不传 Date 给宿主）
//   ④ 条上标题口径固定为「船期回填：将更新 N 行（ETD x / ETA y）」，差异只列前 5 条
//
// 跑：node test/schedask.test.mjs

import { decideScheduleWrite, shortDateText, summarizeAsk } from '../src/lib/schedask.js'
import { ymdToSerial, serialToYmd, dateCellIsClean } from '../src/lib/dates.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const YMD = '2026-10-08'
const SERIAL = ymdToSerial(YMD)          // 46303

console.log('① 该不该写：空 / 日期 / 数字 才能写，文本绝不覆盖')
ok(decideScheduleWrite('', YMD, 'yyyy-mm-dd').write === true, '空格 → 可以写')
ok(decideScheduleWrite(undefined, YMD, 'yyyy-mm-dd').write === true, '读不到值（undefined）→ 可以写')
ok(decideScheduleWrite(null, YMD, 'yyyy-mm-dd').write === true, 'null → 可以写')
ok(decideScheduleWrite('SINOTRANS 天津', YMD, 'yyyy-mm-dd').reason === 'text', '代理名是文本 → 跳过（reason=text）')
ok(decideScheduleWrite('SINOTRANS 天津', YMD, 'yyyy-mm-dd').write === false, '代理名是文本 → 不写')
ok(decideScheduleWrite('13800138000', YMD, 'yyyy-mm-dd').write === false, '联系方式（数字文本）→ 不当日期，不写')
ok(decideScheduleWrite(new Date(2026, 8, 22), YMD, 'yyyy-mm-dd').write === true, '旧日期（Date）→ 可以写')
ok(decideScheduleWrite(46287.66666666664, YMD, 'yyyy-mm-dd').write === true, '旧日期（带时分序列号）→ 可以写')

console.log('② 已经干净的不重写；脏值必须允许修回')
ok(decideScheduleWrite(SERIAL, YMD, 'yyyy-mm-dd').write === false, `已经是 ${YMD} 的整数序列号 → 不重写`)
ok(decideScheduleWrite(SERIAL, YMD, 'yyyy-mm-dd').reason === 'clean', '同上 reason=clean')
ok(decideScheduleWrite(YMD, YMD, 'yyyy-mm-dd').write === false, '文本已经是这一天 → 不重写')
ok(decideScheduleWrite(new Date(2026, 9, 8), YMD, 'yyyy-mm-dd').write === false, 'Date 零点等于这一天 → 不重写')
ok(decideScheduleWrite(new Date(2026, 9, 8, 16, 0, 0), YMD, 'yyyy-mm-dd').write === true, 'Date 带时分（脏）→ 必须能修回')
ok(decideScheduleWrite(46302.66666666664, YMD, 'yyyy-mm-dd').write === true, '偏一天的脏序列号 → 必须能修回')
ok(dateCellIsClean(46302.66666666664, YMD) === false, '（口径一致）脏序列号不算干净')
ok(decideScheduleWrite('', '', 'yyyy-mm-dd').reason === 'no-value', '没有新值 → 不写（reason=no-value）')

console.log('③ 写出去的值：日期格整数序列号 / 非日期格 ymd 文本，绝不传 Date')
const dw = decideScheduleWrite('', YMD, 'yyyy-mm-dd')
ok(dw.value === SERIAL, `日期格式列 → 写整数序列号 ${SERIAL}`, String(dw.value))
ok(Number.isInteger(dw.value), '日期格式列 → 序列号必须是整数（不能有 0.6667）')
ok(dw.serial === true, '日期格式列 → serial=true')
const tw = decideScheduleWrite('', YMD, 'General')
ok(tw.value === YMD && tw.serial === false, '非日期列 → 写 ymd 文本')
ok(!(tw.value instanceof Date), '两种列都不许把 Date 对象交给宿主')

console.log('④ 确认条文案：旧值 → 新值，前 5 条')
ok(shortDateText(46303) === '08-Oct', `序列号 46303 → '08-Oct'`, shortDateText(46303))
ok(shortDateText(46302.66666666664) === '07-Oct', '带时分的 46302.6667 → 显示成表格里那一天 07-Oct（不许四舍五入抹平差异）', shortDateText(46302.66666666664))
ok(shortDateText(new Date(2026, 8, 22)) === '22-Sep', `Date 2026-09-22 → '22-Sep'`, shortDateText(new Date(2026, 8, 22)))
ok(shortDateText('2026-09-22') === '22-Sep', '文本 ymd → 22-Sep')
ok(shortDateText('') === '空', '空格 → 空')
ok(shortDateText('SINOTRANS LOGISTICS CO') === 'SINOTRANS LOGI…', '长文本截断（一眼看得出不是日期）', shortDateText('SINOTRANS LOGISTICS CO'))
ok(shortDateText(12.5) === '12.5', '小数字不是日期 → 原样显示')

const items = [
  { row: 2, label: 'ETD', oldText: '22-Sep', newText: '2026-10-08' },
  { row: 3, label: 'ETD', oldText: '空', newText: '2026-10-08' },
  { row: 4, label: 'ETA', oldText: '07-Oct', newText: '2026-10-08' },
]
const s3 = summarizeAsk(items)
ok(s3.n === 3, '行数 n=3')
ok(s3.etdN === 2 && s3.etaN === 1, 'ETD 2 / ETA 1')
ok(s3.preview.length === 3 && s3.more === 0, '不超过 5 条 → 全列，more=0')
ok(s3.preview[0].text === 'R2 ETD 22-Sep → 2026-10-08', '单行格式 R2 ETD 22-Sep → 2026-10-08', s3.preview[0].text)
ok(s3.title === '船期回填：将更新 3 行（ETD 2 / ETA 1）', '标题口径固定', s3.title)

const many = Array.from({ length: 8 }, (_, i) => ({ row: i + 2, label: 'ETD', oldText: '空', newText: '2026-10-08' }))
const s8 = summarizeAsk(many)
ok(s8.preview.length === 5, '超过 5 条只列前 5 条')
ok(s8.more === 3, '剩余 3 条 → more=3，界面显示「等共 8 行」')
ok(summarizeAsk([]).n === 0 && summarizeAsk([]).title === '船期回填：将更新 0 行（ETD 0 / ETA 0）', '空列表不炸')
ok(summarizeAsk(null).n === 0, '脏输入（null）不炸')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
