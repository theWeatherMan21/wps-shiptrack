// 运输里程碑判定：把各船司五花八门的事件名归到 4 个阶段
// 依据（2026-10 调研）：
//   · DCSA Transport Event Type Code：ARRI（Arrived）/ DEPA（Departed）
//   · Hapag EDI 315 状态码：C=Loaded on vessel / VD=Departed from POL / VA=Arrived at POD
//     / UV=Discharged / AG=Delivered to empty depot / NF=Empty delivered to customer place
//   · Maersk Track&Trace：activity = Departure From / Arrival At / Empty Returned / Gate In / Gate Out，
//     另有 event_time_type = ACTUAL / EXPECTED
//   · MSC：Export Loaded on Vessel / Import Discharged / Empty Container Return / Empty Received At Cy
// 原则：只认 ACTUAL（ETA/expected 不算），取所有事件里的最高阶段，不做倒退。

import { isPlanned } from './truth.js'

export const STAGE = { NONE: 0, DEPARTED: 1, ARRIVED: 2, EMPTY_RETURNED: 3 }

export const STAGE_LABEL = {
  0: '未离起运港',
  1: '已离开起运港（在途）',
  2: '已抵达目的港',
  3: '已在目的港还空箱',
}

// 浅色填充：数据表里不抢字，但一眼能分
export const STAGE_COLOR = {
  1: 0xcfe3fa, // 蓝 = 在途
  2: 0xd5f0dc, // 绿 = 已到港
  3: 0xe6e6e6, // 灰 = 已还空
}
export const NO_FILL = -4142 // xlNone

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[\s._\-,，。()（）/\\]+/g, '')

/**
 * ETA / 预计 之类的“非实际”事件 —— 不能拿来染色。
 * 2026-10-26 实测踩坑：引擎回的事件字段是 **timeType**（ACTUAL/EXPECTED），
 * 这里原来只看 `kind` → EXPECTED 完全没被过滤，
 * 「Container Arrival GDANSK (EXPECTED)」被当成真到港 → 在途的柜子全刷成绿色。
 */
export function isExpected(e) {
  // 口径统一到 truth.js —— 这里只保留旧名字，避免调用方大改
  return isPlanned(e)
}

const RE_EMPTY = /EMPTY(CONTAINER)?(RETURN|RETURNED|RECEIVED|REDELIVERY|REPOSITION)|DELIVEREDTOEMPTYDEPOT|EMPTYDELIVERED|还空箱|空箱进场|EMPTYRECEIVED|EMPTYIN$|CONTAINERRETURN/
const RE_ARRIVE = /ARRIV|BERTH|DISCHARG|UNLOAD|到港|卸船|IMPORTDISCHARG|IMPORTLOADED/
const RE_DEPART = /DEPART|SAILED|离港|VESSELDEPARTED|EXPORTLOADED|LOADEDONVESSEL|ONBOARD|装船/

export const isEmptyEvent = (e) => RE_EMPTY.test(norm(e && e.activity))
export const isArriveEvent = (e) => RE_ARRIVE.test(norm(e && e.activity))
export const isDepartEvent = (e) => RE_DEPART.test(norm(e && e.activity))

/** 港口/码头别名组：新港=XINGANG 属天津、XIANMEN 是 XIAMEN 的拼写变体… */
const PORT_GROUPS = [
  ['TIANJIN', 'XINGANG', 'TANGGU', '新港', '天津'],
  ['XIAMEN', 'XIANMEN', '厦门'],
  ['SHANGHAI', '上海', '洋山', 'YANGSHAN'],
  ['NINGBO', '宁波', 'BEILUN', '北仑'],
  ['QINGDAO', '青岛', 'QIANWAN', '前湾'],
  ['SHENZHEN', 'YANTIAN', 'SHEKOU', 'CHIWAN', '深圳', '盐田', '蛇口', '赤湾'],
  ['GUANGZHOU', 'NANSHA', '广州', '南沙'],
  ['DALIAN', '大连'],
  ['HONGKONG', 'HONG KONG', '香港'],
  ['BUSAN', 'PUSAN', '釜山'],
  ['SINGAPORE', '新加坡'],
  ['PORTKELANG', 'PORT KLANG', '巴生'],
  ['TANJUNGPELEPAS', '丹绒帕拉帕斯'],
];

const canonPort = (s) => norm(s).replace(/^PORTOF/, '').replace(/CN$|DE$|PL$|NL$|SG$|MY$|HK$|KR$|JP$|US$/, '');

/** 港口比对：别名组、去 PORT OF、去国家码、包含关系都算同一个 */
export function samePlace(a, b) {
  const x = canonPort(a);
  const y = canonPort(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  for (const g of PORT_GROUPS) {
    const gx = g.some((v) => x.includes(norm(v)));
    const gy = g.some((v) => y.includes(norm(v)));
    if (gx && gy) return true;
  }
  return false;
}

const tOf = (e) => String((e && e.time) || '');

/**
 * 判定阶段（港口感知，2026-10-26 重写）
 *
 * 旧实现的两个坑（爹地实测反馈）：
 *   ① 只按事件类型判，`DISCHARG`/`IMPORT` 直接当「已到港」→ 中转港卸船被当成目的港到港（整行刷绿）
 *   ② 港口名硬比对：POL 写 TIANJIN、事件写 XINGANG（新港）→ 比对失败 → 离港永远判定不到（不刷蓝）
 * 新规则：
 *   · 有 POL/POD 时，只有「在 POL 离港」「在 POD 到港」才算数；中转港的离/到只影响时间线，不抬阶段
 *   · 港口名走别名组比对（新港=天津、XIANMEN=XIAMEN…）
 *   · 没有 POL/POD 时退回顺序判断，但要求「到港」必须发生在「离港」之后
 * @param {Array} events [{activity, city, time, kind, timeType}]
 * @param {{pol?:string, pod?:string}} ports
 */
export function stageOf(events, ports = {}) {
  const pol = String(ports.pol || '').trim();
  const pod = String(ports.pod || '').trim();
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && !isExpected(e))
    .filter((e) => tOf(e))
    .slice()
    .sort((a, b) => tOf(a).localeCompare(tOf(b)));

  const hits = [];
  const atPort = (e, port) => (!port ? null : samePlace(e.city, port));
  // 没有表头港口列时的兜底：起运港 = 第一个离港事件的港口
  // 船司返回的事件本身带起讫港 —— 优先用事件里的，表头关键词只作兜底（爹地 2026-10-27 明确）
  const firstDep0 = list.find(isDepartEvent);
  const derivedPol = (firstDep0 && firstDep0.city) || '';
  // 目的港：取「之后没有离港」的到达（中转港卸完还会再走，不算终点）
  let derivedPod = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (isDepartEvent(e)) break;
    if (isArriveEvent(e) && e.city) { derivedPod = e.city; break; }
  }
  let polUsed = derivedPol || pol;
  let podUsed = derivedPod || pod;

  // 离港：有 POL 就只认 POL；没 POL 就认第一个离港事件
  let departEv = null;
  for (const e of list) {
    if (!isDepartEvent(e)) continue;
    const m = atPort(e, pol);
    if (m === false) continue;          // 明确不在 POL → 中转港，跳过
    departEv = e;
    break;
  }
  if (!polUsed && departEv) polUsed = departEv.city || '';

  // 到港：有 POD 就只认 POD（取最早一次到达目的港）；没 POD 就取「离港之后」的最后一次到港
  let arriveEv = null;
  if (pod) {
    arriveEv = list.find((e) => isArriveEvent(e) && samePlace(e.city, pod)) || null;
  } else {
    // 没 POD：从后往前找「之后没有离港」的到港事件 —— 中转港卸船之后还会再离港，不算终点
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e === departEv || !isArriveEvent(e)) continue;
      const laterDepart = list.slice(i + 1).some((x) => isDepartEvent(x));
      if (laterDepart) continue;
      arriveEv = e;
      break;
    }
  }

  // 还空：有 POD 就认 POD 的还空；没 POD 认任何还空，但必须在到港之后
  let emptyEv = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!isEmptyEvent(e)) continue;
    const m = atPort(e, pod);
    if (m === false) continue;
    if (arriveEv && tOf(e) < tOf(arriveEv)) continue;
    emptyEv = e;
    break;
  }

  if (!podUsed && arriveEv) podUsed = arriveEv.city || '';

  let stage = STAGE.NONE;
  if (departEv) { stage = STAGE.DEPARTED; hits.push('离港:' + (departEv.city || '') + '@' + tOf(departEv).slice(0, 10)); }
  if (arriveEv) { stage = STAGE.ARRIVED; hits.push('到港:' + (arriveEv.city || '') + '@' + tOf(arriveEv).slice(0, 10)); }
  if (emptyEv) { stage = STAGE.EMPTY_RETURNED; hits.push('还空:' + (emptyEv.city || '') + '@' + tOf(emptyEv).slice(0, 10)); }

  return {
    stage, label: STAGE_LABEL[stage], color: STAGE_COLOR[stage] || NO_FILL, hits,
    pol: polUsed, pod: podUsed, inferred: !pol || !pod,
  };
}
