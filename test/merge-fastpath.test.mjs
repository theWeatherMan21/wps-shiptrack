// 合并格快路径的单测（2026-11-11 真机复现的那个坑）
// 跑：node test/merge-fastpath.test.mjs
//
// 背景：爹地的表 L12:L13 是合并区。插件往 L13 写 46400（=2027-01-13），
// 值落到 L12、读 L13 永远空，横幅报「赋值没生效，不是表保护」。
//
// 根因两层：
//   ① WPS 对「区域内部分合并」（L2:L15 里只有 L12:L13 合并）返回 **0**，
//      而 VBA 规范应是 **Null**；0 被 isVbaTrue 判成「没合并」。
//   ② 快路径据此把整段标记 mergeChecked=true 直接返回，逐格检查再也进不去。
//
// 修法：快路径只对单格段开放（canUseMergeFastPath），多行段一律逐格摸。
// 这个测试锁的就是「多行段绝不允许走快路径」这一条 —— 它是所有批量写的公共入口。

import {
  canUseMergeFastPath, mergeBlockOf, mergeSkipText, isVbaTrue, isMergedNonAnchor,
} from '../src/lib/writeplan.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

console.log('① 快路径：永久停用（两次真机事故的最终结论）');
{
  // 第一次（hotfix9）：单格判断 === true，WPS 返 -1 → 恒假
  // 第二次（hotfix11）：段级判断 !isVbaTrue(0) → 把「部分合并」当成「没合并」
  // 结论：WPS 的 MergeCells 布尔值不可信，任何情况下都不许拿它跳过逐格检查
  ok(canUseMergeFastPath(15, 0) === false, '多行段 + MergeCells=0（WPS 部分合并）→ 禁止');
  ok(canUseMergeFastPath(2, 0) === false, '两行段 + 0 → 禁止');
  ok(canUseMergeFastPath(15, null) === false, '多行段 + null → 禁止');
  ok(canUseMergeFastPath(15, -1) === false, '多行段 + -1 → 禁止');
  ok(canUseMergeFastPath(15, false) === false, '多行段 + false → 禁止');
  ok(canUseMergeFastPath(1, 0) === false, '单格段 + 0 → 也禁止（知澜：单格也直接摸，彻底消残余风险）');
  ok(canUseMergeFastPath(1, false) === false, '单格段 + false → 也禁止');
  ok(canUseMergeFastPath(1, -1) === false, '单格段 + -1 → 禁止');
  ok(canUseMergeFastPath(1, null) === false, '单格段 + null → 禁止');
  ok(canUseMergeFastPath(1, undefined) === false, '单格段 + undefined → 禁止');
}

console.log('② isVbaTrue 的边界（WPS 返 -1/0，不是 true/false）');
{
  ok(isVbaTrue(-1) === true, '-1 = 真');
  ok(isVbaTrue(0) === false, '0 = 假');
  ok(isVbaTrue(1) === true, '1 = 真');
  ok(isVbaTrue(true) === true, 'true = 真');
  ok(isVbaTrue(false) === false, 'false = 假');
  ok(isVbaTrue(null) === false, 'null = 假');
  ok(isVbaTrue(undefined) === false, 'undefined = 假');
}

console.log('③ mergeBlockOf：非左上角必须判为不可写');
{
  // L12:L13 合并，topRow=12 topCol=12(L)
  const area = { mergeCells: -1, topRow: 12, topCol: 12, address: '$L$12:$L$13' };

  const atL13 = mergeBlockOf(area, 13, 12);
  ok(atL13 !== null, 'L13（非左上角）→ 判为不可写');
  ok(atL13 && atL13.addr === 'L12:L13', 'block.addr 指回合并区（$ 已去掉）', JSON.stringify(atL13));
  ok(mergeSkipText(atL13).includes('合并'), '提示文案带「合并」', mergeSkipText(atL13));

  ok(mergeBlockOf(area, 12, 12) === null, 'L12（左上角）→ 可写');
  ok(mergeBlockOf({ mergeCells: 0 }, 14, 12) === null, 'L14（不在合并区）→ 可写');
  ok(mergeBlockOf({ mergeCells: 0 }, 13, 12) === null, 'MergeCells=0 → 可写');
  ok(mergeBlockOf(null, 13, 12) === null, '摸不到 → 可写（按原路写）');
}

console.log('④ 端到端复演：爹地表 L2:L15 只有 L12:L13 合并');
{
  // 模拟 _dropMerged 的两步：① 段级快路径判定 ② 逐格摸
  const seg = [];
  for (let r = 2; r <= 15; r++) seg.push({ row: r, col: 12, mergeChecked: false });

  // WPS 对「L2:L15 部分合并」返回 0（这就是坑）
  const rangeMergeCells = 0;

  // 旧逻辑：!isVbaTrue(0) === true → 整段跳过
  const oldWouldSkipAll = (rangeMergeCells !== null && rangeMergeCells !== undefined && !isVbaTrue(rangeMergeCells));
  ok(oldWouldSkipAll === true, '旧逻辑确实会把 0 当成「没合并」（复现坑）');

  // 新逻辑：多行段不走快路径
  const newSkipsAll = canUseMergeFastPath(seg.length, rangeMergeCells);
  ok(newSkipsAll === false, '新逻辑：多行段不走快路径 → 进入逐格检查');

  // 逐格摸的结果：L13 必须被剔除，其余保留
  // 注意：mock 要按行返回不同结果 —— 只有 L12/L13 在合并区，别的行根本没合并
  const areaOf = (row) => (row === 12 || row === 13
    ? { mergeCells: -1, topRow: 12, topCol: 12, address: '$L$12:$L$13' }
    : { mergeCells: 0 });
  const kept = [];
  const merged = [];
  for (const w of seg) {
    w.mergeChecked = true;
    const blk = mergeBlockOf(areaOf(w.row), w.row, w.col);
    if (blk) merged.push({ row: w.row, addr: blk.addr });
    else kept.push(w.row);
  }
  ok(merged.length === 1 && merged[0].row === 13, 'L13 被剔除（唯一一格）', JSON.stringify(merged));
  ok(merged[0] && merged[0].addr === 'L12:L13', '剔除原因指回 L12:L13', JSON.stringify(merged[0]));
  ok(kept.length === 13, '其余 13 行保留', `实际 ${kept.length}`);
  ok(!kept.includes(13), 'L13 不在可写列表里');
  ok(kept.includes(2) && kept.includes(12) && kept.includes(14) && kept.includes(15), 'L2/L12/L14/L15 都可写', JSON.stringify(kept));
  ok(seg.every((w) => w.mergeChecked === true), '每一格都真的被检查过（mergeChecked 不是白写的）');
}

console.log('⑤ 不制造假阳性：真没合并的表照常全写');
{
  const seg = [];
  for (let r = 2; r <= 15; r++) seg.push({ row: r, col: 12 });
  const kept = [];
  for (const w of seg) {
    const blk = mergeBlockOf({ mergeCells: 0 }, w.row, w.col);
    if (!blk) kept.push(w.row);
  }
  ok(kept.length === 14, '14 行全保留（没有被误杀）', `实际 ${kept.length}`);
}


console.log('⑥ 行列号比较：判据不依赖 MergeCells 布尔值');
{
  // 最终判据 —— 布尔值在 WPS 上两次坑人，MergeArea 的左上角坐标是硬事实
  ok(isMergedNonAnchor(12, 12, 13, 12) === true, 'L13：MergeArea 从 (12,12) 起 → 非左上角');
  ok(isMergedNonAnchor(12, 12, 12, 12) === false, 'L12：坐标相同 → 左上角，可写');
  ok(isMergedNonAnchor(13, 13, 13, 13) === false, '非合并格：MergeArea 等于自身 → 可写');
  ok(isMergedNonAnchor(12, 11, 13, 12) === true, '跨列合并 K12:L13 里的 L13 → 非左上角');
  ok(isMergedNonAnchor('12', '12', '13', '12') === true, '字符串数字也认');
  ok(isMergedNonAnchor(null, 12, 13, 12) === null, '摸不到 Row → null（交调用方兜底）');
  ok(isMergedNonAnchor(12, 12, null, 12) === null, '摸不到 cell row → null');
  ok(isMergedNonAnchor(undefined, undefined, undefined, undefined) === null, '全摸不到 → null');
  ok(isMergedNonAnchor(12, 12, 13, 12) === true, '换列同样成立（K13）');
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
