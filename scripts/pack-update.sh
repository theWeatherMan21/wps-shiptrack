#!/bin/bash
# 打一个「在线更新包」并（可选）起本地更新源
#   用法: scripts/pack-update.sh [--serve]
# 产物: dist-updates/version.json + dist-updates/shiptrack-<ver>.tar.gz
# 桥通过 GET /update/check、POST /update/apply 消费（见 bridge/update.mjs）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDON="$ROOT"
OUT="$ROOT/dist-updates"
STAGE="$OUT/pkg/ShipTrack_"

VER="$(node -p "require('$ADDON/package.json').version")"
echo "== 打包 v$VER =="

# 1) 构建（online 模式产物就是加载项目录内容）
( cd "$ADDON" && node scripts/build.cjs online >/dev/null 2>&1 )
[ -d "$ADDON/wps-addon-build" ] || { echo "✗ 构建产物不存在"; exit 1; }

# 2) 组装
rm -rf "$OUT/pkg"
mkdir -p "$STAGE"
cp -R "$ADDON/wps-addon-build/." "$STAGE/"
printf '{"version":"%s","installedAt":"%s","from":"pack-update"}\n' "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/version.json"

# 3) 校验：入口引用的 assets 必须都在（防止打出一个跑不起来的包）
for f in $(grep -oE 'assets/[A-Za-z0-9_.-]+' "$STAGE/index.html"); do
  [ -f "$STAGE/$f" ] || { echo "✗ 缺文件 $f"; exit 1; }
done
FILES=$(find "$STAGE" -type f | wc -l | tr -d ' ')

# 4) 打 tar.gz + 计算 sha256
PKG="shiptrack-$VER.tar.gz"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT/$PKG" -C "$OUT/pkg" ShipTrack_
SHA=$(shasum -a 256 "$OUT/$PKG" | awk '{print $1}')
SIZE=$(stat -f%z "$OUT/$PKG" 2>/dev/null || stat -c%s "$OUT/$PKG")

# 5) manifest
cat > "$OUT/version.json" <<JSON
{
  "version": "$VER",
  "file": "$PKG",
  "sha256": "$SHA",
  "size": $SIZE,
  "files": $FILES,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
rm -rf "$OUT/pkg"

echo "✓ dist-updates/version.json"
echo "  version : $VER"
echo "  package : $PKG ($SIZE B, $FILES files)"
echo "  sha256  : $SHA"

if [ "${1:-}" = "--serve" ]; then
  PORT="${WPS_UPDATE_PORT:-8792}"
  echo ""
  echo "更新源: http://127.0.0.1:$PORT  （Ctrl-C 停）"
  echo "在 ~/.hermes/.env 写: WPS_UPDATE_URL=http://127.0.0.1:$PORT"
  ( cd "$OUT" && python3 -m http.server "$PORT" --bind 127.0.0.1 )
fi
