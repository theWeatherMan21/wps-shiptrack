#!/bin/bash
# 全量闸门：一次跑完「构建 + 单测 + 探针 + 渲染冒烟 + 桥体检」
# 为什么要有这个：2026-10-26 爹地质问「为什么总在顺手修」——
# 因为此前每次改动只挑相关探针跑，问题靠运气被某个探针撞见。
# 现在改完必须整条跑一遍，任何一项红都不算交付。
#
#   用法: scripts/verify-all.sh [--fast]
#     --fast  跳过 audit-probe（比较慢）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDON="$ROOT"
export NODE_PATH="${NODE_PATH:-$(npm root -g 2>/dev/null)}"
FAIL=0
declare -a RESULTS

run() { # run <名字> <目录> <命令...>
  local name="$1"; local dir="$2"; shift 2
  printf '\n\033[1m== %s ==\033[0m\n' "$name"
  if ( cd "$dir" && timeout 600 "$@" ) 2>&1 | tail -4; then
    RESULTS+=("✅ $name")
  else
    RESULTS+=("❌ $name")
    FAIL=1
  fi
}

run "模板静态检查（模板调用了不存在的成员）" "$ROOT" node scripts/template-lint.mjs
run "构建（online）"        "$ADDON" node scripts/build.cjs online
run "单测：号码解析"        "$ADDON" node scripts/cellparse-test.mjs
run "单测：事件词典"        "$ADDON" node scripts/events-test.mjs
run "单测：里程碑/颜色"     "$ADDON" node scripts/milestone-test.mjs
run "不变量：计划≠事实"      "$ADDON" node scripts/invariants-test.mjs
run "单测：表头识别"        "$ADDON" node scripts/headers-test.mjs
run "单测：ribbon"          "$ADDON" node scripts/ribbon-test.mjs
run "探针：状态机 H1-H21"   "$ADDON" node scripts/state-probe.mjs
if [ "${1:-}" != "--fast" ]; then
run "探针：审计 A-G"        "$ADDON" node scripts/audit-probe.mjs all
fi
run "渲染冒烟（无 pageerror / 按钮齐全）" "$ROOT" node scripts/render-smoke.mjs

printf '\n\033[1m===== 汇总 =====\033[0m\n'
for r in "${RESULTS[@]}"; do echo "$r"; done
[ "$FAIL" -eq 0 ] && echo "全部通过" || echo "有失败项 —— 不许交付"
exit "$FAIL"
