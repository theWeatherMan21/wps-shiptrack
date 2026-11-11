// Excel 行列自动识别 —— 表头语义 → 内容特征 → 同格/分格 → 置信度分层
// ─────────────────────────────────────────────────────────────────────────────
// 入参是插件从 WPS 里读出来的样本矩阵（A1:AZ30，字符串化后的二维数组）。
// 桥是 Node 进程，读磁盘文件；WPS 里那张表有未保存改动时磁盘是旧版，
// 所以样本只能由插件用 COM 读出来喂进来 —— 这是架构约束，不是偏好。
//
// 返回的列号一律是 **1-based**（Excel 的 A=1），跟 TaskPane 的 cfg 对齐。
//
// 判定顺序（三层，逐层收窄）：
//   L1 表头语义 —— 中英文/大小写/空格/括号/斜杠/全角 模糊匹配
//   L2 内容特征 —— 复用 engine/tracking/detect.mjs（→ identify.mjs 单一事实来源）
//                  做「这一格真的是能查的单号吗」的校验（SCAC / 箱主码 / ISO6346 校验位）
//   L3 同格分格 —— 读前 20 行判 single / split / absent
//
// 冲突时以内容为准（表头是历史遗留，内容是事实），并在 fixes[] 里留痕。
// 置信度分档见 confidenceTier()：>=0.8 直接写 / 0.4–0.8 首次预览 / <0.4 人指定。

// ── 表头词表 ────────────────────────────────────────────────────────────────
// 顺序有讲究：越靠前越确信。匹配时先精确后包含。
const HEADER_WORDS = {
  number: [
    '提单号', '提单', '主提单', '订舱号', '工作号', '箱号', '柜号',
    'bl', 'blno', 'bol', 'hbl', 'mbl', 'billoflading', 'booking', 'bookingno',
    'containerno', 'ctrno', 'jobno', 'job', 'referenceno', 'refno', '单号',
  ],
  vessel: [
    '船名', '船名航次', '船', 'vessel', 'vsl', 'shipname', 'vv', 'vesselvoyage',
    'vesselvoy', 'vesselname',
  ],
  voyage: ['航次', '航次号', 'voyage', 'voy', 'voyno', 'voyageno', 'vesselvoy'],
  carrier: ['船司', '船公司', '船东', '承运人', 'carrier', 'line', 'shippingline', '船公司名称', 'sl', 's/l', '船司代码', '承运人代码'],
  date: [
    'etd', 'eta', 'atd', 'ata', '开船', '起运', '到港', '抵港', '离港',
    '预计离港', '预计到港', '实际离港', '实际到港', '船期', '日期',
    'departure', 'arrival', 'sailingdate', 'date',
  ],
  pol: ['pol', '起运港', '装货港', '起运地', 'origin', 'portofloading', 'loadingport', '装港'],
  pod: ['pod', '目的港', '卸货港', '目的地', 'destination', 'portofdischarge', 'dischargeport', '卸港'],
};

// 这些列**绝不能写**（哪怕内容看起来像单号）：客户名、金额、备注、重量
const NEVER_WRITE_WORDS = [
  '客户', '客户名称', 'shipper', 'consignee', '收货人', '发货人', '通知人', 'notify',
  '金额', '价格', '运费', '费用', 'freight', 'amount', 'price', 'cost',
  '备注', '说明', 'remark', 'note', 'memo',
  '代理', 'agent', '业务员', 'sales', '负责人',
  '毛重', '净重', '体积', 'weight', 'volume', 'cbm', '件数', '包装',
];

// 提单类表头词（内容打平时优先选它，而不是箱号列）
const BL_PREF = new Set(['提单号', '提单', '主提单', 'bl', 'blno', 'bol', 'hbl', 'mbl', 'billoflading', '单号']);
// ★ 主提单（MBL）优先于货代提单（HBL）：船司官网只认主提单号，HBL 是货代自己出的号，
//   拿去官网查必然「查无此单」。爹地的表里 HBL/MBL 常常并排，必须选 MBL。
const MASTER_BL = new Set(['主提单', 'mbl', 'mblno', 'masterbl', 'masterbilloflading', '主提单号']);

// ── 归一化 ──────────────────────────────────────────────────────────────────
/** 表头/单元格文本归一：去空格、全角转半角、小写、去分隔符 */
export function normHeader(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // 全角 → 半角（ＡＢＣ→ABC，　→空格）
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
       .replace(/\u3000/g, ' ');
  return s.trim().toLowerCase().replace(/[\s\-_/().、·:：,，]/g, '');
}

/** 单元格值 → 干净字符串（去前后空格，空值统一 ''） */
export function normCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return String(v).replace(/\u00a0/g, ' ').trim();
}

// ── L1：表头语义 ────────────────────────────────────────────────────────────
/**
 * 给一个表头文本打语义标签。
 * @returns {{kind: string|null, score: number, word: string}}
 *   score: 1.0 精确命中 / 0.7 包含命中 / 0 未命中
 */
export function classifyHeader(raw) {
  const h = normHeader(raw);
  if (!h) return { kind: null, score: 0, word: '' };

  // 绝不写优先判（宁可不写，也不覆盖客户名/金额）
  for (const w of NEVER_WRITE_WORDS) {
    const nw = normHeader(w);
    if (h === nw || (nw.length >= 2 && h.includes(nw))) return { kind: 'never', score: 1, word: w };
  }

  // 先找精确
  for (const [kind, words] of Object.entries(HEADER_WORDS)) {
    for (const w of words) {
      if (h === normHeader(w)) return { kind, score: 1, word: w };
    }
  }
  // 再找包含（长词优先，避免 'eta' 命中 'beta'）
  const hits = [];
  for (const [kind, words] of Object.entries(HEADER_WORDS)) {
    for (const w of words) {
      const nw = normHeader(w);
      // 包含匹配只对 ≥3 字符的词开放：'sl'/'eta' 这种 2-3 字母的短码只认精确，
      // 否则 'Slip'/'Beta' 之类会被误判成船司/日期列
      if (nw.length >= 3 && h.includes(nw)) hits.push({ kind, word: w, len: nw.length });
    }
  }
  if (!hits.length) return { kind: null, score: 0, word: '' };
  hits.sort((a, b) => b.len - a.len);
  return { kind: hits[0].kind, score: 0.7, word: hits[0].word };
}

// ── L2：内容特征 ────────────────────────────────────────────────────────────
const RE_CONTAINER = /^[A-Z]{4}\d{7}$/;
const RE_PURE9 = /^\d{9}$/;
const RE_BL_LIKE = /^[A-Z]{4}[A-Z0-9]{5,}$/;
const RE_VESSEL_NAME = /^[A-Z][A-Z .\-']{2,}$/;   // 全大写、无数字
const RE_DATE_ISO = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/;
const RE_DATE_CN = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/;
const EXCEL_EPOCH_MIN = 20000;   // 1954 之后
const EXCEL_EPOCH_MAX = 80000;   // 2119 之前

/** 这一格像不像「一个能被追踪的单号」（提单号 / 箱号 / 订舱号 / 工作号）*/
export function looksLikeNumber(v) {
  const s = normCell(v).toUpperCase().replace(/\s/g, '');
  if (s.length < 6 || s.length > 24) return false;
  if (RE_CONTAINER.test(s)) return true;          // TSTU0000001
  if (RE_PURE9.test(s)) return true;              // 800000001
  if (RE_BL_LIKE.test(s)) return true;            // TSTU0000002
  if (/^\d{10,18}$/.test(s)) return true;         // 长纯数字（订舱号）
  // 货代工作号形态：TESTKAC0123456（数字开头、字母数字混排、含多个字母）
  if (/^[A-Z0-9]{9,24}$/.test(s) && (s.match(/[A-Z]/g) || []).length >= 3 && /\d{3,}/.test(s)) return true;
  return false;
}

/** 这一格像不像船名（纯字母，可带空格/点/连字符；不含数字） */
export function looksLikeVessel(v) {
  const s = normCell(v).toUpperCase().trim();
  if (s.length < 4 || s.length > 45) return false;
  return RE_VESSEL_NAME.test(s);
}

/** 这一格像不像「船名 + 航次」合在一格（MSC LONSON GA645W） */
export function looksLikeVesselVoyage(v) {
  const s = normCell(v).toUpperCase().trim();
  if (s.length < 8) return false;
  // 末尾是 4-8 位「数字+字母」混合的航次号
  const m = s.match(/\s+([A-Z0-9]{4,8})$/);
  if (!m) return false;
  const tail = m[1];
  if (!/\d/.test(tail)) return false;          // 航次里通常有数字
  const head = s.slice(0, m.index).trim();
  return head.length >= 3 && !/\d/.test(head); // 前半段是纯船名
}

/** 这一格像不像日期（文本日期 或 Excel 序列号） */
export function looksLikeDate(v) {
  const s = normCell(v);
  if (!s) return false;
  if (RE_DATE_ISO.test(s) || RE_DATE_CN.test(s)) return true;
  if (/^\d{4}年\d{1,2}月\d{1,2}日?$/.test(s)) return true;
  const n = Number(s);
  return Number.isFinite(n) && n >= EXCEL_EPOCH_MIN && n <= EXCEL_EPOCH_MAX;
}

/**
 * 单号形态的三档判定（L2 的权威口径）。
 *   'strong' = 识别器认（船司可路由）或 ISO6346 校验位通过 → 能为高置信背书
 *   'weak'   = 形态像单号但识别器不认（货代工作号 / 陌生箱主）→ 只算形态分
 *   'other'  = 不像单号
 * 不传识别器（离线单测）时退回纯形态：形态命中就算 strong。
 * @param {string} raw
 * @param {object|null} idmod engine/tracking/detect.mjs 或 identify.mjs
 */
export function judgeNumber(raw, idmod) {
  const s = normCell(raw).toUpperCase().replace(/\s/g, '');
  if (!s || !looksLikeNumber(s)) return 'other';
  if (idmod && typeof idmod.containerCheck === 'function') {
    const chk = idmod.containerCheck(s);
    if (chk.isContainerShape) return chk.valid ? 'strong' : 'weak';
  }
  if (idmod && typeof idmod.detectCarrier === 'function') {
    try {
      const r = idmod.detectCarrier(s);
      return r && r.ok ? 'strong' : 'weak';
    } catch (e) { return 'weak'; }
  }
  return 'strong';
}

/** 这一格像不像「上一轮写进去的追踪结果」（事件 + 日期 + 港口 的组合） */
export function looksLikeTrackingText(v) {
  const s = normCell(v);
  if (!s || s.length < 4) return false;
  const zh = /(离港|装船|卸船|到港|抵港|中转|转运|清关|报关|还箱|提柜|查无|官网|预计|已开船|已到港)/;
  const en = /(Export Received|Full Transshipment|Loaded|Discharged|Arrived|Departed|Gate ?In|Gate ?Out|Empty|Vessel|Booking Confirmed|No Record|Not Found)/i;
  if (!zh.test(s) && !en.test(s)) return false;
  // 有事件词还不够，通常还带日期或地点，避免把「备注里写了"预计"」误判
  return /\d{1,2}[-/月]\d{1,2}|\b[A-Z]{4,}\b|\d{4}-\d{2}/.test(s) || s.length >= 12;
}

/** 这一格像不像「插件写的状态短词」（未查 / 已查 / 查无此号…）—— 这类列本来就是给我们写的 */
export function looksLikeStatusText(v) {
  const s = normCell(v);
  if (!s || s.length > 12) return false;
  return /^(未查|已查|待查|没查|查无此号|官网查无|查询失败|查询超时|超时|无记录|暂无|已更新|待更新|失败|成功|进行中|已跳过|合并跳过)$/.test(s);
}

/** 这一列前 N 个非空值的比例统计 */
function columnProfile(rows, colIdx, maxRows = 20, idmod = null) {
  const vals = [];
  for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
    const v = normCell(rows[i] ? rows[i][colIdx] : '');
    if (v) vals.push(v);
  }
  const total = vals.length;
  if (!total) return { total: 0, ratio: {}, sample: [] };
  const strong = vals.filter((v) => judgeNumber(v, idmod) === 'strong').length;
  const ratio = {
    number: vals.filter(looksLikeNumber).length / total,
    strong: strong / total,
    vessel: vals.filter(looksLikeVessel).length / total,
    vesselVoyage: vals.filter(looksLikeVesselVoyage).length / total,
    date: vals.filter(looksLikeDate).length / total,
    trackingText: vals.filter(looksLikeTrackingText).length / total,
    statusText: vals.filter(looksLikeStatusText).length / total,
    empty: 0,
  };
  return { total, ratio, sample: vals.slice(0, 5) };
}

// ── 主函数 ──────────────────────────────────────────────────────────────────
/**
 * @param {object} input
 * @param {string[][]} input.rows       样本矩阵（每行一个数组，列从 A 开始）
 * @param {number} [input.headerRow]    表头所在行（0-based）；-1 = 没有表头；不传 = 自动找
 * @param {string} [input.sheet]        工作表名（仅回显）
 * @param {object} [input.identify]     可选：engine 的 detect/identify 模块（内容校验）
 * @returns {object} 识别结果，见文件头
 */
export function detectColumns(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const sheet = input.sheet || '';
  const idmod = input.identify || null;
  // 合并单元格：WPS 的 Value2 只有左上角有值，其余是空 —— 这里不补值（补了就是编数据）
  const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);

  const base = {
    ok: false, sheet, headerRow: -1, colCount,
    numberCol: 0, outCol: 0, carrierCol: 0, polCol: 0, podCol: 0,
    vesselCol: 0, voyageCol: 0, vesselMode: 'absent', vesselBy: '',
    startRow: 1, sampleRows: 0,
    confidence: 0, tier: 'manual', reason: '', fixes: [], blocked: [],
  };

  if (!rows.length || !colCount) return { ...base, reason: '样本为空' };

  // ① 找表头行（前 5 行里能匹配已知表头词最多的那行，至少 2 格认出）
  let headerRow = typeof input.headerRow === 'number' ? input.headerRow : -1;
  if (headerRow < 0 && input.headerRow !== 0) headerRow = findHeaderRow(rows, colCount);

  // ② 表头语义 → 每列一个标签
  const headerTags = new Array(colCount).fill(null).map(() => ({ kind: null, score: 0, word: '' }));
  if (headerRow >= 0) {
    const hr = rows[headerRow] || [];
    for (let c = 0; c < colCount; c++) headerTags[c] = classifyHeader(hr[c]);
  }

  // ③ 每列内容画像（跳过表头行本身）
  const dataRows = headerRow >= 0 ? rows.slice(headerRow + 1) : rows;
  const profiles = [];
  for (let c = 0; c < colCount; c++) profiles.push(columnProfile(dataRows, c, 20, idmod));

  const fixes = [];
  const blocked = [];

  // ④ 定单号列
  let numberCol = 0, numberBy = '', numberConf = 0;
  {
    // 4a 表头说是单号，且内容也像 → 最强
    let best = null;
    for (let c = 0; c < colCount; c++) {
      const tag = headerTags[c];
      if (tag.kind !== 'number' || tag.score < 0.7) continue;
      const p = profiles[c];
      const r = p.total ? p.ratio.number : 0;
      const st = (p.ratio && p.ratio.strong) || 0;
      // 内容校验（识别器认 / 箱号校验位过）单独计入分数 —— 两列都像单号时，
      // 「提单号」列比「箱号」列更该被选（fixture 07：TESTMAE0123450 校验位错 = weak）
      const hw = normHeader(tag.word);
      // MBL 额外加权：同分时压过 HBL（官网只认主提单号）
      const prefBonus = MASTER_BL.has(hw) ? 0.08 : (BL_PREF.has(hw) ? 0.02 : 0);
      const score = tag.score * 0.5 + r * 0.3 + st * 0.2 + prefBonus;
      if (!best || score > best.score) best = { col: c + 1, score, r, strong: st, tag };
    }
    if (best && best.r >= 0.5) {
      numberCol = best.col; numberBy = 'header';
      // ★ 表头命中 + 内容校验（识别器认 / ISO6346 通过）才够 0.8；只有表头好看给不出高分
      numberConf = 0.55 + best.tag.score * 0.25 + best.strong * 0.25;
      if (best.strong < 0.3 && best.r >= 0.5) {
        fixes.push(`${colLetter(best.col)} 列表头写「${best.tag.word}」，但内容只有 ${Math.round(best.strong * 100)}% 能对上识别器 —— 首次查询先预览，你点头再写`);
      }
    } else {
      // 4b 表头说单号但内容不像 → 以内容为准（找内容最像的列）
      let contentBest = null;
      for (let c = 0; c < colCount; c++) {
        if (headerTags[c].kind === 'never') continue;
        const p = profiles[c];
        if (!p.total) continue;
        const r = p.ratio.number;
        if (r >= 0.6 && (!contentBest || r > contentBest.r)) contentBest = { col: c + 1, r, strong: (p.ratio && p.ratio.strong) || 0 };
      }
      if (contentBest) {
        numberCol = contentBest.col;
        numberBy = best ? 'content-wins' : 'content';
        const strong = contentBest.strong || contentBest.r;
        numberConf = best ? 0.72 : Math.min(0.78, 0.3 + strong * 0.6);
        if (best) {
          const hName = normCell((rows[headerRow] || [])[best.col - 1]);
          fixes.push(`表头写「${hName}」，内容是单号形态 → 按内容判为 ${colLetter(contentBest.col)} 列`);
        }
      }
    }
  }

  if (!numberCol) {
    return {
      ...base, headerRow, sampleRows: dataRows.length,
      confidence: 0.1, tier: 'manual',
      reason: '找不到单号列（表头与内容都没命中）',
    };
  }

  // ⑤ 绝不覆盖的列（客户名/金额/备注）
  for (let c = 0; c < colCount; c++) {
    if (headerTags[c].kind === 'never') blocked.push({ col: c + 1, why: headerTags[c].word });
  }

  // ⑥ 船名 / 航次 + vesselMode（先定它：输出列不许覆盖船名格）
  let vesselCol = 0, voyageCol = 0, vesselMode = 'absent', vesselBy = '';
  {
    const vCols = [], yCols = [], vvCols = [];
    for (let c = 0; c < colCount; c++) {
      if (headerTags[c].kind === 'vessel') vCols.push(c + 1);
      if (headerTags[c].kind === 'voyage') yCols.push(c + 1);
      const p = profiles[c];
      if (p.total && p.ratio.vesselVoyage >= 0.5) vvCols.push(c + 1);
    }

    // 表头把船名航次写在一列（V/V）→ 先看内容是不是合体形态
    const merged = vVvMergeCandidate(vCols, yCols, profiles);
    if (merged) {
      vesselCol = merged; vesselMode = 'single'; vesselBy = 'header+content';
    } else if (vvCols.length) {
      vesselCol = vvCols[0]; vesselMode = 'single'; vesselBy = 'content';
    } else if (vCols.length) {
      vesselCol = vCols[0]; vesselBy = 'header';
      // 有独立航次列 → split；否则看内容里有没有混着航次
      if (yCols.length) { voyageCol = yCols[0]; vesselMode = 'split'; }
      else {
        const p = profiles[vesselCol - 1];
        if (p.total && p.ratio.vesselVoyage >= 0.4) vesselMode = 'single';
        else if (p.total && p.ratio.vessel >= 0.5) vesselMode = 'split';
        else { vesselMode = 'absent'; vesselCol = 0; vesselBy = ''; }
      }
    } else if (yCols.length) {
      // 只有航次列没有船名列：不猜，标 absent
      voyageCol = 0;
      fixes.push(`只找到航次列 ${colLetter(yCols[0])}，没有船名列，跳过`);
    }

    // 表头标了 vessel 但那列内容一半以上是混杂形态 → 不猜，留痕
    if (vesselCol && vesselMode !== 'single') {
      const p = profiles[vesselCol - 1];
      if (p.total && p.ratio.vesselVoyage > 0.2 && p.ratio.vesselVoyage < 0.6) {
        fixes.push(`${colLetter(vesselCol)} 列格式不一致（${Math.round(p.ratio.vesselVoyage * 100)}% 带航次），跳过`);
        vesselCol = 0; voyageCol = 0; vesselMode = 'absent'; vesselBy = '';
      }
    }
    // 分列但内容其实是「船名 航次」合体 → 内容为准，改成 single
    if (vesselMode === 'split' && vesselCol) {
      const p = profiles[vesselCol - 1];
      if (p.total && p.ratio.vesselVoyage >= 0.5) { vesselMode = 'single'; voyageCol = 0; vesselBy = 'content'; }
    }
  }

  // ⑦ 定输出列（三档，绝不乱覆盖有内容的列）
  let outCol = 0, outColBy = '';
  {
    const isBlocked = (c) => blocked.some((b) => b.col === c);
    // 7a0 内容全是「未查 / 已查 / 查无此号」这类短词 → 这列本来就是给我们写的
    //     注意不能只看表头（爹地表 B 列也叫「状态栏」，但内容是 9/8/8 箱量，不能覆盖）
    for (let c = numberCol + 1; c <= colCount; c++) {
      if (isBlocked(c)) continue;
      const p = profiles[c - 1];
      if (p.total && p.ratio.statusText >= 0.5) { outCol = c; outColBy = 'status'; break; }
    }
    // 7a 先找「上一轮写过的追踪结果列」——输出列天然会有上一轮的值（离港 10-08 XINGANG…），
    //    这不是脏数据，正是我们上次写的地方，继续写它才对。
    if (!outCol) for (let c = numberCol + 1; c <= colCount; c++) {
      if (isBlocked(c)) continue;
      const p = profiles[c - 1];
      if (p.total && p.ratio.trackingText >= 0.4) { outCol = c; outColBy = 'previous-run'; break; }
    }
    // 7b 没有上一轮结果 → 右侧第一个全空列
    if (!outCol) {
      for (let c = numberCol + 1; c <= colCount; c++) {
        if (isBlocked(c)) continue;
        if (profiles[c - 1].total === 0) { outCol = c; outColBy = 'empty'; break; }
      }
    }
    // 7c 都没有 → outCol=0。★ 绝不覆盖箱型/卖价/联系方式这类有内容的列：
    //    把状态文字写进 VOL 格就是把表弄坏，宁可让用户指定。
    if (!outCol) {
      fixes.push('右侧没有空列，也没有上次写入的追踪列 → 请在「更多设置」里指定输出列');
    } else if (outColBy === 'previous-run') {
      fixes.push(`输出列 ${colLetter(outCol)} 有上一轮的追踪结果，继续写这里`);
    }
  }

  // ⑧ 船司列（可选；面板不再让用户选，识别到才用）
  let carrierCol = 0;
  for (let c = 0; c < colCount; c++) {
    if (headerTags[c].kind === 'carrier') { carrierCol = c + 1; break; }
  }

  // ⑨ 港口列
  let polCol = 0, podCol = 0;
  for (let c = 0; c < colCount; c++) {
    if (!polCol && headerTags[c].kind === 'pol') polCol = c + 1;
    if (!podCol && headerTags[c].kind === 'pod') podCol = c + 1;
  }

  // ⑩ 数据范围（sampleRows 只是样本里读到的行数 —— 真行数由插件按整列算，别当 cfg.rows 用）
  const startRow = headerRow >= 0 ? headerRow + 2 : 1;   // 1-based，跳过表头
  const sampleRows = dataRows.filter((r) => normCell(r && r[numberCol - 1])).length;

  // ⑪ 置信度 + 分档
  let confidence = numberConf;
  if (!outCol) confidence = Math.min(confidence, 0.35);
  if (numberBy === 'content-wins') confidence = Math.min(confidence, 0.72);
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
  const tier = confidenceTier(confidence);

  return {
    ...base,
    ok: true,
    headerRow,
    numberCol, outCol, outColBy, carrierCol, polCol, podCol,
    vesselCol, voyageCol, vesselMode, vesselBy,
    startRow, sampleRows,
    confidence, tier,
    numberBy,
    reason: buildReason({ numberCol, numberBy, outCol, vesselMode, confidence, tier }),
    fixes, blocked,
  };
}

/**
 * 置信度分层（知澜 2026-11-11 修正，照此实现）
 *   >=0.8        直接写，零点击
 *   0.4 – 0.8    首次预览确认，之后静默
 *   <0.4         更多设置里人指定
 */
export function confidenceTier(confidence) {
  const c = Number(confidence) || 0;
  if (c >= 0.8) return 'auto';
  if (c >= 0.4) return 'preview';
  return 'manual';
}

/** 识别结果的「形状签名」—— 只含列的位置关系，不含行数（新增订单不算格式变了）*/
export function detectSignature(det) {
  if (!det || !det.numberCol) return '';
  return [
    `n${det.numberCol}`, `o${det.outCol}`, `v${det.vesselCol}`, `y${det.voyageCol}`,
    `m${det.vesselMode}`, `h${det.headerRow}`,
  ].join('|');
}

/**
 * 每次识别 vs 上次确认配置的差异（DoD 6：一致则静默，不一致提示一次）
 * ★ 行数变化不算不一致（新增订单是常态）；表名不算（换表就是另一份配置）
 * @returns {{changed:boolean, changes:Array<{field:string,label:string,from:any,to:any}>, text:string}}
 */
export function diffDetection(confirmed, detected) {
  const out = { changed: false, changes: [], text: '' };
  if (!detected || !detected.numberCol) return out;
  if (!confirmed || !confirmed.numberCol) return out;
  const pairs = [['numberCol', '单号列'], ['outCol', '输出列'], ['vesselCol', '船名列'], ['voyageCol', '航次列']];
  for (const [field, label] of pairs) {
    const a = Number(confirmed[field] || 0);
    const b = Number(detected[field] || 0);
    if (a !== b) out.changes.push({ field, label, from: a, to: b });
  }
  const ha = Number(confirmed.headerRow == null ? -1 : confirmed.headerRow);
  const hb = Number(detected.headerRow == null ? -1 : detected.headerRow);
  if (ha !== hb) out.changes.push({ field: 'headerRow', label: '表头行', from: ha, to: hb });
  const ma = String(confirmed.vesselMode || 'absent');
  const mb = String(detected.vesselMode || 'absent');
  if (ma !== mb) out.changes.push({ field: 'vesselMode', label: '船名格式', from: ma, to: mb });
  out.changed = out.changes.length > 0;
  if (out.changed) {
    out.text = out.changes.map((c) => {
      if (typeof c.from === 'number') return `${c.label} ${colLetter(c.from) || '—'}→${colLetter(c.to) || '—'}`;
      return `${c.label} ${c.from}→${c.to}`;
    }).join('，');
  }
  return out;
}

// ── 辅助 ────────────────────────────────────────────────────────────────────
export function colLetter(n) {
  let s = '';
  let x = Number(n) || 0;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

/** 表头写着 V/V 或「船名航次」的列，看内容是不是合体形态 */
function vVvMergeCandidate(vCols, yCols, profiles) {
  const cands = [...new Set([...vCols, ...yCols])];
  let best = 0, bestRatio = 0;
  for (const c of cands) {
    const p = profiles[c - 1];
    if (!p || !p.total) continue;
    if (p.ratio.vesselVoyage >= 0.5 && p.ratio.vesselVoyage > bestRatio) {
      best = c; bestRatio = p.ratio.vesselVoyage;
    }
  }
  return best;
}

/** 在前 5 行里找表头行：至少两格能被 classifyHeader 认出来，认得多且填得满的优先 */
function findHeaderRow(rows, colCount) {
  let bestRow = -1, bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i] || [];
    let hits = 0, filled = 0;
    for (let c = 0; c < colCount; c++) {
      const v = normCell(r[c]);
      if (!v) continue;
      filled++;
      if (classifyHeader(v).kind) hits++;
    }
    if (hits < 2) continue;                       // 至少两格认得出才当表头
    const score = hits * 2 + filled * 0.1;
    if (score > bestScore) { bestScore = score; bestRow = i; }
  }
  return bestRow;
}

function buildReason({ numberCol, numberBy, outCol, vesselMode, confidence, tier }) {
  const how = numberBy === 'header' ? '按表头' : numberBy === 'content-wins' ? '表头与内容冲突，按内容' : '按内容形态';
  const bits = [`${how}认出单号在 ${colLetter(numberCol)} 列`];
  bits.push(outCol ? `写到 ${colLetter(outCol)} 列` : '没找到可写列');
  if (vesselMode === 'single') bits.push('船名航次写同一格');
  else if (vesselMode === 'split') bits.push('船名航次分两列');
  bits.push(`置信 ${confidence}（${tier === 'auto' ? '直接写' : tier === 'preview' ? '首次预览' : '需人指定'}）`);
  return bits.join('，');
}

export default detectColumns;
