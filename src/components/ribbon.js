import Util from './js/util.js'

const PANE_KEY = 'shiptrack_taskpane_id_v3'

// 这个函数在整个 wps 加载项中是第一个执行的
function OnAddinLoad(ribbonUI) {
  if (typeof window.Application.ribbonUI != 'object') {
    window.Application.ribbonUI = ribbonUI
  }
  if (typeof window.Application.Enum != 'object') {
    window.Application.Enum = Util.WPS_Enum
  }
  return true
}

function paneUrl() {
  return Util.GetUrlPath() + Util.GetRouterHash() + '/taskpane'
}

// 旧 id 可能指向已销毁的窗格（加载项升级/换目录后常见）——必须能自愈重建，
// 否则用户点「打开追踪面板」毫无反应。
function showTaskPane() {
  const app = window.Application
  const saved = app.PluginStorage.getItem(PANE_KEY)
  if (saved) {
    try {
      const pane = app.GetTaskPane(saved)
      if (pane) {
        pane.Visible = !pane.Visible
        return
      }
    } catch (e) {
      // 失效：往下走，重建
    }
    try {
      app.PluginStorage.setItem(PANE_KEY, '')
    } catch (e) {}
  }
  const pane = app.CreateTaskPane(paneUrl())
  app.PluginStorage.setItem(PANE_KEY, pane.ID)
  pane.Visible = true
}

function OnAction(control) {
  const eleId = control.Id
  switch (eleId) {
    case 'btnOpenPanel': {
      try {
        showTaskPane()
      } catch (e) {
        // 连 GetTaskPane 都没有的极老版本：直接新建
        try {
          const pane = window.Application.CreateTaskPane(paneUrl())
          pane.Visible = true
        } catch (e2) {}
      }
      break
    }
    default:
      break
  }
  return true
}

function GetImage(control) {
  return 'images/3.svg'
}

function OnGetVisible(control) {
  return true
}

export default {
  OnAddinLoad,
  OnAction,
  GetImage,
  OnGetVisible
}
