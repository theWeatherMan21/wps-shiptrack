// 从船司返回的事件里取「真实 ETD / ETA」
// 规则：实际发生的优先；没有实际发生的，用计划时间（表格里本来就是计划船期）
import { isPlanned } from './truth.js'

const DAY = (t) => String(t || '').slice(0, 10)
const isDep = (e) => /DEPART|DEPARTURE|SAIL|开航|离港/i.test(String((e && e.activity) || ''))
const isArr = (e) => /ARRIV|ARRIVAL|DISCHARG|到港|卸船/i.test(String((e && e.activity) || ''))
const city = (e) => String((e && e.city) || '').trim().toUpperCase()
const same = (a, b) => !!a && !!b && (a.includes(b) || b.includes(a))

/**
 * @param {Array} events 船司事件
 * @param {{pod?:string}} opt 目的港（用于挑「到目的港」的那次到达）
 * @returns {{etd:string, eta:string, etdPlanned:boolean, etaPlanned:boolean}}
 */
export function pickEtdEta(events, opt = {}) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && e.time)
  const byTime = list.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)))

  // ETD：最早一次离港；有实际发生的就用实际的
  const deps = byTime.filter(isDep)
  const depActual = deps.find((e) => !isPlanned(e))
  const depAny = depActual || deps[0]

  // ETA：目的港的到达（有 pod 只认 pod）；没有 pod 就取最后一次到达
  const pod = String(opt.pod || '').trim().toUpperCase()
  let arrs = byTime.filter(isArr)
  if (pod) {
    const atPod = arrs.filter((e) => same(city(e), pod))
    if (atPod.length) arrs = atPod
  }
  const arrActual = arrs.find((e) => !isPlanned(e))
  const arrAny = arrActual || arrs[arrs.length - 1]

  return {
    etd: depAny ? DAY(depAny.time) : '',
    eta: arrAny ? DAY(arrAny.time) : '',
    etdPlanned: depAny ? isPlanned(depAny) : false,
    etaPlanned: arrAny ? isPlanned(arrAny) : false,
  }
}
