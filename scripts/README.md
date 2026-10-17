# scripts 用途与运行边界

> 状态：Current｜维护责任：构建/测试/发布维护者｜适用范围：当前 `main`。本页按代码静态核对，不代表已在所有平台运行验收。

## 1. 目录与兼容约定

| 位置 | 内容 | 默认运行边界 |
| --- | --- | --- |
| 根目录 | 公开安装、卸载与 Launcher 升级入口，以及 TypeScript 配置 | 保持 GitHub raw 单文件 URL 和发布构件资产路径兼容；真实安装会改变系统，不是测试入口 |
| `build/` | 构建、版本注入、FRP 下载、发布装配 | 写构建产物；部分联网、修改源码版本 |
| `dev/` | 开发启动、CLI 垫片、健康等待、本地真实 frps | 有进程、端口、下载或安装目录副作用 |
| `tests/unit/` | Node/TSX 离线回归与单独 Shell 回归 | 使用夹具、临时目录、adapter 或本地 loopback；不等于零副作用 |
| `tests/e2e/` | 跨进程集成与 Launcher 冒烟 | 需构建产物；启动真实进程，部分强制停止端口占用者 |
| `tests/manual/` | 真实 FRP、云盘、永久链接和 PTY 验证 | 必须先读风险并使用专用可丢弃环境，不纳入默认离线回归 |
| `tests/helpers/` | 测试基础设施 | 被测试入口调用，不是独立验收命令 |

优先从仓库根目录调用已有 `pnpm` 命令，命令名不随分类改变。直接 `node` / `tsx` 调用使用本页新路径。详细测试与发布门禁见 [测试策略](../docs/testing.md)，安装演练见 [快速开始](../docs/quickstart.md)。

## 2. 常用入口

```bash
# 脚本级离线 Node + TSX 回归；先完成依赖安装，不包含 Shell 或真实环境测试
pnpm test:scripts

# Shell 回归单列：需要 Bash；不安装 coturn 或 Client
bash scripts/tests/unit/install-client-bootstrap.test.sh
bash scripts/tests/unit/install-coturn.test.sh

# 跨进程集成：先阅读下文端口/数据库风险
pnpm test
pnpm test:cli
pnpm test:vcp-plugin

# 构建/开发入口
pnpm download:frp
pnpm release --version=<x.y.z>
pnpm vcpdeck:link
```

离线指不依赖外部服务、OAuth 或真实安装，并非不产生任何 I/O：Node 回归可能启动子进程、临时 SQLite、loopback HTTP 服务及临时文件；Shell 需要对应执行环境。首次获取依赖或执行构建下载不属于离线回归本身。

### 保留：启动真实本地 frps

[启动辅助脚本](dev/start-test-frps.cjs) **真实启动 frps 二进制，不是 mock**，供开发 Server、Client 和本地集成联调。在独立终端运行：

```bash
pnpm download:frp
node scripts/dev/start-test-frps.cjs --port=17000 --dashboard-port=17500 --token=<local-test-token> --clean
```

将 `<local-test-token>` 替换为本地专用测试值。默认 bind port 为 `17000`，Dashboard 为 `17500`、登录 `admin/admin`，默认 Token 为 `test-frp-token`。脚本参数也可由 `PORT`、`DASHBOARD_PORT`、`TOKEN`、`FRPS_BIN` 环境变量设置；**这不是 Server 的 `FRPS_BIND_PORT` / `FRPS_TOKEN` 配置命名**。Server 接线示例见 [README 本地 FRPS](../README.md#启动本地-frps-测试实例)。

脚本写入 `.tmp/test-frps/frps.toml` 和日志，配置及控制台含明文测试 Token；Dashboard 当前绑定 `0.0.0.0` 且使用固定测试凭据，**只用于隔离、可信的本地网络，不能暴露到公网**。按 `Ctrl+C` 停止；`--clean` 在信号退出时清理临时目录。`--bg` 只忽略子进程输出，不是可靠的 detached 后台守护，也不保证所有异常退出都完成清理。

## 3. 根目录公开入口（保留原路径）

下列入口保留于根目录，不移动到内部分类目录，避免破坏 raw URL、单文件引导及 Release 资产复制。保留不等于每个 helper 已有独立 CLI 或已完成全平台验收。

| 文件 | 用途、入口与依赖 | 副作用与当前状态 |
| --- | --- | --- |
| [install.cjs](install.cjs) | 通用 ZIP 安装：`node scripts/install.cjs --artifact=server\|client --zip=<本地路径或URL>`；Node、解压工具，Server 安装依赖 Prisma | 下载/解压，写 app/current/env，Server 初始化数据库；已有 Launcher 默认保留；真实安装，不能在生产目录试跑 |
| [uninstall.cjs](uninstall.cjs) | 通用版本卸载；Node，支持 `--dry-run`、`--yes` | 删除版本目录、维护 current；非 TTY 会直接执行，先用 dry-run 核对目标 |
| [install-cli.cjs](install-cli.cjs) | GitHub raw 单文件 CLI 引导；Node、网络，支持 `--tag` / `--repo` / `--dir` | 下载 CLI、覆盖 bin/垫片并配置用户 PATH 或 Shell 配置；建议固定 Tag |
| [install-client.cjs](install-client.cjs) | Server `/releases` 一键安装的平台编排；Node、Server、平台安装能力 | 写凭据/安装状态、下载构件；Windows 使用 ProgramData 固定目录和 SYSTEM 任务；属于真实系统安装 |
| [uninstall-client.cjs](uninstall-client.cjs) | 一键 Client 卸载，校验安装状态、env 和 app-dir；Node、对应平台管理工具 | 停止/删除任务或进程与运行目录；Windows 保留机器 client-id；执行前备份并核对目标 |
| [install-client-linux.cjs](install-client-linux.cjs) | Linux A2 安装及迁移；root/sudo、systemd、Node、Server 下载；提供 adapter 供回归 | 修改 `vcpdeck` 账户、`/opt`、`/var/lib`、`/etc`、sudoers 和 systemd；Client 账户具提权能力；真实系统操作 |
| [uninstall-client-linux.cjs](uninstall-client-linux.cjs) | 导出 `planUninstall` / `runUninstall`，由注入 adapter 执行 Linux systemd 卸载 | 可停止服务、删除 unit/sudoers/env/固定目录与账户；当前是 helper，不能把直接 `node` 调用宣称为完整已接线 CLI |
| [install-client-bootstrap.sh](install-client-bootstrap.sh) | Linux Bash 一键引导；Server Origin、受支持平台、root/sudo、下载工具 | 探测/准备运行时并进入系统安装或显式迁移；改系统前需专用环境验收 |
| [install-client-bootstrap.ps1](install-client-bootstrap.ps1) | Windows PowerShell 5.1+、x64、管理员；Server 预检与私有 Node 引导 | 下载运行时、修复 ProgramData ACL 并安装 SYSTEM 任务；不主动申请 UAC，必须预先提权 |
| [uninstall-client-bootstrap.sh](uninstall-client-bootstrap.sh) | Bash 下载 Server 的卸载资产并用可用 Node 执行 | 联网、临时文件、真实卸载；不能仅凭此入口推断所有 systemd helper 已接线 |
| [uninstall-client-bootstrap.ps1](uninstall-client-bootstrap.ps1) | 管理员 PowerShell；优先 ProgramData 私有 Node，下载执行卸载器 | 联网和真实 Windows 卸载，临时文件清理；必须核对目标 Server 与安装状态 |
| [install-coturn.sh](install-coturn.sh) | Linux TURN 部署；Bash、root、apt/dnf；source 时只加载函数 | 直接执行会安装软件、写 TURN 配置与 secret、操作服务和网络设置；不是纯探测脚本 |
| [upgrade-launcher.cjs](upgrade-launcher.cjs) | PM2 Launcher 升级；本地版本目录中的 Launcher、Node/PM2；支持 `--status` / `--dry-run` | 脱离当前进程执行停止、替换、重启及日志写入；无下载；不适用于所有部署形态 |
| [upgrade-launcher-systemd.cjs](upgrade-launcher-systemd.cjs) | 导出 systemd 升级计划/执行 helper；依赖 adapter 和 `systemd-run` | 在服务 cgroup 外切换文件、daemon-reload、restart；尚不能当作已完成端到端接线的独立 CLI |
| [tsconfig.json](tsconfig.json) | scripts TypeScript 项目配置，继承根配置，包含子目录 TS | 配置本身不执行程序；被类型检查/构建工具消费，增量缓存不是源码资产 |

## 4. build：构建与发布

| 文件 | 用途、入口与依赖 | 副作用与状态 |
| --- | --- | --- |
| [bundle-apps.ts](build/bundle-apps.ts) | 导出 Server/Client/Launcher esbuild 单文件打包 helper；发布脚本调用 | 写 dist bundle，原生/Prisma 依赖保持外置；不是独立发布入口 |
| [download-frp.ts](build/download-frp.ts) | `pnpm download:frp`；Node/TSX、网络、tar/PowerShell 解压 | 下载 frpc/frps 到 Server/Client dist，写 `.tmp/frp-download`；是外部二进制获取，不是离线测试 |
| [inject-version.cjs](build/inject-version.cjs) | 发布流程调用或 `node scripts/build/inject-version.cjs <x.y.z>` | 改根及 Shared/SDK/CLI/插件包版本、manifest、插件列表与运行时版本源码；不是只读检查 |
| [pack-release.ts](build/pack-release.ts) | `pnpm release --version=<x.y.z>`，可设 output / node-constraint；TSX、workspace 依赖、构建/下载工具 | 注入版本、全量构建、FRP 下载、最小依赖装配、CLI/插件构件、ZIP/hash；会改仓库版本和产物，不纳入默认回归 |
| [release-installer-assets.ts](build/release-installer-assets.ts) | 发布资产复制 helper；`copyInstallerAsset`，Node fs | 复制文件，Shell 资产换行规范化为 LF；仅 helper |

## 5. dev：开发辅助

| 文件 | 用途、入口与依赖 | 副作用与状态 |
| --- | --- | --- |
| [dev-client.cjs](dev/dev-client.cjs) | 开发命令调用 Client dist；Node、已构建 Client | 启动真实 Client，默认 app-dir 为 `.tmp/devapp`，转发信号；不创建已退役的 Agent 资源布局 |
| [ensure-frpc.cjs](dev/ensure-frpc.cjs) | Client prebuild；缺少当前平台二进制时补齐；网络/解压工具 | 下载、解压、chmod 并写 Client dist，清理下载临时目录；已有二进制时跳过 |
| [link-cli.cjs](dev/link-cli.cjs) | `pnpm vcpdeck:link`；支持 `--target` / `--dir` | 默认向 Node 所在目录覆盖两个 CLI 垫片，可能需目录写权限；不是 npm link |
| [wait-for-server.cjs](dev/wait-for-server.cjs) | 开发启动编排或导出 helper；轮询 `/api/health`，默认 `http://localhost:3001`，可设 `VCPDECK_SERVER` | 发送 HTTP 请求并等待，不启动 Server、不改数据库 |
| [start-test-frps.cjs](dev/start-test-frps.cjs) | 本地真实 frps 启动；Node、已下载 frps 或 `FRPS_BIN` | 真实监听端口、明文配置/日志、固定 Dashboard 测试凭据；使用方法和网络限制见 §2 |

## 6. tests：离线回归与公共 helper

Node 文件可用 `node --test scripts/tests/unit/<文件>.test.cjs` 单独运行；TS 文件用 `pnpm exec tsx scripts/tests/unit/<文件>.test.ts`。统一 Node/TSX 入口为 `pnpm test:scripts`；**Shell 不在该命令内**。夹具/adapter 测试只能证明其断言范围，不证明真实系统安装、云服务或跨网络可用。

| 文件 | 目的与依赖 | 副作用/状态 |
| --- | --- | --- |
| [prisma-config.test.cjs](tests/unit/prisma-config.test.cjs) | Prisma 配置默认值与 DATABASE_URL 覆盖；Node | 临时切换进程 env/require cache，不连接开发数据库 |
| [wait-for-server.test.cjs](tests/unit/wait-for-server.test.cjs) | health 重试/超时；Node HTTP | loopback 临时服务和端口，结束关闭 |
| [uninstall.test.cjs](tests/unit/uninstall.test.cjs) | 通用版本卸载与 current 指针；Node | 创建/删除临时目录和链接，不卸载真实应用 |
| [cli-shim.test.cjs](tests/unit/cli-shim.test.cjs) | CLI 垫片 MSYS 参数保护；Node 子进程 | 临时目录中运行 link-cli，写/删测试垫片 |
| [release-installer-assets.test.ts](tests/unit/release-installer-assets.test.ts) | 资产复制与 Shell LF 规范化；TSX | 临时文件复制/删除，不打发布包 |
| [upgrade-launcher.test.cjs](tests/unit/upgrade-launcher.test.cjs) | PM2 Launcher 升级夹具与 dry-run；Node | 临时目录及子进程，不操作真实 PM2/HOME |
| [integration-test-db.test.cjs](tests/unit/integration-test-db.test.cjs) | 隔离 DB 目录、URL/marker 校验和清理拒绝；Node | 临时文件写删，不重建开发库 |
| [uninstall-client-linux.test.cjs](tests/unit/uninstall-client-linux.test.cjs) | systemd 卸载计划、拒绝路径；Node、记录 adapter | 记录系统操作，不真实删账户/服务 |
| [upgrade-launcher-systemd.test.cjs](tests/unit/upgrade-launcher-systemd.test.cjs) | systemd 升级顺序与失败分支；Node、记录 adapter | 不执行真实 systemd 升级 |
| [uninstall-client.test.cjs](tests/unit/uninstall-client.test.cjs) | 安装状态/目录验证及卸载行为；Node、夹具 | 临时目录和模拟操作，不卸载本机 Client |
| [install-client-bootstrap.test.sh](tests/unit/install-client-bootstrap.test.sh) | Linux 引导发行版、参数与迁移判定；Bash、fixture | 临时文件与函数调用；单列运行，不下载/安装 Client |
| [install-client.test.cjs](tests/unit/install-client.test.cjs) | 一键安装参数、引导契约与编排；Node、夹具 | 临时文件/子进程及模拟依赖，不代表真机验收 |
| [install-coturn.test.sh](tests/unit/install-coturn.test.sh) | source coturn 纯函数，验证发行版/地址/IPv4；Bash | 临时夹具，不安装软件或改 TURN 服务；单列运行 |
| [install-client-linux.test.cjs](tests/unit/install-client-linux.test.cjs) | Linux A2 布局、权限、迁移/回滚、脱敏；Node、adapter | 临时目录和模拟系统操作，不创建真实 systemd 服务 |
| [agent-session-migration.test.cjs](tests/unit/agent-session-migration.test.cjs) | 保留历史显式迁移的映射、事务与幂等；Node、Server libsql | 独立临时 SQLite；不执行开发/生产迁移，也不恢复退役运行时 |
| [agent-migration-entrypoints.test.cjs](tests/unit/agent-migration-entrypoints.test.cjs) | 基础启动/安装/Release 不再自动执行 Agent 迁移；Node | 静态读取源码，不迁移数据库 |
| [agent-retirement-layout.test.cjs](tests/unit/agent-retirement-layout.test.cjs) | 退役 Agent 资源不再进入开发/发布布局；Node | 静态读取代码与依赖声明，不构建/发布 |
| [install-client-windows-system.test.cjs](tests/unit/install-client-windows-system.test.cjs) | Windows SYSTEM 任务、ACL/身份保留及迁移；Node、adapter | 临时夹具/记录调用，不改真实任务/ACL |
| [install.test.cjs](tests/unit/install.test.cjs) | ZIP 安装、SHA、布局和 Launcher 保留；Node、夹具 | 临时文件/目录，不进行真实安装 |
| [pack-release-deps.test.ts](tests/unit/pack-release-deps.test.ts) | node-datachannel 双平台外部依赖/平台裁剪；TSX | 读取配置/代码，不触发发布构建或网络下载 |
| [integration-test-db.cjs](tests/helpers/integration-test-db.cjs) | E2E 公共 helper；创建系统临时目录、随机 owner marker 与隔离 DATABASE_URL，调用 Prisma `db push` | 初始化和删除临时 SQLite；清理前校验归属/路径/URL，失败关闭；不是独立测试 CLI |

## 7. 跨进程与手工入口：必须显式选择

| 文件 | 目的、入口与依赖 | 副作用与已知边界 |
| --- | --- | --- |
| [test.cjs](tests/e2e/test.cjs) | `pnpm test`；真实 Server + mock/真实 Client、REST/WS；先构建 | 使用隔离临时 DB，但启动时强杀 `3001` 占用进程；仍有旧断言/原始 DELETE 等维护债，不能在开发 Server 并行运行 |
| [test-cli-capabilities.cjs](tests/e2e/test-cli-capabilities.cjs) | `pnpm test:cli`；真实 Server/Client、CLI dist；先构建 | 隔离 DB/假 HOME 与文件夹具，仍会停止 `3001` 占用者、执行真实 Client 文件/任务操作；不属于离线默认集 |
| [test-vcp-plugin.cjs](tests/e2e/test-vcp-plugin.cjs) | `pnpm test:vcp-plugin`；真实外部 VCPToolBox（`VCP_TOOLBOX_PATH`）、Server/Client/FRPS | 隔离 DB/沙箱，仍启动/终止真实进程、使用端口并临时装载插件；不是自包含离线测试 |
| [smoke-launcher.cjs](tests/e2e/smoke-launcher.cjs) | `node scripts/tests/e2e/smoke-launcher.cjs`；Launcher dist、PowerShell `Compress-Archive` | 临时构件/进程、`3999` 端口；仅局部更新/回退流程，部分失败出口可能绕过 finally，失败后人工核对残留 |
| [test-frp.cjs](tests/manual/test-frp.cjs) | `pnpm test:frp`；真实 frps/frpc、Server/Client dist | **使用开发库并删除全部 frpMappings**，强杀 `3001` 及测试 FRPS 相关端口进程；仅可丢弃专用环境运行，需先备份；缺二进制 SKIP 不算通过 |
| [test-aliyundrive.cjs](tests/manual/test-aliyundrive.cjs) | 手工 Node 调用；已启动 Server、管理员、真实 OAuth 与云盘 | 改目标 Server 的全局 Storage 后端/凭据，上传下载删除真实云对象；切回 local 为交互选择，不保证全局状态自动恢复 |
| [test-release-alibaba.cjs](tests/manual/test-release-alibaba.cjs) | 手工 Node 调用；构建/发布工具、Server/Client Launcher、真实 OAuth/云盘 | 自建临时 DB/构件并清理测试对象，但会真实打包（含版本注入）、启动更新和上传/删除云对象；3001 冲突要求人工停止；需专用账户，清理失败应人工复核 |
| [e2e-permanent-link.cjs](tests/manual/e2e-permanent-link.cjs) | 手工 Node 调用；`localhost:3001`、测试管理员及 Local Storage | 上传对象、签永久链接并输出签名信息；**没有实际执行 Server 重启**，早期失败可能以 0 退出且无完整对象清理，不能当 CI 可信通过信号 |
| [terminal-smoke.cjs](tests/manual/terminal-smoke.cjs) | 手工 Node 调用；在线 `smoke-client`、真实 PTY、socket.io-client、测试密码 | 创建真实终端/输入命令并输出 Cookie 前缀；连接/ACK 可能无界等待，无完整 finally 清理；只在专用 Client 运行 |
| [terminal-recovery-test.cjs](tests/manual/terminal-recovery-test.cjs) | 手工 Node 调用；固定 localhost、`smoke-client`、Windows cmd/PTY 环境 | 真实终端输入、断线重连和快照观察；未实际重启进程，ACK 无界等待、无完整会话清理，不能替代正式恢复验收 |

## 8. 已删除与维护规则

- 旧日志入口已删除：依赖过时的 WS/PSK 操作员模型，不作为当前日志入口。
- 旧 FRPS 实例探测脚本已删除：缺认证且会切默认实例；现有 Service 测试**不是**它的完整 HTTP/E2E 等价替代，相关验收仍需按 [测试策略](../docs/testing.md) 补齐。
- 被忽略的 TypeScript 增量缓存不属于源码，不纳入脚本清单或迁移。
- 新增脚本应同步本页用途、依赖、副作用和运行分组；涉及网络、真实数据库、云账户、进程终止、系统安装的脚本，不得默默加入默认离线回归。
- 分类只整理入口与边界，不声称修复本页列出的历史脚本风险；发布前按对应平台和真实环境单独验收。
