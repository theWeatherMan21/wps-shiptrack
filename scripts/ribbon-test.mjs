// ribbon.js 单元测试（Node，无浏览器）：验证任务窗格 id 失效时能自愈重建
global.window = {
  location: { protocol: 'file:', href: 'file:///x/ShipTrack_/index.html' },
  Application: null
}

let created = 0
const panes = {}
function makePane(id) {
  const p = { ID: id, _vis: false }
  Object.defineProperty(p, 'Visible', { get() { return this._vis }, set(v) { this._vis = v } })
  panes[id] = p
  return p
}

const store = {}
let getTaskPaneShouldThrow = true
global.window.Application = {
  ribbonUI: {},
  Enum: {},
  PluginStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) }
  },
  GetTaskPane: (id) => {
    if (getTaskPaneShouldThrow) throw new Error('taskpane id 失效')
    return panes[id] || null   // 失效 id 也可能返回 null
  },
  CreateTaskPane: (url) => {
    created++
    window.__lastUrl = url
    return makePane('pane' + created)
  }
}

const mod = (await import('../src/components/ribbon.js')).default
const results = []
const check = (name, cond, detail) => { results.push([name, cond, detail]); console.log(`${cond ? '✅' : '❌'} ${name}  ${detail}`) }

mod.OnAddinLoad({})
check('OnAddinLoad 返回 true', mod.OnAddinLoad({}) === true, '')

// 1) 首次点击 → 新建窗格（此时 GetTaskPane 还没被调用）
mod.OnAction({ Id: 'btnOpenPanel' })
check('首次点击新建窗格', created === 1 && panes.pane1.Visible === true, `created=${created} visible=${panes.pane1.Visible}`)

// 2) 再次点击 → 复用并切换可见性（窗格正常）
getTaskPaneShouldThrow = false
mod.OnAction({ Id: 'btnOpenPanel' })
check('再次点击切换可见性', created === 1 && panes.pane1.Visible === false, `created=${created} visible=${panes.pane1.Visible}`)

// 3) 让 GetTaskPane 抛错（模拟升级后 id 失效）→ 应重建而不是静默失败
getTaskPaneShouldThrow = true
mod.OnAction({ Id: 'btnOpenPanel' })
check('id 失效时自愈重建', created === 2 && panes.pane2.Visible === true, `created=${created} visible=${panes.pane2 && panes.pane2.Visible}`)

// 4) GetTaskPane 返回 null（也有版本这么做）
getTaskPaneShouldThrow = false
store[Object.keys(store).find((k) => k.includes('taskpane'))] = 'ghost'
mod.OnAction({ Id: 'btnOpenPanel' })
check('GetTaskPane 返回 null 时也重建', created === 3, `created=${created}`)

const bad = results.filter((r) => !r[1])
console.log(`\n${results.length - bad.length}/${results.length} 通过`)
process.exit(bad.length ? 1 : 0)
