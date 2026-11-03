// 不变量测试：写回「读回校验」的三种列型都不许判 fail（★ 10-30 误报事故）
//
// 事故形状（爹地 10-30 截图）：红条「3 格补不进去（表可能被保护/只读）」，而那 3 格其实写进去了。
// 根因是两条路径两把尺：逐格路径 `String(back) === String(text)`，批量路径做日期归一。
// 日期列读回是 Date 对象、数值列读回是 number，裸比较必然不等 → fail → 横幅把人指向「表保护」。
//
// 这里只断言「绝不能让发生的事」，用的全是生产代码（lib/cellwrite.js），不另写一份比较逻辑：
//   ① 同一符号在日期列 / 数值列 / 文本列各写一次 —— 三种都不许判 fail
//   ② 写进去了但形态不同（12.50→12.5、前导零丢失）→ 只能记 format-diff，不许记 fail
//   ③ 真没写进去（赋值静默无效、读回还是旧值）→ 必须判 fail，而且 kind 是 readback（不是「保护」）
//   ④ 四种写法全抛异常 → kind 才是 com（只有这一种才可以说「表可能被保护/只读」）
//   ⑤ 降级链：前一种写法静默没写，必须落到下一种写法上，不许漏写
//
// 跑：node test/cellwrite.test.mjs

import { judgeReadback, cellMatches, writeCellCore, fmtDate } from '../src/lib/cellwrite.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const colLetter = (n) => {
  let s = ''
  let x = Number(n) || 0
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26) }
  return s || 'A'
}
const addr = (r, c) => `${colLetter(c)}${r}`

const toDate = (v) => {
  if (v instanceof Date) return v
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v))
  if (!m) return String(v == null ? '' : v)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * 假表格：按「列型」决定写入后读回长什么样 —— 这才是真机行为
 *   date   : 日期格式的格子，写 '2026-11-03' 读回 Date
 *   number : 数值格式的格子，写 '12.50' 读回 12.5
 *   text   : 原样存
 *   noop   : 赋值静默无效（WPS 个别版本 Cells() 空实现的形状），读回还是旧值
 *   throw  : 一律抛异常（保护/只读的形状）
 */
const mkSheet = (opt = {}) => {
  const kind = opt.kind || 'text'
  const cells = { ...(opt.store || {}) }
  const write = (a1, v) => {
    if (kind === 'throw') throw new Error('Operation not permitted（模拟工作表保护）')
    if (kind === 'noop' || (kind === 'noop-range' && opt._api === 'Range')) return
    if (kind === 'date') { cells[a1] = toDate(v); return }
    if (kind === 'number') { const n = Number(v); cells[a1] = Number.isFinite(n) ? n : String(v == null ? '' : v); return }
    cells[a1] = v === null || v === undefined ? v : String(v)
  }
  const read = (a1) => (a1 in cells ? cells[a1] : undefined)
  const cellObj = (a1, api) => ({
    get Value2() { return read(a1) },
    set Value2(v) { opt._api = api; write(a1, v) },
  })
  const sheet = {
    cells,
    Range: (a1) => cellObj(a1, 'Range'),
    Cells: Object.assign((r, c) => cellObj(addr(r, c), 'Cells'), { Item: (r, c) => cellObj(addr(r, c), 'Item') }),
  }
  return sheet
}

const readOne = (sheet, r, c) => sheet.Range(addr(r, c)).Value2
const write = (sheet, r, c, value) => writeCellCore({ sheet, app: {}, a1: addr(r, c), r, c, value, readOne })

console.log('① 同一符号在三种列型各写一次：都不许判 fail（10-30 误报的正身）')
{
  const SYM = 'SYMBOL-TEST'
  for (const kind of ['date', 'number', 'text']) {
    const sh = mkSheet({ kind })
    const r = write(sh, 12, 11, SYM)          // K12 —— 截图里那条就是 K 列
    ok(r.ok === true, `${kind} 列：同一符号写入后不算失败`, JSON.stringify(r))
    ok(r.ok === true && (r.kind === 'ok' || r.kind === 'format-diff'), `${kind} 列：kind=${r.kind}（不是 com/readback）`)
    ok(String(sh.cells['K12']) !== '' && sh.cells['K12'] !== undefined, `${kind} 列：值真的落进格子了`)
  }
}

console.log('② 日期列 / 数值列的类型差要吞掉（不是 fail，也不该留一堆备注）')
{
  const d = write(mkSheet({ kind: 'date' }), 5, 11, '2026-11-03')
  ok(d.ok === true && d.kind === 'ok', '日期列写 y-m-d、读回 Date → 算写成（ok）', JSON.stringify(d))
  ok(fmtDate(new Date(2026, 10, 3)) === '2026-11-03', '日期口径是本地 y-m-d（不被时区推前一天）')

  const n = write(mkSheet({ kind: 'number' }), 6, 11, '12.5')
  ok(n.ok === true && n.kind === 'ok', '数值列写 12.5、读回 number 12.5 → ok', JSON.stringify(n))

  const n2 = write(mkSheet({ kind: 'number' }), 7, 11, '12.50')
  ok(n2.ok === true, '数值列写 12.50、读回 12.5 → 不算失败', JSON.stringify(n2))
  ok(n2.kind === 'format-diff', '数值列 12.50→12.5 只记 format-diff 备注', `kind=${n2.kind}`)

  const z = write(mkSheet({ kind: 'number' }), 8, 11, '0012')
  ok(z.ok === true && z.kind === 'format-diff', '前导零被表格吃掉（0012→12）→ 不算失败，但留备注', JSON.stringify(z))
}

console.log('③ 真没写进去必须判 fail，而且不能说成「表被保护」')
{
  const sh = mkSheet({ kind: 'noop', store: { K9: '旧值' } })
  const r = write(sh, 9, 11, '新值')
  ok(r.ok === false, '旧值还在 → fail', JSON.stringify(r))
  ok(r.kind === 'readback', 'kind=readback（赋值没生效），不是 com', `kind=${r.kind}`)

  const sh2 = mkSheet({ kind: 'noop' })
  const r2 = write(sh2, 10, 11, '新值')
  ok(r2.ok === false && r2.kind === 'readback', '空格子静默没写 → fail / readback', JSON.stringify(r2))
}

console.log('④ 只有四种写法全抛异常，kind 才是 com')
{
  const r = write(mkSheet({ kind: 'throw' }), 12, 11, 'X')
  ok(r.ok === false, '保护/只读 → fail')
  ok(r.kind === 'com', 'kind=com（这一种才可以说「表可能被保护/只读」）', `kind=${r.kind}`)
}

console.log('⑤ 降级链：第一种写法静默没写，必须落到下一种，不许漏写')
{
  const sh = mkSheet({ kind: 'noop-range' })
  const r = write(sh, 3, 11, 'FALLBACK-TEST')
  ok(r.ok === true, 'Range.Value2 静默无效 → 换 Cells.Item 写进去了', JSON.stringify(r))
  ok(r.via === 'Cells.Item', `落到的写法是 Cells.Item（实际 ${r.via}）`)
}

console.log('⑥ 读回判定本身（批量路径也走这把尺）')
{
  ok(cellMatches(new Date(2026, 10, 3), '2026-11-03') === true, 'Date ⇄ y-m-d 算同一个值')
  ok(cellMatches(12.5, '12.50') === true, '12.5 ⇄ 12.50 算同一个值')
  ok(cellMatches('甲', '甲') === true, '文本相同算同一个值')
  ok(judgeReadback({ back: undefined, want: '甲' }) === 'fail', '读回空 → fail')
  ok(judgeReadback({ prev: '旧值', back: '旧值', want: '新值' }) === 'fail', '读回旧值 → fail')
  ok(judgeReadback({ back: new Date(2026, 10, 3), want: '2026-11-03' }) === 'ok', '批量路径：日期类型差 → ok')
  ok(judgeReadback({ back: '甲\uff08注）', want: '甲' }) === 'format-diff', '非空但不一致 → format-diff（不判 fail）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
