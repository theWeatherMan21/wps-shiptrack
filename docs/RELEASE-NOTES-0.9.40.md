# v0.9.40 · 本地桥常驻 + 三种「桥没连上」分清

> 2026-10-29 · 触发：重启后 WPS 面板一直「本地桥没连上」，点「重连」也回不来。
> 现场核查：8791 无监听、`/tmp` 的日志与 pidfile 都不存在 —— 桥重启后一次都没被拉起，代码没坏，坏的是没人守它。

## 1. macOS：桥装成 LaunchAgent（登录即起 + 崩溃自动重拉）

```bash
scripts/install-launchagent.sh            # 安装/更新（幂等）
scripts/install-launchagent.sh --status   # 看 loaded + 桥是否在听
scripts/install-launchagent.sh --uninstall
```

- `~/Library/LaunchAgents/com.wanyi.wps-shiptrack-bridge.plist`
- `RunAtLoad=true`；`KeepAlive={SuccessfulExit=false}`（崩溃/被杀才重拉，正常退出不折腾）
- 日志固定到 `~/Library/Logs/wps-shiptrack-bridge.log`（**不再落 /tmp**，重启即清的那种坑）
- 实现细节（踩过才知道）：
  1. **TCC**：仓库在 `~/Documents` 下，launchd 直接 `bash <wrapper>` 会被系统拦（`Operation not permitted`，exit 126）。
     改成 `osascript -e 'do shell script ...'` 后与 Hermes 网关同一条授权链，实测正常。
  2. **日志乱码**：osascript 会把捕获的输出当 AppleScript 文本转义（中文乱码、行尾变 `\r`），
     所以日志由 wrapper 自己 `exec >> log`，plist 的 `Standard*Path` 只收 launchd 层噪音。
  3. **孤儿占端口**：osascript 被单独杀掉时 node 可能活着，wrapper 带父进程看门狗（5 秒一查），一起退。

实测：`kill -9` 桥 → 10 秒内自动回来；`kill -9` osascript → 桥跟着退、随即重拉；`bootout`+`bootstrap`（等价退出登录再登录）→ 无需任何终端操作，桥自己起来。

## 2. Windows：登录计划任务（带失败重启）

`bridge/start-win.ps1 -InstallAutostart` 从 `schtasks /SC ONLOGON`（只会触发一次）改成
`Register-ScheduledTask` + `RestartOnFailure`（1 分钟一次，最多 999 次）+ `ExecutionTimeLimit=0`：

```powershell
powershell -ExecutionPolicy Bypass -File bridge\start-win.ps1 -RepoPath "<ShipScheduleHub>" -InstallAutostart
```

- 新增 `-Foreground` 模式：计划任务进程**就是**桥（不再拉一个游离子进程），任务状态「正在运行」与桥同生共死，
  失败重启才有意义。
- `packaging/win/install-win.ps1` 之前找不到 `start-win.ps1`（它在 `bridge/` 下，脚本却在 `packaging/win/` 旁边找），
  顺手修好，并在装完后直接注册守护，不再只装插件不落地。

## 3. 桥进程自检（不静默死）

- 端口被**别的**进程占：明确打日志 + 非 0 退出（守护进程会重试）；10 分钟内连续 3 次就停手并写清原因，避免无限重拉刷日志。
- 端口被**本桥自己**占（重复实例）：打日志 + 正常退出（exit 0），守护进程不折腾。
- 运行期 `server.listening=false`（监听丢了）：60 秒自检发现就退出等重拉。
- 未捕获异常：先落一行人能看懂的原因再退出。
- 未处理的 Promise 拒绝：只记不杀（一批查询跑一半时杀进程会丢在飞结果）。

## 4. 面板横幅分三态（原来只有一句「本地桥没连上」）

| 现场 | 横幅 |
|---|---|
| 8791 无监听（进程没起） | 「本地桥进程没在跑（127.0.0.1:8791 无监听）」+ 一条可复制的启动命令（mac/win 按宿主给）+「复制命令」「重连」 |
| 连得上但桥自报 `ok:false` | 「本地桥进程在跑，但自报异常：<桥给的原因>」 |
| 端口通、但请求被跨域/CSP 拦 | 「加载项被拦：桥在 8791 上活着，但这个面板发的请求被跨域/CSP 挡住」 |

区分手法：`fetch` 被拒（`Failed to fetch`）在「连接被拒」和「跨域被拦」眼里是同一张脸，
所以再用一次 `mode:'no-cors'` 探针（只问「连得上吗」、不读响应）把两者分开。

顺带：`.warn` 之前**根本没有样式**，那条横幅在白底上跟普通文字一样，用户根本看不见 —— 补了琥珀色底。

## 5. 红-绿

`scripts/state-probe.mjs` 新增 H19/H20/H21（都在 `scripts/lib/wps-stub.mjs` 的四种桥现场下跑）：

- H19：8791 无监听 → 横幅必须含「进程没在跑」+ 启动命令 + 两个按钮
- H20：桥返回 `ok:false` → 原样转述原因，且**不**说「进程没在跑」
- H21：端口通但被拦 → 说「加载项被拦」，与「没在跑」区分

先跑红（0.9.39 三条全红，横幅只有「本地桥没连上」），实现后 23/23 全绿；`scripts/verify-all.sh` 11 项全通过。
