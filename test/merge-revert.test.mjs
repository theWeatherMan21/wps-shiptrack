// 合并格「写后还原」的单测（2026-11-11 第六版，判据路线放弃后的兜底）
// 跑：node test/merge-revert.test.mjs
//
// 背景：判据改了六版全在真机上失效 ——
//   hotfix9   MergeCells === true        → WPS 返 -1，恒假
//   hotfix11  段级 !isVbaTrue(0)          → 部分合并返 0，被当成没合并
//   hotfix12  只比 MergeArea.Row/Column   → 真机「现场跳过 0 格」
//   hotfix14  同上                        → 同上
//   hotfix15  顺序 return，坐标短路尺寸    → 场景 C 判成可写
//   hotfix16  左上角地址优先              → 退化单格时 anchor === self，仍判可写
//
// 结论：不再问 WPS「这格是不是合并区」，改成问「我刚写的值现在在哪」。
//   写前拍下锚点原值 → 写完读回空 → 锚点上是我的值吗？是就还回去，报「合并跳过」。

import { shouldRevertAnchor, mergeVerdict } from '../src/lib/writeplan.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

console.log('① 值跑到锚点 → 必须还原');
{
  // L13 写 46400，读回空，L12 变成了 46400
  const d = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorNowText: '46400', wantText: '46400',
  });
  ok(d.revert === true, 'L13 写 46400 → 锚点 L12 也是 46400 → 判值跑偏');
  ok(d.reason === 'value-moved-to-anchor', '理由是 value-moved-to-anchor', d.reason);
}

console.log('② 左上角自己写 → 绝不能还原');
{
  // L12 是合并区左上角，值本来就该写这里
  const d = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L12', anchorNowText: '46400', wantText: '46400',
  });
  ok(d.revert === false, 'L12 = 锚点本身 → 不还原（还原就等于把写成功的抹掉）');
  ok(d.reason === 'anchor-is-self', '理由是 anchor-is-self', d.reason);
}

console.log('③ 锚点没被动 → 是真写失败，不是合并');
{
  const d = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorNowText: '46400', wantText: '46500',
  });
  ok(d.revert === false, '锚点上不是我要写的值 → 不还原，按普通失败报');
  ok(d.reason === 'anchor-untouched', '理由是 anchor-untouched', d.reason);
}

console.log('④ 边界：摸不到锚点 / 没有值');
{
  ok(shouldRevertAnchor({ anchorAddr: '', selfAddr: 'L13', anchorNowText: '', wantText: '46400' }).revert === false, '摸不到锚点 → 不还原');
  ok(shouldRevertAnchor({ anchorAddr: null, selfAddr: 'L13' }).revert === false, '锚点 null → 不还原');
  ok(shouldRevertAnchor({ anchorAddr: 'L12', selfAddr: 'L13', anchorNowText: '46400', wantText: '' }).revert === false, '没有要写的值 → 不还原');
  ok(shouldRevertAnchor({}).revert === false, '全空 → 不还原');
  ok(shouldRevertAnchor({ anchorAddr: '$l$12 ', selfAddr: ' l13', anchorNowText: ' 46400 ', wantText: '46400' }).revert === true, '$ / 大小写 / 空格都不影响');
}

console.log('⑤ 与快路径 mergeVerdict 的关系：它说可写也不等于安全');
{
  // 场景 C：WPS 退化成单格，mergeVerdict 判可写（快路径漏判）——
  // 这没关系，读回兜底会接住。这里锁住「漏判是预期的，不是 bug」。
  const C = mergeVerdict({
    cellAddr: '$L$13', cellRow: 13, cellCol: 12,
    maAddr: '$L$13', maAnchorAddr: '$L$13', maRow: 13, maCol: 12, maRows: 2, maCols: 1,
  });
  ok(C.nonAnchor === false, '快路径在场景 C 下判「可写」（已知漏判，交给读回兜底）', JSON.stringify(C));

  // 但读回兜底一定接得住：写了 → 读回空 → 锚点上是我的值 → 还原
  const d = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorNowText: '46400', wantText: '46400',
  });
  ok(d.revert === true, '同样的场景，读回兜底判「值跑偏」→ 还原');
}

console.log('⑥ 快路径正常时省一次写（它还是有用）');
{
  const normal = mergeVerdict({
    cellAddr: '$L$13', cellRow: 13, cellCol: 12,
    maAddr: '$L$12:$L$13', maAnchorAddr: '$L$12', maRows: 2, maCols: 1,
  });
  ok(normal.nonAnchor === true, 'MergeArea 正常时快路径直接跳过（不写、不污染、不用还原）', JSON.stringify(normal));
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
