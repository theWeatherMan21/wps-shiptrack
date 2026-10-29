#!/bin/bash
# LaunchAgent 入口：前台 exec 桥进程（launchd 靠「进程还活着吗」判断，所以不能 nohup、不能自己退到后台）
# 与 bridge.sh start 的分工：
#   bridge.sh start   = 人手工起一次（后台 nohup，跑完就退出）
#   bridge-launchd.sh = 常驻守护（launchd 拉起，进程死了由 launchd 重拉）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "[bridge-launchd] 进不去仓库目录: $ROOT" >&2; exit 78; }

# 更新源等配置放 ~/.hermes/.env（不写进仓库）
if [ -f "$HOME/.hermes/.env" ]; then set -a; . "$HOME/.hermes/.env"; set +a; fi

# launchd 给的环境只有 /usr/bin:/bin:/usr/sbin:/sbin，node 必须自己找
NODE="${WPS_TRACK_NODE:-}"
if [ -z "$NODE" ]; then
  for c in "$HOME/.hermes/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
[ -n "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "[bridge-launchd] $(date '+%F %T') 找不到 node（试过 ~/.hermes/node / homebrew / /usr/local）" >&2
  exit 78
fi

# 日志自增上限：launchd 不管轮转，超过 5MB 就在启动时挪走一份
LOG="${WPS_TRACK_LOG:-$HOME/Library/Logs/wps-shiptrack-bridge.log}"
mkdir -p "$(dirname "$LOG")"
if [ -f "$LOG" ]; then
  SZ=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
  [ "$SZ" -gt 5242880 ] && mv -f "$LOG" "$LOG.1"
fi
# 自己写日志：launchd 这边是 osascript 代跑，它会把自己捕获的输出当 AppleScript 文本转义/换编码，
# 中文直接成乱码、行尾变成 \r。所以日志由本进程直接落盘，plist 的 Standard*Path 只收 launchd 层噪音。
exec >> "$LOG" 2>&1

export WPS_TRACK_PORT="${WPS_TRACK_PORT:-8791}"

# 父进程看门狗：launchd 这边是 osascript 代跑（见 install-launchagent.sh 里为什么），
# 万一 osascript 被单独杀掉而 node 还活着，就会留一个「没人管」的桥占着 8791，
# 重启的实例只会正常退出（端口已被本桥占）→ 守护进程以为没事。这里让桥跟着父进程一起走。
SELF=$$
ORIG_PPID="$(ps -o ppid= -p "$SELF" 2>/dev/null | tr -d ' ')"
if [ -n "$ORIG_PPID" ]; then
  (
    while sleep 5; do
      PP="$(ps -o ppid= -p "$SELF" 2>/dev/null | tr -d ' ')"
      if [ -z "$PP" ]; then exit 0; fi   # 桥自己已经不在了（正常退出/被 kill）→ 看门狗静默收工
      if [ "$PP" != "$ORIG_PPID" ]; then
        echo "[bridge-launchd] $(date '+%F %T') 父进程 $ORIG_PPID 不在了 → 桥一起退出（不留孤儿占端口）"
        kill -TERM "$SELF" 2>/dev/null
        exit 0
      fi
    done
  ) &
fi

echo "[bridge-launchd] $(date '+%F %T') 启动 node=$NODE port=$WPS_TRACK_PORT repo=$ROOT" >&2
exec "$NODE" "$ROOT/bridge/server.mjs"
