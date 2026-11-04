#!/bin/bash
# macOS 上用 HermesFileHelper 把暂存目录装进 WPS 加载项目录
# （桥是普通 node 进程，被 TCC 拦在 ~/Library/Containers/* 之外，自己写不进去）
#
#   用法: scripts/apply-update-mac.sh <srcBuildDir> <version> [AddonName]
#   AddonName 必须与 publish.xml 的 url 逐字一致 → 默认 ShipTrack4_（带下划线）
#
# 来历：11-05 从已归档的 WPSAddin/scripts/ 搬进插件仓库。bridge/update.mjs 的
#   applyUpdateInner() 第 4 步（macOS 替换）调 REPO_ROOT/scripts/apply-update-mac.sh，
#   而本仓一直没有这个文件 → 从 WPS 插件里点「安装/更新」会报「缺装机脚本」。
#
# helper 的 cp 语义（实测）：目标不存在 → 直接建成目标名；目标已存在 → 拷成 目标/源目录名
set -euo pipefail

SRC="${1:?缺 srcBuildDir}"
VER="${2:?缺 version}"
ADDON_NAME="${3:-ShipTrack4_}"
H="$HOME/Applications/HermesFileHelper.app"
J="$HOME/Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons"
STAGE="$HOME/Library/Application Support/hermes-wps-stage"
CACHE="$HOME/.hermes/wps-shiptrack"

[ -d "$SRC" ] || { echo "❌ 源目录不存在: $SRC"; exit 1; }
[ -f "$SRC/index.html" ] || { echo "❌ 源目录里没有 index.html"; exit 1; }
[ -d "$H" ] || { echo "❌ 缺 HermesFileHelper.app: $H（TCC 只放行它，桥自己写不进 Containers）"; exit 1; }

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

# 1) 暂存（附版本戳，桥/面板靠它显示当前版本）
rm -rf "$STAGE/pkg"
mkdir -p "$STAGE"
ditto "$SRC" "$STAGE/pkg"
printf '{"version":"%s","installedAt":"%s","from":"apply-update-mac"}\n' \
  "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/pkg/version.json"

# 2) 备份旧目录（失败不阻断）
rm -rf "$STAGE/bak"
helper cp "$J/$ADDON_NAME" "$STAGE/bak" >/dev/null 2>&1 || true

# 3) 清旧 → 拷新；失败必须回滚，否则加载项目录直接没了
helper rm "$J/$ADDON_NAME"
if ! helper cp "$STAGE/pkg" "$J/$ADDON_NAME"; then
  echo "❌ 拷贝失败，回滚到备份"
  if [ -d "$STAGE/bak" ]; then
    helper rm "$J/$ADDON_NAME" || true
    helper cp "$STAGE/bak" "$J/$ADDON_NAME" || true
  fi
  exit 1
fi

# 4) 复核：拉回来确认版本串真的在装机产物里
rm -rf "$STAGE/verify"
helper cp "$J/$ADDON_NAME" "$STAGE/verify"
grep -rq "$VER" "$STAGE/verify/assets" || { echo "❌ 装机产物里找不到版本串 $VER"; exit 1; }

# 5) 可读缓存：桥读不了 Containers/*，只认这个文件
mkdir -p "$CACHE"
printf '{"version":"%s","installedAt":"%s","dir":"%s"}\n' \
  "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$J/$ADDON_NAME" > "$CACHE/installed.json"

echo "✓ 已安装 $ADDON_NAME v$VER → $J/$ADDON_NAME"
