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
      <button @click="stop" :disabled="!busy">停止</button>
      <button v-if="pendingWrites.length" class="mini-btn pending-btn" :title="`暂存了 ${pendingWrites.length} 行结果：查询中切走的那几张表，切回来点这里一次写回`" @click="flushPending">补齐回填 {{ pendingWrites.length }}</button>
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
      <div class="muted" v-if="cfg.outCol > 0">上次刷新 {{ lastRunText }}<span v-if="misalign" class="stale">（本轮错位 {{ misalign }} 行 → 这个时间与范围行数不可信）</span> · API 读法 {{ readVia || '—' }} · 写法 {{ writeVia || '—' }}</div>
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
const APP_VER = '0.9.41'
const BRIDGE = 'http://127.0.0.1:8791'
const CFG_KEY = 'shiptrack_cfg_v4'
const LAST_RUN_KEY = 'shiptrack_lastrun_v3'
const AUTO_MS = 24 * 60 * 60 * 1000
// 跨文档闸门：同时开 6 个工作簿时，别让每个面板各跑一轮（2026-10-26 巨卡就是这个）
const GLOBAL_RUN_KEY = 'shiptrack_lastrun_global_v1'
const AUTO_MAX_ROWS = 50          // 自动刷新单次最多查 50 行，其余手动

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
      busy: false,
      stopFlag: false,
      flushing: false,
      pendingWrites: [],   // ★ 10-28：切表期间查到的结果先攒着，切回来点「补齐回填」再写，不整轮作废
      actionErr: '',
      diag: '',
      items: [],
      done: 0,
      total: 0,
      cfg: { numberCol: 0, outCol: 0, startRow: 0, rows: 0, mode: 'column', carrierCol: 0, polCol: 0, podCol: 0 },
      capErr: '',
      writeErr: '',
      scan: null,
      runStart: 0,
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
      runSummary: '',
      misalign: 0,          // ★ 0.9.41：本轮「行身份对不上」跳过写回的行数（界面横幅按它推导）
      misalignSeen: new Set(),
      lastRun: 0,
      autoOn: true,
      timer: null
    }
  },
  computed: {
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
      if (v) this.actionErr = ''
    },
    'scan.count'(v) {
      if (v > 0) this.actionErr = ''
    }
  },
  mounted() {
    this.diagDump()
    this.ping()
    this.loadCarriers()
    this.hydrateCfg()
    this.loadCfg()
    this.checkUpdate()
    this.checkNet()
    this.armRetryTimer()   // 重开文件时把上次没查到的队列接上
    // 自动刷新：延迟 10s 再判（WPS 刚启动时先让它把文档加载完），且全机只允许一个文档跑
    setTimeout(() => this.maybeAutoRefresh(), 10000)
    this.timer = setInterval(() => this.maybeAutoRefresh(), 60 * 60 * 1000)
    // ★ 10-28：切表期间暂存的结果，一旦检测到已回到原表就自动补齐 —— 用户不用点（「简化优先」）
    this.flushTimer = setInterval(() => this.autoFlushWhenBack(), 2500)
  },
  beforeUnmount() {
    try { clearTimeout(this.retryTimer) } catch (e) { /* ignore */ }
    if (this.timer) clearInterval(this.timer)
    if (this.flushTimer) clearInterval(this.flushTimer)
  },
  methods: {
    app() {
      return window.Application
    },
    // 短暂提示：给「点错列」这类操作反馈，几秒后自动消失，不会变成僵尸红条
    flash(msg, ms = 6000) {
      this.actionErr = msg
      clearTimeout(this.flashT)
      this.flashT = setTimeout(() => {
        if (this.actionErr === msg) this.actionErr = ''
      }, ms)
    },
    log(msg) {
      const t = new Date().toLocaleTimeString()
      this.diag = `${t}  ${msg}\n` + this.diag
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
    saveCfg() {
      const raw = JSON.stringify(this.cfg)
      const key = CFG_KEY + ':' + this.docKey()
      const st = this.storage()
      try {
        if (st) st.setItem(key, raw)
      } catch (e) {
        this.log('PluginStorage 写入失败: ' + e.message)
      }
      try {
        localStorage.setItem(key, raw)
      } catch (e) {}
      this.log(`配置已保存（${this.docKey()}）: ` + raw)
      // 落盘到桥（WPS 重启/换会话都还在）
      try {
        if (typeof fetch === 'function') {
          fetch(this.base() + '/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc: this.docKey(), cfg: this.cfg })
          }).catch(() => {})
        }
      } catch (e) {}
    },
    saveLastRun(ts) {
      this.lastRun = ts
      const st = this.storage()
      const key = LAST_RUN_KEY + ':' + this.docKey()
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
      this.items = []
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
      this.actionErr = ''
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
      this.actionErr = ''
      try {
        const s = this.readSel()
        const sheet = this.app().ActiveSheet
        if (this.busy) { this.stopFlag = true; this.log('正在查询，已请求停止以便改配置') }
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
        this.actionErr = '选单号列失败：' + e.message
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
        this.actionErr = ''
      } catch (e) {
        this.actionErr = '选船司列失败：' + e.message
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
    // ---------- 整行底色（里程碑）----------
    // 爹地要求：按里程碑给「该行整行」填充，而不是只染输出单元格。
    applyStageColor(sheet, row, col, stage) {
      const color = STAGE_COLOR[stage] || NO_FILL
      // 行内填充到表格已用区最右列（不刷整张 16384 列，省得又慢又脏）
      let firstCol = 1
      let lastCol = col
      try {
        const ur = sheet.UsedRange
        const left = ur.Column || 1
        const right = left + ((ur.Columns && ur.Columns.Count) || 1) - 1
        if (left > 0) firstCol = left
        if (right > lastCol) lastCol = right
      } catch (e) {}
      const rowAddr = `${colLetter(firstCol)}${row}:${colLetter(lastCol)}${row}`
      const setIt = (interior) => {
        if (color === NO_FILL) {
          interior.ColorIndex = NO_FILL
        } else {
          interior.Pattern = 1
          interior.Color = color
        }
      }
      const tries = [
        ['Range(整行).Interior', () => setIt(sheet.Range(rowAddr).Interior)],
        ['Rows(row).Interior', () => setIt(sheet.Rows(row).Interior)],
        ['Cells(整行)', () => setIt(sheet.Rows(row).Cells.Interior)]
      ]
      for (const [name, fn] of tries) {
        try {
          fn()
          this.fillVia = name
          return true
        } catch (e) {
          this.fillErr = String(e.message || e)
        }
      }
      this.log(`整行上色失败（第 ${row} 行）：${this.fillErr}`)
      return false
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
    // 只清「我们自己刷的三种里程碑色」；用户手工标的底色一律不碰
    clearOurColor(sheet, row) {
      const ours = [STAGE_COLOR[1], STAGE_COLOR[2], STAGE_COLOR[3]]
      try {
        const ur = sheet.UsedRange
        const left = ur.Column || 1
        const right = left + ((ur.Columns && ur.Columns.Count) || 1) - 1
        const rng = sheet.Range(`${colLetter(left)}${row}:${colLetter(right)}${row}`)
        const cur = Number(rng.Interior.Color)
        if (ours.includes(cur)) { rng.Interior.ColorIndex = NO_FILL; return true }
      } catch (e) { /* 读不到就算了，不动 */ }
      return false
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
      const want = normNum(number)
      if (!want) return false
      const col = Number(numCol || this.cfg.numberCol || 0)
      if (!col) return false
      let cur
      try { cur = this.readOne(sheet, row, col) } catch (e) { return false }
      const have = splitParts(toHalf(cur)).map(normNum).filter(Boolean)
      if (!have.length) return false
      // 一格两号（订舱号/提单号同格）时，查询用的可能就是其中之一 → 命中任一即可
      return have.includes(want)
    },
    /** 错位跳过：不写、计数（按行去重）、界面给一句能照着做的提示 */
    markMisalign(it, row, numCol, why) {
      this.misalignSeen.add(`${row}|${numCol || this.cfg.numberCol || 0}`)
      this.misalign = this.misalignSeen.size
      if (it) {
        it.state = 'skip'
        it.misaligned = true
        it.failReason = 'misaligned'
        it.text = '错位跳过（该行单号已变或已空，结果没写，点③重跑）'
      }
      const c = colLetter(numCol || this.cfg.numberCol)
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

    /**
     * ★ 0.9.41 唯一的写回入口：先核行身份，通不过就跳过，通过才真写。
     * 写业务单元格的路径（写结果 / 补写暂存 / 写船期）一律走这里或 verifyRowIdentity，
     * 不许再直接调 writeCell —— 否则下次又只修一处。
     */
    writeRowChecked(it, sheet, row, col, text, numCol) {
      const nc = Number(numCol || (it && it.numCol) || this.cfg.numberCol || 0)
      if (!this.verifyRowIdentity(sheet, row, it ? it.number : '', nc)) {
        this.markMisalign(it, row, nc, '写前核对不通过')
        return { ok: false, skipped: true }
      }
      return this.writeCell(sheet, row, col, text)
    },

    pickOutputCol() {
      this.actionErr = ''
      try {
        const s = this.readSel()
        if (this.cfg.numberCol === 0) {
          this.cfg = { ...this.cfg, outCol: s.col }
          this.saveCfg()
          this.actionErr = ''
          this.log(`输出列 = ${colLetter(s.col)}（等单号列选好再跑）`)
          return
        }
        if (this.cfg.numberCol > 0 && s.col === this.cfg.numberCol) {
          this.flash(`输出列不能和单号列相同（都是 ${colLetter(s.col)}）—— 那会把提单号覆盖掉，换一列再点`)
          return
        }
        if (this.busy) { this.stopFlag = true; this.log('正在查询，已请求停止以便改配置') }
        this.cfg = { ...this.cfg, outCol: s.col }
        this.saveCfg()
        // 选完输出列不自动开跑：以前会自动 refresh，用户刚点完就看见表格被写、面板状态乱跳
        // 现在只准备好配置，什么时候查由用户按「③ 立即刷新」决定
        this.log(`输出列 = ${colLetter(s.col)}（准备好后点 ③ 立即刷新）`)
      } catch (e) {
        this.actionErr = '选输出列失败：' + e.message
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
          if (this.ready && !this.busy) setTimeout(() => this.maybeAutoRefresh(), 3000)
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
    /** S/L 写了船司但该船司没接适配器（如 OOCL）→ 直接给结论，不发请求 */
    knownNotLive(carrier) {
      if (!carrier || !this.carriers || !this.carriers.carriers) return false
      const c = this.carriers.carriers.find((x) => x.id === carrier)
      return !!c && !c.live
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
        if (this.cfg.outCol > 0) this.writeResult(it, sheet, it.row, this.cfg.outCol, true)
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
          this.writeErr = ''
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
      if (!this.ready || this.busy || this.stopFlag) return
      if (!this.globalAutoDue()) return
      if (!this.isActiveDoc()) return
      this.markGlobalAuto()
      this.log('距上次自动刷新超过 24h：只查空行（最多 ' + AUTO_MAX_ROWS + ' 条）')
      this.refresh(false, { auto: true })
    },

    async refresh(manual, opts = {}) {
      this.actionErr = ''
      if (!this.ready) {
        this.flash('先点 ① 选单号列、② 选输出列')
        return
      }
      if (this.busy) return
      if (this.cfg.outCol === this.cfg.numberCol) {
        this.actionErr = '配置异常：输出列和单号列是同一列，拒绝执行（会覆盖提单号）'
        return
      }
      if (!this.bridge) {
        await this.ping()
        if (!this.bridge) return
      }
      const a = this.app()
      const sheet = a && a.ActiveSheet
      if (!sheet) {
        this.actionErr = '没有活动工作表'
        return
      }
      // 先判断「这张表到底能不能写」——写不进去时给明确原因，别让用户猜
      this.writeErr = ''
      this.capErr = this.checkWritable(sheet)
      if (this.capErr) this.log('写回受阻：' + this.capErr)

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
          this.saveCfg()
        }
      }
      const read = this.readRangeValues(sheet, col, r1, r2)
      const vals = read.values
      if (!vals.length) {
        this.actionErr = `读不出 ${colLetter(col)} 列（第 ${r1}–${r2} 行）：${read.error || '所有读法都失败'}`
        this.log('读取失败，诊断: ' + JSON.stringify(this.apiReport || {}))
        return
      }
      this.readVia = read.via
      const nums = vals.map((v, i) => {
        const row = r1 + i
        // 一格写「订舱号/提单号」时：主用提单号，另一个留作兜底（有些船司只认订舱号）
        const parts = splitParts(v).map(cleanNumber).filter(looksLikeNumber)
        return { row, number: parts[0] || '', alts: parts.slice(1), raw: v }
      })
      let todo = nums.filter((x) => x.number)
      if (opts.auto) {
        // 自动刷新只补空行：已经写过结果的行不重查（省得开机就几十个浏览器查询把机器拖死）
        const empty = todo.filter((t) => !String(this.readOne(sheet, t.row, outCol) || '').trim())
        if (!empty.length) { this.log('自动刷新：没有待补的空行，跳过'); return }
        if (empty.length > AUTO_MAX_ROWS) this.log(`自动刷新：待查 ${empty.length} 行，只处理前 ${AUTO_MAX_ROWS} 行`)
        todo = empty.slice(0, AUTO_MAX_ROWS)
      }
      if (!todo.length) {
        this.actionErr = `单号列 ${colLetter(col)}（第 ${r1}–${r2} 行）里没读到提单号 —— 确认选的是 MBL 那一列`
        this.log('前 6 行原始值: ' + JSON.stringify(vals.slice(0, 6)))
        return
      }

      this.items = nums.map((x) => ({
        row: x.row,
        number: x.number || '—',
        numCol: col,            // ★ 0.9.41：写回时按「这一列」核对行身份（跑动中改配置也不影响本轮）
        text: x.number ? '' : '（空/非单号，跳过）',
        state: x.number ? 'idle' : 'skip'
      }))
      this.misalign = 0          // 新一轮从零计数：上一轮的错位提示随这次刷新消失，不挂僵尸
      this.misalignSeen.clear()
      this.busy = true
      this.stopFlag = false
      this.runStart = Date.now()
      const startDoc = this.docKey()
      this.runDoc = startDoc
      this.total = todo.length
      this.done = 0
      this.log(`开始刷新 ${todo.length} 条${manual ? '（手动）' : '（自动）'}`)

      // 2) 并发 2 条查询、完成即写回（桥的并发槽也是 2，正好吃满；中途断了保留已完成）
      const queue = todo.slice()
      // 与桥的并发保持一致（桥默认 4）；可用 window.__SHIPTRACK_CONC__ 调小做排障
      const CONC = Math.min(Number(window.__SHIPTRACK_CONC__ || 4), queue.length)
      let netFails = 0            // 连续连接级失败计数：断网时别把 50 行全试一遍（每行都要起浏览器）
      const worker = async () => {
        while (queue.length && !this.stopFlag) {
          const t = queue.shift()
          try {
            await this.queryAndWrite(sheet, t, outCol, startDoc)
            // 熔断：连接级失败（断网/代理没开）时，后面每行都要再起一个浏览器 —— 直接停
            const it2 = this.items.find((x) => x.row === t.row)
            const netish = it2 && it2.state === 'error'
              && /ECONN|ERR_|Failed to fetch|NetworkError|连接|net::/i.test(String(it2.failReason || it2.text || ''))
            netFails = netish ? netFails + 1 : 0
            if (netFails >= 3) {
              this.stopFlag = true
              this.actionErr = '连续 3 条连接失败（多半是断网或代理没开）—— 已停止本轮，别让每行都去开一次浏览器'
              this.log('熔断：连续连接失败 3 次，停止本轮')
            }
          } catch (e) {
            // 单行异常不许拖垮整轮（历史教训：一次未捕获异常会让面板永远卡在「查询中」）
            const it = this.items.find((x) => x.row === t.row)
            if (it) { it.state = 'error'; it.text = '查询失败：' + (e.message || e) }
            this.log(`R${t.row} 异常: ${e.message || e}`)
          }
          this.done++
        }
      }
      try {
        await Promise.all(Array.from({ length: CONC }, () => worker()))
      } catch (e) {
        this.log('刷新异常终止: ' + (e.message || e))
        this.actionErr = '刷新异常终止：' + (e.message || e)
      } finally {
        this.busy = false
      }
      const completed = !this.stopFlag
      // 没收尾的行别挂着「查询中…」
      for (const it of this.items) {
        if (it.state === 'querying') {
          it.state = 'skip'
          it.text = this.stopFlag ? '（已停止，未完成）' : '（本次未完成，点③重跑）'
        }
        if (it.state === 'idle') {
          it.state = 'skip'
          it.text = this.stopFlag ? '（已停止，未查询）' : '（本次未查，点③刷新）'
          // 这行这次没重算 → 之前刷的里程碑色可能已过期，清掉
          this.clearOurColor(sheet, it.row)
        }
      }

      this.runSummary = summarizeFails(this.items)
      this.log('本轮汇总：' + this.runSummary)
      this.scheduleRetry()
      if (completed) {
        this.saveLastRun(Date.now())
        this.log(`刷新完成 ${this.done}/${this.total}`)
      } else {
        this.log(`提前停止 ${this.done}/${this.total}；24h 自动刷新计时不重置，下次打开会补跑`)
      }
    },

    /**
     * 自动重查：本轮没拿到结果的行，30 分钟后自动再查一次（每号最多 2 次）
     * 队列存进文档配置，关掉面板/重开文件都还在。
     */
    scheduleRetry(sheet) {
      const DELAY = Number(window.__SHIPTRACK_RETRY_MS__ || 0) || 30 * 60 * 1000   // 测试可改短
      const MAX_TRIES = 2
      const prev = Array.isArray(this.cfg.retry) ? this.cfg.retry : []
      const prevBy = new Map(prev.map((x) => [String(x.n), x]))
      const now = Date.now()
      const next = []
      for (const it of this.items) {
        const n = String(it.number || '')
        if (!n || n === '—' || it.state === 'skip') continue
        const gotResult = it.state === 'ok' && !/查无|无记录|未找到|未返回|没有数据/.test(String(it.text || ''))
        if (gotResult) continue
        if (this.stopFlag) continue               // 手动停止的，不自动重查
        const old = prevBy.get(n)
        const tries = (old ? old.tries : 0) + 1
        if (tries > MAX_TRIES) {
          this.log(`R${it.row} ${n} 已自动重查 ${MAX_TRIES} 次仍无结果，不再排队`)
          continue
        }
        next.push({ n, row: it.row, at: now + DELAY, tries })
      }
      this.cfg = { ...this.cfg, retry: next }
      this.saveCfg()
      this.retryCount = next.length
      if (next.length) {
        const t = new Date(next[0].at).toTimeString().slice(0, 5)
        this.log(`${next.length} 条没查到结果 → ${t} 之后自动重查（每号最多 2 次）`)
      }
      this.armRetryTimer()
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
      if (this.busy) { this.retryTimer = setTimeout(() => this.runRetry(), 120000); return }
      const due = (this.cfg.retry || []).filter((x) => x && x.n && x.at <= Date.now() + 5000)
      if (!due.length) { this.armRetryTimer(); return }
      const a = this.app()
      const sheet = a && a.ActiveSheet
      if (!sheet) { this.log('自动重查跳过：当前没有打开的表'); this.retryTimer = setTimeout(() => this.runRetry(), 300000); return }
      const outCol = this.cfg.outCol
      this.busy = true
      this.actionErr = ''
      this.log(`自动重查 ${due.length} 条（30 分钟到点，第 ${due[0].tries} 次）`)
      try {
        for (const item of due) {
          const t = { row: item.row, number: item.n, alts: [], raw: item.n }
          await this.queryAndWrite(sheet, t, outCol, this.docKey())
        }
      } catch (e) {
        this.log('自动重查异常：' + (e.message || e))
      } finally {
        this.busy = false
      }
      // 重查完仍没结果的，留在队列里等下一次（tries 已在 scheduleRetry 里递增）
      const still = (this.cfg.retry || []).filter((x) => !due.some((d) => d.n === x.n))
      this.cfg = { ...this.cfg, retry: still }
      this.saveCfg()
      this.scheduleRetry(sheet)
    },

    // 单行：识别归属 → 查询 → 写回（暂态失败不覆盖旧值）
    async queryAndWrite(sheet, t, outCol, startDoc) {
      const it = this.items.find((x) => x.row === t.row)
      if (!it) return
      const a = this.app()
      // ★ 10-28（爹地报障：一个表不可能开 10 分钟不切 tab）：切表**不再阻止查询** ——
      //   桥在跑、结果有用；是否现在写回由 writeResult 决定（切表了就攒进 pendingWrites）。
      void a
      it.state = 'querying'
      it.text = '查询中…'
      it.failReason = ''
      try {
        let override = ''
        // ① 先看船司列（用户自己的 S/L，最权威；SOC/COC 等字样自动忽略）
        if (this.cfg.carrierCol > 0) {
          try {
            const sl = this.readOne(sheet, t.row, this.cfg.carrierCol)
            override = carrierFromSl(sl)
            if (override) this.log(`${t.number}: 按 S/L「${String(sl).trim()}」→ ${override}`)
          } catch (e) {}
        }
        // ①b 写了船司名、但这个船司没有适配器 → 直接给结论，一个请求都不发
        if (!override && this.cfg.carrierCol > 0) {
          try {
            const sl = this.readOne(sheet, t.row, this.cfg.carrierCol)
            const raw = String(sl == null ? '' : sl).trim()
            if (looksLikeCarrierToken(raw)) {
              it.state = 'error'
              it.text = `${raw} 未接入追踪（请手工查）`
              it.failReason = 'not-wired'
              this.log(`R${t.row} S/L「${raw}」未接入，跳过`)
              return this.writeResult(it, sheet, t.row, outCol, true)
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
          it.text = `${CARRIER_NAME[override] || override} 暂未接入（官网需滑块/验证码，请手工查）`
          it.state = 'error'
          it.failReason = 'not-wired'
          it.manualUrl = this.manualUrlOf(override)          // ★ 10-28：没接入也要给一条能点的路
          it.manualLabel = CARRIER_NAME[override] || override
          return this.writeResult(it, sheet, t.row, outCol, true)
        }
        const call = async (num) => this.httpGet(
          // 单条 90s：绝大多数成功查询 <15s；跑飞的（站点卡住）不能占着 worker 两分钟
          '/track?number=' + encodeURIComponent(num) + (override ? '&carrier=' + override : '') + '&timeout=90000', 95000)
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
          const blCol = this.cfg.blCol || 0
          const bkCol = this.cfg.bkCol || 0
          const pick = (c) => {
            if (!c || c === this.cfg.numberCol) return ''
            try { return cleanNumber(String(this.readOne(sheet, t.row, c) || '')) } catch (e) { return '' }
          }
          // 什么时候还该试第二列：主查的是提单号 → 试订舱号；主查的是订舱号 → 试提单号
          const curIsBl = blCol && this.cfg.numberCol === blCol
          const secondCol = curIsBl ? bkCol : (blCol || this.cfg.altCol || 0)
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
          const pol = this.cfg.polCol ? String(this.readOne(sheet, t.row, this.cfg.polCol) || '') : ''
          const pod = this.cfg.podCol ? String(this.readOne(sheet, t.row, this.cfg.podCol) || '') : ''
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
          this.writeScheduleDates(sheet, t.row, r, routePod || pod, t.number)
        }
      } catch (e) {
        it.text = '查询失败：' + e.message
        it.state = 'error'
        it.failReason = e.message
      }
      return this.writeResult(it, sheet, t.row, outCol)
    },

    /**
     * 表格里有 ETD / ETA 列时，用船司返回的真实船期覆盖
     * 实际发生的优先；没发生的用船司给的计划时间（表格本来就填的计划）
     */
    writeScheduleDates(sheet, row, r, pod, number) {
      const etdCol = this.cfg.etdCol || 0
      const etaCol = this.cfg.etaCol || 0
      if (!etdCol && !etaCol) return
      // ★ 0.9.41：船期也是写进这一行 —— 行变了同样不许写（否则日期会写到别人的货上）
      if (!this.verifyRowIdentity(sheet, row, number, this.cfg.numberCol)) {
        this.log(`R${row} 船期不写：该行单号已变（防写到别的行）`)
        return
      }
      let etd = '', eta = ''
      try { ({ etd, eta } = pickEtdEta(r.events || [], { pod })) } catch (e) { this.log('船期取值失败: ' + (e.message || e)); return }
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
          rng.Value2 = isDate ? new Date(y, m - 1, d) : val
          return true
        } catch (e) { return false }
      }
      const a = put(etdCol, etd)
      const b = put(etaCol, eta)
      if (a || b) this.log(`R${row} 回填船期：ETD ${etd || '—'} · ETA ${eta || '—'}`)
    },

    /** ★ 10-28：切表时把这一行的结果攒起来（不写、不丢），切回来一次补齐 */
    deferWrite(it, outCol) {
      if (!it) return
      // ★ 0.9.41 去重 key 带上 doc/number/row：只按 row|col 去重时，删行后两条结果可能落到同一个 row，
      // 后进的把前一条**静默去重**掉（不报错、直接丢一条）。带 number 区分「同号两行」，带 row 区分
      // 「不同号同一行」——去重是为了幂等，不是为了省存储。
      const numCol = it.numCol || this.cfg.numberCol
      const key = `${this.runDoc}|${it.number}|${numCol}|${outCol}|${it.row}`
      this.pendingWrites = this.pendingWrites.filter((x) => x.key !== key)
      this.pendingWrites.push({
        key, row: it.row, outCol, doc: this.runDoc,
        number: it.number, numCol,
        text: String(it.text || ''), state: it.state,
      })
      it.state = 'pending'
      if (!/待回填/.test(String(it.text))) it.text = String(it.text || '') + '（待回填）'
      this.log(`R${it.row}: 当前不在目标表 → 结果暂存，切回原表点「补齐回填」`)
    },
    /** ★ 10-28：回到原表就自动补齐（不用点按钮）；不在原表就什么都不做，绝不写错表 */
    autoFlushWhenBack() {
      // ★ 10-28 修正（知澜定位）：原来这里还有 `|| this.busy`，把整轮查询期间都挡住了 ——
      //   用户中途切走再切回原表，人已经回来了却一直攒到整轮跑完才补，UI 上就多出一个多余按钮。
      //   去掉 busy 判断是安全的：flushing 防重入、deferWrite 按 key 去重、
      //   _flushPending 只写当前 doc 的 pending，而正在跑的行还没进队列，互不冲突。
      if (!this.pendingWrites.length) return
      if (!this.runDoc) return
      if (this.docKey() !== this.runDoc) return          // 还没回到原表 → 等
      const same = this.pendingWrites.filter((x) => x.doc === this.runDoc)
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
      if (!sheet) { this.actionErr = '没有活动工作表，补不了'; return }
      const nowDoc = this.docKey()
      const same = this.pendingWrites.filter((x) => x.doc === nowDoc)
      const other = this.pendingWrites.filter((x) => x.doc !== nowDoc)
      if (!same.length) {
        this.actionErr = `补不齐：当前是「${nowDoc}」，暂存的 ${this.pendingWrites.length} 条属于「${(other[0] || {}).doc || '—'}」—— 切回那张表再点`
        return
      }
      let ok = 0, fail = 0, miss = 0
      for (const w of same) {
        // ★ 10-28 硬保护：每写一格前都核一次「还在不在目标表」——
        //   自动补齐是定时器驱动的，写入过程中用户随时可能又切走；一旦切走立刻停，绝不多写一格。
        if (this.docKey() !== w.doc) break
        // ★ 0.9.41 同一把尺：暂存的 row 可能隔了几十分钟，行被删/插/排过就弃写
        //   （弃掉而不是留着——留着只会每 2.5 秒重试一次、每次都过不去）
        if (!this.verifyRowIdentity(sheet, w.row, w.number, w.numCol)) {
          miss++
          this.markMisalign(null, w.row, w.numCol, `暂存结果 ${w.number} 对不上号`)
          continue
        }
        const r = this.writeCell(sheet, w.row, w.outCol, w.text)
        if (r && r.ok) {
          ok++
          const it = this.items.find((x) => x.row === w.row)
          if (it) { it.text = w.text; it.state = w.state === 'pending' ? 'ok' : (w.state || 'ok') }
        } else fail++
      }
      this.pendingWrites = other
      this.actionErr = fail || miss
        ? `补齐：成功 ${ok} 条、补不进 ${fail} 条、错位跳过 ${miss} 条（表格行变了，点③重跑）`
        : ''
      this.log(`补齐回填${auto ? '（自动·已回到原表）' : ''}：成功 ${ok} / 失败 ${fail} / 错位跳过 ${miss}${other.length ? `，另有 ${other.length} 条在别的表` : ''}`)
    },

    // 统一写回：确定结论可以覆盖，暂态失败保留旧值
    writeResult(it, sheet, row, outCol, definitiveNow) {
      if (this.capErr) return
      // ★ 10-28（爹地报障）：切表时**不中止整轮**，把这一行攒进待补队列 —— 结果不丢，
      //   切回原表点「补齐回填」一次写回。只有整个工作簿真的没了才放弃。
      if (this.runDoc && this.docKey() !== this.runDoc) {
        const app0 = this.app()
        if (!app0 || !app0.ActiveWorkbook) {
          // 整个工作簿被关掉了 —— 这时候真的没地方写，如实停
          this.stopFlag = true
          this.actionErr = '目标工作簿已关闭，本轮停止（已完成的行已写回原表）'
          return
        }
        this.deferWrite(it, outCol)
        return
      }
      const oldVal = this.readOne(sheet, row, outCol)
      const oldStr = oldVal == null ? '' : String(oldVal).trim()
      // 「未识别 / 未接入 / 暂无动态」是确定结论，可以写；其余失败一律不覆盖旧值
      const definitive = definitiveNow || /未识别承运人|暂未接入|暂无动态/.test(it.text)
      const transient = it.state === 'error' && !definitive
      if (transient && oldStr) {
        // 上一轮刷过的颜色可能已经过期（比如当时误判成到港）→ 清掉，别误导
        this.clearOurColor(sheet, row)
        it.keptOld = true
        it.text = oldStr
        it.note = '本次' + this.shortReason(it.failReason) + '，保留旧值'
        this.log(`R${row} 保留旧值（本次 ${this.shortReason(it.failReason)}）`)
        return
      }
      const w = this.writeRowChecked(it, sheet, row, outCol, it.text)
      if (!w || !w.ok) {
        if (w && w.skipped) return          // 错位跳过：已经记过账、给过提示，不算写入失败
        this.writeErr = '写入失败：' + (w ? w.error : '未知')
        this.log(`写 ${colLetter(outCol)}${row} 失败: ${w ? w.error : '未知'}`)
      } else {
        this.writeVia = w.via
        this.writeErr = ''      // 写成功即清掉上一次的写入失败提示
        // 里程碑底色：只有判出里程碑（1/2/3）才动颜色
        // stage=0 表示「还没离起运港」——这时不刷色，避免把用户自己标的底色刷没了
        // 只有「认得出起讫港 + 判出里程碑」才刷色；否则清掉上一轮刷的色（不然旧色赖着不走，看着乱七八糟）
        if (it.state === 'ok' && it.stage > 0 && !it.inferred) {
          this.applyStageColor(sheet, row, outCol, it.stage)
        } else if (it.state === 'ok') {
          this.clearOurColor(sheet, row)
        }
      }
    },

    failLabel(it) {
      if (!it || (it.state !== 'error' && !/查无|无数据|未找到|未返回|没有数据/.test(String(it.text || '')))) return ''
      const { kind, label } = classifyFail(`${it.failReason || ''} ${it.text || ''}`)
      return kind === 'other' ? '' : label
    },

    stop() {
      this.stopFlag = true
      // 立刻中断在飞的请求（桥那边收到断开就会杀掉对应子进程），不用等 90s 超时
      try { for (const c of this.aborts) { try { c.abort() } catch (e) {} } this.aborts.clear() } catch (e) {}
      // 立刻把没跑完的行标出来，别等收尾逻辑（中断后收尾可能走不到）
      for (const it of this.items) {
        if (it.state === 'querying' || it.state === 'idle') { it.state = 'skip'; it.text = '（已停止）' }
      }
      this.busy = false
      this.log('已停止（在飞的请求已中断）')
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
          this.actionErr = '只读打开的文件解不了保护 —— 先另存/取得编辑权'
          return
        }
        sheet.Unprotect()
        this.capErr = this.checkWritable(sheet)
        this.log('Unprotect 调用完成，当前状态: ' + (this.capErr || '可写'))
        if (!this.capErr) this.actionErr = ''
      } catch (e) {
        this.actionErr = '解除保护失败：' + e.message + '（多半有密码，需要你知道密码）'
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
        // 未接入追踪的船司（目前只有 OOCL）：官网挂了 Cloudflare + CargoSmart 滑块，自动化不可靠
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
          return String(r.carrier || '').toLowerCase() === 'oocl'
            ? 'OOCL 暂未接入（官网需滑块验证，请手工查）'
            : '该船司暂未接入追踪'
        }
        if (/超时|timeout/i.test(raw)) return '查询超时（网络慢，稍后重试）'
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
</style>
