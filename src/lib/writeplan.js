// 写回「写哪些格、写什么值」的唯一口径（★ 2026-11-10）
//
// 为什么要单独一个模块：这两条都属于「同一格被写了两遍 / 写了不该写的格」的数据损坏，
// 而它们藏在组件里就没法单测 —— 爹地撞到的是表格里只剩航次、以及合并格报「读回不一致」。
//
// 铁律：
//   1. **船名列 = 航次列时只写一次**，值一律是「船名 空格 航次」；不去读原格猜它是船名还是航次
//      （原格可能已经被旧的 bug 写坏，按它猜会把错误固化）。
//   2. **合并单元格只有左上角能写**：非左上角一律跳过，并把「与 K12 合并」说出来 ——
//      不许写成「读回不一致」（那是把不可写说成写失败，方向全错）。
//   3. 撞结果列 / 单号列一律不写（别把业务结论覆盖掉）。

import { judgeReadback } from './cellwrite.js'
const letter = (n) => {
  let c = ''
  let x = Number(n || 0)
  while (x > 0) {
    const m = (x - 1) % 26
    c = String.fromCharCode(65 + m) + c
    x = Math.floor((x - 1) / 26)
  }
  return c
}

/**
 * 船名 / 航次要写哪些格、每格写什么。返回 [{ col, text }]。
 * 同列 → 只有一条，text = "船名 航次"；分列 → 最多两条；撞结果列/单号列 → 该格不出现。
 * 两个都没查到 → 返回空数组（一格都不动，别把原值清空）。
 */
export function planVesselVoyage({ vesselCol, voyageCol, outCol, numCol, vessel, voyage }) {
  const vCol = Number(vesselCol || 0)
  const yCol = Number(voyageCol || 0)
  const oCol = Number(outCol || 0)
  const nCol = Number(numCol || 0)
  const blocked = (c) => !!c && (c === oCol || c === nCol)
  const v = String(vessel == null ? '' : vessel).trim()
  const y = String(voyage == null ? '' : voyage).trim()
  if (!v && !y) return []
  if (vCol && vCol === yCol) {
    if (blocked(vCol)) return []
    return [{ col: vCol, text: [v, y].filter(Boolean).join(' ') }]
  }
  // ★ 11-12：没有独立航次列，但引擎查到了航次 —— 拼到船名后面，不许静默丢掉。
  //   爹地撞到的就是这个：识别给了 vesselMode='split'（分两列）却 voyageCol=0，
  //   引擎明明返回了 GA645W，写入端只写船名，11 行 P 列全剩船名。
  if (!yCol && y && vCol && !blocked(vCol)) {
    return [{ col: vCol, text: [v, y].filter(Boolean).join(' ') }]
  }
  const out = []
  if (vCol && v && !blocked(vCol)) out.push({ col: vCol, text: v })
  if (yCol && y && !blocked(yCol)) out.push({ col: yCol, text: y })
  return out
}

/**
 * 合并单元格判定。area = 从 WPS 读出来的 { mergeCells, topRow, topCol, address }（读不到就传 null）。
 * 返回 null = 可写（不是合并格，或正好是左上角）；
 * 返回 { addr, topRow, topCol } = 不可写（非左上角），addr 形如 "K12:K13"。
 */
export function mergeBlockOf(area, row, col) {
  if (!area || !isVbaTrue(area.mergeCells)) return null
  const topRow = Number(area.topRow || 0)
  const topCol = Number(area.topCol || 0)
  if (!topRow || !topCol) return null
  if (topRow === Number(row) && topCol === Number(col)) return null   // 左上角 = 可写
  const addr = String(area.address || '').replace(/\$/g, '') || `${letter(topCol)}${topRow}`
  return { addr, topRow, topCol }
}

/**
 * WPS/COM 的「布尔」不是 JS 布尔：真返回 **-1**，假返回 **0**。
 * 直接写 `x === true` 恒为 false —— 合并单元格检测就是这么静默失效的
 * （代码看着判了，实际一次都没进分支，K13 照写 → 读回空 → 报「赋值没生效」）。
 * 兼容 true/false、-1/0、1/0、'true'/'false'、null/undefined。
 */
export function isVbaTrue(v) {
  if (v === true) return true
  if (v === false || v === null || v === undefined) return false
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  return s === 'true' || s === '-1' || s === '1'
}

/** 跳过时给用户看的一句：「与 K12:K13 合并（不是左上角，这一格不存值）」 */
export function mergeSkipText(block) {
  const a = block && block.addr ? block.addr : '合并区'
  return `与 ${a} 合并，这一格没写`
}

/**
 * 批量段能否走「整段无合并」快路径。
 *
 * ★ 2026-11-11 真机复现两次，最终结论：**停用快路径**。
 *
 *   第一次（hotfix9）：单格判断写成 `cell.MergeCells === true`，
 *     WPS 返 -1 → 恒假 → 合并检测一次都没生效。
 *   第二次（hotfix11）：段级判断 `!isVbaTrue(rangeMergeCells)`，
 *     WPS 对「区域内部分合并」（L2:L15 里只有 L12:L13 合并）返回 **0**，
 *     而 VBA 规范应是 **Null** → 被当成「这段没有合并」→ 整段跳过逐格检查。
 *
 *   两次都是「相信 WPS 的布尔值」。结论：**这个布尔值不可信，别再用它做跳过的依据**。
 *
 * 现在的做法：一律逐格摸，判据用 `MergeArea.Address` 与 `Cells.Address` 比较
 * （地址是硬事实，跟布尔值无关）。代价 15 行 = 15 次 COM，毫秒级。
 *
 * 函数保留是为了让调用点语义清楚、让测试能锁住「永远别开快路径」这件事。
 */
export function canUseMergeFastPath(_segLength, _rangeMergeCells) {
  return false;
}

/**
 * 判定一格能不能写：是不是「合并区里的非左上角格」。
 *
 * ★ 三重判据，任一命中即判非左上角。这是被 WPS 逼出来的：
 *   第一次（hotfix9）`MergeCells === true` → WPS 返 -1，恒假，从没生效。
 *   第二次（hotfix11）段级 `!isVbaTrue(0)` → 部分合并返 0，被当成「没合并」。
 *   第三次（hotfix12）只比 MergeArea.Row/Column → 真机日志「现场跳过 0 格」，说明坐标也没动。
 *   第四次（hotfix14）同上。
 *
 * 所以不再赌某一个字段，三个一起看：
 *   ① MergeArea.Address 含 ":"（是范围）且左上角 ≠ 本格地址 → 非左上角
 *   ② MergeArea 的 Rows.Count 或 Columns.Count > 1        → 非左上角
 *   ③ MergeArea.Row/Column ≠ 本格行列                     → 非左上角
 *
 * 返回 { nonAnchor, reasons[] }：reasons 说明是哪条命中，方便日志和探针定位。
 * 摸不到任何字段 → nonAnchor=false（按原路写，不猜）。
 */
export function mergeVerdict({ cellAddr, cellRow, cellCol, maAddr, maAnchorAddr, maRow, maCol, maRows, maCols } = {}) {
  const norm = (x) => String(x == null ? '' : x).replace(/\$/g, '').replace(/\s/g, '').toUpperCase();
  // ★ Number(null) === 0 —— 直接 Number() 会把「摸不到」当成第 0 行，误判成非左上角
  const num = (x) => {
    if (x === null || x === undefined || x === '') return NaN;
    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  };

  const own = norm(cellAddr);

  // ① 合并区左上角的真实地址（MergeArea.Cells(1,1).Address）—— 最硬，直接定生死
  const anchor = norm(maAnchorAddr);
  if (anchor) return { nonAnchor: anchor !== own, reasons: ['anchor-addr'] };

  // ② MergeArea.Address 是范围（含冒号）—— 次硬
  const a = norm(maAddr);
  if (a.indexOf(':') >= 0) {
    const topLeft = a.split(':')[0];
    const nonAnchor = topLeft !== own;
    return { nonAnchor, reasons: [nonAnchor ? 'addr-range' : 'addr-range-anchor'] };
  }

  const ar = num(maRow), ac = num(maCol), cr = num(cellRow), cc = num(cellCol);
  const coordOk = [ar, ac, cr, cc].every((n) => Number.isFinite(n));
  const mr = num(maRows), mc = num(maCols);
  const sizeMerged = (Number.isFinite(mr) && mr > 1) || (Number.isFinite(mc) && mc > 1);

  // ★ ③ 尺寸说「这格在合并区里」是硬事实。此时坐标不可信 ——
  //   WPS 可能对非左上角格返回它自己的 Row/Column（前四版就是被这个坑掉的），
  //   所以「坐标等于自身」不能推出「是左上角」。
  //   地址和左上角地址都摸不到的情况下，只能保守跳过：
  //   宁可少写一格（用户在面板上看得到「跳过」），也不能把值写进别人的格子（数据污染且不可发现）。
  if (sizeMerged) return { nonAnchor: true, reasons: ['size-only-anchor-unknown'] };

  // ④ 没有尺寸信息时才单靠坐标（普通表格没有合并区时的主路径）
  if (coordOk) {
    const nonAnchor = ar !== cr || ac !== cc;
    return { nonAnchor, reasons: [nonAnchor ? 'coord' : 'coord-same'] };
  }

  return { nonAnchor: false, reasons: [] };
}

/** 兼容旧签名：只要结论 */
export function isMergedNonAnchor(mergeAreaRow, mergeAreaCol, cellRow, cellCol) {
  const v = mergeVerdict({ maRow: mergeAreaRow, maCol: mergeAreaCol, cellRow, cellCol });
  return v.nonAnchor;
}

/**
 * 写完之后：值是不是跑到合并区左上角去了？（第六版兜底判据）
 *
 * 不依赖 WPS 的任何合并字段 —— 六版判据全在真机上失效过
 * （MergeCells 返 -1/0、MergeArea.Address 退化单格、Row/Column 返回自身、Rows.Count 也试过）。
 * 这条路只问两个事实：锚点在哪、锚点现在的值是不是我刚写的那个。
 *
 * @returns {{revert: boolean, reason: string}}
 *   revert=true  → 值跑偏了，调用方把锚点还原成写前的值，并报「与 X 合并，这一格没写」
 *   revert=false → 真没写进去（或锚点没被动），按普通失败处理
 */
export function shouldRevertAnchor({ anchorAddr, selfAddr, anchorPrev, anchorNow, want } = {}) {
  const norm = (x) => String(x == null ? '' : x).replace(/\$/g, '').replace(/\s/g, '').toUpperCase();
  const a = norm(anchorAddr);
  if (!a) return { revert: false, reason: 'no-anchor' };
  // 锚点就是本格 → 不是「值跑别处」，只是写失败
  if (a === norm(selfAddr)) return { revert: false, reason: 'anchor-is-self' };
  if (want === undefined || want === null || String(want).trim() === '') {
    return { revert: false, reason: 'nothing-wanted' };
  }
  // ★ 口径必须复用 cellwrite.judgeReadback，不能自己拿裸文本比。
  //   日期列：写入的是 Date，读回是序列号 46400 —— cellText 一个 "46400"、一个 "2027-01-13"，
  //   裸比永远不相等，于是日期列永远判「锚点没被动」→ 还原逻辑在唯一出问题的列上 100% 失效。
  //   judgeReadback 内部有 sameDate 归一化，且 require prev（锚点写前的值）——
  //   不传 prev，「锚点还是旧值」会被判成 format-diff 而不是 fail，导致凭空还原、抹掉用户正确值。
  const v = judgeReadback({ prev: anchorPrev, back: anchorNow, want });
  // ★ 只有 'ok' 才还原。judgeReadback 还有 'format-diff'（值不同、只是形态差）——
  //   那种情况锚点上不是我要的那个值，还原等于把用户的数改坏。
  if (v !== 'ok') {
    return { revert: false, reason: v === 'fail' ? 'anchor-untouched' : 'anchor-not-my-value' };
  }
  return { revert: true, reason: 'value-moved-to-anchor' };
}

/**
 * 值跑偏扫描：在「写前快照的那片格」里找出「我刚写的值落到了哪一格」。
 *
 * 为什么这么问：WPS 的合并区字段（MergeCells / MergeArea.Address / Row / Rows.Count）
 * 六版全在真机上失效，问不出「锚点是谁」——退化时 Cells(1,1).Address 会返回
 * 非左上角格自己（$K$13），旧版 `anchor !== self` 不成立，快照记成空，还原整段跳过。
 *
 * 但有个不会撒谎的事实：**值只可能落在本格或合并区内某一格**。
 * 所以写前把 Rows.Count × Columns.Count 那片格全拍下来（通常 2×1，成本可忽略），
 * 写后逐格问「我刚写的值是不是在这格里」。命中那一格就是落点。
 *
 * @param {object} o
 * @param {Array<{addr:string, prev:any}>} o.snap   写前快照（含本格也无妨，本格会被跳过）
 * @param {string} o.selfAddr                       本格地址（如 'K13'）
 * @param {any}    o.want                           我刚写的值（Date / number / string）
 * @param {(addr:string)=>any} o.readCell           读某格当前值（COM 摸不到可抛错）
 * @returns {{addr:string, prev:any, reason:string}|null} 命中返回落点，没命中返回 null
 */
export function findMovedValue({ snap, selfAddr, want, readCell } = {}) {
  if (!Array.isArray(snap) || !snap.length) return null;
  if (want === undefined || want === null || String(want).trim() === '') return null;

  const norm = (x) => String(x == null ? '' : x).replace(/\$/g, '').replace(/\s/g, '').toUpperCase();
  const self = norm(selfAddr);

  for (const s of snap) {
    if (!s || !s.addr) continue;
    if (norm(s.addr) === self) continue;          // 本格跳过：它读回空正是「没写进去」的依据

    let back;
    try { back = readCell ? readCell(s.addr) : undefined } catch (e) { continue; }

    // ★ 口径复用 judgeReadback：日期写 Date、读回 46400 必须认成同一天，裸文本比永不相等
    if (judgeReadback({ prev: undefined, back, want }) !== 'ok') continue;

    return { addr: s.addr, prev: s.prev, reason: 'scan-hit' };
  }

  return null;
}


/**
 * 兜底未命中时，把「我看得见的事实」写进红字本身 —— 不要求用户点诊断、也不要求他复制日志。
 *
 * 为什么需要：合并格这条路修了八版，每次定位都卡在「红字只有一句『读回不一致（空）』，
 * 分不清是快照没拍到、还是拍到了但值没落到那几格」。判据写在代码里，用户看不见。
 *
 * 三种情况一句话分清：
 *   快照 1 格            → Rows.Count 返 1，WPS 根本不承认这是合并区，兜底无解
 *   快照 N 格 + 未命中    → 拍到了候选区，但值没落进去 → 不是「跑了」，是真没写
 *   kind=com             → 写入本身抛异常，跟合并无关
 *
 * @param {object} o
 * @param {Array<{addr:string, prev:any}>} o.snap  写前快照
 * @param {string} o.kind                          写入失败类型（com / readback / format-diff）
 * @param {number|string} o.row                    行号
 * @param {string} o.col                           列字母
 * @param {number} [o.maxValLen]                   每个值最多显示多少字符（默认 24）
 * @returns {{cells:number, detail:string, text:string, log:string}}
 */
export function describeSnapMiss({ snap, kind, row, col, maxValLen } = {}) {
  const arr = Array.isArray(snap) ? snap : [];
  const cap = Number(maxValLen) > 0 ? Number(maxValLen) : 24;

  const brief = (v) => {
    let t;
    try { t = JSON.stringify(v === undefined ? null : v); } catch (e) { t = '"?"'; }
    if (t === undefined) t = '"?"';
    return t.length > cap ? t.slice(0, cap) + '…' : t;
  };

  const detail = arr.map((s) => `${(s && s.addr) || '?'}=${brief(s && s.prev)}`).join(' ');
  const cells = arr.length;
  const k = kind || 'unknown';
  const where = `R${row == null ? '?' : row} ${col || '?'}`;

  return {
    cells,
    detail,
    text: `${where} 读回空 · 快照 ${cells} 格 [${detail}] · 扫描未命中 · kind=${k}`,
    log: `${where} 兜底未命中：mergeSnap=${cells} 格（${detail}）· kind=${k}`,
  };
}


/**
 * 这次的船名值该不该盖掉格子里已有的？—— 覆盖的规则从这里定
 *
 * 11-10 的 bug 是「同一格写两遍，后写的航次盖掉船名」，那个已经被 planVesselVoyage
 * （同格只返回一项）堵死了。但同一个位置还有**反方向**的覆盖，更隐蔽：
 *
 *   第一次查询  v='MSC FLORENCE XV' y='GA645W' → P 写 'MSC FLORENCE XV GA645W'
 *   第二次查询  v='MSC FLORENCE XV' y=''       → P 写 'MSC FLORENCE XV'   ← 航次没了
 *
 * planVesselVoyage 只按这次的查询结果算，它不知道格子里原来有什么。引擎某次没带回航次
 * （缓存命中 / 站点改版 / 超时降级），就会把上一轮的航次清掉 —— 表现是「航次自己消失了」。
 *
 * 判据（三条缺一不可，任一不满足就按正常覆盖走）：
 *   ① 旧值以新值开头        —— 换船（MSC A → MSC B）不满足，正常覆盖
 *   ② 旧值比新值长          —— 等长不动
 *   ③ 多出来的部分是一个 token（不含空白）—— 多出的不是杂串
 *
 * 已知保守：船名本身从 'MSC FLORENCE XV' 变短成 'MSC FLORENCE' 时也会判 keep（保留旧值）。
 * 这是有意的 —— 船名变短极罕见，保留比覆盖成短名安全。要覆盖就手动改那格，或整列清空重跑。
 *
 * @param {object} o
 * @param {any} o.cur   格子里现有的值
 * @param {any} o.next  这次要写的值
 * @returns {{keep:boolean, reason:string, extra?:string}}
 */
export function shouldKeepOldText({ cur, next } = {}) {
  const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  const c = norm(cur);
  const n = norm(next);

  if (!c) return { keep: false, reason: 'old-empty' };
  if (!n) return { keep: false, reason: 'nothing-to-write' };
  if (c === n) return { keep: false, reason: 'same' };
  if (!c.startsWith(n)) return { keep: false, reason: 'not-prefix' };

  const rest = c.slice(n.length).trim();
  if (!rest) return { keep: false, reason: 'no-suffix' };
  if (/\s/.test(rest)) return { keep: false, reason: 'multi-token-suffix' };

  return { keep: true, reason: 'old-has-extra-token', extra: rest };
}
