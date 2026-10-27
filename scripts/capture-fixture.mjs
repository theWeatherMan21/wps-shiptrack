// 抓一次真实查询结果存成夹具（自动脱敏：单号/箱号/船名里的编号一律打码）
// 用法：node scripts/capture-fixture.mjs <carrier> <number>
import fs from 'node:fs'
const [carrier, number] = process.argv.slice(2)
if (!carrier || !number) { console.error('用法: node scripts/capture-fixture.mjs <carrier> <number>'); process.exit(2) }

const url = `http://127.0.0.1:8791/track?number=${encodeURIComponent(number)}&carrier=${encodeURIComponent(carrier)}&timeout=120000`
const r = await (await fetch(url)).json()

// 网络类失败不许当夹具存下来 —— 否则「连不上」会被固化成「查不到」的契约
const NET = /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|超时|timeout/i
if (!r.ok && NET.test(String(r.error || ''))) {
  console.error(`拒绝保存：这是网络失败（${String(r.error).slice(0, 60)}），不是「查无此单」。等网络恢复再抓。`)
  process.exit(3)
}

const scrub = (v) => {
  if (typeof v === 'string') {
    return v
      // 集装箱号 / 提单号 / 订舱号 一律打码（保留形态）
      .replace(/\b([A-Z]{4})(\d{7})\b/g, (_, a) => a + '#######')
      .replace(/\b(\d{9,12})\b/g, (m) => '#'.repeat(m.length))
      .replace(/\b([A-Z]{3})U(\d{7})\b/g, '$1U#######')
  }
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === 'raw' || k === 'steps' || k === 'html') continue   // 原始体太大且含业务数据
      o[k] = scrub(x)
    }
    return o
  }
  return v
}

const slim = {
  carrier, origin: r.origin, destination: r.destination, ok: r.ok,
  events: r.events || [], containers: r.containers || null,
  error: r.error || null, capturedAt: new Date().toISOString().slice(0, 10),
}
const out = scrub(slim)
const file = `test/fixtures/${carrier}.json`
fs.writeFileSync(file, JSON.stringify(out, null, 2))
console.log(`${file}  ok=${out.ok} events=${out.events.length} origin=${out.origin} dest=${out.destination}`)
