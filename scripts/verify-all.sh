#!/bin/bash
# 全量闸门：一次跑完「构建 + 单测 + 探针 + 渲染冒烟 + 桥体检」
# 为什么要有这个：2026-10-26 爹地质问「为什么总在顺手修」——
# 因为此前每次改动只挑相关探针跑，问题靠运气被某个探针撞见。
# 现在改完必须整条跑一遍，任何一项红都不算交付。
#
#   用法: scripts/verify-all.sh [--fast] [--smoke]
#     --fast   跳过 audit-probe（比较慢）
#     --smoke  状态机探针只跑冒烟 5 条（每轮回归用，<60s）；
#              发布前请不带 --smoke 跑全量 33 条
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDON="$ROOT"
export NODE_PATH="${NODE_PATH:-$(npm root -g 2>/dev/null)}"
FAIL=0
FAST=0
PROBE_ARG=""
for a in "$@"; do
  case "$a" in
    --fast)  FAST=1 ;;
    --smoke) PROBE_ARG="--smoke" ;;
    *) printf '未知参数：%s（支持 --fast / --smoke）\n' "$a" >&2; exit 2 ;;
  esac
done
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
# ★ 11-05：版本号比较（-hotfixN 后缀）—— 曾把 hotfix3→hotfix4 判成 noop，发布阻断
run "单测：版本号比较"      "$ADDON" node test/vercmp.test.mjs
run "单测：自更新降级保护"  "$ADDON" node test/update-guard.test.mjs
# ★ 10-30：读回校验的三种列型都不许判 fail（日期列/数值列误报「表可能被保护」的红条正身）
run "不变量：写回读回判定"    "$ADDON" node test/cellwrite.test.mjs
run "单测：表头识别"        "$ADDON" node scripts/headers-test.mjs
# ★ 11-11 卡 t_a72fba24：Excel 行列自动识别（夹具矩阵 + 置信分档 + 变化检测 + 桥端到端）
run "单测：Excel 行列识别"   "$ADDON" node test/detect-columns.test.mjs
run "单测：识别粘合层"       "$ADDON" node test/detectcols-lib.test.mjs
run "探针：桥 /detect-columns" "$ADDON" node test/detect-columns-e2e.mjs
run "单测：ribbon"          "$ADDON" node scripts/ribbon-test.mjs
# ★ 卡 t_8a6689dc：canonical 契约（schemaVersion）—— 闸门纯函数 + 桥真进程端到端
run "单测：契约闸门"        "$ADDON" node test/schema.test.mjs
run "探针：桥契约接口（/health 区间 + 降级桩）" "$ADDON" node test/schema-e2e.mjs
# ★ 10-30：doc/sheet/row 从 URL → CLI → 台账，端到端一条（假 CLI 用真 journal 落盘）
run "探针：台账行号端到端"  "$ADDON" node test/track-meta-e2e.mjs
# 台账回归：拿本机真实台账（183 单那批）按新代码重渲染一遍，字段错位就红
run "回归：台账重渲染（183 单）" "$ADDON" node test/ledger-regress.mjs
if [ -n "$PROBE_ARG" ]; then
run "探针：状态机冒烟（H3/H4b/H22/H23/H31）" "$ADDON" node scripts/state-probe.mjs "$PROBE_ARG"
else
run "探针：状态机 H1-H31（全量）" "$ADDON" node scripts/state-probe.mjs
fi
if [ "$FAST" -eq 0 ]; then
run "探针：审计 A-G"        "$ADDON" node scripts/audit-probe.mjs all
fi
run "渲染冒烟（无 pageerror / 按钮齐全）" "$ROOT" node scripts/render-smoke.mjs
# ★ 卡 t_8a6689dc：面板级契约探针（正常/新契约/桥拒绝/老桥 四种现场，真看格子写了什么）
run "探针：契约面板（四现场）" "$ROOT" node scripts/schema-probe.mjs

printf '\n\033[1m===== 汇总 =====\033[0m\n'
for r in "${RESULTS[@]}"; do echo "$r"; done
[ "$FAIL" -eq 0 ] && echo "全部通过" || echo "有失败项 —— 不许交付"
exit "$FAIL"
