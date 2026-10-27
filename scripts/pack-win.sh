#!/bin/bash
# 打 Windows 安装包：加载项产物 + PowerShell 脚本（装/启桥/体检）+ 桥本体 + 说明书
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADDON="$ROOT"
OUT="$ROOT/dist-win"
KIT="$OUT/shiptrack-win-kit"

echo "== 1/4 构建加载项（es2017 目标）=="
cd "$ADDON"
node scripts/build.cjs online >/dev/null
test -f wps-addon-build/index.html
VER=$(python3 -c "import json;print(json.load(open('$ADDON/package.json'))['version'])")

echo "== 2/4 组装 kit =="
rm -rf "$KIT"; mkdir -p "$KIT"
cp -R "$ADDON/wps-addon-build" "$KIT/ShipTrack"
printf '{"version":"%s","installedAt":"%s","from":"pack-win"}\n' "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$KIT/ShipTrack/version.json"
cp "$ROOT/packaging/win/"*.ps1 "$KIT/"
cp "$ROOT/bridge/server.mjs" "$KIT/"
cp "$ROOT/bridge/start-win.ps1" "$KIT/"

cat > "$KIT/README.txt" <<EOF
ShipTrack for WPS Spreadsheet — Windows (v$VER)
================================================

WHAT'S IN THIS FOLDER
  ShipTrack\\         the add-in itself
  install-win.ps1    install / uninstall the add-in (no admin needed)
  start-win.ps1      start / stop / status the local bridge (hidden window)
  env-test.ps1       environment check (WPS version, jsaddons dir, Node, port)
  server.mjs         the local bridge (HTTP -> ShipScheduleHub tracking engine)

QUICK START
  1. env-test.ps1            see what's missing
  2. install-win.ps1         installs add-in, asks for ShipScheduleHub path, starts bridge
     or: install-win.ps1 -NoBridge
  3. FULLY quit WPS (tray icon too), then start WPS Spreadsheet
  4. Ribbon "ShipTrack" tab -> "Open panel"

BRIDGE (needs Node.js LTS on PATH)
  start : powershell -ExecutionPolicy Bypass -File start-win.ps1 -RepoPath <ShipScheduleHub>
  status: powershell -ExecutionPolicy Bypass -File start-win.ps1 -Status
  stop  : powershell -ExecutionPolicy Bypass -File start-win.ps1 -Stop

  The bridge runs the tracking engine from <ShipScheduleHub>\\engine\\tracking\\cli.mjs
  and needs a Chromium browser (Chrome, or the Edge that ships with Windows 10/11).

COLUMN MEMORY
  %USERPROFILE%\\.hermes\\wps-shiptrack\\<workbook|sheet>.json
  survives WPS restarts and reboots.

TROUBLESHOOTING
  "bridge not connected"  -> start-win.ps1; check port 8791 is free
  panel shows old version -> fully quit WPS (panel header shows the version)
  add-in missing          -> env-test.ps1; check %APPDATA%\\kingsoft\\wps\\jsaddons\\publish.xml

UNINSTALL
  powershell -ExecutionPolicy Bypass -File install-win.ps1 -Uninstall
EOF

echo "== 3/4 打包 =="
cd "$OUT"
rm -f shiptrack-win-kit.zip
(cd "$KIT" && zip -qr ../shiptrack-win-kit.zip .)
ls -lh shiptrack-win-kit.zip | awk '{print "  zip:", $5, $9}'
echo "  文件数: $(find "$KIT" -type f | wc -l | tr -d ' ')  版本: $VER"
