#!/usr/bin/env bash
# 发布插件资产到本仓库（wps-latest 滚动 tag + wps-v<版本> 历史 tag）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="theWeatherMan21/wps-shiptrack"
VER="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"
NOTES="${2:-}"
[ "${1:-}" = "--notes" ] || true

cd "$ROOT"
./scripts/pack-update.sh >/dev/null
SRC="$ROOT/dist-updates"
TMP="$(mktemp -d)"
NEWPKG="wps-shiptrack-$VER.tar.gz"
cp "$SRC/shiptrack-$VER.tar.gz" "$TMP/$NEWPKG"
python3 - "$SRC/version.json" "$TMP/wps-version.json" "$NEWPKG" <<'PY'
import json,sys,hashlib,os
src,out,name=sys.argv[1],sys.argv[2],sys.argv[3]
m=json.load(open(src))
p=os.path.join(os.path.dirname(out),name)
m['file']=name; m['sha256']=hashlib.sha256(open(p,'rb').read()).hexdigest()
m['size']=os.path.getsize(p)
json.dump(m,open(out,'w'),ensure_ascii=False,indent=2)
PY
for TAG in wps-latest "wps-v$VER"; do
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
    && gh release upload "$TAG" "$TMP/wps-version.json" "$TMP/$NEWPKG" --repo "$REPO" --clobber \
    || gh release create "$TAG" "$TMP/wps-version.json" "$TMP/$NEWPKG" --repo "$REPO" --title "$TAG" --notes "${NOTES:-wps addon $VER}"
done

# 滚动 tag（wps-latest）只留最新一版 + wps-version.json，历史版本包随 wps-v* 归档，不许再堆。
# 想先看会删什么：scripts/prune-latest.sh --dry-run
TAG=wps-latest REPO="$REPO" ./scripts/prune-latest.sh
echo "发布完成：$REPO · wps-latest / wps-v$VER · v$VER"
