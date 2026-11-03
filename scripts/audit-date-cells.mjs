#!/usr/bin/env node
// 体检：把 xlsx 里「日期格式但值带时分」的格子全找出来（★ 11-03 写错数据事故的复查工具）
//
// 事故：写日期时把 JS Date 交给 COM，WPS 按 UTC 折序列号 → 46302.6666666667
// （= 前一天 16:00。UTC+8 下的本地 2026-10-08 00:00 被当成 UTC 瞬时存了），整列偏一天。
//
// 判据（两条同时成立才算脏，误报率为 0）：
//   ① 格子里的值是 20000–80000 的**带小数**序列号
//   ② 这格的数字格式是**纯日期**（有 y/m/d、没有 h/s/AM-PM）
// 只看①会把正常的时间列（12:30 = .5208333）全报成脏，所以必须连格式一起看。
//
// 用法：node scripts/audit-date-cells.mjs <文件.xlsx> [更多 ...]
// 退出码：0 = 干净；1 = 发现脏值（可接门禁）
// 只读文件、不改宿主、无第三方依赖（系统 unzip）。

import { execFileSync } from 'node:child_process'

const SERIAL_MIN = 20000
const SERIAL_MAX = 80000
const EPOCH_UTC = Date.UTC(1899, 11, 30)
const pad2 = (n) => String(n).padStart(2, '0')

/** 序列号 → 'YYYY-MM-DD HH:MM'（Excel 口径：小数部分 = 一天里的时间） */
export function serialToStamp(n) {
  const t = new Date(EPOCH_UTC + Math.round(Number(n) * 86400000))
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ` +
    `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`
}

/** 带时分的日期序列号（= 脏）？ */
export function isDirtySerial(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return false
  if (n < SERIAL_MIN || n > SERIAL_MAX) return false
  return !Number.isInteger(n)
}

// 内置日期/时间格式 id（ECMA-376）
const BUILTIN = {
  14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
}

/** 纯日期格式？（有年月日、没有时分秒；引号里的字面量不算） */
export function isDateOnlyFormat(code) {
  const s = String(code || '').replace(/"[^"]*"/g, '')
  if (!s) return false
  if (/[hHsS]|AM\/PM|am\/pm/.test(s)) return false
  return /[yYmMdD]/.test(s)
}

const unzipList = (f) => execFileSync('unzip', ['-Z1', f], { encoding: 'utf8' }).split('\n').filter(Boolean)
const unzipRead = (f, e) => execFileSync('unzip', ['-p', f, e], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

const sheetNames = (xml) => [...xml.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => m[1])

/** 样式索引 → 数字格式串（格子上的 s="N" 就是 cellXfs 里的下标） */
export function styleFormats(stylesXml) {
  const custom = new Map()
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    custom.set(Number(m[1]), m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)
  if (!xfs) return []
  return [...xfs[1].matchAll(/<xf[^>]*numFmtId="(\d+)"/g)].map((m) => {
    const id = Number(m[1])
    return custom.has(id) ? custom.get(id) : (BUILTIN[id] || '')
  })
}

function numericCells(xml) {
  const out = []
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/g)) {
    const [, ref, attrs, inner] = m
    if (/\bt="(s|str|inlineStr|b|e)"/.test(attrs)) continue
    const v = /<v>([^<]*)<\/v>/.exec(inner)
    if (!v) continue
    const s = /\bs="(\d+)"/.exec(attrs)
    out.push({ ref, raw: v[1], style: s ? Number(s[1]) : 0 })
  }
  return out
}

export function auditFile(file) {
  const entries = unzipList(file)
  if (!entries.includes('xl/workbook.xml')) return null
  const names = sheetNames(unzipRead(file, 'xl/workbook.xml'))
  const fmts = entries.includes('xl/styles.xml') ? styleFormats(unzipRead(file, 'xl/styles.xml')) : []
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))
  const hits = []
  sheets.forEach((entry, i) => {
    const sheet = names[i] || entry
    for (const c of numericCells(unzipRead(file, entry))) {
      if (!isDirtySerial(c.raw)) continue
      const fmt = fmts[c.style] || ''
      if (!isDateOnlyFormat(fmt)) continue
      hits.push({ sheet, ref: c.ref, serial: c.raw, fmt, shown: serialToStamp(c.raw) })
    }
  })
  return hits
}

const files = process.argv.slice(2)
if (!files.length) {
  console.log('用法: node scripts/audit-date-cells.mjs <文件.xlsx> [...]')
  process.exit(2)
}
let total = 0
for (const f of files) {
  console.log(`\n== ${f}`)
  let hits
  try { hits = auditFile(f) } catch (e) { console.log(`  ❌ 读不了：${e.message}`); continue }
  if (hits === null) { console.log('  （不是 xlsx，跳过）'); continue }
  if (!hits.length) { console.log('  ✓ 干净：没有「日期格式 + 带时分」的格子'); continue }
  console.log(`  ⚠️  发现 ${hits.length} 格：日期格式却是带时分的序列号（实际日期比该写的早一天）：`)
  for (const h of hits) console.log(`    ${h.sheet}!${h.ref} = ${h.serial}（显示 ${h.shown}，格式 ${h.fmt}）`)
  total += hits.length
}
console.log(`\n合计 ${total} 格`)
process.exit(total ? 1 : 0)
