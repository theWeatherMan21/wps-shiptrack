#!/bin/bash
# 把船期追踪桥装成 macOS LaunchAgent（登录即起 + 挂了自动重拉）
#
#   scripts/install-launchagent.sh            安装/更新（幂等，重跑即覆盖）
#   scripts/install-launchagent.sh --status   看 launchd 是否 loaded + 桥是否在听
#   scripts/install-launchagent.sh --uninstall 卸掉（不动仓库）
#
# 为什么需要它：桥原来只能人手 `scripts/bridge.sh start`。重启、合盖休眠被杀、崩溃退出之后
# 面板就永远「桥没连上」，用户分不清是没进程还是被拦（2026-10-29 现场）。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.wanyi.wps-shiptrack-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/wps-shiptrack-bridge.log"
LOGDIR="$(dirname "$LOG")"
WRAP="$ROOT/scripts/bridge-launchd.sh"
DOMAIN="gui/$(id -u)"
PORT="${WPS_TRACK_PORT:-8791}"

status() {
  echo "== launchd =="
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|program|runs|last exit code)" || true
  else
    echo "未安装 / 未 loaded"
  fi
  echo "== 桥 =="
  curl -sS -m 2 "http://127.0.0.1:$PORT/health" || echo "（$PORT 无响应）"
  echo
  echo "== 日志（尾 5 行）: $LOG =="
  tail -5 "$LOG" 2>/dev/null || echo "（还没有日志）"
}

case "${1:-install}" in
  --status|status) status; exit 0 ;;
  --uninstall|uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已卸载 ${LABEL}（仓库和日志没动）"
    exit 0 ;;
  install|"") ;;
  *) echo "用法: $0 [install|--status|--uninstall]"; exit 2 ;;
esac

[ -x "$WRAP" ] || chmod +x "$WRAP" 2>/dev/null || true
[ -f "$ROOT/bridge/server.mjs" ] || { echo "❌ 找不到 $ROOT/bridge/server.mjs"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

# KeepAlive 用 { SuccessfulExit = false } 而不是 true：
#   true     = 不管怎么退出都重拉 → 端口已被本桥占着时（另一个实例在跑，本进程正常退出）
#              会变成 launchd 反复拉起又退出，日志刷屏
#   false    = 崩溃 / 被 kill / 非 0 退出才重拉，正常退出（exit 0）不折腾
# 合盖休眠被杀、SIGKILL、OOM 都属于「非正常退出」，都在守护范围内。
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <!--
    为什么不是直接跑 /bin/bash <wrapper>：
    仓库在 ~/Documents 下，macOS 的 TCC 会拦「launchd 直接拉起的进程」读 Documents
    （实测 exit 126 / Operation not permitted），桥根本起不来。
    走 /usr/bin/osascript + do shell script 后，责任进程变成 osascript，
    跟 Hermes 网关同一条 TCC 授权链，读仓库正常（2026-10-29 实测）。
  -->
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/osascript</string>
    <string>-e</string>
    <string>with timeout of 86400 seconds
do shell script (quoted form of "$WRAP")
end timeout</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>StandardOutPath</key>
  <string>$LOGDIR/wps-shiptrack-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGDIR/wps-shiptrack-launchd.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>WPS_TRACK_PORT</key>
    <string>$PORT</string>
  </dict>
</dict>
</plist>
PLISTEOF

plutil -lint "$PLIST" >/dev/null || { echo "❌ plist 语法错: $PLIST"; exit 1; }

# 先卸掉旧的（重装才生效；bootout 失败说明本来就没装）
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST" || { echo "❌ bootstrap 失败"; exit 1; }
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
# RunAtLoad 会自己拉起；再 kickstart 一次保证现在就在跑
launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true

for i in $(seq 1 20); do
  if curl -sS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo "== 安装完成，核验 =="
launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|runs|last exit code)" || true
if curl -sS -m 2 "http://127.0.0.1:$PORT/health"; then
  echo
  echo "✅ $LABEL 已 loaded，桥在 $PORT 上应答；日志：$LOG"
else
  echo "❌ launchd 已装但桥没应答，看日志：$LOG"
  tail -20 "$LOG" 2>/dev/null
  exit 1
fi
