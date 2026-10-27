#!/bin/bash
# 启动 / 停止 / 体检 船期追踪本地桥（WPS 加载项 ⇄ ShipScheduleHub 追踪引擎）
# 用法: scripts/bridge.sh start|stop|status|restart
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WPS_TRACK_PORT:-8791}"
LOG="/tmp/wps-shiptrack-bridge.log"
PIDFILE="/tmp/wps-shiptrack-bridge.pid"

alive() { curl -sS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }

case "${1:-start}" in
  start)
    if alive; then echo "已在跑: http://127.0.0.1:$PORT"; exit 0; fi
    cd "$ROOT"
    # 更新源等配置放 ~/.hermes/.env（不写进仓库）
    if [ -f "$HOME/.hermes/.env" ]; then set -a; . "$HOME/.hermes/.env"; set +a; fi
    WPS_TRACK_PORT="$PORT" nohup node bridge/server.mjs >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1.5
    if alive; then echo "✓ 已启动 pid=$(cat "$PIDFILE") · http://127.0.0.1:$PORT · 日志 $LOG";
    else echo "✗ 起不来，看日志：$LOG"; tail -20 "$LOG"; exit 1; fi
    ;;
  stop)
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
    pkill -f "bridge/server.mjs" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "✓ 已停止"
    ;;
  status)
    if alive; then echo "✓ 在跑 · $(curl -sS -m 2 "http://127.0.0.1:${PORT}/health")"; else echo "✗ 没在跑（${PORT}）"; fi
    ;;
  restart)
    "$0" stop; sleep 1; "$0" start ;;
  *) echo "用法: $0 start|stop|status|restart"; exit 2 ;;
esac
