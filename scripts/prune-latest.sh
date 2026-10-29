#!/usr/bin/env bash
# 清掉滚动 release（默认 wps-latest）里不属于当前版本的旧资产。
# 保留：当前版本包 wps-shiptrack-<version>.tar.gz + wps-version.json（+ 远端 wps-version.json 里指的那个包）
# 用法：
#   scripts/prune-latest.sh --dry-run   只列出「将会删哪些」，不动远端
#   scripts/prune-latest.sh             真删，删完复核资产数
# 环境变量：TAG（默认 wps-latest）、REPO（默认本仓库）、GITHUB_TOKEN（默认取 gh auth token）
# 安全闸：本地版本包还没上传到该 release、或 release 里没有 wps-version.json 时，一律不删（exit 3）。
#         防止「本地 package.json 先跳版 → 脚本把线上唯一能用的包当好版本删掉」这种事。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${REPO:-theWeatherMan21/wps-shiptrack}"
TAG="${TAG:-wps-latest}"
VER="${VER:-$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")}"
KEEP_PKG="wps-shiptrack-$VER.tar.gz"
KEEP_JSON="wps-version.json"
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done
export GH_TOKEN="${GITHUB_TOKEN:-$(gh auth token)}"

python3 - "$REPO" "$TAG" "$KEEP_PKG" "$KEEP_JSON" "$DRY" <<'PY'
import json, os, sys, urllib.request, urllib.error
repo, tag, keep_pkg, keep_json, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] == '1'
token = os.environ['GH_TOKEN']
API = 'https://api.github.com'

def req(method, path, body=None, accept='application/vnd.github+json'):
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'wps-shiptrack-prune',
    })
    with urllib.request.urlopen(r) as resp:
        raw = resp.read()
        if accept.endswith('json'):
            return (json.loads(raw) if raw else None), resp.status
        return raw, resp.status

rel, _ = req('GET', f'/repos/{repo}/releases/tags/{tag}')
assets = rel.get('assets', [])
by_name = {a['name']: a for a in assets}

# 安全闸 1：目标版本包必须在 release 里，否则本地版本跑在线上前面（还没发布），一个都不删
if keep_pkg not in by_name:
    print(f'[中止] {tag} 里没有 {keep_pkg} —— 本地版本（{keep_pkg}）可能还没上传，'
          f'现在清理会把线上唯一能用的包删掉。先跑 scripts/publish.sh 再清。')
    sys.exit(3)

# 安全闸 2：必须有 wps-version.json，且它指向的包也得留着（线上更新入口不能断）
keep = {keep_pkg, keep_json}
if keep_json in by_name:
    raw, _ = req('GET', f'/repos/{repo}/releases/assets/{by_name[keep_json]["id"]}',
                 accept='application/octet-stream')
    try:
        pointed = json.loads(raw).get('file')
    except Exception:
        pointed = None
    if pointed:
        keep.add(pointed)
        if pointed != keep_pkg:
            print(f'[注意] 线上 {keep_json} 仍指向 {pointed}，一并保留（旧版本先别删）。')
else:
    print(f'[中止] {tag} 里没有 {keep_json}，更新入口不完整，不清理。')
    sys.exit(3)

stale = [a for a in assets if a['name'] not in keep]
print(f'[{tag}] 当前资产 {len(assets)} 个，保留 {" + ".join(sorted(keep))}，待删 {len(stale)} 个')
for a in sorted(stale, key=lambda x: x['name']):
    print(f'  - {a["name"]}  {a["size"]}B  {a["created_at"]}')
if not stale:
    print('没有需要清理的资产。')
    sys.exit(0)
if dry:
    print('[dry-run] 未删除任何资产。')
    sys.exit(0)
failed = []
for a in stale:
    try:
        req('DELETE', f'/repos/{repo}/releases/assets/{a["id"]}')
        print(f'  删除 {a["name"]} … ok')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f'  删除 {a["name"]} … 已不存在')
        else:
            failed.append((a['name'], e.code, e.read().decode()[:200]))
            print(f'  删除 {a["name"]} … 失败 {e.code}')
after, _ = req('GET', f'/repos/{repo}/releases/tags/{tag}')
names = sorted(x['name'] for x in after.get('assets', []))
print(f'复核：[{tag}] 现有 {len(names)} 个资产 -> {names}')
missing = sorted(keep - set(names))
if missing:
    print(f'[告警] 保留项缺失：{missing}')
if failed:
    print('失败清单：', failed)
sys.exit(0 if (not failed and not missing) else 1)
PY
