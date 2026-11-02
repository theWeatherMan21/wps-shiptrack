// 183 单台账回归 + 契约降级演练（卡 t_8a6689dc 的 DoD）
// 跑法：node test/ledger-regress.mjs [台账目录]
//   默认读 ~/.hermes/wps-shiptrack/jobs（可用 WPS_JOBS_DIR 覆盖）
//
// 为什么这么测：台账里的每一行都是引擎真跑出来的结果（10-29 那批 183 单）。
// 把它按引擎的口径还原成结果对象，再喂给**插件现在用的那一份渲染代码**（src/lib/render.js），
// 逐条核对「这一格显示的日期/事件/港口是不是这条记录自己的」——
// 字段一旦错位（比如 current 读到 err、events 顺序变了），这里立刻红。
// 反例对照（negative control）也跑一遍：故意把字段错位，断言测试能抓到 —— 不然「全绿」毫无意义。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { checkResultSchema, MSG_PLUGIN_OLD } from '../src/lib/contract.js'
import { renderLatest } from '../src/lib/render.js'
import { zhEvent, cleanCity } from '../src/lib/events.js'

let bad = 0
const check = (name, cond, detail = '') => {
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ← ' + detail}`)
}

const DIR = process.argv[2] || process.env.WPS_JOBS_DIR || path.join(os.homedir(), '.hermes', 'wps-shiptrack', 'jobs')

/** 台账行（压过的）→ 结果对象（引擎 normalizeTracking 的形状） */
export function toResult(rec) {
  const ev = (rec.events || []).map((e) => ({
    time: e.t, activity: e.a, city: e.c, vessel: e.v, voyage: e.y,
    // x=1 才是「预计」；0/缺省按已发生（与写入台账时的口径一致）
    ...(e.x ? { timeType: 'EXPECTED' } : { timeType: 'ACTUAL' }),
    ...(e.m ? { manual: true } : {}),
    ...(e.k ? { container: e.k } : {}),
  }))
  return {
    ok: !!rec.ok,
    // 老记录没有 sv（=契约版本未发布时写的），桥也没上报 → 走 legacy 兼容
    ...(rec.sv ? { schemaVersion: rec.sv } : {}),
    carrier: rec.c || '', number: rec.n || '',
    error: rec.err || '', errorKind: rec.kind || '',
    phase: rec.phase || '',
    current: rec.cur ? { time: rec.curt, activity: rec.cur, city: rec.curc } : null,
    eta: rec.etat ? { time: rec.etat, city: rec.etac } : null,
    events: ev,
    manualUrl: rec.url || '',
  }
}

const REQUIRED = process.argv.includes('--require')
const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => /^jobs-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort()
  : []
if (!files.length) {
  // 换机器（比如 Windows 那台）时这里没有台账 —— 不是失败，是没样本；要强制就跑 --require
  console.log(`${REQUIRED ? 'FAIL' : 'SKIP'}  台账目录里没有 jobs-*.ndjson：${DIR}`)
  process.exit(REQUIRED ? 1 : 0)
}

let total = 0
let okRows = 0
let failRows = 0
let rendered = 0
const perFile = []

for (const f of files) {
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean)
  let rows = 0, ok = 0
  for (const line of raw) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }   // 半行（并发写）跳过，和 App 侧同口径
    rows++
    const r = toResult(rec)
    const gate = checkResultSchema(r, null)            // 这批数据出自「没有契约版本」的老桥
    const text = renderLatest(r, { carrierLabel: (c) => c })

    // ① 闸门：老桥 + 老数据必须放行（legacy），不许因为加了版本号就把历史数据判死
    if (!gate.ok) {
      check(`${f} ${rec.n} 老数据应兼容放行`, false, `${gate.code} ${gate.short}`)
      continue
    }
    if (rec.ok && r.current) {
      ok++;
      okRows++;
      // ② 这一格必须是**这条记录自己**的日期/事件/港口 —— 字段错位就从这里爆出来
      const wantDate = String(rec.curt || '').slice(0, 10)
      if (wantDate && !text.startsWith(wantDate)) {
        check(`${f} ${rec.n} 日期取自本行`, false, `期望以 ${wantDate} 开头，实得「${text}」`)
        continue
      }
      const wantEv = zhEvent(rec.cur)
      if (wantEv && !text.includes(wantEv)) {
        check(`${f} ${rec.n} 事件取自本行`, false, `期望含「${wantEv}」，实得「${text}」`)
        continue
      }
      const wantCity = cleanCity(rec.curc)
      if (wantCity && !text.includes(wantCity)) {
        check(`${f} ${rec.n} 港口取自本行`, false, `期望含「${wantCity}」，实得「${text}」`)
        continue
      }
    } else {
      failRows++
      // ③ 失败行不许长成「日期 · 事件 · 港口」的样子（那说明读到了别处的字段）
      if (/^\d{4}-\d{2}-\d{2} · /.test(text)) {
        check(`${f} ${rec.n} 失败行不许伪装成事件行`, false, `实得「${text}」`)
        continue
      }
      if (!text.trim()) {
        check(`${f} ${rec.n} 失败行有结论文案`, false, '空文案')
        continue
      }
    }
    rendered++
  }
  total += rows
  perFile.push(`${f}: ${rows} 行（成功 ${ok}）`)
}

check('台账记录全部渲染（不丢行）', rendered === total, `渲染 ${rendered} / 共 ${total}`)
check('回归样本 ≥ 183 单', total >= 183, `实得 ${total}`)
check('样本含成功单（有事件可核对）', okRows > 0, `成功行 ${okRows}`)
check('样本含失败单（有结论可核对）', failRows > 0, `失败行 ${failRows}`)

// ── ④ 反例对照：故意把 current 换成 error 文案（模拟「字段含义变了」）─────────
{
  const sample = JSON.parse(fs.readFileSync(path.join(DIR, files[0]), 'utf8').split('\n').filter(Boolean)
    .find((l) => { try { return JSON.parse(l).ok && JSON.parse(l).cur; } catch { return false } }) || '{}')
  if (!sample.n) {
    check('反例对照（找不到成功样本）', false, 'first file 里没有 ok+cur 的记录')
  } else {
    const broken = toResult(sample)
    broken.current = { time: '1999-01-01', activity: 'DRIFTED-FIELD', city: '' }   // ← 模拟错位
    const text = renderLatest(broken, { carrierLabel: (c) => c })
    const wouldPass = text.startsWith(String(sample.curt).slice(0, 10)) && text.includes(zhEvent(sample.cur))
    check('反例对照：字段错位能被断言抓到', wouldPass === false, `错位后仍「通过」：「${text}」`)
  }
}

// ── ⑤ 桩数据演练（DoD 第一条）：版本号跑到不支持区间 → 只出单号 + 一句话，不猜字段 ──
{
  const stub = { ok: true, schemaVersion: 99, carrier: 'msc', number: 'TSTU0000070', origin: 'NINGBO', destination: 'GDANSK',
    events: [{ time: '2026-11-01T10:00', activity: 'Arrival', city: 'GDANSK' }],
    current: { time: '2026-11-01T10:00', activity: 'Arrival', city: 'GDANSK' } }
  const gate = checkResultSchema(stub, 99)
  check('桩 1：v99 结果 → 拦住', gate.ok === false && gate.code === 'plugin-old', JSON.stringify(gate))
  // 插件在拦住时写的文案（与 TaskPane.queryAndWrite 里那一行完全一致）
  const cell = `${stub.number} · ${gate.short}`
  check('桩 1：单元格 = 单号 + 更新提示', cell === 'TSTU0000070 · ' + MSG_PLUGIN_OLD, cell)
  check('桩 1：不出现任何业务字段', !/NINGBO|GDANSK|Arrival|2026-11/.test(cell), cell)
  check('桩 1：横幅文案带双方版本', /v99/.test(gate.detail) && /v1/.test(gate.detail), gate.detail)

  // 桩 2：正常版本 → 无横幅、渲染与现状一致
  const good = { ...stub, schemaVersion: 1 }
  const gate2 = checkResultSchema(good, 1)
  check('桩 2：v1 结果 → 放行（不挂横幅）', gate2.ok === true && gate2.code === 'ok', JSON.stringify(gate2))
  const text2 = renderLatest(good, { carrierLabel: (c) => c })
  check('桩 2：正常渲染出事件行', text2 === '2026-11-01 · 到港 · GDANSK', text2)

  // 桩 3：桥主动降级（旧插件被桥拒绝）
  const refused = { ok: false, schemaUnsupported: true, schemaVersion: 1, number: 'TSTU0000070', error: '插件版本旧，请更新加载项（桥契约 v1）' }
  const gate3 = checkResultSchema(refused, 1)
  check('桩 3：桥降级桩 → 拦住且话术统一', gate3.ok === false && gate3.code === 'bridge-refused' && gate3.short === MSG_PLUGIN_OLD, JSON.stringify(gate3))
}

console.log('\n台账：' + perFile.join(' | '))
console.log(`合计 ${total} 行（成功 ${okRows} / 失败 ${failRows} / 渲染 ${rendered}）`)
console.log(bad === 0 ? 'ALL PASS' : `${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
