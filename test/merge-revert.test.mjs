// 合并格「写后还原」的单测（2026-11-11 第七版）
// 跑：node test/merge-revert.test.mjs
//
// 背景：判据改了六版全在真机上失效，改成「看我的值落哪了」。
// 第七版修的是比较口径 —— 不能用裸 cellText 比：
//   日期列写入 Date(2027,0,13)，WPS 读回序列号 46400。
//   cellText(46400) = "46400"，cellText(Date) = "2027-01-13"，永远不相等。
//   于是日期列（唯一出问题的那类列）上「锚点上是我的值」这一步 100% 判不出。
//
// 修法：复用 cellwrite.judgeReadback（内部有 sameDate 归一化），并且必须传 prev ——
//   不传 prev，「锚点还是旧值」会被判成 format-diff 而不是 fail，导致凭空还原、抹掉用户正确值。

import { shouldRevertAnchor, mergeVerdict } from '../src/lib/writeplan.js';
import { judgeReadback } from '../src/lib/cellwrite.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

const D = new Date(2027, 0, 13);          // 2027-01-13，Excel 序列号 46400

console.log('① 前提：judgeReadback 的口径（这一条错了，下面全错）');
{
  ok(judgeReadback({ prev: '', back: 46400, want: D }) !== 'fail',
    '写入 Date、读回 46400、锚点原本空 → 认得出是同一天（不是 fail）',
    judgeReadback({ prev: '', back: 46400, want: D }));
  ok(judgeReadback({ prev: 46345, back: 46345, want: D }) === 'fail',
    '锚点还是旧值 46345（我没写过它）→ fail',
    judgeReadback({ prev: 46345, back: 46345, want: D }));
  ok(judgeReadback({ prev: undefined, back: '', want: D }) === 'fail',
    '锚点空着 → fail', judgeReadback({ prev: undefined, back: '', want: D }));
}

console.log('② 三条定案断言（知澜给的）');
{
  // ① 值真的跑到锚点了 → 还原
  const a = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorPrev: '', anchorNow: 46400, want: D,
  });
  ok(a.revert === true, '值跑到 L12 → 还原', JSON.stringify(a));
  ok(a.reason === 'value-moved-to-anchor', '理由是 value-moved-to-anchor', a.reason);

  // ② 锚点是旧值、我没写过它 → 绝不还原（保命条）
  const b = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorPrev: 46345, anchorNow: 46345, want: D,
  });
  ok(b.revert === false, '锚点还是旧值 → 绝不还原（判错这条会改掉用户本来就对的数据）', JSON.stringify(b));
  ok(b.reason === 'anchor-untouched', '理由是 anchor-untouched', b.reason);

  // ③ 锚点空着、值根本没写进去 → 不还原
  const c = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorPrev: undefined, anchorNow: '', want: D,
  });
  ok(c.revert === false, '锚点空着 → 不还原', JSON.stringify(c));
  ok(c.reason === 'anchor-untouched', '理由是 anchor-untouched', c.reason);
}

console.log('③ 日期归一化真的生效（第七版的核心）');
{
  // 写 Date，锚点上读回 46400 —— 裸字符串比会失败，judgeReadback 认得
  const d = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorPrev: '', anchorNow: 46400, want: D,
  });
  ok(d.revert === true, 'write Date / read 46400 → 判定值到了（裸文本比会漏）', JSON.stringify(d));

  // 反过来：写 46400、锚点上读回 Date
  const e = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorPrev: '', anchorNow: D, want: 46400,
  });
  ok(e.revert === true, 'write 46400 / read Date → 同样认得出', JSON.stringify(e));

  // 差一天的日期不能算「值到了」
  const f = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorPrev: '', anchorNow: new Date(2027, 0, 14), want: D,
  });
  ok(f.revert === false, '写成 01-13、锚点上是 01-14 → 不还原（形态差但日期不同）', JSON.stringify(f));
  ok(f.reason === 'anchor-not-my-value', '理由是 anchor-not-my-value（不是我的值就不动）', f.reason);
}

console.log('④ 边界：锚点自身 / 摸不到 / 无值');
{
  ok(shouldRevertAnchor({ anchorAddr: 'L12', selfAddr: 'L12', anchorPrev: 1, anchorNow: 1, want: 1 }).revert === false,
    'L12 是锚点本身 → 不还原（还原等于抹掉写成功的）');
  ok(shouldRevertAnchor({ anchorAddr: 'L12', selfAddr: 'L12' }).reason === 'anchor-is-self', '理由是 anchor-is-self');
  ok(shouldRevertAnchor({ anchorAddr: '', selfAddr: 'L13', want: D }).reason === 'no-anchor', '摸不到锚点 → no-anchor');
  ok(shouldRevertAnchor({ anchorAddr: null, selfAddr: 'L13' }).revert === false, '锚点 null → 不还原');
  ok(shouldRevertAnchor({ anchorAddr: 'L12', selfAddr: 'L13', anchorNow: 46400, want: '' }).reason === 'nothing-wanted',
    '没有要写的值 → nothing-wanted');
  ok(shouldRevertAnchor({}).revert === false, '全空 → 不还原');
  ok(shouldRevertAnchor({ anchorAddr: '$l$12 ', selfAddr: ' l13', anchorPrev: '', anchorNow: 46400, want: D }).revert === true,
    '$ / 大小写 / 空格不影响');
}

console.log('⑤ 字符串列也照常工作（不是只有日期）');
{
  ok(shouldRevertAnchor({ anchorAddr: 'R12', selfAddr: 'R13', anchorPrev: 'old', anchorNow: '放空箱 11-05', want: '放空箱 11-05' }).revert === true,
    '文本列：值跑到锚点 → 还原');
  ok(shouldRevertAnchor({ anchorAddr: 'R12', selfAddr: 'R13', anchorPrev: 'old', anchorNow: 'old', want: '放空箱 11-05' }).revert === false,
    '文本列：锚点还是旧值 → 不还原');
}

console.log('⑥ 与快路径 mergeVerdict 的关系：它说可写也不等于安全');
{
  // 场景 C：WPS 退化成单格，mergeVerdict 判可写（快路径漏判）——
  // 这没关系，读回兜底会接住。这里锁住「漏判是预期的，不是 bug」。
  const C = mergeVerdict({
    cellAddr: '$L$13', cellRow: 13, cellCol: 12,
    maAddr: '$L$13', maAnchorAddr: '$L$13', maRow: 13, maCol: 12, maRows: 2, maCols: 1,
  });
  ok(C.nonAnchor === false, '快路径在场景 C 下判「可写」（已知漏判，交给读回兜底）', JSON.stringify(C));

  const d = shouldRevertAnchor({
    anchorAddr: 'L12', selfAddr: 'L13', anchorPrev: '', anchorNow: 46400, want: D,
  });
  ok(d.revert === true, '同样的场景，读回兜底判「值跑偏」→ 还原');

  const normal = mergeVerdict({
    cellAddr: '$L$13', cellRow: 13, cellCol: 12,
    maAddr: '$L$12:$L$13', maAnchorAddr: '$L$12', maRows: 2, maCols: 1,
  });
  ok(normal.nonAnchor === true, 'MergeArea 正常时快路径直接跳过（不写、不污染、不用还原）', JSON.stringify(normal));
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
