# 真实返回夹具

`scripts/capture-fixture.mjs <carrier> <number>` 抓一次真实查询结果，自动脱敏（单号/箱号打码）。

- 有事件的夹具（maersk / msc / hapag）用于验证：判定口径、着色、起讫港来源
- 无事件的夹具（其余 8 家）用于锁定「查不到」的文案与行为契约：不得判阶段、不得上色

`scripts/invariants-test.mjs` 会遍历本目录，跑跨船司不变量。
