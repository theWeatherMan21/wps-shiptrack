<template>
  <div class="wrap">
    <div class="hdr">
      <span class="dot" :class="bridge ? 'ok' : 'bad'"></span>
      <b>船期追踪</b>
      <span class="muted">{{ bridge ? '桥已连接' : '桥未连接' }}</span>
      <span class="muted" style="margin-left:auto">v{{ ver }}</span>
    </div>

    <!-- 唯一横幅：完全由状态推导，任何一步成功后自动消失，不会挂僵尸提示 -->
    <div v-if="banner" :class="banner.kind === 'err' ? 'err' : 'warn'">
      <div>{{ banner.text }}</div>
      <div v-if="banner.cmd" class="banner-cmd">
        <code>{{ banner.cmd }}</code>
        <button class="mini" @click="copyStartCmd">复制命令</button>
      </div>
      <button v-if="banner.action === 'unprotect'" class="mini" @click="tryUnprotect">尝试解除保护</button>
      <button v-if="banner.action === 'ping'" class="mini" @click="ping">重连</button>
    </div>

    <!-- ★ 卡 t_8a6689dc：契约对不上时的顶部横幅 —— 不许悄悄渲染错字段 -->
    <div v-if="schemaAlert" class="err schema-alert">
      <div><b>{{ schemaAlert.short }}</b></div>
      <div class="muted">{{ schemaAlert.detail }}</div>
    </div>

    <!-- 在线更新：只在真的有新版时出现（检查失败一律静默，不打扰） -->
    <div v-if="upd.has || upd.msg" class="upd">
      <template v-if="upd.has">
        <span>有新版本 <b>v{{ upd.ver }}</b>（当前 v{{ upd.local }}）</span>
        <button class="mini" :disabled="upd.busy" @click="doUpdate">{{ upd.busy ? '更新中…' : '立即更新' }}</button>
      </template>
      <span v-else class="upd-msg">{{ upd.msg }}</span>
    </div>

    <!-- ★ 11-03 爹地原话：「写入 ETD/ETA，请加一个按钮来确认吧，不要静默替换」
         一批查询结束才出这条；**没点确认之前 ETD/ETA 一格都不改**（连历史脏值修复也过这道闸）。
         输出列（短结论）照旧自动写，不受影响。 -->
    <div v-if="schedAsk && schedView" class="schedbar">
      <div class="sb-hd">
        船期回填：将更新 {{ schedView.n }} 行
        <span class="sb-cnt">（ETD {{ schedView.etdN }} / ETA {{ schedView.etaN }}）</span>
      </div>
      <div class="sb-list">
        <div v-for="(x, i) in schedView.preview" :key="i">R{{ x.row }} {{ x.label }} {{ x.oldText }} → {{ x.newText }}</div>
        <div v-if="schedView.more" class="muted">…等共 {{ schedView.n }} 行</div>
      </div>
      <div class="sb-btns">
        <button class="mini sb-go" @click="schedConfirm">确认写入</button>
        <button class="mini" @click="schedSkip">跳过本次</button>
        <label class="sb-auto"><input type="checkbox" v-model="schedAuto" /> 本表以后直接写</label>
      </div>
    </div>

    <!-- ★ t_a72fba24：默认只留「一行识别结果 + 立即查询」，选列控件收进「更多设置」。
         船司列控件已删除（认出单号形态就知道是哪家，不用问）。 -->
    <div class="row auto">
      <span class="auto-state">
        <span class="dot" :class="bridge ? 'ok' : 'bad'"></span>
        <template v-if="detecting">正在识别列…</template>
        <template v-else-if="detected && detected.ok">
          识别到：单号 <b>{{ colLetter(detected.numberCol) }}</b> 列
          → 输出 <b>{{ colLetter(detected.outCol) }}</b>
          <template v-if="detected.vesselCol">
            · <template v-if="detected.vesselMode === 'single'">船名航次同格 <b>{{ colLetter(detected.vesselCol) }}</b></template>
            <template v-else>船名 <b>{{ colLetter(detected.vesselCol) }}</b><template v-if="detected.voyageCol"> / 航次 <b>{{ colLetter(detected.voyageCol) }}</b></template></template>
          </template>
          · {{ cfg.rows || detected.sampleRows }} 行
          <span v-if="detected.tier === 'preview'" class="tier-warn">（首次会先预览，你点头才写）</span>
          <span v-else-if="detected.tier === 'manual'" class="tier-warn">（认不准，「更多设置」里手动选）</span>
        </template>
        <template v-else-if="detected">没识别出列 → 在「更多设置」里手动选</template>
        <template v-else>打开一张表，自动识别列</template>
      </span>
      <button @click="refresh(true)" :disabled="busy || !ready">立即查询</button>
      <button @click="stop" :disabled="!hasRunning">停止</button>
      <button class="mini-btn" @click="moreOpen = !moreOpen">{{ moreOpen ? '收起设置 ▴' : '更多设置 ▾' }}</button>
      <button v-if="pendingWrites.length" class="mini-btn pending-btn" :title="`暂存了 ${pendingWrites.length} 行结果：查询中切走的那几张表，切回来点这里一次写回`" @click="flushPending">补齐回填 {{ pendingWrites.length }}</button>
    </div>
    <div v-if="detected && detected.fixes && detected.fixes.length" class="auto-fix">
      <span v-for="(f, i) in detected.fixes" :key="i">{{ f }}</span>
    </div>

    <!-- ★ 中置信首次：结果只在面板预览，一格都不写（写错会被下一轮当已有值读回去，错会自我繁殖） -->
    <div v-if="previewAsk" class="previewbar">
      <div class="pb-hd">识别结果先给你看一眼 —— 表格一格都还没写：<b>{{ previewAskTextShow() }}</b></div>
      <div class="sb-btns">
        <button class="mini pb-go" @click="confirmPreview">就对</button>
        <button class="mini" @click="cancelPreview">先不写</button>
      </div>
    </div>

    <!-- ★ 格式变了才提示一次（一致就静默；行数变多不算变） -->
    <div v-if="cfgConflict" class="conflictbar">
      <div><b>格式好像变了</b>：{{ cfgConflict.text }}。按新的来？</div>
      <div class="sb-btns">
        <button class="mini pb-go" @click="useNewDetect">按新的</button>
        <button class="mini" @click="keepOldDetect">沿用旧的</button>
      </div>
    </div>

    <!-- 更多设置：猜错才展开（原来那 5 个按钮） -->
    <div class="row" v-if="moreOpen">
      <button @click="pickNumberCol">选单号列</button>
      <button @click="pickOutputCol">选输出列</button>
      <button @click="pickVesselCol" class="mini-btn" :title="'选中船名（如 MSC LONSON）那一列再点'">船名列</button>
      <button @click="pickVoyageCol" class="mini-btn" :title="'选中航次（如 GA645W）那一列再点'">航次列</button>
      <button @click="detectNow({ force: true })" class="mini-btn" :disabled="detecting">重新识别</button>
    </div>

    <!-- ★ 0.9.45 批次条：主区域只留「在跑 / 当前」那一条；跑完的（完成 / 已停）收进「历史 N」默认折叠；
         「再开一批」挪到条尾，不再和 ①②③ 挤在主操作区 -->
    <div class="bchips" v-if="showChips">
      <div v-if="mainBatch" class="bchip main" :class="[mainBatch.state, { on: mainBatch.id === viewBatchId }]"
           :title="batchTitle(mainBatch)" @click="showBatch(mainBatch.id)">
        <span class="bname">{{ batchLabel(mainBatch) }}</span>
        <span class="bmeta">{{ batchMeta(mainBatch) }}</span>
        <span class="bst">{{ stateLabel(mainBatch.state) }}</span>
        <span class="bnum">{{ mainBatch.done }}/{{ mainBatch.total }}</span>
      </div>
      <button v-if="queuedCount" class="bchip queued more-btn" :title="`${queuedCount} 批排在后面，空出一格就开跑`" @click="toggleHist">排队 {{ queuedCount }}</button>
      <button v-if="historyCount" class="bchip hist more-btn" :class="{ open: histOpen }" :title="histOpen ? '收起历史批次' : '展开最近 5 批（完成 / 已停）'" @click="toggleHist">历史 {{ historyCount }}{{ histOpen ? ' ▴' : ' ▾' }}</button>
      <button v-if="busy && ready" class="bchip add" title="同一张表也能再开一批（两批并行，写回按批次先后，后写覆盖前写）" @click="refresh(true, { force: true })">＋ 再开一批</button>
    </div>
    <!-- 展开后才看到的：排队中 + 最近 5 条历史（都带 sheet · 起止行 · 开始时间 · 状态） -->
    <div class="bchips more" v-if="histOpen && (queuedBatches.length || historyShown.length)">
      <div v-for="b in queuedBatches" :key="b.id" class="bchip queued" :class="{ on: b.id === viewBatchId }"
           :title="batchTitle(b)" @click="showBatch(b.id)">
        <span class="bname">{{ batchLabel(b) }}</span>
        <span class="bmeta">{{ batchMeta(b) }}</span>
        <span class="bst">{{ stateLabel(b.state) }}</span>
        <span class="bnum">{{ b.done }}/{{ b.total }}</span>
      </div>
      <div v-for="b in historyShown" :key="b.id" class="bchip hist" :class="[b.state, { on: b.id === viewBatchId }]"
           :title="batchTitle(b)" @click="showBatch(b.id)">
        <span class="bname">{{ batchLabel(b) }}</span>
        <span class="bmeta">{{ batchMeta(b) }}</span>
        <span class="bst">{{ stateLabel(b.state) }}</span>
        <span class="bnum">{{ b.done }}/{{ b.total }}</span>
      </div>
      <span v-if="historyCount > historyShown.length" class="hist-more muted">只显示最近 {{ historyShown.length }} 条（共 {{ historyCount }}）</span>
    </div>

    <!-- 列状态清单：只在「更多设置」展开时出现（默认面板不许有配置项）。
         「船司列」这一行也删了 —— 控件既然没了，就别留一行说明占地方。 -->
    <div v-if="moreOpen" class="steps">
      <div class="step" :class="cfg.numberCol > 0 ? 'done' : 'todo'">
        <b>单号列</b>
        <span v-if="cfg.numberCol > 0">{{ numColText }} · 第 {{ cfg.startRow }}–{{ cfg.startRow + cfg.rows - 1 }} 行</span>
        <span v-else class="muted">未选</span>
      </div>
      <div class="step" :class="cfg.outCol > 0 ? 'done' : (cfg.numberCol > 0 ? 'todo' : 'idle')">
        <b>输出列</b>
        <span v-if="cfg.outCol > 0">{{ outColText }}</span>
        <span v-else class="muted">未选</span>
      </div>
      <div class="step" :class="(cfg.vesselCol > 0 || cfg.voyageCol > 0) ? 'done' : 'idle'">
        <b>船名/航次</b>
        <span v-if="cfg.vesselCol > 0 || cfg.voyageCol > 0">{{ vesselVoyageText }}</span>
        <span v-else class="muted">可选（配了才回填）</span>
      </div>
    </div>
    <div class="next" v-if="moreOpen && stepHint">{{ stepHint }}</div>

    <div class="cfg" v-if="moreOpen && cfg.numberCol > 0">
      <div class="muted">{{ scanText }}</div>
      <div class="muted">范围：{{ cfg.mode === 'column' ? '跟随表格（新加的行会一起查）' : '固定选区（只查选的那几行）' }}</div>
      <div class="muted" v-if="carriers">船司覆盖：{{ carriers.liveCount }}/{{ carriers.count }} 已接入</div>
      <div class="muted">
        起运/目的港列：
        <template v-if="cfg.polCol || cfg.podCol">
          {{ polColText }} / {{ podColText }}
          <span class="muted">（按此判断「已离起运港 / 已到目的港」；认不出时用事件本身推断）</span>
        </template>
        <template v-else>未识别 → 用事件本身推断（中转港不会被误判成到港）</template>
      </div>
      <div class="legend">
        <span class="lg blue">蓝 · 已离起运港（整行）</span>
        <span class="lg green">绿 · 已到目的港</span>
        <span class="lg gray">灰 · 已还空箱</span>
      </div>
      <div class="muted" v-if="cfg.outCol > 0">上次刷新 {{ lastRunText }}<span v-if="misalign" class="stale">（本轮错位 {{ misalign }} 行 → 这个时间与范围行数不可信）</span> · API 读法 {{ readVia || '—' }} · 写法 {{ writeVia || '—' }}<span v-if="writeStats && writeStats.cells"> · 写回 {{ writeStats.cells }} 格/{{ writeStats.runs }} 段 · {{ writeStats.ms }}ms</span></div>
      <div class="muted" v-if="cfg.outCol > 0 && autoOn">已开启：每 24 小时自动刷新（WPS 开着时）</div>
    </div>

    <div class="bar" v-if="busy">
      <div class="bar-in" :style="{ width: progress + '%' }"></div>
      <span class="bar-t">{{ done }}/{{ total }}{{ etaText ? ' · ' + etaText : '' }}{{ writeProgText ? ' · ' + writeProgText : '' }}</span>
    </div>

    <table v-if="items.length" class="tbl">
      <thead>
        <tr><th>行</th><th>单号</th><th>最新动态</th></tr>
      </thead>
      <tbody>
        <template v-for="it in items" :key="it.row">
          <tr :class="[it.state, { handmade: it.handmade, misalign: it.misaligned }]">
            <td>{{ it.row }}</td>
            <td class="mono">{{ it.number }}</td>
            <td class="ev">
              <span v-if="it.stage" class="dot-stage" :class="'s' + it.stage" :title="it.stageLabel"></span>{{ it.text }}<span v-if="failLabel(it)" class="tag-fail">〔{{ failLabel(it) }}〕</span><span v-if="it.handmade" class="tag-manual">手工</span>
              <div v-if="it.note" class="muted">{{ it.note }}</div>
              <button v-if="it.manualUrl && !it.handmade" class="mini manual-btn" @click.stop="toggleManual(it)">{{ it.manualOpen ? '收起' : '手工查' }}</button>
            </td>
          </tr>
          <!-- ★ 10-28：查不通就给「链接 + 收粘贴」；解析走桥上的 /parse-manual（实现只有一处） -->
          <tr v-if="it.manualOpen" class="manual-row">
            <td colspan="3">
              <div class="manual-box">
                <a :href="it.manualUrl" target="_blank" rel="noreferrer" class="manual-link" @click="copyNumber(it.number)">① 打开 {{ it.manualLabel || '官网' }} 查（单号自动复制）</a>
                <textarea v-model="it.manualDraft" class="manual-paste" rows="3" placeholder="② 把官网查到的整段文本粘进来（日期 / 事件 / 港口，贴多少解析多少，认不出也原文留着）"></textarea>
                <div class="manual-foot">
                  <button class="mini primary" :disabled="it.manualBusy" @click="applyManual(it)">{{ it.manualBusy ? '解析中…' : '解析并填入' }}</button>
                  <span class="muted">{{ it.manualNote || '' }}</span>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <details class="diag">
      <summary>诊断 / 日志</summary>
      <pre>{{ diag }}</pre>
      <button class="mini" @click="diagDump">重新体检</button>
      <button class="mini" @click="probeMerge" title="把输出列每一行的 MergeCells / MergeArea / Address 全打出来 —— 判据到底该用哪个值，看数据说话">合并格探针</button>
      <button class="mini" @click="exportWriteFails" :title="`最近 ${writeFailLog.length} 条真写不进的格子（行 / 列 / 原因 / 写法 / 时间），导出成 JSON`">导出写入失败{{ writeFailLog.length ? '（' + writeFailLog.length + '）' : '' }}</button>
      <button class="mini" @click="resetCfg">清空配置</button>
    </details>
  </div>
</template>

<script>
// ★ 10-30：版本号来自 package.json（vite define 注入），别手写常量 —— 手写就会出现
//   「面板显示新版本、包还是旧的」两个真相（技能 wps-addin 明写过的坑）。
const APP_VER = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0'
const BRIDGE = 'http://127.0.0.1:8791'
const CFG_KEY = 'shiptrack_cfg_v4'
const LAST_RUN_KEY = 'shiptrack_lastrun_v3'
const AUTO_MS = 24 * 60 * 60 * 1000
// 跨文档闸门：同时开 6 个工作簿时，别让每个面板各跑一轮（2026-10-26 巨卡就是这个）
const GLOBAL_RUN_KEY = 'shiptrack_lastrun_global_v1'
const AUTO_MAX_ROWS = 50          // 自动刷新单次最多查 50 行，其余手动

import { markRaw } from 'vue'
import { cleanNumber, looksLikeNumber, splitParts, carrierFromSl, looksLikeCarrierToken } from '../lib/cellparse.js'
import { zhEvent, cleanCity } from '../lib/events.js'
import { stageOf, STAGE_COLOR, NO_FILL, STAGE_LABEL } from '../lib/milestone.js'
import { matchPortHeaders, matchDateHeaders, matchNumberHeaders } from '../lib/headers.js'
import { pickEtdEta } from '../lib/dates.js'
// ★ 10-30：读回校验的口径只有一份（lib/cellwrite.js）—— 批量路径与逐格路径共用，
//   以前逐格用裸比较、批量用归一化，日期列/数值列走逐格必然误判「补不进去」。
import { cellMatches, judgeReadback, writeCellCore, cellText } from '../lib/cellwrite.js'
import { planVesselVoyage, mergeBlockOf, mergeSkipText, isVbaTrue, canUseMergeFastPath, mergeVerdict, findMovedValue } from '../lib/writeplan.js'   // ★ 11-10：船名/航次同列 + 合并格 + VBA 布尔
import { summarize as summarizeFails, classifyFail } from '../lib/fail.js'
// ★ 卡 t_8a6689dc：canonical 契约（schemaVersion）闸门 + 单元格文案的唯一实现
import { checkResultSchema, PLUGIN_SCHEMA_VERSION } from '../lib/contract.js'
import { CARRIER_NAME } from '../lib/render.js'
// ★ 卡 t_aa0674a9：派活的三条护栏（doc 校验 / 战果汇总 / 该不该领活）——纯函数，可单测
import { decideBeforeRun, summarizeRun, shouldClaim } from '../lib/jobguard.js'   // ★ t_cec031c1：只借船司短名表，文案逻辑已搬进引擎
// ★ 11-03 爹地原话「写入 ETD/ETA，请加一个按钮来确认吧，不要静默替换」：
//   船期写回的判据与文案全在 lib/schedask.js（纯函数 + 可单测），组件只负责收集 / 出条 / 确认后写。
import { decideScheduleWrite, shortDateText, summarizeAsk } from '../lib/schedask.js'
// ★ t_a72fba24：识别结果的落 cfg 规则（纯函数，可单测）：样本规整 / 首认知情 / 变化检测
import { sampleToMatrix, cfgFromDetection, compareToConfirmed, needsPreview, previewText, positionsOf } from '../lib/detectcols.js'

const colLetter = (n) => {
  let s = ''
  let x = Number(n)
  while (x > 0) {
    const m = (x - 1) % 26
    s = String.fromCharCode(65 + m) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}
// 全角 → 半角（用户手打单号常带全角字母/数字/空格）
const toHalf = (s) => String(s == null ? '' : s)
  .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  .replace(/\u3000/g, ' ')
// 单号比对用的唯一归一化口径：全角转半角 + 去空白/连字符 + 大写
const normNum = (s) => cleanNumber(toHalf(s))

export default {
  name: 'TaskPane',
  data() {
    return {
      bridge: false,
      pinged: false,
      bridgeState: '',   // '' | ok | down | blocked | degraded —— 横幅文案按它分支（10-29）
      bridgeWhy: '',     // 桥自报 / 页面侧的真实原因，直接给人看
      // ★ 卡 t_8a6689dc：桥自报的 canonical 契约版本 + 认不了结果时的横幅（null=没有横幅）
      bridgeSchema: null,
      schemaAlert: null,
      // ★ 0.9.43：busy / items / done / total … 全部下沉到「批次」里（同一工作簿多张表可以各跑各的）。
      //   这里只剩面板级状态；批次级的读写一律走 batches[] 里那一个对象。
      batches: [],         // 批次队列：{id, seq, doc, sheet, cfg 快照, items, done, total, state, stop, errs, …}
      viewBatchId: '',     // 当前正在看的是哪一批（批次条上点一下就切）
      seq: 0,              // 批次序号（写回顺序按它排：先跑的批次先写）
      docNow: '',          // 活动表（轮询得到，用于「切表就看那一批」这类推导）
      histOpen: false,     // ★ 0.9.45 历史批次是否展开（默认折叠，主条只留「在跑 / 当前」）
      clock: Date.now(),   // ★ 0.9.45 相对时间（「3 分钟前」）的刷新节拍，30s 一次
      writeFailLog: [],    // ★ 0.9.45 真写不进的格子（环形缓冲，最近 200 条，可导出）
      panelErr: '',        // 面板级错误（选列失败 / 配置异常 / 补齐结果）；批次自己的错误在 batch.errs 里
      flushing: false,
      pendingWrites: [],   // ★ 10-28：切表期间查到的结果先攒着，切回来点「补齐回填」再写，不整轮作废
      diag: '',
      cfg: { numberCol: 0, outCol: 0, startRow: 0, rows: 0, mode: 'column', carrierCol: 0, polCol: 0, podCol: 0, vesselCol: 0, voyageCol: 0 },
      // ★ t_a72fba24：行列自动识别。detected = 最近一次识别结果；detectedSig = 签名（比变化用）
      detected: null,
      detectedSig: '',
      detecting: false,
      // ★ 中置信首次：结果只在面板预览，一格都不写，等他一键「就对」
      previewAsk: null,     // { batchId, numCol, outCol, rows }
      // ★ 每次识别 vs 上次确认配置：列变了才提示一次
      cfgConflict: null,    // { text, det }
      moreOpen: false,      // 「更多设置 ▾」是否展开（默认收起，猜错才展开）
      scan: null,
      readVia: '',
      writeVia: '',
      apiReport: null,
      flashT: null,
      carriers: null,
      upd: { checked: false, enabled: false, has: false, ver: '', local: '', busy: false, msg: '' },
      net: null,
      retryTimer: null,
      retryCount: 0,
      aborts: new Set(),
      lastRun: 0,
      autoOn: true,
      timer: null,
      xsheetProbe: null,   // ★ 0.9.43 启动时对别的工作表做一次只读探针（不写不建不删）
      jobBusy: false,      // ★ t_aa0674a9：App 派下来的任务正在跑（同一面板只跑一个）
      jobIdNow: '',        // 正在跑的任务 id（日志/界面用）
      // ★ 11-03：ETD/ETA 一律先收集、不写。schedQueue = 本批还没交出去的变更；
      //   schedAsks = 已收尾、等用户点确认的那几批（一格都还没写）
      schedQueue: [],
      schedAsks: [],
      schedAuto: false     // 确认条上「本表以后直接写」的勾选状态
    }
  },
  computed: {
    // ---------- ★ 0.9.43 批次视图层 ----------
    // 模板、横幅、进度条全部按「当前正在看的那一批」读；批次队列本身是真身。
    // 这样「切到另一张表再点③」不会覆盖上一批的进度，两批各走各的。
    vb() {
      const b = this.viewBatchId ? this.batchById(this.viewBatchId) : null
      if (b) return b
      // 切到哪张表就看那张表最近的一批；没跑过就空着（绝不把别的表的行显示成这张表的）
      const d = this.docNow || this.docKey()
      const mine = this.batches.filter((x) => x.doc === d)
      return mine.length ? mine[mine.length - 1] : null
    },
    items() {
      return this.vb ? this.vb.items : []
    },
    /** ★ 11-03：当前这张表等着确认的那一批船期变更（别的表的不在这儿显示，切回去才出条） */
    schedAsk() {
      if (!this.schedAsks || !this.schedAsks.length) return null
      const d = this.docNow || this.docKey()
      const mine = this.schedAsks.filter((x) => x.doc === d)
      return mine.length ? mine[0] : null
    },
    /** 条上的数字与差异列表（前 5 条） */
    schedView() {
      const a = this.schedAsk
      return a ? (a.sum || summarizeAsk(a.items)) : null
    },
    /** 「这张表现在有没有一批在跑」——按当前活动表判断，不受「正在看哪一批」影响 */
    busy() {
      return this.runningForDoc(this.docNow || this.docKey()).length > 0
    },
    done() {
      return this.vb ? this.vb.done : 0
    },
    total() {
      return this.vb ? this.vb.total : 0
    },
    runStart() {
      return this.vb ? this.vb.start : 0
    },
    runSummary() {
      return this.vb ? this.vb.summary : ''
    },
    writeStats() {
      return this.vb ? this.vb.writeStats : null
    },
    writeMs() {
      return this.vb ? this.vb.writeMs : 0
    },
    actionErr() {
      return this.panelErr || (this.vb && this.vb.errs ? this.vb.errs.action : '') || ''
    },
    writeErr() {
      const n = this.writeNote
      return n ? n.text : ''
    },
    /**
     * ★ 0.9.45 写回三态各一句，别再用「写入失败 N 格（批量写不可用，退回逐格也没写进）」
     * 把三种完全不同的病根糊成一句（爹地 10-29 截图那条就是它）：
     *   fail  → 真写不进（表保护 / 只读 / 读回不一致）→ 红色，指向「诊断」
     *   defer → 跨表暂时攒着，切回原表自动补 → 黄色，不当错误
     *   fallback → 批量写路径不认，已逐格写进去了 → 黄色，只是交代路径
     * defer 的条数直接读「活着」的 pendingWrites，补齐了就自动消失，不留僵尸红条。
     */
    writeNote() {
      const b = this.vb
      const note = b && b.writeNote
      if (note && note.fail > 0) {
        const ex = note.failEx
        const at = ex && ex.row ? `R${ex.row} ${ex.col} 列 ` : ''
        // ★ 10-30：失败要分两种说，别一律甩「表可能被保护/只读」——
        //   「读回不一致」是写入判定的事，跟保护无关，说成保护会把人引到错的路上（误报红条就是这么来的）。
        if ((note.rbp || 0) > 0 && !((note.com || 0) > 0)) {
          return { kind: 'err', text: `${note.fail} 格没写进去：${at}写入 ${ex ? ex.wrote : ''} / 读回 ${(ex && ex.back) || '空'}（赋值没生效，不是表保护）—— 点「诊断」看具体行` }
        }
        if ((note.com || 0) > 0 && !((note.rbp || 0) > 0)) {
          return { kind: 'err', text: `${note.fail} 格补不进去（表可能被保护/只读）—— 点「诊断」看具体行` }
        }
        return { kind: 'err', text: `${note.fail} 格补不进去：${note.com || 0} 格是写入抛异常、${note.rbp || 0} 格是读回没变 —— 点「诊断」看具体行` }
      }
      const pend = this.pendingWrites.length
      if (pend > 0) {
        return { kind: 'warn', text: `已有 ${pend} 格结果暂存，切回原表自动补` }
      }
      // ★ 10-30：写进去了、只是读回形态不同（日期被转 Date、数值被格式化）—— 黄条交代一句就够
      if (note && (note.fmt || 0) > 0) {
        const ex = note.fmtEx
        const at = ex ? `R${ex.row} ${ex.col} 列` : ''
        return { kind: 'warn', text: `${note.fmt} 格写入成功但读回格式不同（${at}写入 ${ex ? ex.wrote : ''} / 读回 ${ex ? ex.back : ''}）—— 值已经在表里，不用重写` }
      }
      if (note && note.fbRows > 0) {
        return { kind: 'warn', text: `批量写不认，已逐格写入（成功 ${note.fbOk}）` }
      }
      const legacy = (b && b.errs ? b.errs.write : '') || ''
      return legacy ? { kind: 'err', text: legacy } : null
    },
    capErr() {
      return this.vb ? (this.vb.capErr || '') : ''
    },
    misalign() {
      return this.vb ? this.vb.misalign : 0
    },
    hasRunning() {
      return this.batches.some((b) => b.state === 'running')
    },
    hasQueued() {
      return this.batches.some((b) => b.state === 'queued')
    },
    showChips() {
      return !!(this.mainBatch || this.queuedCount || this.historyCount)
    },
    /**
     * ★ 0.9.45 主条只留一条：优先「正在看的 / 在跑的」，都没有就当前表最近一批，再没有就最后一批。
     * 跑完的批次一律进历史折叠区 —— 爹地 10-29 截图里堆了两条「已停」chip，散就是散在这。
     */
    mainBatch() {
      const list = this.batches.filter((b) => b.kind !== 'retry')
      const running = list.filter((b) => b.state === 'running')
      if (running.length) {
        const viewed = running.filter((b) => b.id === this.viewBatchId)[0]
        return viewed || running[running.length - 1]
      }
      const d = this.docNow || ''
      const finished = (arr) => arr.filter((b) => b.state === 'done' || b.state === 'stopped' || b.state === 'error')
      const mine = list.filter((b) => b.doc === d)
      const fm = finished(mine)
      if (fm.length) return fm[fm.length - 1]
      if (mine.length) return mine[mine.length - 1]
      const fa = finished(list)
      if (fa.length) return fa[fa.length - 1]
      return list.length ? list[list.length - 1] : null
    },
    /** 排队中的批次（自动重查不算，它不占批次条） */
    queuedBatches() {
      return this.batches.filter((b) => b.state === 'queued' && b.kind !== 'retry')
    },
    queuedCount() {
      return this.queuedBatches.length
    },
    /** 跑完的（完成 / 已停 / 出错）→ 历史，最近的在最前 */
    historyBatches() {
      return this.batches
        .filter((b) => b.kind !== 'retry' && (b.state === 'done' || b.state === 'stopped' || b.state === 'error'))
        .slice()
        .reverse()
    },
    historyCount() {
      return this.historyBatches.length
    },
    /** 历史最多显示最近 5 条 */
    historyShown() {
      return this.historyBatches.slice(0, 5)
    },
    // 提示语只从状态推导：不存在「设置了却没人清」的字符串
    banner() {
      if (this.capErr) {
        return { kind: 'err', text: `这张表现在写不进去：${this.capErr}。`, action: 'unprotect' }
      }
      if (this.pinged && !this.bridge) {
        // ★ 10-29：三态分开，别再用一句「没连上」把三种完全不同的病根糊在一起
        if (this.bridgeState === 'blocked') {
          return { kind: 'warn', text: '加载项被拦：桥在 8791 上活着，但这个面板发的请求被跨域/CSP 挡住 —— 查询会全部失败。重开一次加载项面板；还不行就重装加载项。', action: 'ping' }
        }
        if (this.bridgeState === 'degraded') {
          return { kind: 'err', text: `本地桥进程在跑，但自报异常：${this.bridgeWhy || 'ok:false'}`, action: 'ping' }
        }
        return {
          kind: 'warn',
          text: '本地桥进程没在跑（127.0.0.1:8791 无监听）—— 查询会全部失败。',
          cmd: this.startCmdHint,
          action: 'ping'
        }
      }
      if (this.writeNote) return { kind: this.writeNote.kind, text: this.writeNote.text, action: '' }
      // ★ 0.9.41：行身份对不上 → 横幅说清「表格行变了」，并明说这一轮的刷新时间/范围不可信
      if (this.misalign > 0) {
        return {
          kind: 'warn',
          text: `表格行变了（删/插/排序），本轮 ${this.misalign} 行结果对不上，已跳过不写 —— 点③重跑。这时的「上次刷新」时间和范围行数都不可信。`,
          action: ''
        }
      }
      if (this.actionErr) return { kind: 'err', text: this.actionErr, action: '' }
      if (this.cfg.numberCol > 0 && this.scan && this.scan.count === 0) {
        return { kind: 'warn', text: `${this.scan.rows} 行里没识别到提单号 —— 确认选的是 MBL 那一列。`, action: '' }
      }
      return null
    },
    ver() {
      return APP_VER
    },
    isWindows() {
      try { return /Windows|Win32|WOW64/i.test(String((typeof navigator !== 'undefined' && navigator.userAgent) || '')) }
      catch (e) { return false }
    },
    /** 桥没起时给一条能直接粘进终端/PS 的命令（mac / win 各一条，按宿主平台给） */
    startCmdHint() {
      return this.isWindows
        ? '启动：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\\Documents\\trae_projects\\wps-shiptrack\\bridge\\start-win.ps1"'
        : '启动：~/dev/wps-shiptrack/scripts/bridge.sh start'
    },
    startCmdClean() {
      return this.startCmdHint.replace(/^启动：/, '')
    },
    ready() {
      return this.cfg.numberCol > 0 && this.cfg.outCol > 0 && this.cfg.startRow > 0 && this.cfg.rows > 0
    },
    numColText() {
      return colLetter(this.cfg.numberCol)
    },
    vesselVoyageText() {
      const v = this.cfg.vesselCol > 0 ? colLetter(this.cfg.vesselCol) : '—'
      const y = this.cfg.voyageCol > 0 ? colLetter(this.cfg.voyageCol) : '—'
      return `${v} / ${y}`
    },
    outColText() {
      return colLetter(this.cfg.outCol)
    },
    stepHint() {
      if (this.cfg.numberCol === 0) return '在表格里选中提单号那一列（整列选中也行）→ 点上面的「选单号列」'
      if (this.cfg.outCol === 0) return '选中要写结果的列 → 点上面的「选输出列」'
      return ''
    },
    carrierColText() {
      if (!this.cfg.carrierCol) return '未设置（按单号自动识别船司）'
      return colLetter(this.cfg.carrierCol) + '（SOC/COC 之类自动忽略）'
    },
    polColText() {
      return this.cfg.polCol ? colLetter(this.cfg.polCol) : '—'
    },
    podColText() {
      return this.cfg.podCol ? colLetter(this.cfg.podCol) : '—'
    },
    scanText() {
      if (!this.scan) return '正在扫描单号…'
      const { count, rows, via, samples } = this.scan
      if (!count) return `${rows} 行里没识别到提单号 —— 确认选的是 MBL 那一列`
      const eg = samples && samples.length ? '，例：' + samples.join(' / ') : ''
      return `${rows} 行里识别到 ${count} 个提单号（读法 ${via}）${eg}`
    },
    etaText() {
      if (!this.busy || !this.done || !this.runStart) return ''
      // ★ 0.9.44：跑完了不许再拼「剩约 0 秒」（爹地 97/97 截图里那行就是它）
      const left = Math.max(0, this.total - this.done)
      if (left <= 0) return ''
      const per = (Date.now() - this.runStart) / this.done
      const msLeft = left * per
      if (msLeft < 1000) return ''
      return msLeft >= 60000 ? `剩约 ${Math.round(msLeft / 60000)} 分钟` : `剩约 ${Math.round(msLeft / 1000)} 秒`
    },
    /** ★ 0.9.44：写回是独立阶段（查询 97/97 ≠ 写完了）—— 进度条上单独报「写回 43/97」 */
    writeProgText() {
      const b = this.vb
      const w = b && b.writeProg
      // 只在这一轮「查询已经跑完、正在收尾写回」时显示 —— 查询中途边查边写是常态，不必刷这条
      if (!w || !w.total) return ''
      if (!this.total || this.done < this.total) return ''
      return `写回 ${Math.min(w.done || 0, w.total)}/${w.total}`
    },
    progress() {
      return this.total ? Math.round((this.done / this.total) * 100) : 0
    },
    lastRunText() {
      if (!this.lastRun) return '从未'
      const d = new Date(this.lastRun)
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      return `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`
    }
  },
  watch: {
    // 配置补齐 / 扫描出结果时，自动清掉上一次的临时错误
    ready(v) {
      if (v) this.panelErr = ''
    },
    'scan.count'(v) {
      if (v > 0) this.panelErr = ''
    }
  },
  mounted() {
    // ★ 0.9.42 写回层状态：批量写队列 / 我们自己刷过的颜色记账
    this.writeQ = []                    // 待写队列（入队 → 一顿攒 → 按批次一次批量写）
    this.wqTimer = null                 // 攒批定时器
    this.writing = false                // 防重入
    this.flushChain = Promise.resolve() // ★ 0.9.44 写回串行链（分段异步写回，后来的排队）
    this.flushingDocs = new Set()       // ★ 0.9.43 按表的写锁：同一张表同一时刻只许一批在写
    this.ourColor = new Map()           // `${doc}|${row}` → 我们刷的底色（清色只清自己的）
    this.inflight = 0                   // ★ 0.9.43 面板侧全局在飞请求数（硬上限，不只靠桥排队）
    this.slotWaiters = []
    this.cellSeq = new Map()            // `${doc}|${row}|${col}` → 最后写它的批次序号（后写覆盖前写）
    this.docNow = this.docKey()
    this.diagDump()
    this.ping()
    this.loadCarriers()
    this.hydrateCfg()
    this.loadCfg()
    this.checkUpdate()
    this.checkNet()
    this.probeCrossSheet()  // ★ 0.9.43 只读探针：别的表能不能被读写（(a)/(b) 自答，不写不建不删）
    this.armRetryTimer()   // 重开文件时把上次没查到的队列接上
    // 自动刷新：延迟 10s 再判（WPS 刚启动时先让它把文档加载完），且全机只允许一个文档跑
    setTimeout(() => this.maybeAutoRefresh(), 10000)
    this.timer = setInterval(() => this.maybeAutoRefresh(), 60 * 60 * 1000)
    // ★ 10-28：切表期间暂存的结果，一旦检测到已回到原表就自动补齐 —— 用户不用点（「简化优先」）
    this.flushTimer = setInterval(() => this.autoFlushWhenBack(), 2500)
    // ★ 0.9.43：切到别的工作表要按那张表载入自己的列设置（不然多表并行会用错的列写错的表）
    this.docTimer = setInterval(() => this.watchDocChange(), 900)
    // ★ 0.9.45 批次条上的「3 分钟前」得自己走：30s 一个节拍就够（只重算文案，不碰 COM）
    this.clockTimer = setInterval(() => { this.clock = Date.now() }, 30000)
  },
  beforeUnmount() {
    try { clearTimeout(this.retryTimer) } catch (e) { /* ignore */ }
    try { clearTimeout(this.wqTimer) } catch (e) { /* ignore */ }
    if (this.timer) clearInterval(this.timer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.docTimer) clearInterval(this.docTimer)
    if (this.clockTimer) clearInterval(this.clockTimer)
  },
  methods: {
    app() {
      return window.Application
    },
    // 短暂提示：给「点错列」这类操作反馈，几秒后自动消失，不会变成僵尸红条
    flash(msg, ms = 6000) {
      this.panelErr = msg
      clearTimeout(this.flashT)
      this.flashT = setTimeout(() => {
        if (this.panelErr === msg) this.panelErr = ''
      }, ms)
    },
    log(msg) {
      const t = new Date().toLocaleTimeString()
      this.diag = `${t}  ${msg}\n` + this.diag
    },

    // ================= ★ 0.9.43 批次队列 =================
    // 为什么要有批次：busy 是个布尔值时，「点③ → 切到另一张表 → 再点③」第二条直接被静默吃掉。
    // 现在每点一次③开一批，批次自带 {doc, sheet, cfg 快照, items, done, total, 错误} 各跑各的；
    // 写回按批次先后排队，同一张表一次只写一批（后写覆盖前写）。
    maxBatches() {
      const n = Number(window.__SHIPTRACK_MAX_BATCHES__ || 0)
      return n > 0 ? n : 3
    },
    /** 面板侧全局在飞查询硬上限（不能只靠桥排队：每个 slot 一个独立浏览器 profile，内存/CPU 是实的） */
    maxInflight() {
      const n = Number(window.__SHIPTRACK_MAX_INFLIGHT__ || 0)
      return n > 0 ? n : 4
    },
    batchById(id) {
      return this.batches.filter((b) => b.id === id)[0] || null
    },
    runningForDoc(doc) {
      return this.batches.filter((b) => b.doc === doc && b.state === 'running')
    },
    runningCount() {
      return this.batches.filter((b) => b.state === 'running').length
    },
    latestForDoc(doc) {
      const list = this.batches.filter((b) => b.doc === doc)
      return list.length ? list[list.length - 1] : null
    },
    /** 批次标签：工作表名（+ 重查标记） */
    batchLabel(b) {
      const sh = String(b.doc || '').split('|')[1] || '—'
      return (b.kind === 'retry' ? '重查·' : '') + sh
    },
    /** 相对时间：批次条上的「3 分钟前」 */
    relTime(ts) {
      const t = Number(ts || 0)
      if (!t) return ''
      const d = Math.max(0, Number(this.clock || Date.now()) - t)
      if (d < 60000) return '刚刚'
      const m = Math.floor(d / 60000)
      if (m < 60) return `${m} 分钟前`
      const h = Math.floor(m / 60)
      if (h < 24) return `${h} 小时前`
      return `${Math.floor(h / 24)} 天前`
    },
    /** ★ 0.9.45 批次标签的上下文：`起止行 · 开始时间(相对)`（工作表名和状态由模板另外两块显示） */
    batchMeta(b) {
      if (!b) return ''
      const c = b.cfg || {}
      const from = Number(c.startRow || 0)
      const n = Number(c.rows || 0)
      let range = ''
      if (from > 0) range = n > 0 ? `第${from}–${from + n - 1}行` : `第${from}行起`
      const when = b.start ? this.relTime(b.start) : (b.created ? `${this.relTime(b.created)}建的` : '')
      return [range, when].filter(Boolean).join(' · ')
    },
    /** 历史条目的展开/收起（完了一律默认折叠，别占主区域） */
    toggleHist() {
      this.histOpen = !this.histOpen
    },
    batchTitle(b) {
      const bits = [b.doc]
      if (b.cfg && b.cfg.startRow > 0) {
        const to = b.cfg.rows > 0 ? b.cfg.startRow + b.cfg.rows - 1 : ''
        bits.push(to ? `第 ${b.cfg.startRow}–${to} 行` : `第 ${b.cfg.startRow} 行起`)
      }
      if (b.start) bits.push('开始 ' + new Date(b.start).toLocaleString())
      else if (b.created) bits.push('建于 ' + new Date(b.created).toLocaleString())
      if (b.errs && b.errs.action) bits.push(b.errs.action)
      const note = this.writeNoteFor(b)
      if (note) bits.push(note)
      if (b.xsheet && (b.xsheet.ok || b.xsheet.fail)) bits.push(`跨表写 成功 ${b.xsheet.ok} / 回落 ${b.xsheet.fail}`)
      return bits.join(' · ')
    },
    stateLabel(s) {
      return ({ running: '在跑', queued: '排队', done: '完成', stopped: '已停', error: '出错' })[s] || String(s || '')
    },
    showBatch(id) {
      if (!this.batchById(id)) return
      this.viewBatchId = id
      this.panelErr = ''
    },
    // ★ 0.9.43：批次摘要对测试/排障可见。别用 deep watch —— deep 会遍历整个批次对象，
    //   连 Worksheet 的 getter 都会被摸到（每摸一次一次同步 COM，实测一轮多出 219 次）。
    //   改成在关键点显式发一次，成本 = 一次 map。
    publishBatches() {
      try {
        window.__SHIPTRACK_BATCHES__ = this.batches.map((b) => ({
          id: b.id, doc: b.doc, state: b.state, done: b.done, total: b.total,
          kind: b.kind || 'run', xsheet: { ok: b.xsheet.ok, fail: b.xsheet.fail }
        }))
      } catch (e) { /* 非浏览器环境忽略 */ }
    },
    /** 新建一个批次对象（真身：所有可变的进度/错误都挂在它身上） */
    newBatch({ doc, sheet, cfg, items = [], queue = [], kind = 'run', manual = false }) {
      const seq = ++this.seq
      return {
        id: 'b' + seq, seq, kind, manual,
        doc,
        // ★ 关键：WPS 的 Worksheet 对象绝不能塞进响应式数据 —— Vue 的代理会去摸它的 getter
        //   （UsedRange 之类），每摸一次就是一次同步 COM，实测直接把写回阶段拖成几百次 COM。
        sheet: sheet ? markRaw(sheet) : null,
        cfg: { ...cfg },
        items, queue: queue.slice(),
        done: 0, total: queue.length,
        start: 0, state: 'queued',
        created: Date.now(),              // ★ 0.9.45 批次条上的「x 分钟前建的」（排队时还没 start）
        stop: false,
        errs: { action: '', write: '' },
        misalign: 0, misalignSeen: new Set(),
        writeStats: null, writeMs: 0,
        // ★ 0.9.45 写回三态账：fail=真写不进 / defer=跨表暂存 / fb=退回逐格（批量写不认）
        writeNote: { fail: 0, defer: 0, fbRows: 0, fbOk: 0, fmt: 0, com: 0, rbp: 0, fmtEx: null, failEx: null },
        colSnap: null, outSnap: null,
        capErr: '', summary: '',
        xsheet: { ok: 0, fail: 0, dead: false }
      }
    },
    /** 没有批次在手（手工兜底写回、重查）时，按当前表补一个最小批次，保证写回仍然只有一个入口 */
    ensureBatch(sheet) {
      const doc = this.docKey()
      const cur = this.vb
      if (cur && cur.doc === doc) return cur
      const nb = this.newBatch({ doc, sheet, cfg: this.cfg, items: this.items || [], kind: 'misc' })
      nb.capErr = ''
      nb.state = 'done'
      this.batches.push(nb)
      this.publishBatches()
      const live = this.batchById(nb.id) || nb
      this.viewBatchId = live.id
      return live
    },
    /** 跑完/停止的批次不用永远留着：历史只留最近 5 批（界面默认折叠，够回看） */
    pruneBatches() {
      const done = this.batches.filter((b) => b.state === 'done' || b.state === 'stopped')
      if (done.length <= 5) return
      const drop = new Set(done.slice(0, done.length - 5).map((b) => b.id))
      this.batches = this.batches.filter((b) => !drop.has(b.id))
      this.publishBatches()
      if (drop.has(this.viewBatchId)) this.viewBatchId = ''
    },
    /** 队列里排着的批次：有位置了就开跑（一个格子空出来就跑一批） */
    pumpQueue() {
      if (this.runningCount() >= this.maxBatches()) return
      const next = this.batches.filter((b) => b.state === 'queued' && b.kind !== 'retry')[0]
      if (!next) return
      this.runBatch(next)
    },
    /** ★ 0.9.43 切表检测：活动表变了就按那张表重载列设置；正在跑的批次不受影响（用的是自己的快照） */
    watchDocChange() {
      const d = this.docKey()
      if (!d || d === this.docNow) return
      const prev = this.docNow
      this.docNow = d
      this.panelErr = ''
      this.log(`活动表变了：${prev || '—'} → ${d}`)
      this.cfg = { numberCol: 0, outCol: 0, startRow: 0, rows: 0, mode: 'column', carrierCol: 0, polCol: 0, podCol: 0, vesselCol: 0, voyageCol: 0 }
      this.scan = null
      this.loadCfg()
      // ★ t_a72fba24：切到新表自动识别一次（签名没变时 applyDetection 不覆盖用户手改的列）
      this.detectNow()
      const mine = this.latestForDoc(d)
      this.viewBatchId = mine ? mine.id : ''
    },
    /**
     * ★ 0.9.43 (a)/(b) 自答探针：对「活动工作簿里第 2 张表」做一次**只读**取值。
     * 不写、不建、不删 —— 失败只记日志。真正的判据是写回时 crossSheetWrite.ok/fail 的计数：
     *   ok>0 → 这个 WPS 版本能写非活动表（跨表并行写成立）
     *   fail>0 → 不能（自动回落「攒着等切回去」，代码已在保守路径上，不用改）
     */
    probeCrossSheet() {
      const out = { sheets: 0, other: '', readable: false, sample: '', err: '' }
      try {
        const a = this.app()
        if (!a) { out.err = 'no-application'; }
        else {
          const wb = a.ActiveWorkbook
          const count = Number((wb && wb.Sheets && wb.Sheets.Count) || 0)
          out.sheets = count
          if (count >= 2) {
            const sh2 = wb.Sheets.Item(2)
            out.other = String((sh2 && sh2.Name) || '')
            const v = sh2.Range('A1').Value2
            out.readable = true
            out.sample = String(v == null ? '' : v).slice(0, 20)
          }
        }
      } catch (e) {
        out.err = String((e && e.message) || e).slice(0, 80)
      }
      this.xsheetProbe = out
      try { window.__SHIPTRACK_CROSS__ = { ...this.xsheetProbe } } catch (e) {}
      this.log(`跨表只读探针：${out.sheets || 0} 张表 · 第2张=${out.other || '—'} · 读取=${out.readable ? '可用' : (out.err || '单表/无')}`)
    },
    /** 跨表写计数也暴露出来（真机跑一轮多表后抄这两个数就是 (a)/(b) 的实测答案） */
    publishCross(b) {
      const sum = { ok: 0, fail: 0 }
      for (const x of this.batches) { sum.ok += (x.xsheet && x.xsheet.ok) || 0; sum.fail += (x.xsheet && x.xsheet.fail) || 0 }
      try {
        window.__SHIPTRACK_CROSS__ = { ...sum, probe: this.xsheetProbe, last: b ? { ...b.xsheet } : null }
      } catch (e) {}
    },
    /** 全局在飞查询槽位（面板侧硬上限：多批并行时不是无限开浏览器） */
    async acquireSlot() {
      if (this.inflight < this.maxInflight()) { this.inflight++; return }
      await new Promise((res) => this.slotWaiters.push(res))
      this.inflight++
    },
    releaseSlot() {
      this.inflight = Math.max(0, this.inflight - 1)
      const w = this.slotWaiters.shift()
      if (w) setTimeout(w, 0)
    },

    // ---------- 配置持久化（PluginStorage 优先，回退 localStorage） ----------
    storage() {
      const a = this.app()
      try {
        if (a && a.PluginStorage) return a.PluginStorage
      } catch (e) {}
      return null
    },
    docKey() {
      const a = this.app()
      try {
        const wb = a.ActiveWorkbook && a.ActiveWorkbook.Name
        const sh = a.ActiveSheet && a.ActiveSheet.Name
        return String(wb || '') + '|' + String(sh || '')
      } catch (e) {
        return ''
      }
    },
    /** ★ 10-30：当前这张表的 doc / sheet 两段（台账要能事后定位到具体行，别只有内存里的日志） */
    docSheetOf(b) {
      const key = String((b && b.doc) || this.docKey() || '')
      const parts = key.split('|')
      return { doc: parts[0] || '', sheet: parts[1] || '' }
    },
    /** ★ 0.9.43：读「别的表」已落盘的配置（批次跑的是别的表时，重查队列要写回那张表的配置） */
    loadStoredCfg(doc) {
      const key = CFG_KEY + ':' + doc
      let raw = null
      try {
        const st = this.storage()
        raw = st ? st.getItem(key) : null
      } catch (e) {}
      if (!raw) {
        try { raw = localStorage.getItem(key) } catch (e) {}
      }
      if (!raw) return null
      try { return JSON.parse(raw) } catch (e) { return null }
    },
    loadCfg() {
      let raw = null
      const st = this.storage()
      const key = CFG_KEY + ':' + this.docKey()
      try {
        raw = st ? st.getItem(key) : null
      } catch (e) {}
      if (!raw) {
        try {
          raw = localStorage.getItem(key)
        } catch (e) {}
      }
      if (raw) {
        try {
          this.cfg = { ...this.cfg, ...JSON.parse(raw) }
          this.log(`配置已载入（${this.docKey()}）`)
        } catch (e) {
          this.log('配置解析失败: ' + e.message)
        }
      }
      if (this.cfg.numberCol > 0) this.scanColumn()
      try {
        const lrKey = LAST_RUN_KEY + ':' + this.docKey()
        const lr = st ? st.getItem(lrKey) : localStorage.getItem(lrKey)
        if (lr) this.lastRun = Number(lr) || 0
      } catch (e) {}
    },
    saveCfg(doc, cfgObj) {
      const obj = cfgObj || this.cfg
      const raw = JSON.stringify(obj)
      const d = doc || this.docKey()
      const key = CFG_KEY + ':' + d
      const st = this.storage()
      try {
        if (st) st.setItem(key, raw)
      } catch (e) {
        this.log('PluginStorage 写入失败: ' + e.message)
      }
      try {
        localStorage.setItem(key, raw)
      } catch (e) {}
      this.log(`配置已保存（${d}）: ` + raw)
      // 落盘到桥（WPS 重启/换会话都还在）
      try {
        if (typeof fetch === 'function') {
          fetch(this.base() + '/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc: d, cfg: obj })
          }).catch(() => {})
        }
      } catch (e) {}
    },
    saveLastRun(ts, doc) {
      const d = doc || this.docKey()
      if (d === this.docNow || !this.docNow) this.lastRun = ts
      const st = this.storage()
      const key = LAST_RUN_KEY + ':' + d
      try {
        if (st) st.setItem(key, String(ts))
      } catch (e) {}
      try {
        localStorage.setItem(key, String(ts))
      } catch (e) {}
    },
    resetCfg() {
      // 注意：真实 key 是 CFG_KEY + ':' + docKey()，原来清的是裸 CFG_KEY → 什么都没清掉
      const key = CFG_KEY + ':' + this.docKey()
      this.cfg = { numberCol: 0, outCol: 0, startRow: 0, rows: 0, mode: 'column', carrierCol: 0, polCol: 0, podCol: 0, vesselCol: 0, voyageCol: 0 }
      this.scan = null
      this.saveLastRun(0)
      const st = this.storage()
      try { if (st) st.setItem(key, '') } catch (e) {}
      try { localStorage.removeItem(key) } catch (e) {}
      // 桥端也清掉，否则重开面板会被 hydrateCfg 又恢复回来
      try {
        fetch(this.base() + '/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc: this.docKey(), cfg: {} })
        }).catch(() => {})
      } catch (e) {}
      this.panelErr = ''
      this.log('配置已清空（含桥端）')
    },

    // ---------- 选区 ----------
    readSel() {
      const a = this.app()
      if (!a) throw new Error('window.Application 不存在（没跑在 WPS 里）')
      const sel = a.Selection
      if (!sel) throw new Error('当前没有选区')
      const col = Number(sel.Column)
      const row = Number(sel.Row)
      if (!col || !row) throw new Error('当前没有选中表格单元格 —— 先在表格里点一个格子，再点选列')
      let rows = (sel.Rows && sel.Rows.Count) || 1
      let lastUsed = 0
      try {
        const ur = a.ActiveSheet.UsedRange
        lastUsed = (ur.Row || 1) + ((ur.Rows && ur.Rows.Count) || 1) - 1
      } catch (e) {}
      if (lastUsed && row) rows = Math.min(rows, Math.max(0, lastUsed - row + 1))
      if (rows > 2000) {
        this.log(`选区 ${rows} 行超过上限，只处理前 2000 行`)
        rows = 2000
      }
      return { col, row, rows, rawRows: (sel.Rows && sel.Rows.Count) || 1, nCols: (sel.Columns && sel.Columns.Count) || 1 }
    },

    pickNumberCol() {
      this.panelErr = ''
      try {
        const s = this.readSel()
        const sheet = this.app().ActiveSheet
        if (this.runningForDoc(this.docKey()).length) this.log('这张表正在查询：改配置只影响下一轮，本轮按开始时快照跑')
        const { r1, r2, how, mode } = this.resolveRange(s, sheet)
        this.cfg = { ...this.cfg, numberCol: s.col, startRow: r1, rows: Math.max(1, r2 - r1 + 1), mode, detManual: true, detConfirmed: null }
        this.saveCfg()
        this.log(`单号列 = ${colLetter(s.col)} · 第 ${r1}–${r2} 行（${how}）`)
        this.scan = null
        this.scanColumn()          // 立刻给反馈：这列里认出了几个提单号
        this.detectHeaderCols(sheet)
        // 同理：选完单号列也不自动开跑，避免刚点完就满屏刷新
        if (this.cfg.outCol > 0) this.log('两步都选好了 → 点 ③ 立即刷新 开始查询')
      } catch (e) {
        this.panelErr = '选单号列失败：' + e.message
      }
    },

    // 用户选什么就用什么；只对「整列/单格」两种极端做收敛，不预设任何列或起始行
    resolveRange(sel, sheet) {
      // ★ 0.9.41：整列时末行按「该单号列最后一个非空行」算（别用整表 UsedRange，会把空行也圈进来）
      const usedLast = this.numberLastRow(sheet, this.usedLastRow(sheet), sel.col)
      const raw = sel.rawRows || sel.rows || 1
      // 「整列/单格」= 跟着表长；明确框选 = 只认这个范围，一次定死
      const wholeColumn = raw <= 1 || raw >= 1000
      let r1 = sel.row || 1
      let r2 = r1 + (sel.rows || 1) - 1
      let how = `按选区 ${sel.rows} 行（固定范围）`
      if (wholeColumn) {
        r1 = 1
        r2 = usedLast
        how = `整列 → 跟随单号列已用末行 ${usedLast}`
      } else if (r2 > usedLast) {
        r2 = usedLast
        how = `按选区 ${sel.rows} 行（收到已用区末行）`
      }
      if (r2 < r1) r2 = r1
      return { r1, r2, how, mode: wholeColumn ? 'column' : 'range' }
    },

    pickVesselCol() { this.pickExtraCol('vesselCol', '船名') },
    pickVoyageCol() { this.pickExtraCol('voyageCol', '航次') },
    /** 选「额外结果列」（船名/航次）—— 撞单号列/输出列直接拒，别把提单号覆盖掉 */
    pickExtraCol(field, label) {
      try {
        const s = this.readSel()
        if (s.col === this.cfg.numberCol || s.col === this.cfg.outCol) {
          this.flash(`${label}列不能和单号列/输出列相同（${colLetter(s.col)}）`)
          return
        }
        // ★ 2026-11-10：船名列 = 航次列是**允许**的（爹地的表就一格放「船名 航次」）。
        //   同列时回填只写一次拼接值，不会互相覆盖 —— 这里只提示一句，不拦。
        const other = field === 'vesselCol' ? this.cfg.voyageCol : this.cfg.vesselCol
        const sameCol = Number(other || 0) === Number(s.col)
        this.cfg = { ...this.cfg, [field]: s.col, detManual: true, detConfirmed: null }
        this.saveCfg()
        this.log(sameCol
          ? `${label}列 = ${colLetter(s.col)}（和另一列同一格 → 回填「船名 航次」一次写进去）`
          : `${label}列 = ${colLetter(s.col)}（查到才写，查不到保留原值）`)
        this.panelErr = ''
      } catch (e) {
        this.panelErr = `选${label}列失败：` + e.message
      }
    },
    pickCarrierCol() {
      try {
        const s = this.readSel()
        if (s.col === this.cfg.numberCol || s.col === this.cfg.outCol) {
          this.flash('船司列不能和单号列/输出列相同')
          return
        }
        this.cfg = { ...this.cfg, carrierCol: s.col }
        this.saveCfg()
        this.log(`船司列 = ${colLetter(s.col)}（会自动忽略 SOC/COC 等字样）`)
        this.panelErr = ''
      } catch (e) {
        this.panelErr = '选船司列失败：' + e.message
      }
    },

    // 表头自动认列：起运港(POL) + 目的港(POD)
    // 不假设固定列位/固定表头行：往上扫 3 行、横向扫 60 列，关键词打分（含中英文、合并表头）。
    // 认不出就不硬判——执行期用事件本身推断起讫港（见 milestone.stageOf 的 inferred 兜底）。
    detectHeaderCols(sheet) {
      this.detectCarrierCol(sheet)
      // 以前这里「港口列已认出就直接 return」→ 单号两列/船期列永远不会再认
      // （爹地 2026-10-28：表格有提单号+订舱号两列，插件完全没提取订舱号）
      const needPort = !(this.cfg.polCol && this.cfg.podCol)
      const needNum = !(this.cfg.blCol && this.cfg.bkCol)
      const needDate = !(this.cfg.etdCol && this.cfg.etaCol)
      if (!needPort && !needNum && !needDate) return
      const baseRow = Math.max(1, this.cfg.startRow)
      const rows = [baseRow, baseRow - 1, baseRow - 2].filter((r) => r >= 1)
      let pol = this.cfg.polCol, pod = this.cfg.podCol, hitRow = 0
      let dateHit = !!(this.cfg.etdCol && this.cfg.etaCol)
      let numHit = !!this.cfg.altCol
      for (const row of rows) {
        let vals = []
        try {
          vals = this.flattenValues(sheet.Range(`${this.addr(row, 1)}:${this.addr(row, 60)}`).Value2, 60)
        } catch (e) { vals = [] }
        const cells = []
        for (let c = 1; c <= 60; c++) {
          let t = String(vals[c - 1] !== undefined ? vals[c - 1] : '').trim()
          if (!t) { try { t = String(this.readOne(sheet, row, c) || '').trim() } catch (e) { t = '' } }
          cells.push(t)
        }
        let m = matchPortHeaders(cells)
        let cellsUsed = cells
        if (!m.pol || !m.pod) {
          // 批量读法在某些 WPS 版本上只回第一格 → 逐格再读一遍兜底
          const cells2 = []
          for (let c = 1; c <= 60; c++) {
            let t = ''
            try { t = String(this.readOne(sheet, row, c) || '').trim() } catch (e) { t = '' }
            cells2.push(t)
          }
          const m2 = matchPortHeaders(cells2)
          m = { pol: m.pol || m2.pol, pod: m.pod || m2.pod, scores: m2.scores }
          cellsUsed = cells2
        }
        // 单号两列（提单号 / 订舱号）：另选一列做「第二查询」
        if (needNum) {
          const mn = matchNumberHeaders(cellsUsed)
          const main = this.cfg.numberCol
          const cand = [mn.bl, mn.bk].filter((c) => c && c !== main)
          if (mn.bl || mn.bk) this.cfg = { ...this.cfg, blCol: mn.bl || this.cfg.blCol || 0, bkCol: mn.bk || this.cfg.bkCol || 0 }
          if (cand.length) {
            this.cfg = { ...this.cfg, altCol: cand[0] }
            numHit = true
            this.saveCfg()
            this.log(`第二单号列 = ${colLetter(cand[0])}（另一个号也会查，取更新的动态）`)
          }
        }
        // 船期列（ETD/ETA）：用最终读到的表头格来认
        if ((!this.cfg.etdCol || !this.cfg.etaCol) && !dateHit) {
          const md = matchDateHeaders(cellsUsed)
          if (md.etd) this.cfg = { ...this.cfg, etdCol: md.etd }
          if (md.eta) this.cfg = { ...this.cfg, etaCol: md.eta }
          if (md.etd || md.eta) { dateHit = true; this.saveCfg() }
        }
        if (!pol && m.pol) { pol = m.pol; hitRow = row }
        if (!pod && m.pod) { pod = m.pod; hitRow = hitRow || row }
        if (pol && pod) break
      }
      if (needPort && (pol || pod)) {
        this.cfg = { ...this.cfg, polCol: pol, podCol: pod }
        this.saveCfg()
        this.log(`港口列：起运 ${pol ? colLetter(pol) : '—'} · 目的 ${pod ? colLetter(pod) : '—'}（表头第 ${hitRow || baseRow} 行）`)
      } else if (needPort) {
        this.log('表头没认出 POL/POD → 改用事件本身推断起讫港（兜底）')
      }
    },

    // ══ ★ t_a72fba24：行列自动识别（表头语义 + 内容特征 + 同格/分格 + 置信分层）══
    // 架构约束：桥是 Node 读磁盘，WPS 里未保存的表它看不见 → 样本只能由这里用 COM 读出来喂过去。
    // 规则库在桥侧（bridge/detect-columns.mjs + engine/tracking/detect.mjs），插件不另写一份。
    colLetter(n) {
      let s = ''
      let x = Number(n) || 0
      while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26) }
      return s
    },

    /** 一次 COM 读 A1:AZ30（30 行 × 52 列），转成二维字符串矩阵 */
    readSampleGrid(sheet, maxRows = 30, maxCols = 52) {
      const a1 = `A1:${this.addr(maxRows, maxCols)}`
      let raw = null
      try { raw = sheet.Range(a1).Value2 } catch (e) {
        this.log('读样本失败：' + String((e && e.message) || e).slice(0, 80))
        return []
      }
      if (raw == null) return []
      const str = (v) => (v == null ? '' : (typeof v === 'string' ? v : String(v)))
      if (!Array.isArray(raw)) return [[str(raw)]]
      if (Array.isArray(raw[0])) return raw.map((r) => (Array.isArray(r) ? r.map(str) : [str(r)]))
      return [raw.map(str)]      // 一维 = 只有一行，WPS 在单行选区会这么返回
    },

    /** 识别当前表 → 填 cfg。force=true 时即使签名没变也覆盖用户手选 */
    async detectNow({ force = false } = {}) {
      if (this.detecting || !this.bridge) return null
      let sheet = null
      try { sheet = this.app().ActiveSheet } catch (e) { return null }
      if (!sheet) return null
      this.detecting = true
      try {
        const rows = this.readSampleGrid(sheet, 30, 52)
        if (!rows.length || !rows[0] || !rows[0].length) {
          this.detected = null
          this.log('表是空的，没东西可识别')
          return null
        }
        const r = await this.httpPost('/detect-columns', { rows, sheet: sheet.Name }, 12000)
        if (!r || !r.ok) {
          this.detected = { ok: false, reason: (r && (r.reason || r.error)) || '识别失败' }
          this.log('识别失败：' + this.detected.reason)
          return null
        }
        this.detected = r
        this.log('自动识别：' + (r.reason || '') + (r.fixes && r.fixes.length ? '；' + r.fixes.join('；') : ''))
        this.applyDetection(r, { force })
        return r
      } finally {
        this.detecting = false
      }
    },

    /**
     * 识别结果 → cfg。三条硬规矩：
     *   ① 行数**按整表**算（识别只看前 30 行样本，sampleRows 不能当查询范围）
     *   ② 认出的列原样落到 cfg（认 B 就写 B），并且 store 一份「确认位置」给下次比对
     *   ③ 手工覆盖过列（detManual）就不再被自动识别盖掉，除非显式 force
     */
    applyDetection(det, { force = false } = {}) {
      if (!det || !det.ok || !det.numberCol) return null
      const sig = `${det.numberCol}|${det.outCol}|${det.vesselCol}|${det.voyageCol}|${det.vesselMode}`
      const prev = this.detectedSig
      if (!force && this.cfg.detManual) return null            // 人手动选过 → 不抢
      if (!force && prev === sig && this.cfg.numberCol > 0 && this.cfg.rows > 0) return null

      let sheet = null
      try { sheet = this.app().ActiveSheet } catch (e) { sheet = null }
      const startRow = Math.max(1, Number(det.startRow) || 1)
      let rows = 0
      try {
        if (sheet) {
          const usedLast = this.usedLastRow(sheet)
          const last = this.numberLastRow(sheet, usedLast, det.numberCol)
          rows = Math.max(1, last - startRow + 1)
        }
      } catch (e) { rows = 0 }
      if (!rows) rows = Math.max(1, Number(det.sampleRows) || 1)

      const patch = cfgFromDetection(det, { startRow, rows })
      if (!patch) return null
      this.cfg = { ...this.cfg, ...patch, detManual: false }
      this.detectedSig = sig
      this.saveCfg()
      if (prev && prev !== sig) this.log(`表格式变了（${prev} → ${sig}），已按新的来；不对可在「更多设置」里改`)
      return this.cfg
    },

    /** 预览条上的文案：「单号 B 列 · 输出 K 列 · 12 行」 */
    previewAskTextShow() { return this.previewAsk ? previewText(this.previewAsk) : '' },

    /**
     * 「就对」：把预览里的结果真正写进表格，并把这张表的格式记为确认配置。
     * 不再重查一遍 —— 结果是刚查回来的，再查一次既慢又可能被站点限流。
     */
    confirmPreview() {
      const p = this.previewAsk
      if (!p) return
      this.previewAsk = null
      const b = this.batchById(p.batchId)
      if (!b) return
      b.preview = false
      const outCol = b.cfg.outCol
      let n = 0
      for (const it of b.items) {
        if (!it.number || it.state === 'skip' || it.state === 'querying' || it.state === 'idle' || it.state === 'pending') continue
        if (it.keptOld) continue
        this.writeResult(b, it, b.sheet, it.row, outCol)
        n++
      }
      // 存为该 doc+sheet 的确认配置：之后每次识别只要结果一致就静默直写
      const pos = positionsOf(this.detected)
      if (pos && pos.numberCol) this.cfg = { ...this.cfg, detConfirmed: pos, detTier: 'auto' }
      this.saveCfg(b.doc)
      this.log(`预览确认：写入 ${n} 行；这张表的格式已记为确认配置（之后直接写，不再问）`)
    },

    /** 「先不写」：一格都不动，也不记确认配置（下次还是先预览） */
    cancelPreview() {
      this.previewAsk = null
      this.log('预览没确认：表格一格都没写')
    },

    /** 格式变了 → 按新的来：用新识别的列，继续本轮查询 */
    useNewDetect() {
      const c = this.cfgConflict
      this.cfgConflict = null
      if (c && c.det) this.applyDetection(c.det, { force: true })
      this.refresh(true, { skipDetect: true })
    },

    /** 格式变了 → 沿用旧的：按已确认的列继续，别乱改他的表 */
    keepOldDetect() {
      this.cfgConflict = null
      this.log('沿用旧的列配置（本次不按新识别的来）')
      this.refresh(true, { skipDetect: true })
    },

    // 表头自动认列：S/L、船司、船公司、CARRIER
    detectCarrierCol(sheet) {
      if (this.cfg.carrierCol) return
      const row = Math.max(1, this.cfg.startRow)
      let vals = []
      try {
        vals = this.flattenValues(sheet.Range(`${this.addr(row, 1)}:${this.addr(row, 40)}`).Value2, 40)
      } catch (e) {
        vals = []
      }
      // 批量读法在个别版本只回首格 → 表头通常在前 40 列，逐格补读一次（只在未配置时执行）
      if (vals.length < 2) {
        vals = []
        for (let c = 1; c <= 40; c++) {
          try { vals.push(this.readOne(sheet, row, c)) } catch (e) { vals.push('') }
        }
      }
      for (let c = 1; c <= 40; c++) {
        const raw = vals[c - 1] !== undefined ? vals[c - 1] : this.readOne(sheet, row, c)
        const t = String(raw == null ? '' : raw).trim()
        if (/^(S\s*\/\s*L|SL|船司|船公司|船东|CARRIER|LINE)$/i.test(t)) {
          this.cfg = { ...this.cfg, carrierCol: c }
          this.saveCfg()
          this.log(`自动认到船司列：${colLetter(c)}（表头「${t}」）`)
          return
        }
      }
      this.log('没找到船司列表头（S/L / 船司 / CARRIER），可按「船司列（可选）」手动选')
    },

    // 只扫不发请求：让用户点完 ① 立刻知道「选对了没」
    scanColumn() {
      try {
        const sheet = this.app().ActiveSheet
        const r1 = this.cfg.startRow
        const r2 = this.cfg.startRow + this.cfg.rows - 1
        const read = this.readRangeValues(sheet, this.cfg.numberCol, r1, r2)
        if (!read.values.length) {
          this.scan = { count: 0, rows: r2 - r1 + 1, via: '读不出', samples: [] }
          return
        }
        const nums = read.values.flatMap((v) => splitParts(v).map(cleanNumber)).filter(looksLikeNumber)
        this.scan = { count: nums.length, rows: r2 - r1 + 1, via: read.via, samples: nums.slice(0, 3) }
        this.log(`扫描 ${colLetter(this.cfg.numberCol)} 第 ${r1}–${r2} 行：识别 ${nums.length} 个提单号`)
      } catch (e) {
        this.scan = null
        this.log('扫描失败: ' + e.message)
      }
    },

    // 表实际用到的末行（UsedRange；取不到就沿选区往下探 200 行）
    usedLastRow(sheet) {
      try {
        const ur = sheet.UsedRange
        const last = (ur.Row || 1) + ((ur.Rows && ur.Rows.Count) || 1) - 1
        if (last > 5000) this.log(`表用到第 ${last} 行，超过 5000 行上限，只处理前 5000 行`)
        return Math.max(1, Math.min(last, 5000))
      } catch (e) {
        this.log('UsedRange 取不到，按 200 行处理: ' + e.message)
        return 200
      }
    },

    /**
     * ★ 0.9.41：扫描范围以「单号列最后一个非空行」为准，不再用整表 UsedRange。
     * 为什么必改：结果列一旦在数据区下面写进过文字（K115/K116 那次就是这样），
     * 整表 UsedRange 的末行就被顶到那里 —— 下次还扫那一段空行、还可能再写一次。
     * 错误结果自己把范围撑大，然后再证明自己没错。按单号列收口后，清掉脏文字范围自动缩回。
     * 取不到 / 读不全 → 退回 UsedRange（宁可多扫几行，也不掐掉真数据）。
     * 合并单元格：纵向合并只有左上角有值，末行落在最后一个有值的锚点；锚点下面属于同一票，
     * 本来也没有单号可查，所以不会漏数据。中途的空行无影响（取的是最后一个非空行）。
     */
    numberLastRow(sheet, usedLast, col) {
      const c = Number(col || this.cfg.numberCol || 0)
      if (!c || !usedLast || usedLast < 1) return usedLast
      try {
        const { values } = this.readRangeValues(sheet, c, 1, usedLast)
        if (!values || !values.length || (usedLast > 1 && values.length !== usedLast)) return usedLast
        for (let i = values.length - 1; i >= 0; i--) {
          if (String(values[i] == null ? '' : values[i]).trim()) return i + 1
        }
      } catch (e) {
        this.log('单号列末行探测失败，退回整表已用区: ' + (e.message || e))
      }
      return usedLast
    },

    // ---------- 兼容层：不同 WPS 版本 API 可用性不一样，逐个试 ----------
    addr(r, c) {
      return colLetter(c) + r
    },
    flattenValues(raw, n) {
      if (raw == null) return []
      if (Array.isArray(raw)) {
        if (raw.length && Array.isArray(raw[0])) {
          // 2D 有两种形态，必须分开处理（2026-10-26 实测踩过）：
          //   多行×1列 → 取每行首格；1 行×N 列（表头行）→ 取整行，否则只剩第一格
          if (raw.length === 1 && raw[0].length > 1) return raw[0]
          return raw.map((r) => (Array.isArray(r) ? r[0] : r))
        }
        return raw
      }
      if (typeof raw === 'string' && n > 1) return raw.split(/\r?\n/)
      return [raw]
    },
    readRangeValues(sheet, col, r1, r2) {
      const a = this.app()
      const A1 = `${this.addr(r1, col)}:${this.addr(r2, col)}`
      const n = r2 - r1 + 1
      const tries = [
        ['Range.Value2', () => sheet.Range(A1).Value2],
        ['Range.Text', () => sheet.Range(A1).Text],
        ['Cells.Item', () => { const o = []; for (let r = r1; r <= r2; r++) o.push(sheet.Cells.Item(r, col).Value2); return o }],
        ['Cells()', () => { const o = []; for (let r = r1; r <= r2; r++) o.push(sheet.Cells(r, col).Value2); return o }],
        ['App.Range', () => { if (typeof a.Range !== 'function') throw new Error('无 Application.Range'); return a.Range(A1).Value2 }]
      ]
      this.apiReport = this.apiReport || {}
      for (const [name, fn] of tries) {
        try {
          const vals = this.flattenValues(fn(), n)
          // 关键：多格读取必须拿到和请求行数一样多的值，否则说明这个 API 在这版 WPS 上只回了首格
          if (n > 1 && vals.length !== n) {
            this.apiReport[name] = `长度不符 ${vals.length}/${n}`
            continue
          }
          if (vals.length) {
            this.apiReport.read = name
            return { values: vals, via: name }
          }
          this.apiReport[name] = '空'
        } catch (e) {
          this.apiReport[name] = String(e.message || e).slice(0, 80)
        }
      }
      return { values: [], via: '', error: JSON.stringify(this.apiReport) }
    },
    /**
     * ★ 0.9.42 批量读：整列一次读出，行内查询只查内存。
     * 以前每行要 readOne 船司列（两次）、POL、POD、订舱号列 —— 97 行就是几百次同步 COM；
     * 现在每种列一次 Range 读回整段。取不全的列不进缓存，行内自动退回逐格读（绝不因为缓存没读到就当空）。
     */
    prefetchCols(sheet, cols, r1, r2) {
      const cache = new Map()
      const n = r2 - r1 + 1
      if (!n || n < 1) return cache
      for (const c of cols || []) {
        const col = Number(c || 0)
        if (!col || cache.has(col)) continue
        const r = this.readRangeValues(sheet, col, r1, r2)
        if (r && r.values && r.values.length === n) cache.set(col, { from: r1, to: r2, values: r.values })
        else this.log(`第 ${colLetter(col)} 列整列读取不全，这一列退回逐格读`)
      }
      return cache
    },
    /** 行内读一列：命中本轮快照就查内存，否则逐格读（分类用的列才走快照；核行身份永远读实时值） */
    readColCached(batch, col, row) {
      const c = Number(col || 0)
      if (!c) return ''
      const hit = batch && batch.colSnap && batch.colSnap.get(c)
      if (hit && row >= hit.from && row <= hit.to) {
        const v = hit.values[row - hit.from]
        return v == null ? '' : v
      }
      try {
        const sheet = (batch && batch.sheet) || this.app().ActiveSheet
        const v = this.readOne(sheet, row, c)
        return v == null ? '' : v
      } catch (e) { return '' }
    },
    /** 输出列原值：本轮开头批量读的那一份快照（1 次 COM 覆盖整段），取不到才逐格读 */
    oldOutText(batch, row, col) {
      const s = batch && batch.outSnap
      if (s && s.col === col && row >= s.from && row < s.from + s.values.length) {
        const v = s.values[row - s.from]
        return v == null ? '' : String(v).trim()
      }
      try {
        const sheet = (batch && batch.sheet) || this.app().ActiveSheet
        const v = this.readOne(sheet, row, col)
        return v == null ? '' : String(v).trim()
      } catch (e) { return '' }
    },
    // ---------- 整行底色（里程碑）★ 0.9.42：区段批量刷 ----------
    // 为什么改：逐格 Interior.Color 也是同步 COM，97 行 = 97 次 —— 和逐格写一样卡。
    // 现在按「连续行 + 同一种颜色」合并成区段，一次赋值刷完整段；只有区段批量失败才退回逐行。
    usedColSpan(sheet, outCol) {
      let left = 1
      let right = Number(outCol || this.cfg.outCol || 1)
      try {
        const ur = sheet.UsedRange
        const l = ur.Column || 1
        const r = l + ((ur.Columns && ur.Columns.Count) || 1) - 1
        if (l > 0) left = l
        if (r > right) right = r
      } catch (e) {}
      return { left, right }
    },
    /** 单行整行上色/清色（区段批量不行时的退路；单行也用得上） */
    paintRow(sheet, row, left, right, color) {
      const addr = `${colLetter(left)}${row}:${colLetter(right)}${row}`
      const tries = [
        ['Range(整行).Interior', () => sheet.Range(addr).Interior],
        ['Rows(row).Interior', () => sheet.Rows(row).Interior],
        ['Cells(整行)', () => sheet.Rows(row).Cells.Interior]
      ]
      for (const [name, get] of tries) {
        try {
          const it = get()
          if (color === NO_FILL) it.ColorIndex = NO_FILL
          else { it.Pattern = 1; it.Color = color }
          this.fillVia = name
          return true
        } catch (e) { this.fillErr = String(e.message || e) }
      }
      this.log(`整行上色失败（第 ${row} 行）：${this.fillErr}`)
      return false
    },
    /**
     * ★ 0.9.42 着色批量刷：plan = [{row, color}]（color = NO_FILL 表示「清我们自己刷的色」）
     *   · 连续行 + 同色 → 一次 Range("A2:M6").Interior.Color（1 次 COM，不是 5 次）
     *   · 清色只清 this.ourColor 里记账的（= 我们刷过），用户手工标的底色一律不碰；
     *     也正因为有记账，不必再为了「这色是不是我们的」每行读一次 Interior.Color。
     */
    paintRows(sheet, plan, doc, outCol) {
      if (!plan || !plan.length) return 0
      const d = doc || this.docKey()
      const { left, right } = this.usedColSpan(sheet, outCol)
      const todo = []
      for (const p of plan) {
        const k = `${d}|${p.row}`
        if (p.color === NO_FILL) {
          if (!this.ourColor.has(k)) continue      // 没刷过 → 不读也不写
          todo.push(p)
        } else {
          this.ourColor.set(k, p.color)
          todo.push(p)
        }
      }
      todo.sort((x, y) => x.row - y.row)
      let ops = 0
      let i = 0
      while (i < todo.length) {
        let j = i
        while (j + 1 < todo.length && todo[j + 1].row === todo[j].row + 1 && todo[j + 1].color === todo[j].color) j++
        const seg = todo.slice(i, j + 1)
        i = j + 1
        const from = seg[0].row
        const to = seg[seg.length - 1].row
        const color = seg[0].color
        let done = false
        if (to > from) {   // 单行走退路就够了，不必为 1 行再试一次区段
          try {
            const it = sheet.Range(`${colLetter(left)}${from}:${colLetter(right)}${to}`).Interior
            if (color === NO_FILL) it.ColorIndex = NO_FILL
            else { it.Pattern = 1; it.Color = color }
            done = true
            ops++
          } catch (e) { this.fillErr = String(e.message || e) }
        }
        if (!done) {
          for (const p of seg) { if (this.paintRow(sheet, p.row, left, right, p.color)) ops++ }
        }
        if (color === NO_FILL) for (const p of seg) this.ourColor.delete(`${d}|${p.row}`)
      }
      return ops
    },
    /** 单行清我们自己刷的色（零散调用留的口；批量路径统一走 paintRows） */
    clearOurColor(sheet, row, doc, outCol) {
      this.paintRows(sheet, [{ row, color: NO_FILL }], doc, outCol)
    },
    clearOurColors(sheet, rows, doc, outCol) {
      const plan = (rows || []).map((row) => ({ row, color: NO_FILL }))
      if (plan.length) this.paintRows(sheet, plan, doc, outCol)
    },

    readOne(sheet, r, c) {
      const a = this.app()
      const A1 = this.addr(r, c)
      try { const v = sheet.Range(A1).Value2; if (v !== undefined && v !== null) return v } catch (e) {}
      try { const v = sheet.Cells.Item(r, c).Value2; if (v !== undefined && v !== null) return v } catch (e) {}
      try { const v = sheet.Cells(r, c).Value2; if (v !== undefined && v !== null) return v } catch (e) {}
      try { return a.Range(A1).Value2 } catch (e) {}
      return undefined
    },
    /** 毫秒表（写回阶段计时用；WPS 里 performance 可能没有，退回 Date） */
    nowMs() {
      try { if (typeof performance !== 'undefined' && performance.now) return performance.now() } catch (e) {}
      return Date.now()
    },

    /**
     * 单号比对 —— 唯一口径：全角/空格/连字符归一化后，一格多号命中任一即可。
     * 批量核身份（_writeSeg）与逐格核身份（verifyRowIdentity）必须共用这把尺，
     * 两处口径不一样等于没有校验。
     */
    sameNumber(want, cellValue) {
      const w = normNum(want)
      if (!w) return false
      const have = splitParts(toHalf(cellValue)).map(normNum).filter(Boolean)
      if (!have.length) return false
      return have.includes(w)
    },
    /**
     * ★ 0.9.41 行身份校验 —— 唯一一把尺：writeResult / _flushPending / 自动刷新 / ETD-ETA 写回全走这里。
     *
     * 为什么需要它：扫描时记的是行号（r1+i），写回可能要等几秒（实时）到几十分钟（暂存补写）。
     * 这中间用户删行/插行/排序，行号就指向别的行了 —— 上次修的是「表变了要拦」，这次是「行变了要拦」。
     * 判据只看这一格：numberCol@row 现在的单号，是不是查询时那个单号。
     *   · 该行为空（空行/只有备注）→ 返回 false（空行硬保护，不需要第二条规则）
     *   · 单号列没配 / 查不到 → 返回 false（宁可不写，也不写到不确定的格子里）
     * 比对前归一化（全角转半角 + 去空白/连字符 + 大写）：用户手打的号常带空格/全角，
     * 严格比对会把「同一行」误判成错位而少写 —— 那是另一种错。
     */
    verifyRowIdentity(sheet, row, number, numCol) {
      if (!normNum(number)) return false
      const col = Number(numCol || this.cfg.numberCol || 0)
      if (!col) return false
      let cur
      try { cur = this.readOne(sheet, row, col) } catch (e) { return false }
      return this.sameNumber(number, cur)
    },
    /** 错位跳过：不写、计数（按行去重）、界面给一句能照着做的提示 */
    markMisalign(batch, it, row, numCol, why) {
      const b = batch || this.vb
      if (b) {
        b.misalignSeen.add(`${row}|${numCol || b.cfg.numberCol || 0}`)
        b.misalign = b.misalignSeen.size
      }
      if (it) {
        it.state = 'skip'
        it.misaligned = true
        it.failReason = 'misaligned'
        it.text = '错位跳过（该行单号已变或已空，结果没写，点③重跑）'
      }
      const c = colLetter(numCol || (b && b.cfg.numberCol) || 0)
      this.log(`R${row} 错位跳过：${why || ''} ${c}${row} 现在不是它 —— 结果不写`)
    },

    writeCell(sheet, r, c, text) {
      const a = this.app()
      // ★ 10-30：判定逻辑全部搬进 lib/cellwrite.js（纯函数 + 可单测）。
      //   以前这里是 `String(back) === String(text)`，和批量路径的 sameCellText 两把尺，
      //   日期列（读回 Date）和数值列（读回 number）走逐格必然「读回不一致」→ fail →
      //   红条说「表可能被保护/只读」，方向全指错。
      const res = writeCellCore({
        sheet, app: a, a1: this.addr(r, c), r, c, value: text,
        readOne: (sh, rr, cc) => this.readOne(sh, rr, cc),
      }) || { ok: false, error: '写入失败' }
      if (res.ok) this.apiReport = { ...(this.apiReport || {}), write: res.via }
      return res
    },

    // ================= ★ 0.9.42（P0-2）唯一写回入口 + 批量写 =================
    /**
     * writeRowChecked(sheet, row, col, text, number) —— 写业务单元格只许走这里。
     *   = 核行身份 + 写入 + 写后校验，三步都在这一层收口（别处不许再直接调 writeCell）。
     *
     * 为什么是「入队」而不是「立刻写」：
     *   以前每来一条结果就写一格，97 行 = 97 次写 + 97 次读回校验，每格至少 2 次同步 COM 打在主线程上，WPS 明显卡。
     *   现在先入队 → _flushWriteQueue 按列聚合成「连续区段」→ 一次 Range("K2:K98").Value2 = [[...]] 写完
     *   → 再一次批量读回校验。身份校验也批量：一次读单号列整段，逐行比号。
     *   只有批量写不可用（老版本不认二维数组 / 写入抛错 / 读回不一致）才退回逐格定位，逐格时依旧逐格核身份。
     *
     * 已接入本入口的写回路径（4 条，全部走这里）：
     *   ① 实时写回 writeResult（③ 立即刷新 / 自动刷新 / 自动重查 runRetry / 手工兜底 applyManual 都汇到这里）
     *   ② 暂存补写 _flushPending（查询中切走攒下的结果，切回原表补齐）
     *   ③ 船期回填 writeScheduleDates（ETD / ETA 两列）
     *   ④ 自动重查 runRetry → queryAndWrite → writeResult（与 ① 同一条链）
     */
    writeRowChecked(batch, sheet, row, col, text, number, numCol, it, rawValue) {
      // 拿到响应式代理再改（raw 对象改了 UI 不刷新）
      const b = (batch && this.batchById(batch.id)) || batch || this.ensureBatch(sheet)
      const c = Number(col || 0)
      const r = Number(row || 0)
      if (!c || !r) {
        if (b) b.errs.write = '写入失败：列或行没定'
        return { ok: false, error: '列或行没定' }
      }
      const entry = {
        batchId: b.id,
        batch: b,
        doc: b.doc || this.docKey(),
        sheet,
        row: r,
        col: c,
        numCol: Number(numCol || (it && it.numCol) || b.cfg.numberCol || 0),
        number: String(number == null ? '' : number),
        text: String(text == null ? '' : text),
        value: rawValue === undefined ? String(text == null ? '' : text) : rawValue,
        it: it || null,
        result: 'queued'
      }
      this.writeQ.push(entry)
      this._armWriteFlush()
      return { ok: true, queued: true, entry }
    },
    /** 攒一小会儿再写：并发查到的结果合并进同一次批量写，用户看到的仍是「边查边出」 */
    _armWriteFlush() {
      // 攒批窗口 400ms（人眼看不出滞后）；队列一旦够 10 行就立刻写，不必等满窗口 ——
      // 每段写回都有固定开销（核身份读 + 写 + 读回 ≈ 3~4 次 COM），段越少越省。
      const ms = Number(window.__SHIPTRACK_FLUSH_MS__ || 0) || 400
      if (!this.wqTimer && this.writeQ.length >= 10) { this.flushWrites().catch(() => {}); return }
      if (this.wqTimer) return
      this.wqTimer = setTimeout(() => {
        this.wqTimer = null
        this.flushWrites().catch(() => {})
      }, ms)
    },
    flushWrites() {
      if (this.wqTimer) { clearTimeout(this.wqTimer); this.wqTimer = null }
      // ★ 0.9.44：写回改成分段异步（每 N 行让出主线程）→ 必须自己串行化：
      //   以前同步执行天然互斥，现在两次 flush 不许同时摸 COM，后来的排在前一次后面。
      const run = () => this._flushWriteQueue()
      const prev = this.flushChain || Promise.resolve()
      const p = prev.then(run, run)
      this.flushChain = p.catch(() => {})
      return p
    },
    /** 写回一段就让出一帧：主线程先重绘（进度条/写回计数），再接着写 —— 不许一次卡死几百毫秒 */
    _yieldToUI() {
      return new Promise((r) => setTimeout(r, 0))
    },
    /** 每段写多少行（测试可用 window.__SHIPTRACK_WRITE_CHUNK__ 压小） */
    _writeChunkRows() {
      const n = Number(window.__SHIPTRACK_WRITE_CHUNK__ || 0)
      return n > 0 ? n : 30
    },
    /**
     * 队列落盘：按 (输出列, 单号列) 分组 → 行排序 → 连续区段 → 段内批量核身份 → 批量写 → 批量读回校验。
     * 中间有洞就断开：只对连续区段批量写，「不写的格」一个都不碰。
     * （整段覆盖会把洞里的公式/用户内容替换成死值 —— 这是最隐蔽的一种数据损坏，所以宁可按段写。）
     */
    async _flushWriteQueue() {
      const st = { ok: 0, fail: 0, miss: 0, merged: 0, runs: 0, cells: 0, fills: 0, fmt: 0, com: 0, rbp: 0, via: '', ms: 0 }
      if (this.writing || !this.writeQ.length) return st
      const a = this.app()
      if (!a) return st
      const all = this.writeQ
      this.writeQ = []
      this.writing = true
      const t0 = this.nowMs()
      const later = []
      try {
        // ① 按批次归拢：一批的写只落在它自己那张表上（绝不串表）
        const perBatch = new Map()
        for (const w of all) {
          const k = w.batchId || ('doc:' + w.doc)
          if (!perBatch.has(k)) perBatch.set(k, [])
          perBatch.get(k).push(w)
        }
        // ② 按批次先后写：同一张表「先跑的批次先写」→ 后写覆盖前写，符合直觉
        const groups = [...perBatch.values()].sort((x, y) => ((x[0].batch && x[0].batch.seq) || 0) - ((y[0].batch && y[0].batch.seq) || 0))
        for (const list of groups) {
          const b = (list[0].batchId && this.batchById(list[0].batchId)) || list[0].batch || null
          const doc = list[0].doc
          if (this.flushingDocs.has(doc)) { later.push(...list); continue }   // 这张表已有批次在写 → 排到下一次
          const cross = doc !== this.docKey()
          const sheet = cross ? (b && b.sheet) : a.ActiveSheet
          if (!sheet) { later.push(...list); continue }
          const bst = { ok: 0, fail: 0, miss: 0, merged: 0, runs: 0, cells: 0, fills: 0, fmt: 0, com: 0, rbp: 0, via: '', ms: 0 }
          const bt0 = this.nowMs()
          let deferred = 0
          this.flushingDocs.add(doc)
          // ★ 0.9.44：写回独立进度（查询跑完 ≠ 写完了）——「查询 97/97」之后显示「写回 43/97」
          if (b) b.writeProg = { done: 0, total: list.length }
          try {
            if (cross && !this._sheetUsable(b, sheet)) {
              // (b) 现场：这个 WPS 版本摸不到非活动表 → 老实攒着，切回去再写，绝不去猜
              deferred = this._deferEntries(list, b, '跨表写不可用（这个 WPS 版本摸不到非活动表）')
            } else {
              await this._writeList(sheet, list, bst, b)
              if (cross) {
                const failed = list.filter((w) => w.result === 'fail')
                if (failed.length) {
                  bst.fail -= failed.length          // 没写进去的不算失败：先攒着，切回那张表再补
                  deferred += this._deferEntries(failed, b, '跨表写失败')
                }
              }
            }
          } finally {
            this.flushingDocs.delete(doc)
            if (b) b.writeProg = null       // 这张表写完了 → 进度条上的「写回 x/y」收掉
          }
          bst.ms = Math.round(this.nowMs() - bt0)
          bst.deferred = deferred          // ★ 0.9.45：跨表暂存也算三态之一（不进 fail）
          if (b && cross) { b.xsheet.ok += bst.ok; b.xsheet.fail += deferred }
          this._accWriteStats(b, bst)
          for (const k of ['ok', 'fail', 'miss', 'merged', 'runs', 'cells', 'fills', 'fmt', 'ms']) st[k] += bst[k]
          if (bst.via) st.via = bst.via
        }
      } catch (e) {
        const msg = String((e && e.message) || e)
        this.writeQ.push(...all.filter((w) => w.result === 'queued'))
        const b = (all[0] && all[0].batch) || this.vb
        if (b) b.errs.write = '写入失败：' + msg
        this.log('批量写回异常：' + msg)
      } finally {
        this.writing = false
        if (later.length) this.writeQ.push(...later)   // 这一轮没写的（表被占/别的表）留着下一轮
        // ★ 0.9.44：写回期间新进来的结果 / 被表锁挡下的条目要接着写 —— 但只在「这一轮真写进去了」时才重排，
        //   否则碰上永久写不进去的表（表被占）会每 400ms 空转一次。
        if (this.writeQ.length && !this.wqTimer && (st.cells || st.fail)) this._armWriteFlush()
      }
      st.ms = Math.round(this.nowMs() - t0)
      if (st.via) this.writeVia = st.via
      if (st.merged) {
        const ex = st.mergedEx
        this.log(`写回：${st.merged} 格跳过（合并单元格${ex ? `，如 ${ex.col}${ex.row} 与 ${ex.block} 合并` : ''}）`)
      }
      if (st.fail) {
        this.log(`写回：成功 ${st.ok} / 失败 ${st.fail} / 错位跳过 ${st.miss}`)
      } else if (st.cells) {
        this.log(`写回：${st.cells} 格 / ${st.runs} 段 / ${st.ms}ms${st.via ? ' · ' + st.via : ''}`)
      }
      // ★ 0.9.43：写回账本累计（界面/诊断/基准看的是「这一轮一共写了多少格、一共多久」，
      //   只报最后一次 flush 会让人以为只写了 3 格）
      const acc = this.writeAcc || (this.writeAcc = { ok: 0, fail: 0, miss: 0, runs: 0, cells: 0, fills: 0, fmt: 0, ms: 0 })
      for (const k of ['ok', 'fail', 'miss', 'merged', 'runs', 'cells', 'fills', 'fmt', 'ms']) acc[k] += st[k]
      if (st.via) acc.via = st.via
      try { window.__SHIPTRACK_STATS__ = { ...acc, lastMs: st.ms, lastCells: st.cells } } catch (e) {}
      this.publishCross()
      return st
    },
    /** 一轮写回的账记到「这批」身上（界面按当前这一批显示，不混批） */
    _accWriteStats(b, bst) {
      if (!b) return
      const prev = b.writeStats || { ok: 0, fail: 0, miss: 0, runs: 0, cells: 0, fills: 0, via: '', ms: 0 }
      b.writeStats = {
        ok: prev.ok + bst.ok, fail: prev.fail + bst.fail, miss: prev.miss + bst.miss,
        runs: prev.runs + bst.runs, cells: prev.cells + bst.cells, fills: prev.fills + bst.fills,
        via: bst.via || prev.via, ms: prev.ms + bst.ms
      }
      b.writeMs = (b.writeMs || 0) + bst.ms
      // ★ 0.9.45：三态分开记账。别再往 errs.write 里塞「批量写不可用，退回逐格也没写进」——
      //   那句话把「跨表暂存」「批量路径不认但逐格写成了」「真写不进」糊成一条，害人。
      const note = b.writeNote || (b.writeNote = { fail: 0, defer: 0, fbRows: 0, fbOk: 0, fmt: 0, com: 0, rbp: 0, fmtEx: null, failEx: null })
      note.fail += Number(bst.fail || 0)
      note.defer += Number(bst.deferred || 0)
      // ★ 10-30：格式差单独记账（不算失败）；失败按「COM 抛异常 / 读回没变」分开数，
      //   横幅才能说准话（只有前者才可能是保护/只读）。
      // ★ 2026-11-10：合并单元格跳过单独记账（不是失败，但要让用户知道哪格没写、跟谁合并了）
      note.merged = (note.merged || 0) + Number(bst.merged || 0)
      if (bst.mergedEx && !note.mergedEx) note.mergedEx = bst.mergedEx
      note.fmt = (note.fmt || 0) + Number(bst.fmt || 0)
      note.com = (note.com || 0) + Number(bst.com || 0)
      note.rbp = (note.rbp || 0) + Number(bst.rbp || 0)
      if (bst.fmtEx && !note.fmtEx) note.fmtEx = bst.fmtEx
      if (bst.failEx && !note.failEx) note.failEx = bst.failEx
      if (bst.fbRows) {
        note.fbRows += Number(bst.fbRows || 0)
        note.fbOk += Number(bst.fbOk || 0)
      }
      // 这一轮整段写成了 → 之前那轮留下的失败计数不再成立（横幅只从状态推导，不许挂僵尸红条）
      if (bst.cells && !bst.fail) { note.fail = 0; note.com = 0; note.rbp = 0; note.failEx = null }
      if (bst.cells && !bst.fail) b.errs.write = ''
    },
    /** 某一批的写回三态文案（条上的 tooltip 用；横幅走 writeNote） */
    writeNoteFor(b) {
      const n = b && b.writeNote
      if (!n) return ''
      if (n.fail > 0) {
        const ex = n.failEx
        if ((n.rbp || 0) > 0 && !((n.com || 0) > 0)) return `${n.fail} 格没写进去（${ex ? `R${ex.row} ${ex.col} 列：写入 ${ex.wrote} / 读回 ${ex.back || '空'}` : '赋值没生效'}）`
        if ((n.com || 0) > 0 && !((n.rbp || 0) > 0)) return `${n.fail} 格补不进去（表可能被保护/只读）`
        return `${n.fail} 格补不进去（${n.com || 0} 格抛异常 / ${n.rbp || 0} 格读回没变）`
      }
      if ((n.merged || 0) > 0) {
        const ex = n.mergedEx
        return `${n.merged} 格跳过（合并单元格${ex ? `：${ex.col}${ex.row} 与 ${ex.block} 合并，只有左上角能写` : ''}）`
      }
      if (n.defer > 0) return `${n.defer} 格结果暂存，切回原表自动补`
      if ((n.fmt || 0) > 0) {
        const ex = n.fmtEx
        return `${n.fmt} 格写入成功但读回格式不同${ex ? `（R${ex.row} ${ex.col} 列：写入 ${ex.wrote} / 读回 ${ex.back}）` : ''}`
      }
      if (n.fbRows > 0) return `批量写不认，已逐格写入（成功 ${n.fbOk}）`
      return ''
    },
    /**
     * ★ 0.9.45 真写不进的格子记一条（环形缓冲，最近 200 条，可导出）：
     *   {row, col, error, via, ts} + 单号/批次/是否后来改成跨表暂存 —— 事后归因就靠这个。
     */
    _recordWriteFail(w, r, viaHint) {
      if (!w) return
      const rec = {
        ts: Date.now(),
        doc: String(w.doc || ''),
        sheet: String(w.doc || '').split('|')[1] || '',
        row: Number(w.row || 0),
        col: colLetter(Number(w.col || 0)),
        colNum: Number(w.col || 0),
        number: String(w.number == null ? '' : w.number),
        error: String((r && r.error) || '写入失败'),
        via: String(viaHint || (r && r.via) || '逐格'),
        batchId: String(w.batchId || ''),
        resolved: 'fail'      // fail | deferred（跨表被搬进待补队列时改掉）
      }
      w.errRec = rec
      this.writeFailLog.push(rec)
      if (this.writeFailLog.length > 200) this.writeFailLog.splice(0, this.writeFailLog.length - 200)
      try { window.__SHIPTRACK_WRITE_FAILS__ = this.writeFailLog.slice() } catch (e) {}
      this.log(`写不进 ${colLetter(rec.colNum)}${rec.row}（${rec.via}）：${rec.error}`)
    },
    /** 导出写入失败明细（复制到剪贴板 + 落到日志，WPS 里剪贴板不给就手工复制 pre 里的 JSON） */
    exportWriteFails() {
      const rows = this.writeFailLog.map((r) => ({ ...r }))
      const json = JSON.stringify(rows, null, 1)
      try { window.__SHIPTRACK_WRITE_FAILS__ = rows } catch (e) {}
      const head = rows.length
        ? rows.slice(-30).map((r) => `R${r.row} ${r.col}  ${r.error}  · ${r.via} · ${new Date(r.ts).toLocaleTimeString()} · ${r.resolved}`).join('\n')
        : '（还没有真写不进的格子）'
      this.log(`写入失败明细 ${rows.length} 条（最多留 200 条）\n${head}`)
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json)
          this.flash(`已复制 ${rows.length} 条写入失败明细（JSON）`)
        } else {
          this.flash('剪贴板不可用：明细已写进下面的日志，手工复制', 12000)
        }
      } catch (e) {
        this.flash('剪贴板不可用：明细已写进下面的日志，手工复制', 12000)
      }
    },
    /** 非活动表的 Worksheet 对象还摸得到吗（只读一次取值，不写不建不删） */
    _sheetUsable(b, sheet) {
      if (b && b.xsheet && b.xsheet.dead) return false
      try {
        sheet.Range('A1').Value2
        return true
      } catch (e) {
        if (b && b.xsheet) b.xsheet.dead = true
        this.log(`跨表读不到「${(b && b.doc) || ''}」（${String((e && e.message) || e).slice(0, 40)}）→ 改用「攒着等切回」`)
        return false
      }
    },
    /** 写不进非活动表的结果先攒进待补队列（按批次分桶：同表多批也不会互相盖掉） */
    _deferEntries(list, b, why) {
      let n = 0
      for (const w of list) {
        if (w.result === 'ok' || w.result === 'superseded') continue   // 写成了 / 已被后一批覆盖 → 都不用攒
        const it = w.it
        const numCol = w.numCol || (b && b.cfg.numberCol) || 0
        const key = `${w.batchId || 'x'}|${w.doc}|${w.number}|${numCol}|${w.col}|${w.row}`
        this.pendingWrites = this.pendingWrites.filter((x) => x.key !== key)
        this.pendingWrites.push({
          key, batchId: w.batchId || '', row: w.row, outCol: w.col, doc: w.doc,
          number: w.number, numCol,
          text: w.text, state: (it && it.state) || 'ok'
        })
        w.result = 'deferred'
        // ★ 0.9.45：这条 fail 其实是跨表暂存（后面会自动补齐）→ 环形缓冲里改标记，别事后当成本真失败
        if (w.errRec) w.errRec.resolved = 'deferred'
        if (it) {
          it.state = 'pending'
          if (!/待回填/.test(String(it.text))) it.text = String(it.text || '') + '（待回填）'
        }
        n++
      }
      if (n) this.log(`${why}：${n} 条结果暂存，切回「${(b && b.doc) || ''}」自动补写`)
      return n
    },
    /** 一批的待写队列 → 按 (输出列, 单号列) 分组 → 行排序 → 连续区段 */
    async _writeList(sheet, list, st, batch) {
      // ★ 0.9.43「后写覆盖前写」的硬保证：同一张表同一格，如果序号更大的批次已经写过，
      //   序号小的批次就不许再往回写（否则谁先 flush 谁就赢，结果取决于网络快慢，不是直觉）。
      //   同一格里出现多次（重查）只留最后一条。
      const last = new Map()
      for (const w of list) last.set(`${w.row}|${w.col}`, w)
      const keep = []
      const seq = (batch && batch.seq) || 0
      for (const w of last.values()) {
        const k = `${w.doc}|${w.row}|${w.col}`
        const prev = this.cellSeq.get(k)
        if (prev && seq < prev) { w.result = 'superseded'; st.sup = (st.sup || 0) + 1; continue }
        this.cellSeq.set(k, seq)
        keep.push(w)
      }
      if (!keep.length) return
      const groups = new Map()
      for (const w of keep) {
        const k = `${w.col}|${w.numCol}`
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(w)
      }
      const paints = []
      // ★ 0.9.44：写回分段 + 独立进度
      //   每格 ≥2 次同步 COM（核身份读 + 写 + 读回），一次写几十行主线程就是几百毫秒不重绘 ——
      //   爹地的 97 行截图正是停在「97/97 · 剩约 0 秒」。现在每 N 行让出一帧，并顺手报「写回 x/y」。
      const chunk = this._writeChunkRows()
      let sinceYield = 0
      for (const colList of groups.values()) {
        colList.sort((x, y) => x.row - y.row)
        let i = 0
        while (i < colList.length) {
          let j = i
          while (j + 1 < colList.length && colList[j + 1].row === colList[j].row + 1) j++   // 连续行号
          const seg = colList.slice(i, j + 1)
          i = j + 1
          // 区段再按 chunk 切：身份校验与批量写都按小段走，段内仍是批量写（不多花 COM）
          for (let k = 0; k < seg.length; k += chunk) {
            const part = seg.slice(k, k + chunk)
            this._writeSeg(batch, sheet, part, st, paints)
            if (batch && batch.writeProg) {
              batch.writeProg.done = Math.min(batch.writeProg.total, (batch.writeProg.done || 0) + part.length)
            }
            sinceYield += part.length
            if (sinceYield >= chunk) { sinceYield = 0; await this._yieldToUI() }
          }
        }
      }
      if (paints.length) st.fills = this.paintRows(sheet, paints, batch && batch.doc, batch && batch.cfg.outCol)
      if (sinceYield) await this._yieldToUI()   // 收尾也让一帧，最后一格进度能画出来
    },
    _cellValueOf(w) {
      return w.value === undefined ? w.text : w.value
    },
    /**
     * 读回校验（批量路径用）：与逐格路径同一个口径 —— lib/cellwrite.js 的 cellMatches。
     * 日期列回来的可能是 Date、数值列可能是 number：类型差一律吞掉（谁也别在这里另写一版比较）。
     */
    sameCellText(back, w) {
      const want = this._cellValueOf(w)
      return cellMatches(back, want) || cellMatches(back, w && w.text)
    },
    /**
     * 合并单元格判定（★ 2026-11-10，爹地那张表 K12:K13 / L12:L13 是合并的）。
     * 合并区只有**左上角**那格存值：往其余格写 → 值跑到左上角、读回是空 → 整段报「读回不一致」，
     * 把人引到「表可能被保护/只读」的死路上。所以写之前先判 MergeArea：
     *   非左上角 → 跳过并报「与 K12 合并」，绝不写；左上角 → 照常写。
     * 返回 null（可写）或 {addr, topRow, topCol}。
     * 老版本摸不到 MergeCells/MergeArea 就返回 null —— 不猜，按原路写。
     */
    _mergeBlockOf(sheet, row, col) {
      // 只负责摸 COM；判据在 lib/writeplan.js 的 mergeVerdict（纯函数，可单测）。
      // ★ 2026-11-11 真机日志「现场跳过 0 格」逼出来的第四版：
      //   前三次分别赌 MergeCells 布尔、段级布尔、MergeArea 坐标，全在真机上失效。
      //   现在三个判据一起看，任一命中即跳过，并且把命中的理由记下来。
      try {
        const cell = sheet.Cells(row, col)
        const ma = cell.MergeArea
        let maRows = null, maCols = null, maAnchorAddr = null
        try { maRows = ma ? ma.Rows.Count : null } catch (e) { maRows = null }
        try { maCols = ma ? ma.Columns.Count : null } catch (e) { maCols = null }
        // ★ MergeArea.Cells(1,1) 是合并区左上角的真实地址 —— WPS 就算 MergeArea.Address
        //   返回单格，这个也还是左上角。判据最硬的一条。
        try { maAnchorAddr = ma && ma.Cells(1, 1) ? ma.Cells(1, 1).Address : null } catch (e) { maAnchorAddr = null }
        const v = mergeVerdict({
          cellAddr: cell.Address,
          cellRow: row,
          cellCol: col,
          maAddr: ma ? ma.Address : null,
          maAnchorAddr,
          maRow: ma ? ma.Row : null,
          maCol: ma ? ma.Column : null,
          maRows,
          maCols,
        })
        if (!v.nonAnchor) return null
        // 拿到合并区地址就报地址；拿不到就报「合并区」，绝不编格子号骗用户
        const addr = String((ma && ma.Address) || '').replace(/\$/g, '') || '合并区'
        return {
          addr,
          topRow: ma ? Number(ma.Row) || 0 : 0,
          topCol: ma ? Number(ma.Column) || 0 : 0,
          reasons: v.reasons,
        }
      } catch (e) {
        return null   // 摸不到 → 不猜，按原路写
      }
    },
    /**
     * 批量范围先剔合并格：剔除后剩下的连续行号自然断开，不会把不可写的格串进同一段批量写。
     * 快路径：整段 MergeCells === false → 一次 COM 就过，不逐格摸。
     */
    _dropMerged(sheet, seg, st, batch) {
      if (!seg || !seg.length) return seg || []
      let mc
      try {
        const a1 = `${colLetter(seg[0].col)}${seg[0].row}`
        const a2 = `${colLetter(seg[seg.length - 1].col)}${seg[seg.length - 1].row}`
        mc = sheet.Range(`${a1}:${a2}`).MergeCells
      } catch (e) { mc = null }
      // ★ 2026-11-11 真机复现（爹地表 L12:L13 合并、L13 照写、读回空）：
      //   快路径只对「单格段」有效。多行段一律逐格摸 —— WPS 对「区域内部分合并」返回 0
      //   （VBA 规范应是 Null），0 会被判成「没合并」→ 整段跳过检查 → 非左上角格照写、读回空。
      //   判定收进 canUseMergeFastPath（纯函数，可单测），别在这里散着写。
      if (canUseMergeFastPath(seg.length, mc)) {
        for (const w of seg) w.mergeChecked = true
        return seg
      }
      const keep = []
      for (const w of seg) {
        w.mergeChecked = true
        const blk = this._mergeBlockOf(sheet, w.row, w.col)
        if (!blk) { keep.push(w); continue }
        // 不是失败：这一格本来就不存值。单独记一笔（merged），横幅上说清「与 K12 合并」。
        w.result = 'merged'
        w.error = `与 ${blk.addr} 合并`
        st.merged = (st.merged || 0) + 1
        if (!st.mergedEx) st.mergedEx = { row: w.row, col: colLetter(w.col), block: blk.addr }
        if (w.it) {
          w.it.state = 'skip'
          w.it.mergedInto = blk.addr
          w.it.failReason = w.it.failReason || 'merged'
          w.it.text = `${String(w.it.text || '')}（${mergeSkipText(blk)}）`
        }
        this.log(`R${w.row} ${colLetter(w.col)} 与 ${blk.addr} 合并（不是左上角）→ 跳过不写${blk.reasons ? ' [' + blk.reasons.join(',') + ']' : ''}`)
      }
      return keep
    },
    /** 一段连续行：批量核身份 → 逐段写（段内批量）→ 记着色计划 */
    _writeSeg(batch, sheet, seg, st, paints) {
      // ★ 2026-11-10：写之前先把合并格剔掉（非左上角根本不可写）——
      //   否则批量写会把值塞进左上角、其余格读回空 → 全段误报「读回不一致」。
      seg = this._dropMerged(sheet, seg, st, batch)
      if (!seg.length) return
      const from = seg[0].row
      const to = seg[seg.length - 1].row
      const nc = seg[0].numCol
      // ① 批量核身份：单号列整段一次读（1 次 COM），不再逐格 readOne
      let idVals = null
      if (nc) {
        const r = this.readRangeValues(sheet, nc, from, to)
        if (r && r.values && r.values.length === (to - from + 1)) idVals = r.values
      }
      const passed = []
      for (const w of seg) {
        // 批量读不出来就退回逐格读 —— 身份校验可以慢，绝不能省
        const cell = idVals ? idVals[w.row - from] : (nc ? this.readOne(sheet, w.row, nc) : '')
        if (nc && this.sameNumber(w.number, cell)) passed.push(w)
        else {
          w.result = 'miss'
          st.miss++
          this.markMisalign(batch, w.it, w.row, nc, idVals ? '批量核对不通过' : '核对不通过')
        }
      }
      if (!passed.length) return
      // ② 过了身份的行再切连续段（没过的是洞 → 跳过，绝不写）
      let i = 0
      while (i < passed.length) {
        let j = i
        while (j + 1 < passed.length && passed[j + 1].row === passed[j].row + 1) j++
        const run = passed.slice(i, j + 1)
        i = j + 1
        if (run.length === 1) {
          // 单行段走逐格口（身份刚刚在本段批量核过，needCheck=false 不重复读一次）
          this._writeOneChecked(batch, sheet, run[0], st, false)
        } else {
          this._batchWriteRun(batch, sheet, run, st)
        }
        // ③ 着色计划：等全部写完，最后一遍按区段批量刷（这里不碰 Interior）
        for (const w of run) {
          const it = w.it
          if (!it || w.result !== 'ok') continue
          if (it.state === 'ok' && it.stage > 0 && !it.inferred) paints.push({ row: w.row, color: STAGE_COLOR[it.stage] || NO_FILL })
          else if (it.state === 'ok') paints.push({ row: w.row, color: NO_FILL })
        }
      }
    },
    /** 批量写：一次 Range("K2:K98").Value2 = [[...]]，再一次批量读回校验 */
    _batchWriteRun(batch, sheet, run, st) {
      const col = run[0].col
      const from = run[0].row
      const to = run[run.length - 1].row
      const addr = `${colLetter(col)}${from}:${colLetter(col)}${to}`
      const flat = run.map((w) => this._cellValueOf(w))
      const grid = flat.map((v) => [v])
      const a = this.app()
      const tries = [
        ['Range.Value2(二维)', () => { sheet.Range(addr).Value2 = grid }],
        ['Range.Value2(一维)', () => { sheet.Range(addr).Value2 = flat }],
        ['App.Range(二维)', () => { if (typeof a.Range !== 'function') throw new Error('无 Application.Range'); a.Range(addr).Value2 = grid }]
      ]
      const errs = []
      // ★ 10-30：写前读一次整段旧值。归因要靠它：读回来还是旧值 = 赋值没生效（真失败）；
      //   读回来是新值只是形态不同 = 格式差（不许记 fail，最多记一条 format-diff 备注）。
      const before = this.readRangeValues(sheet, col, from, to)
      const prevs = (before && before.values && before.values.length === run.length) ? before.values : null
      for (const [name, fn] of tries) {
        try {
          fn()
          const back = this.readRangeValues(sheet, col, from, to)
          if (back && back.values && back.values.length === run.length) {
            let bad = 0
            let fmt = 0
            run.forEach((w, k) => {
              const v = judgeReadback({ prev: prevs ? prevs[k] : undefined, back: back.values[k], want: this._cellValueOf(w) })
              if (v === 'fail') bad++
              else if (v === 'format-diff') {
                fmt++
                if (!st.fmtEx) st.fmtEx = { row: w.row, col: colLetter(col), wrote: cellText(this._cellValueOf(w)), back: cellText(back.values[k]) }
              }
            })
            if (!bad) {
              st.ok += run.length
              st.cells += run.length
              st.runs++
              if (fmt) st.fmt = (st.fmt || 0) + fmt
              st.via = name
              this.apiReport = { ...(this.apiReport || {}), write: name }
              run.forEach((w) => { w.result = 'ok'; w.via = name })
              return true
            }
            errs.push(`${name}: 读回不一致 ${bad}/${run.length} 格`)
          } else {
            errs.push(`${name}: 读回不全（${back && back.values ? back.values.length : 0}/${run.length}）`)
          }
        } catch (e) {
          errs.push(`${name}: ${String((e && e.message) || e)}`)
        }
      }
      // ③ 批量写不可用 → 逐格定位；每格重新核身份（不因为「刚核过」就省）
      this.log(`批量写 ${addr} 不可用（${errs[0] || '未知'}）→ 退回逐格写`)
      // ★ 0.9.45：这是第三种状态 —— 批量路径不认，但逐格写进去了（不是失败，别报成失败）
      const ok0 = st.ok
      for (const w of run) this._writeOneChecked(batch, sheet, w, st, true, '退回逐格时核对不通过', '逐格(批量写不认)')
      st.fbRows = (st.fbRows || 0) + run.length
      st.fbOk = (st.fbOk || 0) + (st.ok - ok0)
      return false
    },
    /**
     * 逐格写（批量写的唯一旁路：整个文件里只有这一处调 writeCell）。
     * 单行段、以及批量写不可用时的逐格定位都走它：先核身份（needCheck=true 时），再写，写内置读回校验。
     */
    _writeOneChecked(batch, sheet, w, st, needCheck = true, why = '写前核对不通过', viaHint = '') {
      // ★ 2026-11-10：合并区非左上角 → 跳过（不写，也不许报「读回不一致」）。
      //   正常路径在 _writeSeg 已经判过（w.mergeChecked）；这里兜住别处直接调进来的情况。
      if (!w.mergeChecked) {
        w.mergeChecked = true
        const blk = this._mergeBlockOf(sheet, w.row, w.col)
        if (blk) {
          w.result = 'merged'
          w.error = `与 ${blk.addr} 合并`
          st.merged = (st.merged || 0) + 1
          if (!st.mergedEx) st.mergedEx = { row: w.row, col: colLetter(w.col), block: blk.addr }
          if (w.it) {
            w.it.state = 'skip'
            w.it.mergedInto = blk.addr
            w.it.text = `${String(w.it.text || '')}（${mergeSkipText(blk)}）`
          }
          this.log(`R${w.row} ${colLetter(w.col)} 与 ${blk.addr} 合并（不是左上角）→ 跳过不写${blk.reasons ? ' [' + blk.reasons.join(',') + ']' : ''}`)
          return false
        }
      }
      if (needCheck) {
        const cur = w.numCol ? this.readOne(sheet, w.row, w.numCol) : ''
        if (w.numCol && !this.sameNumber(w.number, cur)) {
          w.result = 'miss'
          st.miss++
          this.markMisalign(batch, w.it, w.row, w.numCol, why)
          return false
        }
      }
      // ★ 2026-11-11 第八版：写之前把「合并区候选格」整片拍下来。
      //   不再问 WPS「锚点是谁」—— 六版全在真机上失效，退化时 Cells(1,1).Address
      //   会返回非左上角格自己（$K$13），于是 `anchor !== self` 不成立、什么都记不下，
      //   还原逻辑整段跳过，真机红字就是这么来的（K13 写 46344 / 读回空 / 没还回去）。
      //   只用一个不会撒谎的事实：Rows.Count / Columns.Count。
      //   值只可能落在本格或合并区内某一格 → 整片拍下来，就一定有落点。
      if (!w.anchorSnapped) {
        w.anchorSnapped = true
        try {
          const c0 = sheet.Cells(w.row, w.col)
          const ma0 = c0.MergeArea
          const rc = Number(ma0 && ma0.Rows && ma0.Rows.Count) || 1
          const cc = Number(ma0 && ma0.Columns && ma0.Columns.Count) || 1
          const snap = []
          for (let r = w.row; r > w.row - rc && r >= 1; r--) {
            for (let c = w.col; c > w.col - cc && c >= 1; c--) {
              const cell = sheet.Cells(r, c)
              snap.push({ addr: `${colLetter(c)}${r}`, prev: cell.Value2 })
            }
          }
          w.mergeSnap = snap
        } catch (e) { /* 摸不到就不拍，后面按普通失败处理 */ }
      }
      const r = this.writeCell(sheet, w.row, w.col, this._cellValueOf(w))
      if (r && r.ok) {
        st.ok++
        st.cells++
        st.runs++
        w.result = 'ok'
        w.via = r.via
        // ★ 10-30：写成但读回形态不同 ≠ 失败（日期列 Date / 数值列 number）。
        //   最多记一条 format-diff 备注，别把用户引到「表被保护」那条死路上。
        if (r.kind === 'format-diff') {
          st.fmt = (st.fmt || 0) + 1
          const ex = { row: w.row, col: colLetter(w.col), wrote: r.wrote, back: r.backText }
          if (!st.fmtEx) st.fmtEx = ex
          this.log(`R${ex.row} ${ex.col} 列写入成功但读回格式不同（写入 ${r.wrote} / 读回 ${r.backText}）—— 算写成，不重写`)
        }
        return true
      }
      // ★ 2026-11-11 第六版（判据路线放弃后的兜底）：读回空，但值跑到合并区左上角了。
      //   不依赖 WPS 任何合并字段，只问「我刚写的值现在在哪」：
      //     在锚点上 → 值跑偏了，还回原值，报「与 X 合并，这一格没写」
      //     不在锚点上 → 真的没写进去，按原路记 fail
      if (r && r.kind !== 'com' && (w.mergeSnap || w.anchorAddr)) {
        const reverted = this._revertMergedWrite(sheet, w)
        if (reverted) {
          const hit = reverted.addr
          st.merged = (st.merged || 0) + 1
          if (!st.mergedEx) st.mergedEx = { row: w.row, col: colLetter(w.col), block: hit }
          w.result = 'merged'
          w.error = `与 ${hit} 合并`
          if (w.it) {
            w.it.state = 'skip'
            w.it.mergedInto = hit
            w.it.failReason = w.it.failReason || 'merged'
            w.it.text = `${String(w.it.text || '')}（与 ${hit} 合并，这一格没写）`
          }
          this.log(`R${w.row} ${colLetter(w.col)} 写进去的值跑到 ${hit}（合并区非左上角）→ 已还原该格原值，跳过不写`)
          return false
        }
      }
      st.fail++
      // ★ 10-30：失败分两种，别糊成一句「可能被保护/只读」：
      //   com      = 四种写法全抛异常 → 才可能是保护/只读
      //   readback = 没抛错但读回是空/旧值 → 是 API 静默没写（Cells() 那类），跟保护无关
      if (r && r.kind === 'com') st.com = (st.com || 0) + 1
      else st.rbp = (st.rbp || 0) + 1
      if (!st.failEx) st.failEx = { row: w.row, col: colLetter(w.col), wrote: (r && r.wrote) || '', back: (r && r.backText) || '', kind: (r && r.kind) || 'readback' }
      w.result = 'fail'
      w.error = r && r.error
      // ★ 0.9.45：真写不进才记——{row, col, error, via, ts} 进环形缓冲，供事后归因
      this._recordWriteFail(w, r, viaHint)
      return false
    },

    /**
     * 写完之后发现「读回空、但值跑到合并区某一格了」→ 把那一格还原成写前的值。
     *
     * ★ 第八版：不再依赖「锚点是谁」。
     *   WPS 退化时 MergeArea.Cells(1,1).Address 返回非左上角格自己（$K$13），
     *   旧版 `anAddr !== selfAddr` 不成立 → anchorAddr 记成空 → 还原整段跳过。
     *
     *   现在只有一个事实：值只可能落在本格或合并区内某一格。
     *   写前把 Rows.Count × Columns.Count 那片格全拍下来（通常 2×1，成本可忽略），
     *   写后逐格问「我刚写的值是不是在这格里」。命中 → 那一格还原 + 报「与 X 合并」。
     *   命不中 → 真没写进去 → 返回 null，按普通失败走。
     *
     * mergeSnap 是逐格 w 上的（_writeOneChecked 每格各拍各的），不是全局缓存。
     */
    _revertMergedWrite(sheet, w) {
      try {
        // 兼容旧快照（anchorAddr 单点）—— 老数据/老路径也不会因此失效
        const snap = Array.isArray(w.mergeSnap) && w.mergeSnap.length
          ? w.mergeSnap
          : (w.anchorAddr ? [{ addr: w.anchorAddr, prev: w.anchorPrev }] : [])

        // 扫描逻辑抽成纯函数（test/merge-revert 那三条必测锁的就是它）
        const hit = findMovedValue({
          snap,
          selfAddr: `${colLetter(w.col)}${w.row}`,
          want: this._cellValueOf(w),
          readCell: (addr) => {
            const c = sheet.Range(addr)
            return c ? c.Value2 : undefined
          },
        })
        if (!hit) return null

        const target = sheet.Range(hit.addr)
        if (!target) return null
        target.Value2 = hit.prev                               // 还原成写前的值
        return { addr: hit.addr, reason: hit.reason }
      } catch (e) {
        return null
      }
    },

    pickOutputCol() {
      this.panelErr = ''
      try {
        const s = this.readSel()
        if (this.cfg.numberCol === 0) {
          this.cfg = { ...this.cfg, outCol: s.col, detManual: true, detConfirmed: null }
          this.saveCfg()
          this.panelErr = ''
          this.log(`输出列 = ${colLetter(s.col)}（等单号列选好再跑）`)
          return
        }
        if (this.cfg.numberCol > 0 && s.col === this.cfg.numberCol) {
          this.flash(`输出列不能和单号列相同（都是 ${colLetter(s.col)}）—— 那会把提单号覆盖掉，换一列再点`)
          return
        }
        if (this.runningForDoc(this.docKey()).length) this.log('这张表正在查询：改配置只影响下一轮，本轮按开始时快照跑')
        this.cfg = { ...this.cfg, outCol: s.col }
        this.saveCfg()
        // 选完输出列不自动开跑：以前会自动 refresh，用户刚点完就看见表格被写、面板状态乱跳
        // 现在只准备好配置，什么时候查由用户按「③ 立即刷新」决定
        this.log(`输出列 = ${colLetter(s.col)}（准备好后点 ③ 立即刷新）`)
      } catch (e) {
        this.panelErr = '选输出列失败：' + e.message
      }
    },

    // ---------- HTTP ----------
    async httpPost(path, timeoutMs = 30000, body = null) {
      const url = this.base() + path
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shiptrack': '1' },
          body: body === null ? '{}' : JSON.stringify(body),   // ★ 10-28：/parse-manual 需要带正文
          ...(ctl ? { signal: ctl.signal } : {}),
        })
        return await r.json()
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    async httpGet(path, timeoutMs = 5000) {
      const url = this.base() + path
      try {
        if (typeof fetch !== 'function') throw new Error('no-fetch')
        const ctl = typeof AbortController === 'function' ? new AbortController() : null
        if (ctl) this.aborts.add(ctl)
        const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
        let r
        try {
          r = await fetch(url, ctl ? { signal: ctl.signal } : undefined)
        } finally {
          if (timer) clearTimeout(timer)
          if (ctl) this.aborts.delete(ctl)
        }
        return await r.json()
      } catch (e) {
        // 用户点了「停止」→ 主动 abort：别再走 XHR 兜底重发一遍
        if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) throw e
        try {
          return await new Promise((resolve, reject) => {
            const x = new XMLHttpRequest()
          x.open('GET', url, true)
          x.timeout = timeoutMs
          x.onload = () => {
            try {
              resolve(JSON.parse(x.responseText))
            } catch (err) {
              reject(new Error('返回不是 JSON'))
            }
          }
          x.onerror = () => reject(new Error('XHR 网络错误（桥没起 / 被跨域拦）'))
          x.ontimeout = () => reject(new Error('XHR 超时'))
          x.send()
          })
        } catch (e2) {
          // 连接级失败 → 翻转桥状态，横幅立刻显示「本地桥没连上」并给重连按钮
          if (/XHR 网络错误|XHR 超时|ECONN|Failed to fetch|NetworkError|ERR_/i.test(String(e2 && e2.message))) {
            this.bridge = false
          }
          throw e2
        }
      }
    },
    base() {
      return BRIDGE
    },
    // WPS 的 PluginStorage 在开发模式加载项里不保证持久 → 以桥上的文件为准
    async hydrateCfg() {
      if (this.cfg.numberCol > 0) return
      try {
        const r = await this.httpGet('/config?doc=' + encodeURIComponent(this.docKey()), 4000)
        if (r && r.ok && r.cfg && r.cfg.numberCol) {
          this.cfg = { ...this.cfg, ...r.cfg }
          this.scan = null
          this.scanColumn()
          this.log(`已恢复本文档的列设置（${r.exact ? '精确匹配' : '沿用同文件上次'}）：单号列 ${colLetter(this.cfg.numberCol)}${this.cfg.outCol ? ' · 输出列 ' + colLetter(this.cfg.outCol) : ''}`)
          // 恢复后如果超过 24h，照常自动刷一轮
          if (this.ready && !this.runningForDoc(this.docKey()).length) setTimeout(() => this.maybeAutoRefresh(), 3000)
        }
      } catch (e) {
        this.log('从桥恢复配置失败: ' + e.message)
      }
    },

    async loadCarriers() {
      try {
        const r = await this.httpGet('/carriers', 5000)
        if (r && r.ok) {
          this.carriers = r
          this.log(`船司支持：${r.liveCount}/${r.count} 已接入 — ${(r.carriers || []).filter((c) => !c.live).map((c) => c.name).join('、') || '全部已接入'}`)
        }
      } catch (e) {
        this.log('加载船司清单失败: ' + e.message)
      }
    },
    /** S/L 写了船司、但桥报该船司没有适配器（如 SITC/ANL/KMTC）→ 直接给结论，不发请求 */
    knownNotLive(carrier) {
      if (!carrier || !this.carriers || !this.carriers.carriers) return false
      const c = this.carriers.carriers.find((x) => x.id === carrier)
      return !!c && !c.live
    },
    /** 展示名：优先插件自己的短名表，其次桥给的 name（没适配器的船司如 SITC 只有桥知道名字） */
    shortName(carrier) {
      if (!carrier) return ''
      if (CARRIER_NAME[carrier]) return CARRIER_NAME[carrier]
      const c = ((this.carriers && this.carriers.carriers) || []).find((x) => x.id === carrier)
      return (c && c.name) || carrier
    },
    /** ★ 10-28：该船司的官网页（桥从 identify.mjs 直出，插件不维护第二份 URL 表） */
    officialUrl(carrier) {
      if (!carrier || !this.carriers || !this.carriers.carriers) return ''
      const c = this.carriers.carriers.find((x) => x.id === carrier)
      return (c && c.manualUrl) || ''
    },
    /** 打开官网页的同时把单号送进剪贴板（ASP.NET 的 postback 不认 GET 预填，只能复制） */
    copyNumber(n) {
      try { if (n && navigator.clipboard) navigator.clipboard.writeText(String(n)) } catch (e) { /* 剪贴板不可用就算了 */ }
    },
    /** 展开 / 收起某一行的手工兜底面板 */
    toggleManual(it) {
      it.manualOpen = !it.manualOpen
      if (it.manualOpen && !it.manualDraft) it.manualDraft = ''
    },
    /** 把粘进来的官网文本交给桥解析（解析逻辑只有 engine/tracking/manual-parse.mjs 一处） */
    async applyManual(it, sheet) {
      const text = String(it.manualDraft || '').trim()
      if (!text) { it.manualNote = '先粘点东西进来'; return }
      it.manualBusy = true
      try {
        const r = await this.httpPost('/parse-manual', 12000, { text })
        if (!r || !r.ok) throw new Error((r && r.error) || '解析失败')
        if (r.parsed && r.events.length) {
          const lines = r.events.map((e) => `${e.time.slice(5)} ${e.activity}${e.city ? ' @ ' + e.city : ''}`)
          it.text = `手工 · ${r.events.length} 条：${lines.slice(-2).join(' / ')}`
          it.handmade = true
          it.state = 'ok'
          it.failReason = ''
          it.manualNote = `解析出 ${r.events.length} 条 · 已标为手工来源`
          it.manualOpen = false
        } else {
          it.text = `手工 · 未解析：${String(r.raw || text).replace(/\s+/g, ' ').slice(0, 80)}`
          it.handmade = true
          it.state = 'ok'
          it.failReason = ''
          it.manualNote = '没认出日期/事件，原文已原样保留'
        }
        // 立刻写回单元格（不改列、不加列，沿用已选的输出列）
        if (this.cfg.outCol > 0) this.writeResult(this.ensureBatch(sheet), it, sheet, it.row, this.cfg.outCol, true)
      } catch (e) {
        it.manualNote = '解析失败：' + String(e.message || e)
      } finally {
        it.manualBusy = false
      }
    },

    async ping() {
      this.pinged = true
      try {
        const h = await this.httpGet('/health', 3000)
        const was = this.bridge
        if (h && h.ok) {
          this.bridge = true
          this.bridgeState = 'ok'
          this.bridgeWhy = ''
          // ★ 卡 t_8a6689dc：桥自报的契约区间（老桥没有 → null，按 v1 兼容渲染）
          this.bridgeSchema = Number.isInteger(h.schemaVersion) ? h.schemaVersion : null
          this.log(`契约：桥 v${this.bridgeSchema == null ? '未上报（老桥）' : this.bridgeSchema} · 本插件 v${PLUGIN_SCHEMA_VERSION}`)
          this.log('bridge: ' + JSON.stringify(h))
          if (!was) this.log('桥已重新连上')
          // 桥通了 → 之前因连接失败留下的批次级写入错误自动失效（横幅不会挂僵尸）
          for (const b of this.batches) if (b.errs && /写入失败/.test(b.errs.write || '')) b.errs.write = ''
        } else {
          // 连得上、但桥自己说 ok:false（Origin 被拒 / 依赖缺失…）→ 原样转述，不猜
          this.bridge = false
          this.bridgeState = 'degraded'
          this.bridgeWhy = String((h && (h.error || h.msg || h.detail)) || 'ok:false')
          this.log('bridge 自报异常: ' + JSON.stringify(h))
        }
      } catch (e) {
        this.bridge = false
        this.bridgeWhy = String((e && e.message) || e)
        // 关键区分：连接被拒 与 被跨域/CSP 拦，在 fetch 眼里是同一张脸
        // 靠 no-cors 探针（不读响应、只问「连得上吗」）把两者分开
        this.bridgeState = (await this.reachProbe()) === 'reachable' ? 'blocked' : 'down'
        this.log(`ping 失败（${this.bridgeState}）: ${this.bridgeWhy}`)
      }
    },
    /** 只问「8791 连得上吗」，不读内容（no-cors：能连上就 resolve 一个 opaque 响应） */
    async reachProbe() {
      if (typeof fetch !== 'function') return 'unknown'
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ctl ? setTimeout(() => ctl.abort(), 2500) : null
      try {
        await fetch(this.base() + '/health', { mode: 'no-cors', cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}) })
        return 'reachable'
      } catch (e) {
        // no-cors 也可能被 PNA/CSP 挡（那就说明页面侧有拦截，不是没进程）
        return /cors|cross-origin|private network|content security|csp/i.test(String((e && e.message) || '')) ? 'reachable' : 'unreachable'
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    async copyStartCmd() {
      const cmd = this.startCmdClean
      try {
        if (!(navigator.clipboard && navigator.clipboard.writeText)) throw new Error('no-clipboard')
        await navigator.clipboard.writeText(cmd)
        this.flash('启动命令已复制，粘到终端跑一次就好')
      } catch (e) {
        this.flash('复制不了，手工粘这条：' + cmd, 15000)
      }
    },
    /**
     * ★ 2026-11-11 合并格探针：三次都栽在「WPS 的合并格返回值到底是啥」上，别再猜。
     *
     * 打三样东西，对着看就知道判据该用哪个：
     *   MergeCells        布尔（VBA 规范 -1/0，实测部分合并返 0）
     *   MergeArea.Address 合并区范围（$K$12:$K$13）
     *   MergeArea.Row/Col 合并区左上角坐标
     *   Address           本格地址（$K$13）
     *
     * 判读：
     *   非左上角格：Address=$K$13 且 MergeArea.Address=$K$12:$K$13 → 地址比较成立
     *   若 MergeArea.Address 也返回 $K$13 → WPS 连 MergeArea 都不可信，改用 Rows.Count > 1
     *   Rows.Count / Cols.Count 永远是最硬的：合并区 >=2，普通格 =1
     */
    probeMerge() {
      const out = []
      out.push('=== 合并格探针 ' + new Date().toLocaleString() + ' ===')
      try {
        const a = this.app()
        if (!a) { out.push('WPS Application 摸不到'); this.log(out.join('\n')); return }
        // ★ 16:47 爹地点探针崩过：`Cannot read properties of undefined (reading 'ActiveSheet')`。
        //   日志里「宿主: Microsoft Excel · 文档: 无」—— 这时 ActiveDocument 是 undefined。
        //   走三条兜底，全空才认输。
        let doc = null
        try { doc = a.ActiveDocument } catch (e) { doc = null }
        if (!doc) { try { doc = a.ActiveWorkbook } catch (e) { doc = null } }
        if (!doc) { try { if (a.Workbooks && a.Workbooks.Count) doc = a.Workbooks.Item(1) } catch (e) { doc = null } }
        if (!doc) { out.push('摸不到活动工作簿（ActiveDocument / ActiveWorkbook / Workbooks.Item(1) 全空）'); this.log(out.join('\n')); return }
        let sheet = null
        try { sheet = doc.ActiveSheet } catch (e) { sheet = null }
        if (!sheet) { try { if (doc.Sheets && doc.Sheets.Count) sheet = doc.Sheets.Item(1) } catch (e) { sheet = null } }
        if (!sheet) { out.push('摸不到活动工作表'); this.log(out.join('\n')); return }

        const cfg = this.cfg || {}
        const startRow = Number(cfg.startRow) || 2
        const rows = Number(cfg.rows) || 15
        out.push('表: ' + (doc.Name || '?') + ' | 工作表: ' + (sheet.Name || '?') + ' | 行: ' + startRow + '-' + (startRow + rows - 1))

        // ★ 扫「所有会被写的列」，不只输出列 —— 报错的格子可能在 ETD/ETA 列
        const targets = []
        const add = (label, c) => { const n = Number(c) || 0; if (n > 0) targets.push([label, n]) }
        add('单号列', cfg.numberCol)
        add('输出列', cfg.outCol)
        add('ETD列', cfg.etdCol)
        add('ETA列', cfg.etaCol)
        add('POL列', cfg.polCol)
        add('POD列', cfg.podCol)
        if (!targets.length) { out.push('cfg 里一个列都没定，先点「立即查询」'); this.log(out.join('\n')); return }
        out.push('要扫的列: ' + targets.map(([l, c]) => l + '=' + colLetter(c)).join(' '))

        let totalMerged = 0
        for (const [label, c] of targets) {
          out.push('--- ' + label + ' = ' + colLetter(c) + '(' + c + ') ---')
          let mergedCount = 0
          for (let r = startRow; r < startRow + rows; r++) {
            try {
              const cell = sheet.Cells(r, c)
              const mc = cell.MergeCells
              const ma = cell.MergeArea
              const maAddr = ma ? ma.Address : '(null)'
              const maRow = ma ? ma.Row : '(null)'
              const maCol = ma ? ma.Column : '(null)'
              let rowsCnt = null, colsCnt = null, maAnchorAddr = null
              try { rowsCnt = ma ? ma.Rows.Count : null } catch (e) { rowsCnt = null }
              try { colsCnt = ma ? ma.Columns.Count : null } catch (e) { colsCnt = null }
              try { maAnchorAddr = ma && ma.Cells(1, 1) ? ma.Cells(1, 1).Address : null } catch (e) { maAnchorAddr = null }
              const ownAddr = cell.Address
              // 用跟写路径完全相同的判据算一遍，真值和结论一起打
              const v = mergeVerdict({
                cellAddr: ownAddr, cellRow: r, cellCol: c,
                maAddr, maAnchorAddr, maRow, maCol, maRows: rowsCnt, maCols: colsCnt,
              })
              const flag = v.nonAnchor ? ' ★非左上角[' + v.reasons.join(',') + ']' : ''
              if (v.nonAnchor) { mergedCount++; totalMerged++ }
              out.push(`${colLetter(c)}${r}: MergeCells=${JSON.stringify(mc)} | MergeArea=${maAddr} @(${maRow},${maCol}) | 左上角=${maAnchorAddr || '(null)'} | Address=${ownAddr} | Rows=${rowsCnt} Cols=${colsCnt}${flag}`)
            } catch (e) {
              out.push(`${colLetter(c)}${r}: 读取异常 ${e && e.message ? e.message : e}`)
            }
          }
          out.push('--- ' + label + ' 命中 ' + mergedCount + ' 格 ---')
        }
        out.push('=== 合计命中非左上角: ' + totalMerged + ' 格 ===')
      } catch (e) {
        out.push('探针失败: ' + (e && e.message ? e.message : e))
      }
      this.log(out.join('\n'))
    },

    diagDump() {
      const a = this.app()
      const lines = []
      lines.push('页面: ' + location.protocol + ' · origin=' + location.origin)
      lines.push('Application: ' + (a ? '存在' : '不存在'))
      if (a) {
        try { lines.push('WPS: ' + (a.Version || '?') + ' / Build ' + (a.Build || '?')) } catch (e) {}
        try { lines.push('宿主: ' + (a.Name || '?') + ' · 文档: ' + (a.ActiveDocument ? a.ActiveDocument.Name : '无')) } catch (e) {}
      }
      lines.push('桥: ' + BRIDGE)
      this.diag = lines.join('\n') + '\n---\n' + this.diag
    },

    // ---------- 刷新 ----------
    // 是否「当前正在看的这张表」——只有它在最前面才自动跑
    isActiveDoc() {
      try {
        const a = this.app()
        const wb = a.ActiveWorkbook && a.ActiveWorkbook.Name
        const sh = a.ActiveSheet && a.ActiveSheet.Name
        return String(wb || '') + '|' + String(sh || '') === this.docKey()
      } catch (e) { return false }
    },
    globalAutoDue() {
      const st = this.storage()
      let last = 0
      try { last = Number((st && st.getItem(GLOBAL_RUN_KEY)) || localStorage.getItem(GLOBAL_RUN_KEY) || 0) } catch (e) {}
      return Date.now() - last >= AUTO_MS
    },
    markGlobalAuto() {
      const st = this.storage()
      try { if (st) st.setItem(GLOBAL_RUN_KEY, String(Date.now())) } catch (e) {}
      try { localStorage.setItem(GLOBAL_RUN_KEY, String(Date.now())) } catch (e) {}
    },
    // 自动刷新总入口：多处条件都在这里收口，避免「每个打开的工作簿各跑一轮」
    maybeAutoRefresh() {
      if (!this.ready || this.runningForDoc(this.docKey()).length) return
      if (!this.globalAutoDue()) return
      if (!this.isActiveDoc()) return
      this.markGlobalAuto()
      this.log('距上次自动刷新超过 24h：只查空行（最多 ' + AUTO_MAX_ROWS + ' 条）')
      this.refresh(false, { auto: true })
    },

    async refresh(manual, opts = {}) {
      this.panelErr = ''
      // ★ 卡 t_8a6689dc：契约横幅按「这一轮」算 —— 这轮里没有契约不符就自动消失，不挂僵尸提示
      this.schemaAlert = null
      // ★ 快照必须在任何 await 之前取：桥慢/重连时 await 一次，用户可能已经切到别的表了
      const a = this.app()
      const sheet = a && a.ActiveSheet
      const doc = this.docKey()
      if (!sheet) {
        this.panelErr = '没有活动工作表'
        return
      }
      // ★ t_a72fba24 第一条铁律：**每次**都重新识别（一次 COM 读 30 行，毫秒级）。
      //   · 和存下的确认配置一致 → 静默，直接查直接写（零点击）
      //   · 不一致 → 只提示一次「格式好像变了」，等他点「按新的 / 沿用旧的」
      //   · 行数变多不算变化（新增订单是常态，不打扰）
      if (!opts.skipDetect) {
        const det = await this.detectNow()
        if (det && det.ok) {
          const diff = compareToConfirmed(this.cfg, det)
          if (diff.changed) { this.cfgConflict = { text: diff.text, det }; return }
        }
        if (!this.ready) {
          this.flash('没认出列来，展开「更多设置」手动选单号列和输出列')
          return
        }
      }
      if (this.cfg.outCol === this.cfg.numberCol) {
        this.panelErr = '配置异常：输出列和单号列是同一列，拒绝执行（会覆盖提单号）'
        return
      }
      if (!sheet) {
        this.panelErr = '没有活动工作表'
        return
      }
      // ★ 0.9.43：同一张表已经有一批在跑 → 默认不许再点（防手抖把同一段查两遍）；
      //   要并行就点「再开一批」（opts.force）。不同表本来就不拦 —— 这正是这次要的功能。
      if (!opts.force && this.runningForDoc(doc).length) {
        this.log(`「${doc}」已经有一批在跑；想并行再来一批就点「再开一批」`)
        return
      }
      // 先判断「这张表到底能不能写」——写不进去时给明确原因，别让用户猜
      const capErr = this.checkWritable(sheet)
      if (capErr) this.log('写回受阻：' + capErr)

      // 1) 按用户选的区域读（多种 API 依次尝试，兼容不同 WPS 版本）
      const col = this.cfg.numberCol
      const outCol = this.cfg.outCol          // 快照：跑的过程中用户改配置也不影响这一轮
      const r1 = this.cfg.startRow
      let r2 = this.cfg.startRow + this.cfg.rows - 1
      if (this.cfg.mode === 'column') {
        const usedLast = this.usedLastRow(sheet)
        // ★ 0.9.41：末行按单号列收口（含收缩）——结果列下面的脏文字不该把范围顶大
        const last = this.numberLastRow(sheet, usedLast, col)
        if (last !== usedLast) this.log(`范围按单号列收口到第 ${last} 行（整表用到 ${usedLast} 行）`)
        if (last !== r2) {
          if (last > r2) this.log(`表尾有新数据：范围 ${r1}–${r2} 扩到 ${r1}–${last}`)
          else this.log(`范围收缩：${r1}–${r2} → ${r1}–${last}（下面没有单号）`)
          r2 = Math.max(r1, last)
          this.cfg = { ...this.cfg, rows: r2 - r1 + 1 }
          this.saveCfg(doc)
        }
      }
      const read = this.readRangeValues(sheet, col, r1, r2)
      const vals = read.values
      if (!vals.length) {
        this.panelErr = `读不出 ${colLetter(col)} 列（第 ${r1}–${r2} 行）：${read.error || '所有读法都失败'}`
        this.log('读取失败，诊断: ' + JSON.stringify(this.apiReport || {}))
        return
      }
      this.readVia = read.via
      // ★ 0.9.42 批量读：输出列整段一次读（「保留旧值」判断、自动刷新筛空行都靠它），不再逐格 readOne
      const outRead = this.readRangeValues(sheet, outCol, r1, r2)
      const outSnap = (outRead && outRead.values && outRead.values.length === (r2 - r1 + 1))
        ? { col: outCol, from: r1, values: outRead.values }
        : null
      // ★ 0.9.42 批量读：船司/港口/双列号各整列一次读（原来每行 4~5 次 readOne）
      const colSnap = this.prefetchCols(sheet, [this.cfg.carrierCol, this.cfg.polCol, this.cfg.podCol, this.cfg.blCol, this.cfg.bkCol], r1, r2)
      const nums = vals.map((v, i) => {
        const row = r1 + i
        // 一格写「订舱号/提单号」时：主用提单号，另一个留作兜底（有些船司只认订舱号）
        const parts = splitParts(v).map(cleanNumber).filter(looksLikeNumber)
        return { row, number: parts[0] || '', alts: parts.slice(1), raw: v }
      })
      let todo = nums.filter((x) => x.number)
      if (opts.auto) {
        // 自动刷新只补空行：已经写过结果的行不重查（省得开机就几十个浏览器查询把机器拖死）
        const tmp = { sheet, outSnap }
        const empty = todo.filter((t) => !this.oldOutText(tmp, t.row, outCol))
        if (!empty.length) { this.log('自动刷新：没有待补的空行，跳过'); return }
        if (empty.length > AUTO_MAX_ROWS) this.log(`自动刷新：待查 ${empty.length} 行，只处理前 ${AUTO_MAX_ROWS} 行`)
        todo = empty.slice(0, AUTO_MAX_ROWS)
      }
      if (!todo.length) {
        this.panelErr = `单号列 ${colLetter(col)}（第 ${r1}–${r2} 行）里没读到提单号 —— 确认选的是 MBL 那一列`
        this.log('前 6 行原始值: ' + JSON.stringify(vals.slice(0, 6)))
        return
      }

      const items = nums.map((x) => ({
        row: x.row,
        number: x.number || '—',
        numCol: col,            // ★ 0.9.41：写回时按「这一列」核对行身份（跑动中改配置也不影响本轮）
        text: x.number ? '' : '（空/非单号，跳过）',
        state: x.number ? 'idle' : 'skip'
      }))
      // ★ 0.9.43：这一轮的全部状态装进一个「批次」，面板不再有全局 busy —— 另一张表可以同时再开一批
      const cfgSnap = { ...this.cfg }
      this.writeAcc = { ok: 0, fail: 0, miss: 0, runs: 0, cells: 0, fills: 0, ms: 0 }   // 本轮写回账本从零开始
      const b = this.newBatch({ doc, sheet, cfg: cfgSnap, items, queue: todo, kind: opts.auto ? 'auto' : 'run', manual })
      // ★ 中置信首次（0.4–0.8 且这张表还没确认过）→ 本轮只预览，一格都不写
      b.preview = needsPreview(this.cfg, this.detected)
      if (b.preview) this.log('这张表是首次识别（中置信）→ 本轮只预览结果，不写表格；你点「就对」才写')
      b.capErr = capErr
      b.outSnap = outSnap
      b.colSnap = colSnap
      this.batches.push(b)
      this.publishBatches()
      this.pruneBatches()
      this.viewBatchId = b.id
      this.docNow = doc
      this.publishCross()
      if (this.runningCount() >= this.maxBatches()) {
        this.log(`第 ${b.seq} 批（${doc}）排队：已有 ${this.runningCount()} 批在跑（上限 ${this.maxBatches()}），空出一格就开跑`)
        return
      }
      await this.runBatch(b)
    },

    /**
     * ★ 0.9.43 跑一批：它自己的表、自己的配置快照、自己的进度和错误。
     * 两批并行时观察到的就是「两份进度条各走各的」，写回由 _flushWriteQueue 按批次排队。
     */
    async runBatch(b) {
      if (!b || b.state === 'running') return
      // ★ 关键：闭包里拿到的必须是 Vue 的响应式代理，否则改 raw 对象 UI 不刷新（banner/进度条全僵）
      b = this.batchById(b.id) || b
      b.state = 'running'
      if (!b.start) b.start = Date.now()
      this.publishBatches()
      const sheet = b.sheet
      const outCol = b.cfg.outCol
      const queue = b.queue.slice()
      // 桥没连上：这里补一次 ping（不挡批次创建，停止按钮照样能按）
      if (!this.bridge) {
        await this.ping()
        if (b.stop) { this.finishBatch(b); return }
        if (!this.bridge) {
          b.errs.action = '本地桥没连上，本轮没发任何查询（按横幅里的命令把桥起起来再点③）'
          this.finishBatch(b)
          return
        }
      }
      // 每批内部并发 4；面板全局还有 maxInflight 的硬上限（多批并行时自动互相让位）
      const CONC = Math.max(1, Math.min(Number(window.__SHIPTRACK_CONC__ || 4), queue.length))
      this.log(`开跑第 ${b.seq} 批（${b.doc}）：${queue.length} 条${b.manual ? '（手动）' : '（自动）'}${this.runningCount() > 1 ? ` · 同时 ${this.runningCount()} 批` : ''}`)
      let netFails = 0            // 连续连接级失败计数：断网时别把 50 行全试一遍（每行都要起浏览器）
      const worker = async () => {
        while (queue.length && !b.stop) {
          const t = queue.shift()
          try {
            await this.queryAndWrite(b, sheet, t, outCol)
            // 熔断：连接级失败（断网/代理没开）时，后面每行都要再起一个浏览器 —— 直接停这一批
            const it2 = b.items.filter((x) => x.row === t.row)[0]
            const netish = it2 && it2.state === 'error'
              && /ECONN|ERR_|Failed to fetch|NetworkError|连接|net::/i.test(String(it2.failReason || it2.text || ''))
            netFails = netish ? netFails + 1 : 0
            if (netFails >= 3) {
              b.stop = true
              b.errs.action = '连续 3 条连接失败（多半是断网或代理没开）—— 已停止本轮，别让每行都去开一次浏览器'
              this.log(`熔断：连续连接失败 3 次，停止第 ${b.seq} 批（其它批次不受影响）`)
            }
          } catch (e) {
            // 单行异常不许拖垮整轮（历史教训：一次未捕获异常会让面板永远卡在「查询中」）
            const it = b.items.filter((x) => x.row === t.row)[0]
            if (it) { it.state = 'error'; it.text = '查询失败：' + (e.message || e) }
            this.log(`R${t.row} 异常: ${e.message || e}`)
          }
          b.done++
          this.publishBatches()
        }
      }
      try {
        await Promise.all(Array.from({ length: CONC }, () => worker()))
      } catch (e) {
        this.log('刷新异常终止: ' + (e.message || e))
        b.errs.action = '刷新异常终止：' + (e.message || e)
      } finally {
        // ★ 0.9.42：本轮剩余的写回队列立刻落盘（分段批量写 + 读回），然后再统计——
        //   不然「查询跑完了但结果还堆在队列里」会把汇总算错。
        // ★ 0.9.44：写回是「await 的异步收尾」，busy 必须等它写完才复位（避免面板先松手、
        //   主线程还在写，画面停在最后一帧）。收尾自己抛异常也绝不能把面板锁死 →
        //   内层 try/finally 保证 finishBatch 一定跑得到。
        try {
          await this.flushWrites()
        } catch (e) {
          b.errs.write = '收尾写回异常：' + String((e && e.message) || e).slice(0, 80)
          this.log(b.errs.write)
        } finally {
          this.finishBatch(b)
        }
      }
    },

    /** 一批的收尾：把没跑完的行标清楚、汇总、落重查队列、放行排队的批次（提前退出也走这里） */
    finishBatch(batch) {
      let b = batch || this.vb
      if (!b) return
      b = this.batchById(b.id) || b
      const sheet = b.sheet
      const outCol = b.cfg.outCol
      const completed = !b.stop
      // 没收尾的行别挂着「查询中…」
      const idleRows = []
      for (const it of b.items) {
        if (it.state === 'querying') {
          it.state = 'skip'
          it.text = b.stop ? '（已停止，未完成）' : '（本次未完成，点③重跑）'
        }
        if (it.state === 'idle') {
          it.state = 'skip'
          it.text = b.stop ? '（已停止，未查询）' : '（本次未查，点③刷新）'
          // 这行这次没重算 → 之前刷的里程碑色可能已过期，清掉（一起批量清，不逐行摸 Interior）
          idleRows.push(it.row)
        }
      }
      if (idleRows.length) this.clearOurColors(sheet, idleRows, b.doc, outCol)
      b.colSnap = null
      b.outSnap = null
      b.summary = summarizeFails(b.items)
      b.state = b.stop ? 'stopped' : 'done'
      this.publishBatches()
      this.log(`第 ${b.seq} 批（${b.doc}）汇总：${b.summary}`)
      // ★ 预览批次收尾：告诉他「认成这样、几行」，点「就对」才写
      if (b.preview) {
        const n = b.items.filter((x) => x.number && x.state !== 'skip' && x.state !== 'querying' && x.state !== 'idle').length
        if (n) {
          this.previewAsk = { batchId: b.id, numCol: b.cfg.numberCol, outCol: b.cfg.outCol, rows: n }
          this.log(`预览：${n} 行结果等你确认（表格一格都还没写）`)
        }
      }
      // ★ 11-03：船期变更在这一批收尾时才交出去（自动写 or 出确认条）——绝不在查询途中写日期
      try { this.settleSchedule(b) } catch (e) { this.log('船期确认条异常: ' + ((e && e.message) || e)) }
      this.scheduleRetry(b)
      if (completed) {
        this.saveLastRun(Date.now(), b.doc)
        this.log(`刷新完成 ${b.done}/${b.total}（第 ${b.seq} 批 ${b.doc}）`)
      } else {
        this.log(`提前停止 ${b.done}/${b.total}（第 ${b.seq} 批）；24h 自动刷新计时不重置，下次打开会补跑`)
      }
      // ★ 0.9.43：(a)/(b) 的实测答案就在这两个数里 —— 真机跑一轮多表后抄回来
      if (b.xsheet.ok || b.xsheet.fail) this.log(`第 ${b.seq} 批跨表写：成功 ${b.xsheet.ok} / 回落 ${b.xsheet.fail}`)
      this.publishCross(b)
      this.pruneBatches()
      this.pumpQueue()
    },

    /**
     * 自动重查：本轮没拿到结果的行，30 分钟后自动再查一次（每号最多 2 次）
     * 队列存进文档配置，关掉面板/重开文件都还在。
     */
    scheduleRetry(batch) {
      const b = batch || this.vb
      if (!b) return
      const DELAY = Number(window.__SHIPTRACK_RETRY_MS__ || 0) || 30 * 60 * 1000   // 测试可改短
      const MAX_TRIES = 2
      const isCur = b.doc === (this.docNow || this.docKey())
      const base = isCur ? this.cfg : (this.loadStoredCfg(b.doc) || {})
      const prev = Array.isArray(base.retry) ? base.retry : []
      const prevBy = new Map(prev.map((x) => [String(x.n), x]))
      const now = Date.now()
      const next = []
      for (const it of b.items) {
        const n = String(it.number || '')
        if (!n || n === '—' || it.state === 'skip') continue
        const gotResult = it.state === 'ok' && !/查无|无记录|未找到|未返回|没有数据/.test(String(it.text || ''))
        if (gotResult) continue
        if (b.stop) continue               // 手动停止的，不自动重查
        const old = prevBy.get(n)
        const tries = (old ? old.tries : 0) + 1
        if (tries > MAX_TRIES) {
          this.log(`R${it.row} ${n} 已自动重查 ${MAX_TRIES} 次仍无结果，不再排队`)
          continue
        }
        next.push({ n, row: it.row, at: now + DELAY, tries })
      }
      this.saveCfg(b.doc, { ...base, retry: next })
      if (isCur) {
        this.cfg = { ...this.cfg, retry: next }
        this.retryCount = next.length
        this.armRetryTimer()
      }
      if (next.length) {
        const t = new Date(next[0].at).toTimeString().slice(0, 5)
        this.log(`${next.length} 条没查到结果 → ${t} 之后自动重查（每号最多 2 次）`)
      }
    },

    armRetryTimer() {
      try { clearTimeout(this.retryTimer) } catch (e) { /* ignore */ }
      const q = (this.cfg.retry || []).filter((x) => x && x.n)
      if (!q.length) return
      const at = Math.min(...q.map((x) => x.at || 0))
      const delay = Math.max(5000, at - Date.now())
      // setTimeout 上限约 24.8 天，这里最多 30 分钟，安全
      this.retryTimer = setTimeout(() => this.runRetry(), delay)
    },

    async runRetry() {
      const doc = this.docKey()
      if (this.runningForDoc(doc).length || this.runningCount() >= this.maxBatches()) {
        this.retryTimer = setTimeout(() => this.runRetry(), 120000)
        return
      }
      const due = (this.cfg.retry || []).filter((x) => x && x.n && x.at <= Date.now() + 5000)
      if (!due.length) { this.armRetryTimer(); return }
      const a = this.app()
      const sheet = a && a.ActiveSheet
      if (!sheet) { this.log('自动重查跳过：当前没有打开的表'); this.retryTimer = setTimeout(() => this.runRetry(), 300000); return }
      const outCol = this.cfg.outCol
      // ★ 0.9.43：重查也是一批（自带 items/cfg 快照），不再借用全局 busy
      const last = this.latestForDoc(doc)
      const items = due.map((x) => {
        const prev = last ? last.items.filter((i) => i.row === x.row)[0] : null
        return {
          row: x.row, number: x.n, numCol: this.cfg.numberCol,
          text: (prev && prev.text) || '', state: 'idle',
          stage: prev && prev.stage, stageLabel: prev && prev.stageLabel
        }
      })
      const b0 = this.newBatch({ doc, sheet, cfg: this.cfg, items, queue: due.map((x) => ({ row: x.row, number: x.n, alts: [], raw: x.n })), kind: 'retry' })
      b0.outSnap = null
      b0.colSnap = null
      b0.state = 'running'
      b0.start = Date.now()
      this.batches.push(b0)
      this.publishBatches()
      const b = this.batchById(b0.id) || b0            // 用响应式代理（raw 改了 UI 不刷新）
      if (!this.viewBatchId) this.viewBatchId = b.id
      this.log(`自动重查 ${due.length} 条（30 分钟到点，第 ${due[0].tries} 次）`)
      try {
        for (const item of b.queue) {
          if (b.stop) break
          await this.queryAndWrite(b, sheet, item, outCol)
          b.done++
        }
      } catch (e) {
        this.log('自动重查异常：' + (e.message || e))
      } finally {
        // ★ 0.9.44：写回是异步分段收尾，必须等它写完再判「这一批完成」
        try { await this.flushWrites() } catch (e) { this.log('重查收尾写回异常：' + ((e && e.message) || e)) }
      }
      b.state = 'done'
      b.summary = summarizeFails(b.items)
      // 重查完仍没结果的，留在队列里等下一次（tries 已在 scheduleRetry 里递增）
      const still = (this.cfg.retry || []).filter((x) => !due.some((d) => d.n === x.n))
      this.cfg = { ...this.cfg, retry: still }
      this.saveCfg(doc)
      this.scheduleRetry(b)
      this.pruneBatches()
    },

    // 单行：识别归属 → 查询 → 写回（暂态失败不覆盖旧值）
    async queryAndWrite(batch, sheet, t, outCol) {
      const b = batch || this.vb
      const cfg = b ? b.cfg : this.cfg
      const it = b.items.filter((x) => x.row === t.row)[0]
      if (!it) return
      // ★ 10-28（爹地报障：一个表不可能开 10 分钟不切 tab）：切表**不再阻止查询** ——
      //   桥在跑、结果有用；是否现在写回由 writeResult 决定（写不进非活动表就攒进 pendingWrites）。
      it.state = 'querying'
      it.text = '查询中…'
      it.failReason = ''
      try {
        let override = ''
        // ① 先看船司列（用户自己的 S/L，最权威；SOC/COC 等字样自动忽略）
        if (cfg.carrierCol > 0) {
          try {
            const sl = this.readColCached(b, cfg.carrierCol, t.row)   // ★ 0.9.42 整列快照，不再逐行读
            override = carrierFromSl(sl)
            if (override) this.log(`${t.number}: 按 S/L「${String(sl).trim()}」→ ${override}`)
          } catch (e) {}
        }
        // ①b 写了船司名、但这个船司没有适配器 → 直接给结论，一个请求都不发
        if (!override && cfg.carrierCol > 0) {
          try {
            const sl = this.readColCached(b, cfg.carrierCol, t.row)   // ★ 0.9.42 整列快照，不再逐行读
            const raw = String(sl == null ? '' : sl).trim()
            if (looksLikeCarrierToken(raw)) {
              it.state = 'error'
              it.text = `${raw} 未接入（手工查）`
              it.failReason = 'not-wired'
              this.log(`R${t.row} S/L「${raw}」未接入，跳过`)
              return this.writeResult(b, it, sheet, t.row, outCol, true)
            }
          } catch (e) {}
        }
        // ② 没写船司列时才问识别器
        if (!override) try {
          const idr = await this.httpGet('/identify?number=' + encodeURIComponent(t.number), 4000)
          if (idr && !idr.carrier) {
            const c0 = (idr.candidates || [])[0]
            if (c0 && c0.carrier && Number(c0.score || 0) > 0) {
              override = c0.carrier
              this.log(`${t.number}: 无确定归属 → 按候选 ${c0.label || c0.carrier} 查`)
            }
          }
        } catch (e) {
          this.log(`${t.number}: identify 失败 ${e.message}`)
        }
        if (override && this.knownNotLive(override)) {
          it.text = `${this.shortName(override) || override} 未接入（手工查）`
          it.state = 'error'
          it.failReason = 'not-wired'
          it.manualUrl = this.officialUrl(override)          // ★ 10-28：没接入也要给一条能点的路
          it.manualLabel = this.shortName(override) || override
          return this.writeResult(b, it, sheet, t.row, outCol, true)
        }
        // ★ 0.9.43：真正的查询走「面板全局槽位」——多批并行时在飞请求数有硬上限，
        //   超了就在这儿等（不是让桥去排队，桥那边是浏览器实例，占了就是占了）。
        // ★ 卡 t_cec031c1：pol/pod 必须传给桥 —— 里程碑判定搬进引擎后，
        //   只有插件知道用户选了哪两列港口；不传就等于让引擎瞎猜阶段。
        const rowPol = cfg.polCol ? String(this.readColCached(b, cfg.polCol, t.row) || '') : ''
        const rowPod = cfg.podCol ? String(this.readColCached(b, cfg.podCol, t.row) || '') : ''
        // ★ 10-30：台账（~/.hermes/wps-shiptrack/jobs/*.ndjson）里 doc/sheet/row 全是空/0，
        //   事后定位全靠内存里的 writeFailLog —— /track 早就支持这三个参数，带上就完事。
        const at = this.docSheetOf(b)
        // ★ 2026-11-05：待重查批次（上次没抓到）告诉桥/引擎「这是重试」→ Maersk 站点窗口从 8s 放宽到 20s。
        //   否则重试还是用 8s，同一批行会永远失败（爹地截图里 67 格待重查卡死就是这么来的）。
        const retryQ = b.kind === 'retry' ? '&retry=1' : ''
        const call = async (num) => {
          await this.acquireSlot()
          try {
            return await this.httpGet(
              // 单条 90s：绝大多数成功查询 <15s；跑飞的（站点卡住）不能占着 worker 两分钟
              // ★ 卡 t_8a6689dc：带上本插件认得的契约版本 → 桥太新/太旧都能当场拒绝（日志里也能定位是谁旧）
              '/track?number=' + encodeURIComponent(num) + (override ? '&carrier=' + override : '') + '&timeout=90000' + '&schema=' + PLUGIN_SCHEMA_VERSION + retryQ
              + '&doc=' + encodeURIComponent(at.doc) + '&sheet=' + encodeURIComponent(at.sheet) + '&row=' + Number(t.row || 0)
              + (rowPol ? '&pol=' + encodeURIComponent(rowPol) : '') + (rowPod ? '&pod=' + encodeURIComponent(rowPod) : ''), 95000)
          } finally {
            this.releaseSlot()
          }
        }
        let usedNum = t.number
        let r = await call(usedNum)
        // 查无此单 & 这一格还有别的号（订舱号/提单号）→ 换那个号再试一次
        const notFound = r && r.ok === false && /DOCUMENT does not exist|not found|No tracking data|HTTP 404|Shipment not found/i.test(String(r.error || ''))
        if (notFound && t.alts && t.alts.length) {
          const alt = t.alts[0]
          this.log(`${t.number} 查无 → 换同格的另一个号 ${alt} 再试`)
          const r2 = await call(alt)
          if (r2 && r2.ok !== false) { r = r2; usedNum = alt }
        }
        // 双列策略（爹地 2026-10-27 定）：先查提单号，查无动态再查订舱号。
        // 这样绝大多数行只发 1 个请求，不会因为多一列就把整批耗时翻倍。
        const hasEvents = (x) => !!(x && x.ok !== false && (x.events || []).length)
        if (!hasEvents(r)) {
          const blCol = cfg.blCol || 0
          const bkCol = cfg.bkCol || 0
          const pick = (c) => {
            if (!c || c === cfg.numberCol) return ''
            try { return cleanNumber(String(this.readColCached(b, c, t.row) || '')) } catch (e) { return '' }
          }
          // 什么时候还该试第二列：主查的是提单号 → 试订舱号；主查的是订舱号 → 试提单号
          const curIsBl = blCol && cfg.numberCol === blCol
          const secondCol = curIsBl ? bkCol : (blCol || cfg.altCol || 0)
          const altNum = pick(secondCol)
          if (altNum && altNum !== usedNum) {
            this.log(`R${t.row} ${usedNum} 无动态 → 再试另一列 ${altNum}`)
            const r2 = await call(altNum)
            if (hasEvents(r2) || (r && r.ok === false && r2 && r2.ok !== false)) { r = r2; usedNum = altNum }
          }
        }
        it.usedNumber = usedNum
        // ★ 卡 t_8a6689dc：先问「这份结果本插件认不认得」，答不上来就**不碰任何业务字段**。
        //   字段名/含义变了还照原样渲染 = 把 A 的文案静默写到 B 的位置，比报错危险得多。
        const gate = checkResultSchema(r, this.bridgeSchema)
        if (!gate.ok) {
          it.schemaBlocked = true
          it.text = `${usedNum} · ${gate.short}`
          it.state = 'error'
          it.failReason = gate.detail || gate.short
          this.raiseSchemaAlert(gate)
          this.log(`R${t.row} ${usedNum} 契约不符（${gate.code}）→ 已降级，不猜字段`)
          return this.writeResult(b, it, sheet, t.row, outCol, true)   // 确定结论：必须写进去，别保留旧值
        }
        // ★ 卡 t_cec031c1：「说人话」只在引擎定义一次 —— 插件照字段渲染，不再自己算
        it.text = (r && r.canonical && r.canonical.shortText) || ('查询完成' + (r && r.ok === false ? '（失败）' : ''))
        // ★ 2026-11-05：船名/航次（引擎 canonical.vessel/voyage，爹地图上「MSC LONSON | GA645W」两列）
        //   只有成功结果才带；失败时留空，让写回逻辑按「保留旧值」处理
        it.vessel = (r && r.canonical && r.canonical.vessel) || ''
        it.voyage = (r && r.canonical && r.canonical.voyage) || ''
        // 'actual' = 已开船的事实船名；'expected' = 还没开船，取官网计划航次
        it.vesselFrom = (r && r.canonical && r.canonical.vesselFrom) || ''
        it.state = r && r.ok === false ? 'error' : 'ok'
        if (it.state === 'error') {
          it.failReason = String((r && r.error) || '查询失败')
          // ★ 10-28：查挂了也给出路 —— 桥把引擎的 manualUrl/manualLabel 透传出来
          if (r && r.manualUrl) { it.manualUrl = r.manualUrl; it.manualLabel = r.manualLabel || it.manualLabel || '' }
        }
        if (it.state === 'ok') {
          // 里程碑着色：蓝=已离起运港 / 绿=已到目的港 / 灰=已还空箱
          const pol = cfg.polCol ? String(this.readColCached(b, cfg.polCol, t.row) || '') : ''   // ★ 0.9.42 整列快照
          const pod = cfg.podCol ? String(this.readColCached(b, cfg.podCol, t.row) || '') : ''
          // 船司查询结果里本来就写着起运港/目的港（Maersk 页头就有 "XINGANG, CN → GDANSK, PL"）
          // → 它是第一优先；事件推断次之；表格列兜底（爹地 2026-10-27 明确）
          const cityOf = (v) => String(v || '').split('(')[0].trim()
          const routePol = cityOf(r.origin)
          const routePod = cityOf(r.destination)
          // ★ 卡 t_cec031c1：阶段由引擎算（canonical），插件不再自己判；
          //   老桥/老引擎没给 canonical 时才退回本地判定，保证不断档。
          const st = (r.canonical && typeof r.canonical.stage === 'number')
            ? { stage: r.canonical.stage, label: r.canonical.stageLabel, inferred: !!r.canonical.stageInferred }
            : stageOf(r.events || [], { pol: routePol || pol, pod: routePod || pod })
          it.stage = st.stage
          it.stageLabel = st.label
          it.inferred = !!st.inferred   // 港口列读不到 → 用事件瞎猜，猜出来也不许着色
          // 表格里有 ETD/ETA 列 → 用船司返回的真实船期覆盖
          this.writeScheduleDates(b, sheet, t.row, r, routePod || pod, t.number)
        }
      } catch (e) {
        it.text = '查询失败：' + e.message
        it.state = 'error'
        it.failReason = e.message
      }
      return this.writeResult(b, it, sheet, t.row, outCol)
    },

    /**
     * 表格里有 ETD / ETA 列时，用船司返回的真实船期覆盖
     * 实际发生的优先；没发生的用船司给的计划时间（表格本来就填的计划）
     */
    writeScheduleDates(batch, sheet, row, r, pod, number) {
      const b = batch || this.vb
      const cfg = b ? b.cfg : this.cfg
      const etdCol = cfg.etdCol || 0
      const etaCol = cfg.etaCol || 0
      if (!etdCol && !etaCol) return
      let etd = '', eta = ''
      try { ({ etd, eta } = pickEtdEta(r.events || [], { pod })) } catch (e) { this.log('船期取值失败: ' + (e.message || e)); return }
      const numCol = cfg.numberCol
      // ★ 11-03 爹地原话：「写入 ETD/ETA，请加一个按钮来确认吧，不要静默替换」
      //   所以这里**只收集、不写**：一格都不许动，等一批收尾由 settleSchedule 出确认条，
      //   用户点「确认写入」才走 writeRowChecked（judge 在 lib/schedask.js，收集/确认各判一次）。
      const doc = (b && b.doc) || this.docKey()
      const batchId = (b && b.id) || ''
      const collect = (col, val, label) => {
        if (!col || !val) return false
        let cur
        let fmt = ''
        try {
          const rng = sheet.Range(`${colLetter(col)}${row}`)
          try { cur = rng.Value2 } catch (e) { cur = undefined }
          try { fmt = String(rng.NumberFormatLocal || '') } catch (e) { fmt = '' }
        } catch (e) { return false }
        // 护栏两条都在 decideScheduleWrite 里：
        //   ① 格子里是非空文本（代理名/联系方式）→ 绝不覆盖（列被挪动/复用时会指到别人的列上）
        //   ② 已经干净等于这一天 → 不重写；带时分的 46302.6667 是脏值，要能修回，但必须过确认
        const d = decideScheduleWrite(cur, val, fmt)
        if (!d.write) {
          if (d.reason === 'text') this.log(`R${row} ${colLetter(col)} 现在是文本（${String(cur).slice(0, 12)}）→ 不当船期列，跳过`)
          return false
        }
        this.schedQueue.push({
          batchId,
          doc,
          row,
          col,
          label,
          number: String(number == null ? '' : number),
          numCol,
          oldText: shortDateText(cur),
          newText: val,
          value: d.value         // ★ 日期格给整数序列号，非日期格给 ymd 文本 —— 绝不把 Date 交给宿主
        })
        return true
      }
      const a = collect(etdCol, etd, 'ETD')
      const c = collect(etaCol, eta, 'ETA')
      if (a || c) this.log(`R${row} 待回填船期（还没写，等确认）：ETD ${etd || '—'} · ETA ${eta || '—'}`)
    },

    /**
     * ★ 11-03 一批收尾：把这一批收集到的船期变更交出去 ——
     *   本表勾过「以后直接写」→ 直接写；否则出确认条，**在用户点确认之前一格都不写**。
     */
    settleSchedule(batch) {
      const b = batch || this.vb
      if (!b) return
      const bid = b.id
      const mine = this.schedQueue.filter((x) => x.batchId === bid)
      if (!mine.length) return
      this.schedQueue = this.schedQueue.filter((x) => x.batchId !== bid)
      const sum = summarizeAsk(mine)
      if (b.cfg && b.cfg.autoEtdEta) {
        this.log(`船期回填（本表已选「以后直接写」）：${sum.n} 行（ETD ${sum.etdN} / ETA ${sum.etaN}）`)
        this.applyScheduleItems(mine, b, 'auto').catch((e) => this.log('船期自动写入异常: ' + ((e && e.message) || e)))
        return
      }
      this.schedAsks.push({ batchId: bid, seq: b.seq, doc: b.doc || this.docKey(), items: mine, sum, at: Date.now() })
      this.schedAuto = false
      this.log(sum.title + ' —— 等你点「确认写入」，确认前一格不改')
    },

    /**
     * 真正写船期（确认 / 自动两条路共用）。
     * 收集到确认之间用户可能刚手改过格子 → 每格按现场值重判一遍，文本仍不覆盖、干净仍不重写。
     */
    async applyScheduleItems(items, b, why) {
      const list = Array.isArray(items) ? items : []
      const doc = (b && b.doc) || (list[0] && list[0].doc) || this.docKey()
      if (!list.length) return { ok: 0, skip: 0, fail: 0 }
      if (this.docKey() !== doc) {
        const msg = `船期没写：当前是「${this.docKey()}」，这批属于「${doc}」—— 切回那张表再点确认`
        this.panelErr = msg
        this.log(msg)
        return { ok: 0, skip: list.length, fail: 0 }
      }
      const sheet = (b && b.sheet) || (this.app() && this.app().ActiveSheet)
      if (!sheet) {
        this.panelErr = '没有活动工作表，船期写不进去'
        return { ok: 0, skip: list.length, fail: 0 }
      }
      const handles = []
      let skipped = 0
      for (const w of list) {
        if (this.docKey() !== doc) break          // 写到一半被切走 → 立刻停，绝不多写一格
        let cur
        let fmt = ''
        try {
          const rng = sheet.Range(`${colLetter(w.col)}${w.row}`)
          try { cur = rng.Value2 } catch (e) { cur = undefined }
          try { fmt = String(rng.NumberFormatLocal || '') } catch (e) { fmt = '' }
        } catch (e) { skipped++; continue }
        const d = decideScheduleWrite(cur, w.newText, fmt)
        if (!d.write) { skipped++; continue }
        handles.push({ w, h: this.writeRowChecked(b, sheet, w.row, w.col, w.newText, w.number, w.numCol, null, d.value) })
      }
      await this.flushWrites()
      let ok = 0
      let fail = 0
      let miss = 0
      for (const { h } of handles) {
        const res = h && h.entry ? h.entry.result : 'fail'
        if (res === 'ok' || res === 'superseded') ok++
        else if (res === 'miss') miss++
        else fail++
      }
      const label = why === 'auto' ? '自动写入' : '确认写入'
      this.log(`船期回填（${label}）：写成功 ${ok} 格 · 现场跳过 ${skipped} 格 · 写不进 ${fail} 格${miss ? ` · 错位 ${miss}` : ''}`)
      if (fail || miss) this.panelErr = `船期回填：成功 ${ok} 格、写不进 ${fail} 格、错位 ${miss} 格`
      return { ok, skip: skipped, fail, miss }
    },

    /** 确认条：确认写入（只写条里这几行；勾了「以后直接写」就记进这张表的 cfg） */
    async schedConfirm() {
      const a = this.schedAsk
      if (!a) return
      if (this.schedAuto) {
        this.cfg = { ...this.cfg, autoEtdEta: true }
        this.saveCfg(a.doc)
        this.log(`已记住：表「${a.doc}」以后 ETD/ETA 直接写（不再问）`)
      }
      this.schedAsks = this.schedAsks.filter((x) => !(x.batchId === a.batchId && x.at === a.at))
      const b = this.batchById(a.batchId) || null
      await this.applyScheduleItems(a.items, b, 'confirm')
    },

    /** 确认条：跳过本次（一格不写，但账要记） */
    schedSkip() {
      const a = this.schedAsk
      if (!a) return
      const sum = a.sum || summarizeAsk(a.items)
      this.schedAsks = this.schedAsks.filter((x) => !(x.batchId === a.batchId && x.at === a.at))
      this.log(`用户跳过船期回填 ${sum.n} 行（ETD ${sum.etdN} / ETA ${sum.etaN}）—— 一格没写`)
    },

    /** ★ 10-28：切表时把这一行的结果攒起来（不写、不丢），切回来一次补齐 */
    deferWrite(it, outCol, batch) {
      if (!it) return
      const b = batch || this.vb
      const doc = (b && b.doc) || this.docKey()
      // ★ 0.9.41 去重 key 带上 doc/number/row：只按 row|col 去重时，删行后两条结果可能落到同一个 row，
      // 后进的把前一条**静默去重**掉（不报错、直接丢一条）。带 number 区分「同号两行」，带 row 区分
      // 「不同号同一行」——去重是为了幂等，不是为了省存储。
      // ★ 0.9.43 key 前面再加批次号：同一张表点两次刷新时，两批可能写同一行，必须能分开、按批次顺序补。
      const numCol = it.numCol || (b && b.cfg.numberCol) || this.cfg.numberCol
      const key = `${(b && b.id) || 'x'}|${doc}|${it.number}|${numCol}|${outCol}|${it.row}`
      this.pendingWrites = this.pendingWrites.filter((x) => x.key !== key)
      this.pendingWrites.push({
        key, batchId: (b && b.id) || '', row: it.row, outCol, doc,
        number: it.number, numCol,
        text: String(it.text || ''), state: it.state,
      })
      it.state = 'pending'
      if (!/待回填/.test(String(it.text))) it.text = String(it.text || '') + '（待回填）'
      this.log(`R${it.row}: 当前不在目标表 → 结果暂存，切回原表点「补齐回填」`)
    },
    /** ★ 10-28：回到原表就自动补齐（不用点按钮）；不在原表就什么都不做，绝不写错表 */
    // ---------- ★ 卡 t_aa0674a9 第二步：App 派活 / 插件领活 → 查询 → 回填 → 上报 ----------

    async httpPost(path, body, timeoutMs = 8000) {
      const url = this.base() + path
      try {
        if (typeof fetch !== 'function') throw new Error('no-fetch')
        const ctl = typeof AbortController === 'function' ? new AbortController() : null
        const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
            ...(ctl ? { signal: ctl.signal } : {}),
          })
          return await r.json()
        } finally { if (timer) clearTimeout(timer) }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    },

    /**
     * 心跳里领一次活。**静默**：桥不通/没活/用户正在跑自己的批次 → 什么都不做，
     * 下个心跳（2.5s）再来。绝不弹窗打断用户编辑。
     */
    async claimJobOnce() {
      const doc = this.docNow || this.docKey()
      // ③ 静默原则：任何一条不满足就跳过，不打扰用户（判据在 jobguard，可单测）
      if (!shouldClaim({ jobBusy: this.jobBusy, userBusy: this.busy, flushing: this.flushing, bridgeUp: !!this.bridge, currentDoc: doc })) return
      let got = null
      try {
        got = await this.httpGet('/jobs/next?doc=' + encodeURIComponent(doc), 4000)
      } catch (e) { return }                        // 桥不通 → 静默重试
      if (!got || !got.ok || !got.jobId) return
      await this.runClaimedJob(got.jobId, got.spec || {})
    },

    /**
     * 跑一个派活。三条验收条件（知澜 2026-11-02 定的）：
     *   ① 领到活但表已经不是那个 doc → 一行不写，直接 report failed（别把数据填进别人的表）
     *   ② 回填中途报错 → 已写的行保留，report 里报 written 实际数，剩余算 failed
     *   ③ 领活失败静默重试（见 claimJobOnce），不弹窗、不打断用户编辑
     */
    async runClaimedJob(jobId, spec) {
      this.jobBusy = true
      this.jobIdNow = jobId
      const docAtClaim = String(spec.doc || '')
      const report = (extra) => this.httpPost(`/jobs/${jobId}/report`, extra)
      const rows = Math.max(0, Number(spec.rows) || 0)
      const cols = spec.cols || {}
      // 只补失败时总量是失败行数，不是整段行数
      // ★ 2026-11-05：初值给 rows，真正的总数在 work 构造后按 work.length 重算 ——
      //   spec.rows 含表头行（startRow 从 1 传、规整到 2），直接拿来当 total
      //   会让进度条永远停在 13/14，用户以为漏跑了一行。
      let total = (Array.isArray(spec.pendingRows) && spec.pendingRows.length) ? spec.pendingRows.length : rows
      let ok = 0, failed = 0, written = 0, skipped = 0
      try {
        // ① 表被切走 / 列没配 → 一行不写（判据在 jobguard，可单测）
        const gate = decideBeforeRun({ currentDoc: this.docKey(), specDoc: docAtClaim, cols })
        if (!gate.proceed) {
          this.log(`派活 ${jobId}：${gate.reason}（当前 ${this.docKey()}，派给 ${docAtClaim}）→ 一行不写`)
          await report({ ...gate.report, ok: 0, failed: total || 1, written: 0, total: total || 1 })
          return
        }
        const a = this.app()
        const sheet = a.ActiveSheet
        const outCol = Number(cols.out)
        // ★ 驳回 1：pendingRows 有值时**只补这些行**，不再整段遍历。
        //   失败行的 row + number 都是桥从 ledger 里取的，插件照单跑即可。
        const pendingRows = Array.isArray(spec.pendingRows) && spec.pendingRows.length ? spec.pendingRows : null
        const work = pendingRows
          ? pendingRows.map((p) => ({ row: Number(p.row) || 0, number: String(p.number || '') }))
          : Array.from({ length: rows }, (_, i) => ({ row: (Number(spec.startRow) || 2) + i, number: '' }))
        total = work.length || total          // 实际要跑的行数（不含表头/整段外）
        this.log(pendingRows
          ? `派活 ${jobId}：只补失败 ${work.length} 行（${work.map((w) => w.number).slice(0, 5).join(', ')}${work.length > 5 ? '…' : ''}）→ 写 ${colLetter(outCol)} 列`
          : `派活 ${jobId}：${docAtClaim} 第 ${spec.startRow} 行起 ${rows} 行 → 写 ${colLetter(outCol)} 列`)

        for (let i = 0; i < work.length; i++) {
          const row = work[i].row
          if (!row) { failed++; continue }          // ledger 里没行号（老记录）→ 算失败，别乱猜行
          if (this.docKey() !== docAtClaim) {       // 中途切表 → 停手，已写的保留
            this.log(`派活 ${jobId}：跑到第 ${i + 1} 行时表被切走 → 停手（已写 ${written} 行保留）`)
            break
          }
          let num = work[i].number
          if (!num) {
            try { num = cleanNumber(String(this.readColCached(null, cols.number, row) || '')) } catch (e) { num = '' }
          }
          if (!num) { skipped++; continue }           // 空行 / 不是单号 → 跳过，不算失败但要计入「已处理」
          //   ★ 2026-11-05：不计数的话 ok+failed 永远 < total（遍历 14 行、只有 13 行有号），
          //   进度条停在 13/14，用户以为漏跑了一行。

          let r = null
          try {
            const q = [
              'number=' + encodeURIComponent(num),
              'timeout=90000',
              'schema=' + PLUGIN_SCHEMA_VERSION,
              'doc=' + encodeURIComponent(docAtClaim),
              // ★ 10-30：sheet 也要带上（以前只有 doc+row，台账里 sheet 恒空）
              'sheet=' + encodeURIComponent(String(docAtClaim).split('|')[1] || ''),
              'row=' + row,
            ]
            if (cols.pol) { const v = String(this.readColCached(null, cols.pol, row) || '').trim(); if (v) q.push('pol=' + encodeURIComponent(v)) }
            if (cols.pod) { const v = String(this.readColCached(null, cols.pod, row) || '').trim(); if (v) q.push('pod=' + encodeURIComponent(v)) }
            r = await this.httpGet('/track?' + q.join('&'), 95000)
          } catch (e) {
            r = { ok: false, error: String((e && e.message) || e), canonical: null }
          }

          // 文案只认引擎 canonical（插件的格式化逻辑已删，这里不许再自己拼）
          const text = (r && r.canonical && r.canonical.shortText) || (r && r.ok === false ? '查询失败' : '查询完成')
          try {
            const w = this.writeCell(sheet, row, outCol, text)
            if (w && w.ok) { written++; if (r && r.ok !== false) ok++; else failed++ }
            else failed++
          } catch (e) { failed++ }

          if ((i + 1) % 5 === 0) await report({ ok, failed, written, total, skipped })   // 中途只报进度，不带 state
        }

        const fin = summarizeRun({ ok, failed, written, total, skipped })
        await report(fin)
        this.log(`派活 ${jobId} 完成：成功 ${fin.ok} · 失败 ${fin.failed} · 写入 ${fin.written}/${fin.total}`)
      } catch (e) {
        // ② 中途炸了：已写的不动，如实报
        const fin = summarizeRun({ ok, failed, written, total, skipped, interrupted: true, error: String((e && e.message) || e) })
        await report(fin)
        this.log(`派活 ${jobId} 异常：${fin.error}（已写 ${fin.written} 行保留，未跑完的记为失败）`)
      } finally {
        this.jobBusy = false
        this.jobIdNow = ''
      }
    },

    autoFlushWhenBack() {
      // ★ 卡 t_aa0674a9：顺手领一次派活（挂在现成心跳上，不新起定时器）。
      //   放在最前面：暂存补写要等切回原表，别让派活被它挡住。
      this.claimJobOnce()
      // ★ 0.9.43：判据从「整轮的 runDoc」改成「暂存队列里有没有当前这张表的」——
      //   多批并行时不再依赖某一个批次的归属。
      if (!this.pendingWrites.length) return
      const now = this.docKey()
      if (!now) return
      const same = this.pendingWrites.filter((x) => x.doc === now)
      if (!same.length) return
      this.flushPending(true)
    },
    /** ★ 10-28：切回原表后一次写回所有暂存结果（用 writeCell 的读回校验，写不进会如实报） */
    async flushPending(auto = false) {
      if (this.flushing) return                 // 防重入：自动补齐与手动点击不许同时写
      if (!this.pendingWrites.length) return
      this.flushing = true
      try {
        await this._flushPending(auto)
      } finally {
        this.flushing = false
      }
    },
    async _flushPending(auto = false) {
      if (!this.pendingWrites.length) return
      const a = this.app()
      const sheet = a && a.ActiveSheet
      if (!sheet) { this.panelErr = '没有活动工作表，补不了'; return }
      const nowDoc = this.docKey()
      const same = this.pendingWrites.filter((x) => x.doc === nowDoc)
      const other = this.pendingWrites.filter((x) => x.doc !== nowDoc)
      if (!same.length) {
        this.panelErr = `补不齐：当前是「${nowDoc}」，暂存的 ${this.pendingWrites.length} 条属于「${(other[0] || {}).doc || '—'}」—— 切回那张表再点`
        return
      }
      let ok = 0, fail = 0, miss = 0
      // ★ 0.9.42：暂存补写也走唯一入口 —— 全部入队后一次批量写 + 批量核身份；
      //   每条结果从队列条目的 result 回读（queued / ok / fail / miss）。
      // ★ 0.9.43：按批次先后补 —— 同一张表点过两轮时，后一轮覆盖前一轮。
      const ordered = same.slice().sort((x, y) => {
        const bx = this.batchById(x.batchId)
        const by = this.batchById(y.batchId)
        return ((bx && bx.seq) || 0) - ((by && by.seq) || 0)
      })
      const handles = []
      for (const w of ordered) {
        // ★ 10-28 硬保护：写入过程中用户随时可能又切走；一旦切走立刻停，绝不多写一格。
        if (this.docKey() !== w.doc) break
        const pb = this.batchById(w.batchId) || this.vb
        const pseudo = {
          number: w.number, numCol: w.numCol,
          text: w.text, state: w.state === 'pending' ? 'ok' : (w.state || 'ok')
        }
        handles.push({ w, pb, h: this.writeRowChecked(pb, sheet, w.row, w.outCol, w.text, w.number, w.numCol, pseudo) })
      }
      await this.flushWrites()          // 补齐是用户明确要的动作 → 立刻落盘，不等攒批
      for (const { w, pb, h } of handles) {
        const res = h && h.entry ? h.entry.result : 'fail'
        if (res === 'ok') {
          ok++
          const it = pb && pb.items ? pb.items.filter((x) => x.row === w.row)[0] : null
          if (it) { it.text = w.text; it.state = w.state === 'pending' ? 'ok' : (w.state || 'ok') }
        } else if (res === 'miss') miss++
        else if (res === 'superseded') { /* 后一批已经写过这一格 → 不用补 */ }
        else fail++
      }
      this.pendingWrites = other
      this.panelErr = fail || miss
        ? `补齐：成功 ${ok} 条、补不进 ${fail} 条、错位跳过 ${miss} 条（表格行变了，点③重跑）`
        : ''
      this.log(`补齐回填${auto ? '（自动·已回到原表）' : ''}：成功 ${ok} / 失败 ${fail} / 错位跳过 ${miss}${other.length ? `，另有 ${other.length} 条在别的表` : ''}`)
    },

    // 统一写回：确定结论可以覆盖，暂态失败保留旧值
    writeResult(batch, it, sheet, row, outCol, definitiveNow) {
      const b = batch || this.vb
      if (b && b.capErr) return
      // ★ 中置信首次：结果只留在面板上，**一格都不写**。
      //   写错的格下一轮会被当「已有值」读回去，错会自我繁殖 —— 所以宁可不写。
      if (b && b.preview) { it.previewOnly = true; return }
      // ★ 0.9.43：切表**不再**在这里分流 —— 一律入队，由 _flushWriteQueue 判断这张表现在能不能写：
      //   能（这个 WPS 版本摸得到非活动表）就直接写进去；不能就自动攒进待补队列，切回来自动补。
      //   这样「(a) 还是 (b)」由运行现场自己回答，代码不用等实测就知道该走哪条路。
      const oldStr = this.oldOutText(b, row, outCol)   // ★ 0.9.42：本轮开头整段读一次的快照，不再逐格读
      // 「未识别 / 未接入 / 暂无动态」是确定结论，可以写；其余失败一律不覆盖旧值
      const definitive = definitiveNow || /未识别承运人|未接入追踪|未接入|暂无动态/.test(it.text)
      const transient = it.state === 'error' && !definitive
      if (transient && oldStr) {
        // 上一轮刷过的颜色可能已经过期（比如当时误判成到港）→ 清掉，别误导
        this.clearOurColor(sheet, row, b && b.doc, outCol)
        it.keptOld = true
        it.text = oldStr
        it.note = '本次' + (classifyFail(it.failReason).label) + '，保留旧值'
        this.log(`R${row} 保留旧值（本次 ${classifyFail(it.failReason).label}）`)
        return
      }
      // ★ 0.9.42 唯一写回入口：入队 → 批量核身份 → 批量写 → 批量读回；
      //   着色也一并交给 _flushWriteQueue 按区段批量刷（这里不再逐行摸 Interior）。
      const w = this.writeRowChecked(b, sheet, row, outCol, it.text, it.number, it.numCol, it)
      if (!w || !w.ok) {
        if (b) b.errs.write = '写入失败：' + (w ? w.error : '未知')
        this.log(`写 ${colLetter(outCol)}${row} 失败: ${w ? w.error : '未知'}`)
        return
      }
      // ★ 2026-11-05：船名 / 航次。配了列才写，没配（0）就跳过 —— 不预设默认列。
      //   走同一个 writeRowChecked（唯一写入口），身份校验、批量、读回全部复用，不另开一条写路径。
      // ★ 2026-11-10：写哪几格、写什么值由 lib/writeplan.js 的纯函数定（可单测）：
      //   · 船名列 = 航次列 → **只写一次**「船名 空格 航次」（原来同一格写两遍，后写的航次盖掉船名）
      //   · 分列 → 各写一格；撞结果列/单号列 → 该格不写
      //   一律按「船名 空格 航次」拼，不去读原格猜它是什么（原格可能已被旧 bug 写坏）。
      const targets = planVesselVoyage({
        vesselCol: this.cfg.vesselCol, voyageCol: this.cfg.voyageCol,
        outCol, numCol: it.numCol, vessel: it.vessel, voyage: it.voyage
      })
      for (const t of targets) {
        const wv = this.writeRowChecked(b, sheet, row, t.col, t.text, it.number, it.numCol, it)
        if (!wv || !wv.ok) this.log(`写 ${colLetter(t.col)}${row} 船名/航次失败: ${wv ? wv.error : '未知'}`)
      }
    },

    failLabel(it) {
      if (!it || (it.state !== 'error' && !/查无|无数据|未找到|未返回|没有数据/.test(String(it.text || '')))) return ''
      const { kind, label } = classifyFail(`${it.failReason || ''} ${it.text || ''}`)
      return kind === 'other' ? '' : label
    },

    stop() {
      // ★ 0.9.43：停止 = 停掉所有在跑的批次（在飞请求一起中断），而不是只停「当前正在看的那一批」
      const running = this.batches.filter((b) => b.state === 'running')
      for (const b of running) {
        b.stop = true
        for (const it of b.items) {
          if (it.state === 'querying' || it.state === 'idle') { it.state = 'skip'; it.text = '（已停止）' }
        }
      }
      // 排队中的批次一起取消（不然空出一格后它又自己开跑了）
      for (const b of this.batches.filter((x) => x.state === 'queued')) { b.stop = true; b.state = 'stopped' }
      // 立刻中断在飞的请求（桥那边收到断开就会杀掉对应子进程），不用等 90s 超时
      try { for (const c of this.aborts) { try { c.abort() } catch (e) {} } this.aborts.clear() } catch (e) {}
      this.publishBatches()
      this.log(`已停止${running.length > 1 ? `（${running.length} 批）` : ''}（在飞的请求已中断）`)
    },

    // ---------- 写权限体检 ----------
    checkWritable(sheet) {
      const a = this.app()
      try {
        if (a.ActiveWorkbook && a.ActiveWorkbook.ReadOnly) {
          return '工作簿是只读打开的（云文档只读 / 文件只读属性 / 别人正在编辑）'
        }
      } catch (e) {
        this.log('ReadOnly 检查失败: ' + e.message)
      }
      try {
        if (sheet.ProtectContents === true) {
          return '工作表被保护（审阅 → 撤消工作表保护）'
        }
      } catch (e) {
        this.log('ProtectContents 检查失败（旧版本可能不支持）: ' + e.message)
      }
      try {
        if (a.ActiveWorkbook && a.ActiveWorkbook.ProtectStructure === true) {
          return '工作簿结构被保护（不能改表结构）'
        }
      } catch (e) {}
      return ''
    },
    tryUnprotect() {
      const a = this.app()
      const sheet = a && a.ActiveSheet
      if (!sheet) return
      try {
        if (a.ActiveWorkbook && a.ActiveWorkbook.ReadOnly) {
          this.panelErr = '只读打开的文件解不了保护 —— 先另存/取得编辑权'
          return
        }
        sheet.Unprotect()
        const cap = this.checkWritable(sheet)
        const b = this.vb
        if (b && b.doc === this.docKey()) b.capErr = cap
        this.log('Unprotect 调用完成，当前状态: ' + (cap || '可写'))
        if (!cap) this.panelErr = ''
      } catch (e) {
        this.panelErr = '解除保护失败：' + e.message + '（多半有密码，需要你知道密码）'
        this.log('Unprotect 失败: ' + e.message)
      }
    },

    isTransient(text) {
      return /超时|timeout|查询失败|网络|连接|ECONN|ERR_|空响应/i.test(String(text || ''))
    },
    // 网络环境体检：代理开没开、几家船司能不能连通 —— 查询失败时先看这行
    async checkNet() {
      try {
        const r = await this.httpGet('/net', 8000)
        if (!r || !r.ok) return
        this.net = r
        const ok = Object.entries(r.reach || {}).filter(([, v]) => v.ok).map(([k]) => k)
        const bad = Object.entries(r.reach || {}).filter(([, v]) => !v.ok).map(([k]) => k)
        this.log(`网络：代理${r.proxyOn ? '开' : '关'}${r.clashPort ? '(' + r.clashPort + ')' : ''} · 通 ${ok.join('/') || '无'}${bad.length ? ' · 不通 ' + bad.join('/') : ''}`)
        if (r.advice) this.log('网络建议：' + r.advice)
      } catch (e) { /* 探测失败不影响主流程 */ }
    },
    async checkUpdate() {
      // 静默：没配更新源 / 桥没起 / 网络不通，一律不显示任何东西
      try {
        const r = await this.httpGet('/update/check', 8000)
        this.upd.checked = true
        this.upd.enabled = !!r.enabled
        this.upd.local = r.local || ''
        this.upd.has = !!r.hasUpdate
        this.upd.ver = (r.remote && r.remote.version) || ''
      } catch (e) { this.upd.checked = true }
    },
    async doUpdate() {
      this.upd.busy = true
      this.upd.msg = ''
      try {
        const r = await this.httpPost('/update/apply', 120000)
        if (r && r.ok) {
          this.upd.has = false
          this.upd.local = r.to
          this.upd.msg = `已更新到 v${r.to}，重启 WPS 后生效`
          this.log(`更新完成：v${r.from} → v${r.to}（${r.files} 个文件）`)
        } else {
          this.upd.msg = '更新失败：' + String((r && r.error) || '未知原因').slice(0, 60)
        }
      } catch (e) {
        this.upd.msg = '更新失败：' + String(e.message || e).slice(0, 60)
      } finally {
        this.upd.busy = false
      }
    },
    /** 顶部横幅：只在第一次碰到契约不符时挂上（同一轮不刷屏），成功后由 refresh 清掉 */
    raiseSchemaAlert(gate) {
      if (this.schemaAlert && this.schemaAlert.code === gate.code) return
      this.schemaAlert = { code: gate.code, short: gate.short, detail: gate.detail || '' }
    },

  }
}
</script>

<style>
.banner-sum { margin: 4px 0 6px; padding: 4px 8px; background: #f4f7fb; border: 1px solid #dbe4f0; border-radius: 6px; font-size: 11px; color: #33507a; }
.tag-fail { margin-left: 4px; color: #a15c00; font-size: 11px; }
.wrap { font-family: -apple-system, 'PingFang SC', sans-serif; font-size: 12px; color: #222; padding: 8px; }
.hdr { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.upd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; color: #1f6f43;
  background: #eaf7ef; border: 1px solid #cfe9d9; border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; }
.upd-msg { color: #555; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.ok { background: #22a06b; }
.dot.bad { background: #d64545; }
.muted { color: #888; font-size: 11px; }
.next { margin: 6px 0 2px; color: #0a6; font-weight: 600; }
.steps { margin: 6px 0; border: 1px solid #e6e6e6; border-radius: 6px; overflow: hidden; }
.step { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; font-size: 12px; border-top: 1px solid #f0f0f0; }
.step:first-child { border-top: 0; }
.step b { flex: 0 0 68px; font-weight: 600; }
.step.done { background: #f2fbf4; }
.step.done b { color: #0a7d32; }
.step.todo { background: #fffbe6; }
.step.todo b { color: #8a6d00; }
.step.idle { background: #fafafa; color: #888; }
.row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
/* ★ t_a72fba24：默认那一行 = 识别摘要 + 立即查询，选列控件收进「更多设置」 */
.row.auto { align-items: center; gap: 8px; }
.auto-state { flex: 1 1 100%; display: flex; align-items: center; gap: 6px; font-size: 12px; color: #333; padding: 2px 0 4px; }
.auto-state .dot { flex: 0 0 auto; }
.auto-fix { margin: -4px 0 8px; font-size: 11px; color: #8a6d3b; display: flex; flex-direction: column; gap: 2px; }
.tier-warn { color: #a15c00; }
button { font-size: 12px; padding: 4px 8px; border: 1px solid #c8ccd4; border-radius: 4px; background: #f7f8fa; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
.mini { font-size: 11px; padding: 2px 6px; margin: 4px 4px 0 0; }
.hint { color: #666; line-height: 1.7; margin: 6px 0; }
.cfg { background: #f6f8fb; border: 1px solid #e3e8f0; border-radius: 4px; padding: 6px 8px; line-height: 1.7; margin: 6px 0; }
.err { background: #fdecec; border: 1px solid #f3b6b6; color: #a32020; padding: 6px 8px; border-radius: 4px; margin-bottom: 8px; line-height: 1.5; }
/* 10-29：warn 之前没有样式，横幅在白底上像普通文字，用户看不见「桥没连上」 */
.warn { background: #fff8e6; border: 1px solid #f0d79a; color: #8a5b00; padding: 6px 8px; border-radius: 4px; margin-bottom: 8px; line-height: 1.5; }
.banner-cmd { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.banner-cmd code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; background: rgba(0, 0, 0, .06); padding: 2px 5px; border-radius: 3px; word-break: break-all; user-select: all; }
.bar { position: relative; height: 16px; background: #eef1f5; border-radius: 3px; overflow: hidden; margin: 6px 0; }
.bar-in { height: 100%; background: #4c8bf5; transition: width .2s; }
.bar-t { position: absolute; inset: 0; text-align: center; font-size: 10px; line-height: 16px; color: #333; }
.tbl { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
.tbl th, .tbl td { border-bottom: 1px solid #eceef2; padding: 3px 4px; text-align: left; vertical-align: top; }
.tbl th { color: #666; font-weight: 600; background: #fafbfc; }
.mono { font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
tr.ok td { background: #f3fbf6; }
tr.error td { background: #fdf4f4; }
tr.querying td { background: #f4f8ff; }
tr.skip td { color: #aaa; }
.diag { margin-top: 10px; border-top: 1px dashed #ddd; padding-top: 6px; }
.diag pre { white-space: pre-wrap; font-size: 10px; color: #555; max-height: 200px; overflow: auto; }
/* 里程碑图例与行内小点 */
.legend { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 4px; }
.lg { font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid #cfcfcf; white-space: nowrap; }
.lg.blue { background: #cfe3fa; } .lg.green { background: #d5f0dc; } .lg.gray { background: #e6e6e6; }
.dot-stage { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; border: 1px solid rgba(0,0,0,.15); }
.dot-stage.s1 { background: #2f7fd1; } .dot-stage.s2 { background: #1d9e52; } .dot-stage.s3 { background: #8a8a8a; }
/* 保留旧值的行：淡黄底，一眼看出「这行这次没更新」 */
.tbl tr.kept { background: #fffbe6; }
.muted { color: #888; font-size: 11px; }
.next { margin-top: 4px; color: #0a6; font-weight: 600; }
/* ── ★ 10-28 手工兜底（爹地拍板）：查不通就给链接 + 收粘贴；手工来源要一眼看出 ── */
.tag-manual { margin-left: 4px; padding: 0 6px; border-radius: 9px; font-size: 10.5px; font-weight: 800; color: #fff; background: #a15c00; }
.tbl tr.handmade { background: #fffaf0; }
.tbl tr.handmade td:first-child { box-shadow: inset 3px 0 0 #a15c00; }
.manual-btn { margin-top: 3px; font-size: 11px; padding: 1px 7px; border: 1px solid #d8c3a0; border-radius: 6px; background: #fff; color: #a15c00; cursor: pointer; }
.manual-row td { background: #fffaf0; padding: 8px 10px; }
.manual-box { display: flex; flex-direction: column; gap: 6px; }
.manual-link { font-size: 12px; font-weight: 700; color: #2f6df6; text-decoration: none; }
.manual-link:hover { text-decoration: underline; }
.manual-paste { width: 100%; box-sizing: border-box; font-size: 12px; font-family: inherit; padding: 6px 8px; border: 1px solid #e0d6c4; border-radius: 6px; background: #fff; resize: vertical; }
.manual-foot { display: flex; align-items: center; gap: 8px; }
.mini.primary { background: #a15c00; color: #fff; border-color: #a15c00; }
/* ★ 10-28 切表不中止：暂存待补的行 + 补齐按钮 */
.tbl tr.pending { background: #f2f7ff; }
.tbl tr.pending td:first-child { box-shadow: inset 3px 0 0 #2f6df6; }
/* ★ 0.9.41 行身份校验：错位行与「上次刷新不可信」的提示色 */
.stale { color: #a15c00; }
.tbl tr.misalign td { color: #a15c00; text-decoration: line-through; }
.pending-btn { background: #2f6df6 !important; color: #fff !important; border-color: #2f6df6 !important; font-weight: 700; }
/* ★ 0.9.43 批次条：同一工作簿多张表各跑各的，一眼看到谁在跑、谁在排队 */
.bchips { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }
.bchip { display: flex; align-items: baseline; gap: 5px; padding: 3px 8px; border: 1px solid #d6dbe4; border-radius: 12px;
  background: #f7f8fa; font-size: 11px; cursor: pointer; color: #444; white-space: nowrap; }
.bchip .bname { font-weight: 700; max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
.bchip .bst { font-size: 10px; color: #888; }
.bchip.running { background: #eaf1ff; border-color: #9dbdf7; color: #1b4ea8; }
.bchip.running .bst { color: #1b4ea8; }
.bchip.queued { background: #fffbe6; border-color: #e8d68a; color: #8a6d00; }
.bchip.done { background: #f2fbf4; border-color: #cfe9d9; color: #1f6f43; }
.bchip.stopped { background: #fafafa; border-color: #ddd; color: #777; }
.bchip.on { box-shadow: 0 0 0 2px rgba(47, 109, 246, .35); }
/* ★ 0.9.45 批次条收口：主条一条 + 历史折叠 + 「再开一批」挪到条尾 */
.bchip .bmeta { color: #7a8290; font-size: 10px; }
.bchip .bnum { font-variant-numeric: tabular-nums; }
.bchip.main { padding: 4px 10px; }
.bchip.hist { background: #fafbfc; border-color: #dfe3ea; color: #666; }
.bchip.hist .bst { color: #8a9099; }
.bchip.hist.open { border-color: #b9c3d4; background: #f4f6f9; }
.bchip.add { background: #fff; border-style: dashed; border-color: #9dbdf7; color: #1b4ea8; }
.bchip.add:hover { background: #eef3ff; }
button.bchip { font-family: inherit; line-height: 1.4; }
.bchips.more { margin-top: -2px; padding-left: 8px; border-left: 2px solid #e6e9ef; }
.hist-more { font-size: 10px; align-self: center; }
/* ★ 11-11 行列自动识别：默认面板就一行 + 一个按钮，猜错才展开 */
.auto { align-items: center; }
.auto-state { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 11.5px; color: #333; }
.tier-warn { color: #a15c00; }
.auto-fix { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 8px; font-size: 11px; color: #888; line-height: 1.5; }
.previewbar { margin: 6px 0 8px; padding: 8px 10px; border: 1px solid #9dbdf7; border-left: 4px solid #2f6df6;
  background: #f4f8ff; border-radius: 8px; font-size: 12px; color: #1b3f7a; }
.pb-hd { margin-bottom: 4px; }
.mini.pb-go { background: #2f6df6; border-color: #2f6df6; color: #fff; font-weight: 700; }
.conflictbar { margin: 6px 0 8px; padding: 8px 10px; border: 1px solid #f0c36d; border-left: 4px solid #d98b00;
  background: #fffdf3; border-radius: 8px; font-size: 12px; color: #5b4300; }
/* ★ 11-03 ETD/ETA 回填确认条（爹地要的按钮：不许静默替换） */
.schedbar { margin: 6px 0 8px; padding: 8px 10px; border: 1px solid #f0c36d; border-left: 4px solid #d98b00;
  background: #fffdf3; border-radius: 8px; font-size: 12px; color: #5b4300; }
.sb-hd { font-weight: 700; color: #8a5a00; }
.sb-cnt { font-weight: 400; }
.sb-list { margin: 4px 0 6px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; color: #444; line-height: 1.5; }
.sb-btns { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sb-auto { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: #6b5a2e; cursor: pointer; }
.mini.sb-go { background: #d98b00; border-color: #d98b00; color: #fff; font-weight: 700; }
</style>
