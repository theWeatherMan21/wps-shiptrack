# ShipTrack · WPS 加载项

在 WPS 表格里按里程碑给提单号着色：选中「单号列」和「输出列」，插件逐行识别单号 → 查船司轨迹 → 回填「日期 · 事件 · 港口」并按里程碑整行着色。

## 结构

```
src/            加载项前端（Vue 3 + vite）
scripts/        构建 / 校验 / 打包 / 装机 / 探针
bridge/         本机 HTTP 桥（8791）：识别船司、调引擎、写配置、在线更新
packaging/      Windows 安装脚本
test/fixtures/  真实船司返回夹具（已脱敏）
```

## 常用命令

```bash
node scripts/build.cjs online       # 构建到 wps-addon-build/
./scripts/install-verify.sh         # 装进本机 WPS 并校验
./scripts/verify-all.sh             # 全量校验（单测 + 探针 + 不变量）
./scripts/pack-update.sh            # 打更新包到 dist-updates/
```

## 本地桥常驻（别让人守着终端）

桥（`127.0.0.1:8791`）原来只能人手 `scripts/bridge.sh start`：重启、合盖休眠被杀、崩溃退出之后，
面板就永远「桥没连上」。现在两边都有守护：

```bash
# macOS：LaunchAgent（登录即起，崩溃/被杀自动重拉，日志在 ~/Library/Logs/wps-shiptrack-bridge.log）
scripts/install-launchagent.sh
scripts/install-launchagent.sh --status

# Windows：登录计划任务（RestartOnFailure 1 分钟一次）
powershell -ExecutionPolicy Bypass -File bridge\start-win.ps1 -RepoPath "<ShipScheduleHub>" -InstallAutostart
```

`scripts/bridge.sh` 仍留着做手工排查（start/stop/status/restart），`status` 会顺带报守护有没有装。

## 发布

本仓库**只发插件**，与船期查询 App 的 release 分开：

```bash
# 打 tag 并上传资产（wps-latest 滚动 + wps-v<版本> 历史）
scripts/publish.sh --notes "说明"
```

桥与 App 共用 `ShipScheduleHub` 的追踪引擎目录（`SSH_REPO`）。

## 与船期 App 的同步约定

`ShipScheduleHub` 的 `engine/` 改动后，本仓库必须跟一个补丁版本：

```bash
cd ~/Documents/trae_projects/ShipScheduleHub
scripts/hotfix-addon.sh "说明"
```

这条规则有机器兜底：`ShipScheduleHub` 推送前会跑 `scripts/addon-sync-check.sh`，
引擎比插件新就直接拦下（急用可 `SKIP_ADDON_SYNC=1 git push`）。
