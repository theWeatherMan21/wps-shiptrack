// 给还没夹具的船司各试几个号（按各家号码格式生成，ISO 6346 校验位），抓到就存夹具
import fs from 'node:fs'

// 各家号码形态（来自引擎里的校验报错）：
//   akkon     = AKKU + 10 位（共 14）
//   evergreen = EGLV + 12 位（共 16）
//   one       = ONEY + 10 位（BL/booking）
//   cma/cosco/zim/hmm/yangming = 箱号形态（4 字母 + 7 位 + 校验位）
const SPEC = {
  cma: { type: 'iso', prefixes: ['CMAU', 'ECMU'] },
  one: { type: 'digits', prefixes: ['ONEY'], digits: 10 },
  cosco: { type: 'iso', prefixes: ['CSNU', 'COSU'] },
  evergreen: { type: 'digits', prefixes: ['EGLV'], digits: 12 },
  zim: { type: 'iso', prefixes: ['ZIMU'] },
  hmm: { type: 'iso', prefixes: ['HMMU', 'HASU'] },
  akkon: { type: 'digits', prefixes: ['AKKU'], digits: 10 },
  yangming: { type: 'iso', prefixes: ['YMLU'] },
}

const LV = { A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20, K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31, U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38 }

function iso6346(prefix) {
  const body = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join('')
  const s = prefix + body
  let sum = 0
  for (let i = 0; i < 10; i++) {
    const c = s[i]
    const v = /[0-9]/.test(c) ? Number(c) : LV[c]
    sum += v * Math.pow(2, i)
  }
  return prefix + body + ((sum % 11) % 10)
}

const rand = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')
const gen = (spec, i) => {
  const pre = spec.prefixes[i % spec.prefixes.length]
  return spec.type === 'iso' ? iso6346(pre) : pre + rand(spec.digits)
}

for (const c of Object.keys(SPEC)) {
  const file = `test/fixtures/${c}.json`
  if (fs.existsSync(file)) { console.log(`${c}: exists, skip`); continue }
  let best = null
  for (let i = 0; i < 3; i++) {
    const num = gen(SPEC[c], i)
    try {
      const r = await (await fetch(`http://127.0.0.1:8791/track?number=${num}&carrier=${c}&timeout=90000`)).json()
      const n = (r.events || []).length
      console.log(`  ${c} ${num} -> ok=${r.ok} events=${n} ${String(r.error || '').slice(0, 60)}`)
      if (!best || n > (best.events || []).length) best = { ...r, _num: num }
      if (n > 0) break
    } catch (e) {
      console.log(`  ${c} ${num} -> request failed ${e.message}`)
    }
  }
  if (best) {
    const out = {
      carrier: c, origin: best.origin, destination: best.destination, ok: best.ok,
      events: best.events || [], error: best.error || null,
      capturedAt: new Date().toISOString().slice(0, 10),
    }
    fs.writeFileSync(file, JSON.stringify(out, null, 2))
    console.log(`${c}: wrote ${file} events=${out.events.length} ok=${out.ok}`)
  }
}
console.log('done')
