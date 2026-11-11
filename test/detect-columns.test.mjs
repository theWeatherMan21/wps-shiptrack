// test/detect-columns.test.mjs —— Excel 行列自动识别的夹具矩阵 + 置信分档不变量（★ 2026-11-11）
//
// 为什么这样测：识别是「猜」，猜错就会把结果写进错的列（写错了还会被下一轮读回去，
// 错会自我繁殖）。所以锁死的不是「某一格的值」，而是这几条：
//   ① 7 类格式各有夹具（test/fixtures/detect/），识别结果 === 夹具里写明的期望
//   ② 识别出的列 === 实际写入的列（用 writeplan 的纯函数交叉验证，不许「认 B 写 C」）
//   ③ 置信分档边界：>=0.8 auto / 0.4–0.8 preview / <0.4 manual
//   ④ 表头与内容冲突 → 以内容为准，并留可见痕迹（fixes 非空）
//   ⑤ 每次识别的变化检测：列变了才提示，行数变多不算
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  detectColumns, confidenceTier, detectSignature, diffDetection,
  classifyHeader, looksLikeNumber, looksLikeVessel, looksLikeVesselVoyage, looksLikeDate, colLetter,
} from '../bridge/detect-columns.mjs'
import { planVesselVoyage } from '../src/lib/writeplan.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX_DIR = path.join(HERE, 'fixtures', 'detect')
const REPO = process.env.SSH_REPO || path.resolve(os.homedir(), 'dev', 'ShipScheduleHub')

let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`PASS ${label}${extra ? ' · ' + extra : ''}`)
  else { fail++; console.log(`FAIL ${label}${extra ? ' · ' + extra : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 内容校验用的识别器（真实引擎，走 identify.mjs 单一事实来源）；拿不到就退化成纯形态
let idmod = null
try { idmod = await import(pathToFileURL(path.join(REPO, 'engine/tracking/detect.mjs')).href) }
catch (e) { console.log(`SKIP 识别器不可用（${e.message}）—— 内容校验退回纯形态`) }
try {
  const id = await import(pathToFileURL(path.join(REPO, 'engine/tracking/identify.mjs')).href)
  idmod = { ...(idmod || {}), containerCheck: id.containerCheck }
} catch (e) { /* 有 detect 就够了 */ }

const run = (fx) => detectColumns({ rows: fx.rows, sheet: fx.sheet, identify: idmod })

// ── ① 夹具矩阵：逐条比对期望 ────────────────────────────────────────────────
const files = fs.readdirSync(FIX_DIR).filter((f) => f.endsWith('.json')).sort()
ok(files.length >= 12, '夹具数量 ≥ 12（7 类格式各有覆盖）', `files=${files.length}`)
for (const f of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, f), 'utf8'))
  const r = run(fx)
  const ex = fx.expect || {}
  const bad = []
  for (const [k, v] of Object.entries(ex)) {
    if (k === 'fixHas') {
      if (!(r.fixes || []).some((s) => String(s).includes(v))) bad.push(`fixes 里应有「${v}」，实际 ${JSON.stringify(r.fixes)}`)
      continue
    }
    if (String(r[k]) !== String(v)) bad.push(`${k} 期望 ${v} 实际 ${r[k]}`)
  }
  ok(bad.length === 0, `夹具 ${f}`, bad.length ? bad.join('；') : `col=${colLetter(r.numberCol)} out=${colLetter(r.outCol)} conf=${r.confidence} tier=${r.tier}`)
  // 每条夹具都必须给出人看得懂的理由
  ok(!!r.reason && r.reason.length > 4, `夹具 ${f} 有 reason`, r.reason)
}

// ── ② 识别出的列 === 实际写入的列（交叉验证 writeplan）─────────────────────
{
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, '01-header-zh-single-vv.json'), 'utf8'))
  const r = run(fx)
  const targets = planVesselVoyage({
    vesselCol: r.vesselCol, voyageCol: r.voyageCol, outCol: r.outCol, numCol: r.numberCol,
    vessel: 'MSC LONSON', voyage: 'GA645W',
  })
  ok(r.vesselMode === 'single', '船名航次同格 → vesselMode=single')
  ok(targets.length === 1 && targets[0].col === r.vesselCol, '同格只写船名列那一格', JSON.stringify(targets))
  ok(targets.every((t) => t.col !== r.outCol && t.col !== r.numberCol), '船名不会写进输出列/单号列')
}
{
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, '02-header-en-split-vv.json'), 'utf8'))
  const r = run(fx)
  const targets = planVesselVoyage({
    vesselCol: r.vesselCol, voyageCol: r.voyageCol, outCol: r.outCol, numCol: r.numberCol,
    vessel: 'MSC LONSON', voyage: 'GA645W',
  })
  ok(r.vesselMode === 'split', '船名/航次两列 → vesselMode=split')
  ok(eq(targets.map((t) => t.col), [r.vesselCol, r.voyageCol]), '分列时船名/航次各写一格（就是识别出的那两列）', JSON.stringify(targets))
}

// ── ③ 置信分档边界 ────────────────────────────────────────────────────────
ok(confidenceTier(1) === 'auto', '置信 1.0 → 直接写')
ok(confidenceTier(0.8) === 'auto', '置信 0.80（边界）→ 直接写')
ok(confidenceTier(0.79) === 'preview', '置信 0.79 → 首次预览')
ok(confidenceTier(0.4) === 'preview', '置信 0.40（边界）→ 首次预览')
ok(confidenceTier(0.39) === 'manual', '置信 0.39 → 人指定')
ok(confidenceTier(0) === 'manual', '置信 0 → 人指定')

// 高置信的前提是「表头命中 + 内容校验过」，只有表头好看不够
{
  const rows = [['提单号', '客户名称']]
  for (let i = 0; i < 6; i++) rows.push(['COTTON T-SHIRT', 'ABC'])
  const r = detectColumns({ rows, identify: idmod })
  ok(r.numberCol === 0 || r.tier !== 'auto', '表头写提单号但内容不像单号 → 不给 auto 档', `col=${r.numberCol} conf=${r.confidence}`)
}

// ── ④ 表头与内容冲突：以内容为准 + 留痕 ────────────────────────────────────
{
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, '09-header-content-conflict.json'), 'utf8'))
  const r = run(fx)
  ok(r.numberBy === 'content-wins', '表头与内容冲突 → numberBy=content-wins', r.numberBy)
  ok((r.fixes || []).some((s) => s.includes('按内容判为')), '冲突留了一行可见痕迹（fixes）', JSON.stringify(r.fixes))
  ok(r.tier === 'preview', '冲突（0.72）→ 首次预览确认，不静默写', `conf=${r.confidence}`)
}

// ── ⑤ 每次识别的变化检测 ──────────────────────────────────────────────────
{
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, '01-header-zh-single-vv.json'), 'utf8'))
  const a = run(fx)
  const same = diffDetection({ ...a }, { ...a, sampleRows: 28 })   // 只多了几行数据
  ok(same.changed === false, '行数变多不算格式变化（不打扰）', JSON.stringify(same.changes))

  const moved = diffDetection({ ...a }, { ...a, numberCol: 4 })
  ok(moved.changed === true, '单号列 B→D 要报变化')
  ok(moved.text.includes('单号列') && moved.text.includes('B') && moved.text.includes('D'), '变化文案写清 B→D', moved.text)

  const outMoved = diffDetection({ ...a }, { ...a, outCol: 17 })
  ok(outMoved.changed === true && outMoved.text.includes('输出列'), '输出列变了也报', outMoved.text)

  const modeChanged = diffDetection({ ...a }, { ...a, vesselMode: 'split' })
  ok(modeChanged.changed === true && modeChanged.text.includes('船名格式'), '船名格式变了也报', modeChanged.text)

  ok(diffDetection(null, a).changed === false, '没有确认过的配置 → 不报变化（交给置信分层）')
}

// ── ⑥ 签名稳定：同表同列 → 同签名；行数不进签名 ────────────────────────────
{
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, '01-header-zh-single-vv.json'), 'utf8'))
  const a = run(fx)
  const b = run({ ...fx, rows: fx.rows.concat([['9', 'MAEU9999999', 'MAERSK', 'X', 'Y', 'MSC LONSON GA645W', 'Z', '40HQ', '1', '1']]) })
  ok(detectSignature(a) === detectSignature(b), '样本行数变了，签名不变', detectSignature(a))
  ok(detectSignature(a) !== detectSignature({ ...a, numberCol: 3 }), '列变了，签名变')
}

// ── ⑦ 表头模糊匹配（中/英/全角/括号/斜杠）─────────────────────────────────
const H = (t) => classifyHeader(t).kind
ok(H('提单号') === 'number' && H('提单') === 'number' && H('MBL No') === 'number' && H('B/L') === 'number', '单号：中文/英文/缩写都认')
ok(H('ＢＬ ＮＯ') === 'number', '全角 ＢＬ ＮＯ 认得出')
ok(H('船名航次') === 'vessel' && H('VESSEL/VOYAGE') === 'vessel', '船名：中英混排认得出')
ok(H('Carrier (Shipping Line)') === 'carrier', '船司：括号写法认得出')
ok(H('起运港(POL)') === 'pol' && H('目的港 / POD') === 'pod', '港口：中英并列认得出')
ok(H('ETD 预计离港') === 'date', '日期：中英并列认得出')
ok(H('客户名称') === 'never' && H('金额') === 'never' && H('备注') === 'never', '客户/金额/备注 → 绝不写')
ok(H('随便什么') === null, '无关表头 → 不认')

// ── ⑧ 内容形态判定 ────────────────────────────────────────────────────────
ok(looksLikeNumber('800000001'), '9 位纯数字 = 单号')
ok(looksLikeNumber('TSTU0000001'), '4 字母 + 7 数字 = 箱号形态')
ok(looksLikeNumber('TESTKAC0123456'), '货代工作号形态')
ok(!looksLikeNumber('SHANGHAI'), '港口名不是单号')
ok(looksLikeVessel('MSC LONSON'), '船名形态')
ok(!looksLikeVessel('GA645W'), '航次不是船名（含数字）')
ok(looksLikeVesselVoyage('MSC LONSON GA645W'), '船名+航次合体形态')
ok(!looksLikeVesselVoyage('MSC LONSON'), '纯船名不算合体')
ok(looksLikeDate('2026-11-13') && looksLikeDate('2026/11/13') && looksLikeDate('2026.11.13') && looksLikeDate('46303'), '日期：三种文本 + Excel 序列号')
ok(!looksLikeDate('TESTMAE0123457'), '单号不是日期')

// ── ⑨ 列字母换算（面板/日志文案靠它）──────────────────────────────────────
ok(colLetter(1) === 'A' && colLetter(26) === 'Z' && colLetter(27) === 'AA' && colLetter(52) === 'AZ', '列号 1-based → A/Z/AA/AZ')

// ── ⑩ 空样本 / 脏样本不许崩 ───────────────────────────────────────────────
{
  const e1 = detectColumns({})
  ok(e1.ok === false && e1.tier === 'manual', '空样本 → ok:false + manual，不崩')
  const e2 = detectColumns({ rows: [[], []] })
  ok(e2.ok === false, '只有空行 → ok:false')
  const e3 = detectColumns({ rows: [['提单号', '客户名称', null, 12345], ['TESTMAE0123457', 'ABC', undefined, '']], identify: idmod })
  ok(e3.ok === true && e3.numberCol === 1, 'null/undefined/数字混在样本里也不崩', `col=${e3.numberCol}`)
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
