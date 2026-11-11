#!/bin/bash
# 装机 + 强校验：stage → 清旧目录 → 拷贝 → 逐字节比对 → 版本串核对
# 2026-10-23 教训：cp 会把旧哈希文件留在目录里，index.html 指的可能还是旧 chunk；
#               只看「文件数对不对」不够，必须核对当前版本串真的在装机产物里。
set -euo pipefail

ADDON_NAME="${ADDON_NAME:-ShipTrack4_}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)/wps-addon-build}"
VER="${2:-$(python3 -c "import json,sys;print(json.load(open('$(dirname "$0")/../package.json'))['version'])")}"
H="$HOME/Applications/HermesFileHelper.app"
J="$HOME/Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons"
STAGE="$HOME/Library/Application Support/hermes-wps-stage"

[ -d "$SRC" ] || { echo "❌ 构建产物不存在: $SRC"; exit 1; }
[ -f "$SRC/index.html" ] || { echo "❌ $SRC 里没有 index.html"; exit 1; }

helper() {
  rm -f "$HOME/.hermes/filehelper-result.json"
  open -a "$H" --args "$@"
  for _ in $(seq 1 40); do
    [ -f "$HOME/.hermes/filehelper-result.json" ] && break
    sleep 0.25
  done
  local r; r="$(cat "$HOME/.hermes/filehelper-result.json" 2>/dev/null || echo '{"ok":false,"msg":"no-result"}')"
  echo "$r" | grep -q '"ok":true' || { echo "❌ helper 失败: $r"; exit 1; }
}

echo "== 1) 暂存（FileHelper 只能从白名单目录取源）=="
rm -rf "$STAGE/$ADDON_NAME"
ditto "$SRC" "$STAGE/$ADDON_NAME"

echo "== 2) 清旧目录再拷（避免残留旧哈希 chunk）=="
helper rm "$J/$ADDON_NAME"
helper cp "$STAGE/$ADDON_NAME" "$J"

echo "== 3) 逐字节比对 =="
rm -rf "$STAGE/.verify-$ADDON_NAME"
helper cp "$J/$ADDON_NAME" "$STAGE/.verify-$ADDON_NAME"
diff -r "$STAGE/.verify-$ADDON_NAME" "$SRC" >/dev/null || { echo "❌ 装机内容与构建产物不一致"; exit 1; }

echo "== 4) 版本串核对 =="
IDX="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$STAGE/.verify-$ADDON_NAME/index.html" | head -1)"
[ -n "$IDX" ] || { echo "❌ index.html 里找不到入口 js"; exit 1; }
grep -rq "$VER" "$STAGE/.verify-$ADDON_NAME/assets" || { echo "❌ 装机产物里找不到版本串 $VER"; exit 1; }

echo "== 5) 旧文案残留检查（防僵尸构建）=="
STALE=$( (grep -l "选提单号列" "$STAGE/.verify-$ADDON_NAME"/assets/*.js 2>/dev/null || true) | wc -l | tr -d ' ')
[ "$STALE" = "0" ] || { echo "⚠️ 仍然存在旧文案 chunk（$STALE 个），检查构建是否干净"; }

mkdir -p "$HOME/.hermes/wps-shiptrack"
# ★ 11-11：装机要幂等 —— 产物一个字节没变就不该把「装机时间」往后推。
#   否则每次跑 install-verify 都会把 WPS 进程标成「旧插件」（狼来了），
#   真正换了内容那天反而没人信。
HASH_NOW=$(cd "$SRC" && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) -exec shasum -a 256 {} + 2>/dev/null | sort | shasum -a 256 | awk '{print $1}')
OLD_JSON="$HOME/.hermes/wps-shiptrack/installed.json"
OLD_HASH=$(python3 - "$OLD_JSON" <<'PYX' 2>/dev/null || true
import json,sys
print(json.load(open(sys.argv[1])).get("hash",""))
PYX
)
OLD_TS=$(python3 - "$OLD_JSON" <<'PYX' 2>/dev/null || true
import json,sys
print(json.load(open(sys.argv[1])).get("installedAt",""))
PYX
)
OLD_CHANGED=$(python3 - "$OLD_JSON" <<'PYX' 2>/dev/null || true
import json,sys
print(json.load(open(sys.argv[1])).get("changedAt",""))
PYX
)
NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "${OLD_HASH:-}" ] && [ "$OLD_HASH" = "$HASH_NOW" ] && [ -n "${OLD_CHANGED:-}" ]; then
  # 内容和上次一个字节都不差 → 「这版插件是什么时候装上的」这个时刻不该往后推
  CHANGED_TS="$OLD_CHANGED"
  echo "   产物哈希未变（${HASH_NOW}）→ 内容自 ${OLD_CHANGED} 起没变过，这次是幂等重装"
else
  CHANGED_TS="$NOW_TS"
fi
printf '{"version":"%s","installedAt":"%s","changedAt":"%s","hash":"%s","dir":"%s"}\n' \
  "$VER" "$NOW_TS" "$CHANGED_TS" "$HASH_NOW" "$J/$ADDON_NAME" > "$OLD_JSON"

echo "✅ 装机完成并校验通过：$ADDON_NAME · v${VER} · 入口 ${IDX}"

echo "== 6) 宿主机进程检查（第四种「装了没生效」：进程比装机还老）=="
# 判据必须是「进程启动时刻 vs 装机时刻」，不能只看「WPS 在不在跑」——
# 装了新版之后又打开过 WPS 的，进程是新的，这时候再喊「重启」就是误报。
WPID=$(pgrep -x wpsoffice 2>/dev/null | head -1)
INSTALL_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" +%s 2>/dev/null || date +%s)
# installed.json 里记的是本次装机的 UTC 时刻，换算成 epoch 来比
IJ_TS=$(python3 - "$HOME/.hermes/wps-shiptrack/installed.json" <<'PYEOF' 2>/dev/null || true
import json,sys,calendar,time
j=json.load(open(sys.argv[1]))
print(calendar.timegm(time.strptime(j["installedAt"], "%Y-%m-%dT%H:%M:%SZ")))
PYEOF
)
[ -n "${IJ_TS:-}" ] && INSTALL_EPOCH="$IJ_TS"
if [ -n "$WPID" ]; then
  WSTART=$(ps -o lstart= -p "$WPID" 2>/dev/null | sed 's/^ *//')
  WSTART_EPOCH=$(date -j -f "%a %b %d %T %Y" "$WSTART" +%s 2>/dev/null || echo 0)
  # ★ 判据用 changedAt（内容最后变化的时刻）：幂等重装不该把 WPS 标成「旧插件」（狼来了）
  CHANGED_EPOCH=$(python3 - "$OLD_JSON" <<'PYX' 2>/dev/null || true
import json,sys,calendar,time
j=json.load(open(sys.argv[1]))
print(calendar.timegm(time.strptime(j.get("changedAt") or j.get("installedAt"), "%Y-%m-%dT%H:%M:%SZ")))
PYX
)
  if [ -n "${CHANGED_EPOCH:-}" ]; then CHECK_EPOCH="$CHANGED_EPOCH"; else CHECK_EPOCH="$INSTALL_EPOCH"; fi
  if [ "$WSTART_EPOCH" -gt 0 ] && [ "$WSTART_EPOCH" -lt "$CHECK_EPOCH" ]; then
    printf '\033[1;31m⚠️  WPS 正在运行（PID %s，启动于 %s），比本次装机（%s）早 —— 加载的是旧插件\033[0m\n' \
      "$WPID" "$WSTART" "$(date -r "$CHECK_EPOCH" '+%F %T')"
    printf '\033[1;31m   关窗口无效，必须完全退出（Cmd+Q / 菜单「退出」）再打开。判据：面板右下角应显示 v%s。\033[0m\n' "$VER"
  else
    echo "   WPS 正在运行（PID ${WPID}，启动于 ${WSTART}）—— 比本次装机晚，用的就是新插件。"
  fi
else
  echo "   WPS 没在运行 —— 下次打开会用新插件，无需重启。"
fi

# ---- 桥进程：第五种「装了没生效」—— 插件是新的、桥跑的是旧规则（2026-11-11 知澜实测踩到）----
# 桥是常驻 Node 进程，代码在磁盘上改了它不会自己重载；面板版本号显示 hotfix10（对），
# 真正干活的 /detect-columns 还是老逻辑 —— 比 WPS 那个更隐蔽。
BPID=$(lsof -nP -iTCP:"${WPS_TRACK_PORT:-8791}" -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -n "$BPID" ]; then
  BSTART=$(ps -o lstart= -p "$BPID" 2>/dev/null | sed 's/^ *//')
  BEPOCH=$(date -j -f "%a %b %d %T %Y" "$BSTART" +%s 2>/dev/null || echo 0)
  # 「代码的新鲜度」= bridge/ 下最新一个 .mjs 的 mtime（含本次改的 detect-columns.mjs）
  NEWEST=$(find "$REPO_ROOT/bridge" -name '*.mjs' -exec stat -f '%m %N' {} + 2>/dev/null | sort -rn | head -1)
  NEPOCH=${NEWEST%% *}
  NPATH=${NEWEST#* }
  if [ "$BEPOCH" -gt 0 ] && [ -n "${NEPOCH:-}" ] && [ "$NEPOCH" -gt "$BEPOCH" ]; then
    printf '\033[1;31m⚠️  桥进程比 bridge/ 里的代码旧（PID %s 启动于 %s，而 %s 改于 %s）\033[0m\n' \
      "$BPID" "$BSTART" "$(basename "$NPATH")" "$(date -r "$NEPOCH" '+%F %T')"
    printf '\033[1;31m   桥不重载代码 → /detect-columns 还是旧规则。重启：scripts/bridge.sh restart\033[0m\n'
  else
    echo "   桥在跑（PID ${BPID}，启动于 ${BSTART}）—— 比 bridge/ 里最新的代码新，规则是当次的。"
  fi
else
  echo "   桥没在跑 —— 面板会提示「桥未连接」，先 scripts/bridge.sh start。"
fi

echo "== 8) 桥端点实证（判据用端点不用时间戳：时间戳证明重启过，证明不了跑的是哪版代码）=="
if ! curl -s --max-time 3 http://127.0.0.1:8791/health >/dev/null 2>&1; then
  echo "   桥没在跑（8791 不通）→ launchctl kickstart -k gui/$(id -u)/com.wanyi.wps-shiptrack-bridge"
else
  DC=$(curl -s --max-time 5 -X POST http://127.0.0.1:8791/detect-columns \
        -H 'Content-Type: application/json' \
        -d '{"rows":[["提单号",""],["TSTU0000001",""]]}' 2>/dev/null)
  if echo "$DC" | grep -q '"numberCol"'; then
    echo "   ✅ 桥已是新版（/detect-columns 返回了 numberCol）"
  else
    echo "   ⚠️  桥上跑的是旧代码 —— /detect-columns 不可用：$(echo "$DC" | head -c 80)"
    echo "      → launchctl kickstart -k gui/$(id -u)/com.wanyi.wps-shiptrack-bridge"
  fi
fi
