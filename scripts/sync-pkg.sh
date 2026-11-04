#!/usr/bin/env bash
# 把「已发布的那一版」同步进本地离线兜底目录（~/.hermes/wps-shiptrack/pkg）。
# 为什么必须有：引擎 engine/wps-addon.mjs 的网络全挂兜底是按 man.file 的文件名
# 去 pkg 目录找包；只发 Release 不同步 pkg，就会「清单取得到、包下载被断 → 安装失败」。
#
# 用法：
#   scripts/sync-pkg.sh                 从 dist-updates/version.json 同步（先跑 pack-update.sh）
#   scripts/sync-pkg.sh --from DIR      从已算好 sha256 的发布产物目录同步（publish.sh 用这个）
#   scripts/sync-pkg.sh --dry-run       只打印会做什么
# 环境变量：WPS_PKG_DIR（默认 ~/.hermes/wps-shiptrack/pkg）、KEEP（保留几个历史包，默认 2）
#
# 落盘约定（和引擎兜底严格对齐）：
#   $WPS_PKG_DIR/wps-shiptrack-<ver>.tar.gz   文件名必须等于 wps-version.json 里的 file
#   $WPS_PKG_DIR/wps-version.json             version/file/sha256/size 四者自洽
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="${WPS_PKG_DIR:-$HOME/.hermes/wps-shiptrack/pkg}"
KEEP="${KEEP:-2}"
DRY=0
FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [ -n "$FROM" ]; then
  SRC="$FROM"
  MAN="$SRC/wps-version.json"
else
  SRC="$ROOT/dist-updates"
  MAN="$SRC/version.json"
fi
[ -f "$MAN" ] || { echo "✗ 找不到清单 $MAN（先跑 scripts/pack-update.sh）" >&2; exit 1; }

# 源包名 / 落盘名：本地兜底统一加 wps- 前缀（与历史 pkg 目录、Release 资产同名）
eval "$(python3 - "$MAN" <<'PY'
import json, sys, shlex
m = json.load(open(sys.argv[1]))
name = m.get('file') or ''
if not name:
    print('echo "✗ 清单缺 file 字段" >&2; exit 1')
else:
    local = name if name.startswith('wps-') else 'wps-' + name
    print(f'SRC_PKG={shlex.quote(name)}')
    print(f'LOCAL_PKG={shlex.quote(local)}')
PY
)"

SRC_PATH="$SRC/$SRC_PKG"
[ -f "$SRC_PATH" ] || { echo "✗ 找不到包 $SRC_PATH" >&2; exit 1; }

if [ "$DRY" = "1" ]; then
  echo "· 将同步 $SRC_PATH → $PKG_DIR/$LOCAL_PKG"
  echo "· 将同步 $MAN → $PKG_DIR/wps-version.json"
  echo "· pkg 目录保留最新 $KEEP 个历史包"
  exit 0
fi

mkdir -p "$PKG_DIR"
# 原子落地：先 .tmp 再 mv，避免安装侧读到半个文件
cp "$SRC_PATH" "$PKG_DIR/.$LOCAL_PKG.tmp"
mv -f "$PKG_DIR/.$LOCAL_PKG.tmp" "$PKG_DIR/$LOCAL_PKG"

# 清单里 file 必须指向本地落盘名，sha256/size 重算自落盘文件（不信任来源）
python3 - "$MAN" "$PKG_DIR/wps-version.json" "$LOCAL_PKG" "$PKG_DIR/$LOCAL_PKG" <<'PY'
import json, sys, hashlib, os
src, out, name, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
m = json.load(open(src))
m['file'] = name
m['sha256'] = hashlib.sha256(open(path, 'rb').read()).hexdigest()
m['size'] = os.path.getsize(path)
tmp = out + '.tmp'
json.dump(m, open(tmp, 'w'), ensure_ascii=False, indent=2)
os.replace(tmp, out)
print(f"  version : {m.get('version')}")
print(f"  package : {name} ({m['size']} B)")
print(f"  sha256  : {m['sha256']}")
PY

# 回读自检：文件名 / sha256 / size 三者对得上才算同步成功
python3 - "$PKG_DIR" <<'PY'
import json, sys, hashlib, os
d = sys.argv[1]
m = json.load(open(os.path.join(d, 'wps-version.json')))
p = os.path.join(d, m['file'])
assert os.path.exists(p), '清单指向的包不存在：' + m['file']
h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
assert h == m['sha256'], 'sha256 不自洽'
assert os.path.getsize(p) == m['size'], 'size 不自洽'
print('✓ 兜底包自检通过')
PY

# 历史包只留最新 KEEP 个（兜底只按清单文件名找，旧包仅留作手工回滚）
python3 - "$PKG_DIR" "$KEEP" "$LOCAL_PKG" <<'PY'
import os, sys, glob
d, keep, cur = sys.argv[1], int(sys.argv[2]), sys.argv[3]
files = [f for f in glob.glob(os.path.join(d, 'wps-shiptrack-*.tar.gz')) if os.path.basename(f) != cur]
files.sort(key=lambda f: os.path.getmtime(f), reverse=True)
for f in files[keep - 1:]:
    os.remove(f)
    print('  - 清掉旧包', os.path.basename(f))
PY

echo "✓ pkg 同步完成：$PKG_DIR"
