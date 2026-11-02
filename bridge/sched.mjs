// 按船司的调度：同船司串行、跨船司并行。
//
// 为什么要有这个模块（卡 t_228d289b）：
//   批量查票时，同一家船司并发只会把自己打进限流/冷却（OOCL 连查 6–8 次锁 45 分钟），
//   而不同船司之间是独立的站点和数据源，并行完全安全。
//   所以调度分两层：
//     ① 本模块：按 carrier 排队（同司串行）
//     ② 桥里的 slot()：全局并发上限（MAX_CONCURRENT）
//   互斥压在 slot() 之外 —— 先拿船司锁，再进全局槽位。不另造一套信号量。
//
// 纯函数、无 IO，可以直接单测。

/**
 * 造一个「按 key 互斥」的调度器。
 * @returns {{run: (key: string, fn: Function) => Promise<any>, pending: () => number, size: () => number}}
 */
export function makeKeyedMutex() {
  const chains = new Map();   // key -> 队尾 Promise

  function run(key, fn) {
    const k = key || '_unknown';
    const prev = chains.get(k) || Promise.resolve();
    // 前一个失败也要放行：用 then(fn, fn) 而不是 then(fn)，
    // 否则链上第一个任务报错后，后面排着的全部静默不执行（比报错更难查）。
    const mine = prev.then(fn, fn);
    const tail = mine.then(() => {}, () => {});   // 队尾只关心「跑完了」，不传播异常
    chains.set(k, tail);
    // 队尾没人排了就删掉，避免 Map 随船司数无限增长（长期运行的桥必须管这个）
    tail.then(() => { if (chains.get(k) === tail) chains.delete(k); });
    return mine;
  }

  return {
    run,
    pending: () => [...chains.keys()].length,
    size: () => chains.size,
  };
}

/**
 * 把一组号码按 carrier 分组，供调用方决定调度。
 * @param {string[]} numbers
 * @param {(n: string) => string} detect  号码 → 船司 id（识别不出返回 ''）
 */
export function groupByCarrier(numbers, detect) {
  const out = new Map();
  for (const n of numbers) {
    let c = '';
    try { c = detect(n) || ''; } catch (e) { c = ''; }
    const k = c || '_unknown';
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(n);
  }
  return out;
}
