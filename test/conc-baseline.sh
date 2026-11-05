#!/bin/bash
# 并发追踪基准（2026-11-05 P0：Chrome 档案争用的守门脚本）
#
# 判据（知澜口径）：同一批真号并发跑 → 成功 ≥5/6，且日志里不许出现
#   "Target page, context or browser has been closed"
#
# 用法（真号通过环境变量传，脚本本身不含业务数据）：
#   MAERSK_NUMBERS="111111111,222222222,333333333,444444444,555555555" bash test/conc-baseline.sh
#   MAERSK_CONCURRENCY=6 bash test/conc-baseline.sh          # 默认 6
#   MAERSK_DECOY=TESTBL001 bash test/conc-baseline.sh        # 可选：第 6 个干扰号（期望失败）
#
# 自己起桥（8792）、自己杀；独立 profile 根 + 独立台账目录，不碰爹地正在用的桥（8791）。
set -u
NUMBERS="${MAERSK_NUMBERS:-}"
CONC="${MAERSK_CONCURRENCY:-6}"
DECOY="${MAERSK_DECOY:-}"
[ -n "$NUMBERS" ] || { echo "用法：MAERSK_NUMBERS=\"号1,号2,...\" bash test/conc-baseline.sh"; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCR="$(mktemp -d "${TMPDIR:-/tmp}/conc-baseline-XXXXXX")"
PORT="${MAERSK_BENCH_PORT:-8792}"
cd "$ROOT" || exit 1

env WPS_TRACK_PORT="$PORT" \
    WPS_TRACK_PROFILE_ROOT="$SCR/chrome" \
    WPS_TRACK_LEDGER_DIR="$SCR/state" \
    WPS_TRACK_JOBS_DIR="$SCR/state/jobs-queue" \
    WPS_TRACK_CONFIG_DIR="$SCR/state" \
    WPS_TRACK_CONCURRENCY="$CONC" \
    SSH_TRACK_CACHE_TTL_MS=0 \
    node bridge/server.mjs > "$SCR/bridge.log" 2>&1 &
BPID=$!
trap 'kill $BPID 2>/dev/null; wait $BPID 2>/dev/null; rm -rf "$SCR"' EXIT

for i in $(seq 1 80); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null || { echo "✗ 桥没起来（端口 $PORT 被占？）"; exit 3; }

LIST="$NUMBERS"
[ -n "$DECOY" ] && LIST="$NUMBERS,$DECOY"

echo "并发 $CONC · 号数 $(echo "$LIST" | tr ',' '\n' | wc -l | tr -d ' ')"
T0=$(date +%s)
PIDS=""
for n in $(echo "$LIST" | tr ',' ' '); do
  ( curl -s -m 180 "http://127.0.0.1:$PORT/track?number=$n&carrier=maersk&timeout=90000&fresh=1" > "$SCR/r-$n.json" ) &
  PIDS="$PIDS $!"
done
for p in $PIDS; do wait "$p"; done
T1=$(date +%s)

python3 - "$SCR" "$T1" "$T0" "$DECOY" <<'PY'
import json, sys, glob, os
sc, t1, t0, decoy = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
ok = fail = 0
for f in sorted(glob.glob(os.path.join(sc, 'r-*.json'))):
    n = os.path.basename(f)[2:-5]
    try: d = json.load(open(f))
    except Exception: print(f'  {n}: 结果不是 JSON'); fail += 1; continue
    c = d.get('canonical') or {}
    good = bool(d.get('ok'))
    if n == decoy:   # 干扰号：本来就不该成功
        print(f'  {n} (干扰) {"ok" if good else "FAIL"} — {c.get("shortText") or d.get("error", "")[:40]}')
        continue
    ok += good; fail += (not good)
    print(f'  {n} {"ok" if good else "FAIL"} events={c.get("eventCount", 0)} ms={d.get("ms")} retried={bool(d.get("retried"))} {c.get("shortText") or d.get("error", "")[:50]}')
print(f'成功 {ok} / {ok + fail}（判据 ≥5）· 总耗时 {t1 - t0}s')
sys.exit(0 if ok >= 5 else 1)
PY
RESULT=$?

LOCKED=$(grep -c 'has been closed' "$SCR/bridge.log" || true)
FORCED=$(curl -s -m 3 "http://127.0.0.1:$PORT/health" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('profilePool') or {}).get('forced',0))" 2>/dev/null || echo '?')
echo "撞锁错误（must be 0）: $LOCKED · profilePool.forced: $FORCED"
sleep 2
LEFT=$(pgrep -f "$SCR/chrome" | wc -l | tr -d ' ')
echo "收尾残留 Chrome（应为 0）: $LEFT"

if [ "$RESULT" = "0" ] && [ "$LOCKED" = "0" ]; then
  echo "✅ 基准通过"
  exit 0
fi
echo "❌ 基准未过"
exit 1
