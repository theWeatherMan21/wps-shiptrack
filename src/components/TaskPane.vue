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

    <!-- 在线更新：只在真的有新版时出现（检查失败一律静默，不打扰） -->
    <div v-if="upd.has || upd.msg" class="upd">
      <template v-if="upd.has">
        <span>有新版本 <b>v{{ upd.ver }}</b>（当前 v{{ upd.local }}）</span>
        <button class="mini" :disabled="upd.busy" @click="doUpdate">{{ upd.busy ? '更新中…' : '立即更新' }}</button>
      </template>
      <span v-else class="upd-msg">{{ upd.msg }}</span>
    </div>

    <!-- 三步：选单号列 → 选输出列 → 刷新 -->
    <div class="row">
      <button @click="pickNumberCol">① 选单号列</button>
      <button @click="pickOutputCol">② 选输出列</button>
      <button @click="pickCarrierCol" class="mini-btn">船司列（可选）</button>
      <button @click="refresh(true)" :disabled="busy || !ready">③ 立即刷新</button>
      <button v-if="busy && ready" class="mini-btn" title="同一张表也能再开一批（两批并行，写回按批次先后，后写覆盖前写）" @click="refresh(true, { force: true })">再开一批</button>
      <button @click="stop" :disabled="!hasRunning">停止</button>
      <button v-if="pendingWrites.length" class="mini-btn pending-btn" :title="`暂存了 ${pendingWrites.length} 行结果：查询中切走的那几张表，切回来点这里一次写回`" @click="flushPending">补齐回填 {{ pendingWrites.length }}</button>
    </div>

    <!-- ★ 0.9.43 批次条：同一工作簿里多张表各跑各的；点一下切到那一批看明细 -->
    <div class="bchips" v-if="showChips">
      <div v-for="b in batches" :key="b.id" class="bchip" :class="[b.state, { on: b.id === viewBatchId }]"
           :title="batchTitle(b)" @click="showBatch(b.id)">
        <span class="bname">{{ batchLabel(b) }}</span>
        <span class="bnum">{{ b.done }}/{{ b.total }}</span>
        <span class="bst">{{ stateLabel(b.state) }}</span>
      </div>
    </div>

    <!-- 三步清单：永远显示每一步选没选，不靠「报错」告诉用户下一步 -->
    <div class="steps">
      <div class="step" :class="cfg.numberCol > 0 ? 'done' : 'todo'">
        <b>① 单号列</b>
        <span v-if="cfg.numberCol > 0">{{ numColText }} · 第 {{ cfg.startRow }}–{{ cfg.startRow + cfg.rows - 1 }} 行</span>
        <span v-else class="muted">未选</span>
      </div>
      <div class="step" :class="cfg.outCol > 0 ? 'done' : (cfg.numberCol > 0 ? 'todo' : 'idle')">
        <b>② 输出列</b>
        <span v-if="cfg.outCol > 0">{{ outColText }}</span>
        <span v-else class="muted">未选</span>
      </div>
      <div class="step" :class="cfg.carrierCol > 0 ? 'done' : 'idle'">
        <b>船司列</b>
        <span>{{ cfg.carrierCol > 0 ? carrierColText : '可选（按单号识别）' }}</span>
      </div>
    </div>
    <div class="next" v-if="stepHint">{{ stepHint }}</div>

    <div class="cfg" v-if="cfg.numberCol > 0">
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
      <span class="bar-t">{{ done }}/{{ total }}{{ etaText ? ' · ' + etaText : '' }}</span>
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
      <button class="mini" @click="resetCfg">清空配置</button>
    </details>
  </div>
</template>

<script>
const APP_VER = '0.9.43'
const BRIDGE = 'http://127.0.0.1:8791'
const CFG_KEY = 'shiptrack_cfg_v4'
const LAST_RUN_KEY = 'shiptrack_lastrun_v3'
const AUTO_MS = 24 * 60 * 60 * 1000
// 跨文档闸门：同时开 6 个工作簿时，别让每个面板各跑一轮（2026-10-26 巨卡就是这个）
const GLOBAL_RUN_KEY = 'shiptrack_lastrun_global_v1'
const AUTO_MAX_ROWS = 50          // 自动刷新单次最多查 50 行，其余手动

import { markRaw } from 'vue'
import { cleanNumber, looksLikeNumber, splitParts, carrierFromSl, looksLikeCarrierToken } from '../lib/cellparse.js'
import { zhEvent, cleanCity, formatEventLine } from '../lib/events.js'
import { isPlanned } from '../lib/truth.js'
import { stageOf, STAGE_COLOR, NO_FILL, STAGE_LABEL } from '../lib/milestone.js'
import { notFoundText } from '../lib/retention.js'
import { matchPortHeaders, matchDateHeaders, matchNumberHeaders } from '../lib/headers.js'
import { pickEtdEta } from '../lib/dates.js'
import { summarize as summarizeFails, classifyFail } from '../lib/fail.js'

const CARRIER_NAME = {
  hapag: 'HPL', maersk: 'MSK', zim: 'ZIM', cosco: 'COSCO', cma: 'CMA',
  oocl: 'OOCL', one: 'ONE', hmm: 'HMM', evergreen: 'EMC', yangming: 'YML',
  akkon: 'AKK'
}
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
      // ★ 0.9.43：busy / items / done / total … 全部下沉到「批次」里（同一工作簿多张表可以各跑各的）。
      //   这里只剩面板级状态；批次级的读写一律走 batches[] 里那一个对象。
      batches: [],         // 批次队列：{id, seq, doc, sheet, cfg 快照, items, done, total, state, stop, errs, …}
      viewBatchId: '',     // 当前正在看的是哪一批（批次条上点一下就切）
      seq: 0,              // 批次序号（写回顺序按它排：先跑的批次先写）
      docNow: '',          // 活动表（轮询得到，用于「切表就看那一批」这类推导）
      panelErr: '',        // 面板级错误（选列失败 / 配置异常 / 补齐结果）；批次自己的错误在 batch.errs 里
      flushing: false,
      pendingWrites: [],   // ★ 10-28：切表期间查到的结果先攒着，切回来点「补齐回填」再写，不整轮作废
      diag: '',
      cfg: { numberCol: 0, outCol: 0, startRow: 0, rows: 0, mode: 'column', carrierCol: 0, polCol: 0, podCol: 0 },
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
      xsheetProbe: null    // ★ 0.9.43 启动时对别的工作表做一次只读探针（不写不建不删）
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
      return (this.vb && this.vb.errs ? this.vb.errs.write : '') || ''
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
      return this.hasRunning || this.hasQueued || this.batches.filter((b) => b.kind !== 'retry').length > 1
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
      if (this.writeErr) return { kind: 'err', text: this.writeErr, action: '' }
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
        : '启动：~/Documents/trae_projects/wps-shiptrack/scripts/bridge.sh start'
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
    outColText() {
      return colLetter(this.cfg.outCol)
    },
    stepHint() {
      if (this.cfg.numberCol === 0) return '第 1 步：在表格里选中提单号那一列（整列选中也行）→ 点「① 选单号列」'
      if (this.cfg.outCol === 0) return '第 2 步：选中要写结果的列 → 点「② 选输出列」'
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
      const per = (Date.now() - this.runStart) / this.done
      const left = Math.max(0, this.total - this.done) * per
      return left >= 60000 ? `剩约 ${Math.round(left / 60000)} 分钟` : `剩约 ${Math.round(left / 1000)} 秒`
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
  },
  beforeUnmount() {
    try { clearTimeout(this.retryTimer) } catch (e) { /* ignore */ }
    try { clearTimeout(this.wqTimer) } catch (e) { /* ignore */ }
    if (this.timer) clearInterval(this.timer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.docTimer) clearInterval(this.docTimer)
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
    batchTitle(b) {
      const bits = [b.doc]
      if (b.errs && b.errs.action) bits.push(b.errs.action)
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
        start: 0, state: 'queued', stop: false,
        errs: { action: '', write: '' },
        misalign: 0, misalignSeen: new Set(),
        writeStats: null, writeMs: 0,
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
    /** 跑完/停止的批次不用永远留着：只留最近 6 批，免得状态栏越来越长 */
    pruneBatches() {
      const done = this.batches.filter((b) => b.state === 'done' || b.state === 'stopped')
      if (done.length <= 6) return
      const drop = new Set(done.slice(0, done.length - 6).map((b) => b.id))
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
      this.cfg = { numberCol: 0, outCol: 0, startRow: 0, rows: 0, mode: 'column', carrierCol: 0, polCol: 0, podCol: 0 }
      this.scan = null
      this.loadCfg()
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
      this.cfg = { numberCol: 0, outCol: 0, startRow: 0, rows: 0, mode: 'column', carrierCol: 0, polCol: 0, podCol: 0 }
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
        this.cfg = { ...this.cfg, numberCol: s.col, startRow: r1, rows: Math.max(1, r2 - r1 + 1), mode }
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
      const A1 = this.addr(r, c)
      const tries = [
        ['Range.Value2', () => { sheet.Range(A1).Value2 = text }],
        ['Cells.Item', () => { sheet.Cells.Item(r, c).Value2 = text }],
        ['Cells()', () => { sheet.Cells(r, c).Value2 = text }],
        ['App.Range', () => { if (typeof a.Range !== 'function') throw new Error('无 Application.Range'); a.Range(A1).Value2 = text }]
      ]
      const errs = []
      for (const [name, fn] of tries) {
        try {
          fn()
          const back = this.readOne(sheet, r, c)
          if (String(back) === String(text)) {
            this.apiReport = { ...(this.apiReport || {}), write: name }
            return { ok: true, via: name }
          }
          errs.push(`${name}: 读回不一致（${back === undefined ? 'undefined' : back}）`)
        } catch (e) {
          errs.push(`${name}: ${String(e.message || e)}`)
        }
      }
      // 报第一条失败原因（通常最贴近根因），别把最后一条「API 不存在」当结论
      return { ok: false, error: errs[0] || '写入失败', all: errs }
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
      if (!this.wqTimer && this.writeQ.length >= 10) { this.flushWrites(); return }
      if (this.wqTimer) return
      this.wqTimer = setTimeout(() => {
        this.wqTimer = null
        this.flushWrites()
      }, ms)
    },
    flushWrites() {
      if (this.wqTimer) { clearTimeout(this.wqTimer); this.wqTimer = null }
      return this._flushWriteQueue()
    },
    /**
     * 队列落盘：按 (输出列, 单号列) 分组 → 行排序 → 连续区段 → 段内批量核身份 → 批量写 → 批量读回校验。
     * 中间有洞就断开：只对连续区段批量写，「不写的格」一个都不碰。
     * （整段覆盖会把洞里的公式/用户内容替换成死值 —— 这是最隐蔽的一种数据损坏，所以宁可按段写。）
     */
    _flushWriteQueue() {
      const st = { ok: 0, fail: 0, miss: 0, runs: 0, cells: 0, fills: 0, via: '', ms: 0 }
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
          const bst = { ok: 0, fail: 0, miss: 0, runs: 0, cells: 0, fills: 0, via: '', ms: 0 }
          const bt0 = this.nowMs()
          let deferred = 0
          this.flushingDocs.add(doc)
          try {
            if (cross && !this._sheetUsable(b, sheet)) {
              // (b) 现场：这个 WPS 版本摸不到非活动表 → 老实攒着，切回去再写，绝不去猜
              deferred = this._deferEntries(list, b, '跨表写不可用（这个 WPS 版本摸不到非活动表）')
            } else {
              this._writeList(sheet, list, bst, b)
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
          }
          bst.ms = Math.round(this.nowMs() - bt0)
          if (b && cross) { b.xsheet.ok += bst.ok; b.xsheet.fail += deferred }
          this._accWriteStats(b, bst)
          for (const k of ['ok', 'fail', 'miss', 'runs', 'cells', 'fills', 'ms']) st[k] += bst[k]
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
      }
      st.ms = Math.round(this.nowMs() - t0)
      if (st.via) this.writeVia = st.via
      if (st.fail) {
        this.log(`写回：成功 ${st.ok} / 失败 ${st.fail} / 错位跳过 ${st.miss}`)
      } else if (st.cells) {
        this.log(`写回：${st.cells} 格 / ${st.runs} 段 / ${st.ms}ms${st.via ? ' · ' + st.via : ''}`)
      }
      // ★ 0.9.43：写回账本累计（界面/诊断/基准看的是「这一轮一共写了多少格、一共多久」，
      //   只报最后一次 flush 会让人以为只写了 3 格）
      const acc = this.writeAcc || (this.writeAcc = { ok: 0, fail: 0, miss: 0, runs: 0, cells: 0, fills: 0, ms: 0 })
      for (const k of ['ok', 'fail', 'miss', 'runs', 'cells', 'fills', 'ms']) acc[k] += st[k]
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
      if (bst.fail) b.errs.write = `写入失败 ${bst.fail} 格（批量写不可用，退回逐格也没写进）`
      else if (bst.cells) b.errs.write = ''
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
    _writeList(sheet, list, st, batch) {
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
      for (const colList of groups.values()) {
        colList.sort((x, y) => x.row - y.row)
        let i = 0
        while (i < colList.length) {
          let j = i
          while (j + 1 < colList.length && colList[j + 1].row === colList[j].row + 1) j++   // 连续行号
          const seg = colList.slice(i, j + 1)
          i = j + 1
          this._writeSeg(batch, sheet, seg, st, paints)
        }
      }
      if (paints.length) st.fills = this.paintRows(sheet, paints, batch && batch.doc, batch && batch.cfg.outCol)
    },
    _cellValueOf(w) {
      return w.value === undefined ? w.text : w.value
    },
    /** 读回校验：日期列回来的可能是 Date，按 y-m-d 比 */
    sameCellText(back, w) {
      const want = this._cellValueOf(w)
      if (want instanceof Date) {
        const p = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (back instanceof Date) return p(back) === p(want)
        const s = String(back == null ? '' : back)
        return s === p(want) || s.slice(0, 10) === p(want) || s === w.text
      }
      return String(back == null ? '' : back) === String(want)
    },
    /** 一段连续行：批量核身份 → 逐段写（段内批量）→ 记着色计划 */
    _writeSeg(batch, sheet, seg, st, paints) {
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
      for (const [name, fn] of tries) {
        try {
          fn()
          const back = this.readRangeValues(sheet, col, from, to)
          if (back && back.values && back.values.length === run.length) {
            let bad = 0
            run.forEach((w, k) => { if (!this.sameCellText(back.values[k], w)) bad++ })
            if (!bad) {
              st.ok += run.length
              st.cells += run.length
              st.runs++
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
      for (const w of run) this._writeOneChecked(batch, sheet, w, st, true, '退回逐格时核对不通过')
      return false
    },
    /**
     * 逐格写（批量写的唯一旁路：整个文件里只有这一处调 writeCell）。
     * 单行段、以及批量写不可用时的逐格定位都走它：先核身份（needCheck=true 时），再写，写内置读回校验。
     */
    _writeOneChecked(batch, sheet, w, st, needCheck = true, why = '写前核对不通过') {
      if (needCheck) {
        const cur = w.numCol ? this.readOne(sheet, w.row, w.numCol) : ''
        if (w.numCol && !this.sameNumber(w.number, cur)) {
          w.result = 'miss'
          st.miss++
          this.markMisalign(batch, w.it, w.row, w.numCol, why)
          return false
        }
      }
      const r = this.writeCell(sheet, w.row, w.col, this._cellValueOf(w))
      if (r && r.ok) {
        st.ok++
        st.cells++
        st.runs++
        w.result = 'ok'
        w.via = r.via
        return true
      }
      st.fail++
      w.result = 'fail'
      w.error = r && r.error
      return false
    },

    pickOutputCol() {
      this.panelErr = ''
      try {
        const s = this.readSel()
        if (this.cfg.numberCol === 0) {
          this.cfg = { ...this.cfg, outCol: s.col }
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
    carrierLabel(carrier) {
      if (!carrier) return ''
      if (CARRIER_NAME[carrier]) return CARRIER_NAME[carrier]
      const c = ((this.carriers && this.carriers.carriers) || []).find((x) => x.id === carrier)
      return (c && c.name) || carrier
    },
    /** ★ 10-28：该船司的官网页（桥从 identify.mjs 直出，插件不维护第二份 URL 表） */
    manualUrlOf(carrier) {
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
      // ★ 快照必须在任何 await 之前取：桥慢/重连时 await 一次，用户可能已经切到别的表了
      const a = this.app()
      const sheet = a && a.ActiveSheet
      const doc = this.docKey()
      if (!this.ready) {
        this.flash('先点 ① 选单号列、② 选输出列')
        return
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
        // ★ 0.9.42：本轮剩余的写回队列立刻落盘（一次批量写 + 一次读回），
        //   然后再统计——不然「查询跑完了但结果还堆在队列里」会把汇总算错。
        this.flushWrites()
      }
      this.finishBatch(b)
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
        this.flushWrites()
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
              it.text = `${raw} 未接入追踪（请手工查）`
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
          it.text = `${this.carrierLabel(override) || override} 未接入追踪（请手工查）`
          it.state = 'error'
          it.failReason = 'not-wired'
          it.manualUrl = this.manualUrlOf(override)          // ★ 10-28：没接入也要给一条能点的路
          it.manualLabel = this.carrierLabel(override) || override
          return this.writeResult(b, it, sheet, t.row, outCol, true)
        }
        // ★ 0.9.43：真正的查询走「面板全局槽位」——多批并行时在飞请求数有硬上限，
        //   超了就在这儿等（不是让桥去排队，桥那边是浏览器实例，占了就是占了）。
        const call = async (num) => {
          await this.acquireSlot()
          try {
            return await this.httpGet(
              // 单条 90s：绝大多数成功查询 <15s；跑飞的（站点卡住）不能占着 worker 两分钟
              '/track?number=' + encodeURIComponent(num) + (override ? '&carrier=' + override : '') + '&timeout=90000', 95000)
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
        it.text = this.formatLatest(r)
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
          const st = stageOf(r.events || [], {
            pol: routePol || pol,
            pod: routePod || pod,
          })
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
      // ★ 0.9.42：船期也是「写回」——一律走唯一入口（入队 → 批量核身份 → 批量写），
      //   不再直接摸 Range；行身份由 writeRowChecked 那一把尺统一核，写错行的口子彻底收掉。
      const put = (col, val) => {
        if (!col || !val) return false
        try {
          const addr = `${colLetter(col)}${row}`
          const rng = sheet.Range(addr)
          let cur = '', fmt = ''
          try { cur = String(rng.Value2 == null ? '' : rng.Value2).slice(0, 10) } catch (e) { cur = '' }
          if (cur === val) return false
          try { fmt = String(rng.NumberFormatLocal || '') } catch (e) { fmt = '' }
          const isDate = /y{2,}|m{1,2}[-/]d|d{1,2}[-/]m/i.test(fmt)
          const [y, m, d] = val.split('-').map(Number)
          this.writeRowChecked(b, sheet, row, col, val, number, numCol, null, isDate ? new Date(y, m - 1, d) : val)
          return true
        } catch (e) { return false }
      }
      const a = put(etdCol, etd)
      const c = put(etaCol, eta)
      if (a || c) this.log(`R${row} 待回填船期：ETD ${etd || '—'} · ETA ${eta || '—'}`)
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
    autoFlushWhenBack() {
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
      this.flushWrites()          // 补齐是用户明确要的动作 → 立刻落盘，不等攒批
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
        it.note = '本次' + this.shortReason(it.failReason) + '，保留旧值'
        this.log(`R${row} 保留旧值（本次 ${this.shortReason(it.failReason)}）`)
        return
      }
      // ★ 0.9.42 唯一写回入口：入队 → 批量核身份 → 批量写 → 批量读回；
      //   着色也一并交给 _flushWriteQueue 按区段批量刷（这里不再逐行摸 Interior）。
      const w = this.writeRowChecked(b, sheet, row, outCol, it.text, it.number, it.numCol, it)
      if (!w || !w.ok) {
        if (b) b.errs.write = '写入失败：' + (w ? w.error : '未知')
        this.log(`写 ${colLetter(outCol)}${row} 失败: ${w ? w.error : '未知'}`)
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
      // 立刻中断在飞的请求（桥那边收到断开就会杀掉对应子进程），不用等 90s 超时
      try { for (const c of this.aborts) { try { c.abort() } catch (e) {} } this.aborts.clear() } catch (e) {}
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
    shortReason(s) {
      const t = String(s || '失败').split('\n')[0]
      if (/超时|timeout/i.test(t)) return '超时'
      if (/ECONN|连接|网络|ERR_|page\.goto|net::|Failed to fetch/i.test(t)) return '网络错误'
      if (/404|not found|does not exist/i.test(t)) return '查无此单'
      return t.replace(/^Error:\s*/i, '').slice(0, 14)
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
    formatLatest(r) {
      if (!r) return '空响应'
      if (r.ok === false) {
        const raw = String(r.error || '查询失败')
        if (/Cannot tell which carrier|unknown-prefix|未识别/i.test(raw)) return '未识别承运人（可能是货代单）'
        // 官网只保留近 12 个月 / 单号不存在 → 统一按「查无」处理
        if (/仅保留 12 个月|DOCUMENT does not exist/i.test(raw)) {
          return notFoundText(r.carrier, CARRIER_NAME[r.carrier])
        }
        if (/官网当前不可用|site-unavailable|maintenance work/i.test(raw)) {
          return `${CARRIER_NAME[r.carrier] || '船司'} 官网当前不可用（地区限制/维护中，换网络或手工查）`
        }
        if (/需要 14 位提单号|Akkon 未找到/i.test(raw)) {
          return 'AKK 查无此单（需 14 位提单号，箱号不能单独查）'
        }
        if (/no tracking module|not wired up for/i.test(raw)) {
          return `${this.carrierLabel(r.carrier) || '该船司'} 未接入追踪（请手工查）`
        }
        if (/超时|timeout/i.test(raw)) return '查询超时（网络慢，稍后重试）'
        // ★ 10-29：OOCL 匿名端点有 QF8 限流（连查 6-8 次会被封一阵）→ 如实说，别叫人反复重试
        if (/限流|throttled|too many requests|访问过于频繁/i.test(raw)) {
          return `${this.carrierLabel(r.carrier) || '船司'} 站方限流（过几分钟再查，别连续重试）`
        }
        if (/HTTP 404|No tracking data found/i.test(raw)) {
          return notFoundText(r.carrier, CARRIER_NAME[r.carrier])
        }
        if (/DOCUMENT does not exist|Shipment not found/i.test(raw)) {
          // 只说事实：官网对这两个号都没有记录。不猜「你用错了号」——工具分不清就该两个都试过再说
          return notFoundText(r.carrier, CARRIER_NAME[r.carrier])
        }
        const short = raw.split('\n')[0].slice(0, 40)
        return '失败：' + short
      }
      const evs = r.events || []
      // 只有「已发生」的事件才算最新动态；计划/预计的（EXPECTED）不能当成事实报出来
      // 爹地 2026-10-27：279885106 连柜都没装，却被写成「12-12 到港 · GDANSK」
      const isPlan = (e) => isPlanned(e)   // 与里程碑判定同一口径（truth.js）
      const actuals = evs.filter((e) => !isPlan(e))
      const cur = (r.current && !isPlan(r.current)) ? r.current : (actuals.length ? actuals[actuals.length - 1] : null)
      const plans = evs.filter(isPlan)
      const plan = plans.length ? plans[plans.length - 1] : null
      if (!cur) {
        return plan
          ? `还没发货（预计 ${formatEventLine(plan.time, plan.activity, plan.city)}）`
          : (r.phase ? `暂无动态（${r.phase}）` : '暂无动态')
      }
      const line = formatEventLine(cur.time, cur.activity, cur.city)
      // 有比它更晚的计划事件 → 附在后面，但明确写「预计」
      return plan && String(plan.time || '') > String(cur.time || '')
        ? `${line}；预计 ${formatEventLine(plan.time, plan.activity, plan.city)}`
        : line
    }
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
</style>
