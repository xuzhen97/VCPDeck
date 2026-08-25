# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本采用[语义化版本](https://semver.org/lang/zh-CN/)。日期 `YYYY-MM-DD`。

## [Unreleased]

### Fixed

- Client 一键安装生成的 PM2 ecosystem 现在过滤安装器进程继承的 `VCPDECK_*`，并通过 `launcher-env.cjs` preload 在启动时清除缓存值、主动加载 `launcher.env`，避免 PM2 缓存旧 `VCPDECK_SERVER` 后覆盖文件配置。

## [0.6.4] - 2026-08-26

### Changed

- Exec Job 现在明确区分正常非零退出、`EXEC_TIMEOUT` 与 `EXEC_SIGNALLED`；timeout/取消会终止完整进程树并保留已捕获输出，不再把无退出码的信号终止伪造成 `exitCode: 1`。
- Job 详情、CLI 与 Frontend 统一展示 Job 顶层远端 timeout；exec 基础设施错误完成后继续派发队列中的下一项。
- 远程命令执行文档、协议说明和 CLI Skill 同步更新 timeout、信号终止与进程树清理语义。

## [0.6.3] - 2026-08-25

### Added

- Windows 一键安装器（install-client.cjs）：开机自启注册在非管理员权限被拒时自动弹 UAC 提权补注册（自包含 EncodedCommand payload，任务名/参数不变；取消或失败降级并打印可直接执行的 schtasks 命令），普通权限安装不再需要二次操作。

### Changed

- CLI `jobs run --json --wait` 的 stdout 现在只包含最终 JSON，等待状态、命令边界警告和暂时网络错误统一写入 stderr；复杂 shell 命令推荐作为 `--` 后的单一参数，安全单 token 不再产生误报警告。
- CLI 的 Git Bash/MSYS shell 垫片默认禁用参数路径转换，避免 `/root/...` 等远端路径在启动 Windows `node.exe` 前被改写。

### Fixed

- 修复 `jobs run --timeout=<seconds>` 未转换单位、把秒数直接作为 Node.js 毫秒 timeout 下发，导致远端命令可能在几十毫秒后被提前终止的问题。

## [0.6.2] - 2026-08-24

### Added

- 新增 `scripts/upgrade-launcher.cjs` 一键升级 Launcher：材料取自本机已解压版本的 launcher payload，停守护→备份覆盖→重启→验证在线，失败自动还原、sha256 一致幂等跳过；随发版 zip 分发于 `client/installer/`，可经 `vcpdeck jobs run` 远程执行（deployment.md §9.8）。

### Changed

- Launcher 在 Windows 解压 zip 优先使用系统 bsdtar（`System32 ar.exe` 流式解压，较 PowerShell Expand-Archive 快数倍），失败自动兜底 Expand-Archive 并输出实际使用的解压器；Launcher prepare 新增下载（含体积）/校验/解压分项与总耗时日志。

## [0.6.1] - 2026-08-24

### Added

- CLI 新增 `vcpdeck frp mapping create/delete`：覆盖 TCP/HTTP/HTTPS、可选自动名称、实例/端口/域名与 1–300 秒确认时限；命令等待 Client frpc 动作和 FRPS Dashboard 双重确认后才成功，`--json` 输出稳定结果。
- FRP 映射新增 `provisioning/deleting/error` 收敛状态、同实例 proxy name 唯一约束和 `operationJobId`；创建确认失败自动回滚，删除确认成功后才移除控制面记录。

### Fixed

- 修复 FRP 创建在 `spawn(frpc)` 后立即误报 active、删除先删数据库导致孤儿 proxy 和内部 Job 无法终结的问题；Client 启动/重启失败会恢复内存 registry 与旧 frpc 配置，Dashboard 故障按未确认收敛而不让 Job 永久卡住。
- CLI 修复 `terminal attach` 重连后沦为只读的问题：Server 对 operator 断开设计有 30 秒重连保护期，期间须携带 reconnectToken 才能恢复可输入模式——CLI 此前未保存也未回传该令牌，导致退出后 30 秒内重连只能拿到 viewer（画面正常但键盘无效）。现令牌持久化于配置目录并在 attach 时自动回传。

## [0.5.0] - 2026-08-23

### Added

- CLI 新增 `vcpdeck terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>]`：创建终端会话（缺省选默认 Shell），输出 sessionId 与 attach 连接命令——纯命令行完成建会话到 TUI 直连全流程，无需经 Frontend。
- CLI 新增 `vcpdeck completions bash|powershell`：生成 Shell 补全脚本——覆盖顶层命令、各域子命令、常用 flag 与生成时嵌入的已配置环境名（`--env=` 候选，零网络请求）；环境增删后重新生成。
- 新增 `pnpm vcpdeck:link`（scripts/link-cli.cjs）：将 CLI 安装为全局 `vcpdeck` 命令——向 Node 可执行目录写入 CMD/PowerShell 与 Git Bash 两个垫片，不经 npm/pnpm link、不触碰 pnpm store；支持 `--target=`/`--dir=` 定制。
- 新增远程一键安装脚本 `scripts/install-cli.cjs`：仅有 Node 18+ 的联网机器可用单条 `node -e 'fetch(…).then(eval)' -- --tag=<版本>` 从 GitHub raw 下载随 tag 提交的单文件 CLI 包并生成垫片、自动配置 PATH、自验收；Windows/POSIX 双端。

### Fixed

- 安装器内建三次重试与 jsDelivr 镜像回退，网络错误与 404 分类提示（此前单次失败即中止且提示误导）。

### Documentation

- README「从 GitHub 安装」补充 CLI 全局命令安装与 Tab 补全；design/cli.md 新增 §16 全局安装与 Shell 补全、修正 §10 终端边界与 §15 过时清单；operations.md 新增「Client PM2 进程丢失」处置。

## [0.4.0] - 2026-08-23

### Fixed

- CLI 修复 `terminal` 命令组未接入分发入口的问题：shells/list/close/attach 已实现并有单测，但入口未路由导致实际二进制报“未知命令”，现已在 `vcpdeck --help` 与分发中接入。
- CLI 修复 `files download` 在本地存储后端下的签名下载地址为相对路径导致请求失败的问题：现按环境 Server 地址拼接（外部 Provider 绝对直链不受影响）。

### Added

- CLI 新增 `vcpdeck terminal attach`：本地终端 raw mode 直连远端 PTY（经 /app 数据面与 Bearer 握手认证），TUI 体感与 SSH 一致，Ctrl+Q 退出；决策见 ADR-0020。
- CLI 新增 `vcpdeck pi attach`：交互式对话 REPL 驱动远端 Pi 子任务——每行提示词下发、等待完成后取回助手回复、循环继续；支持 /abort、/state 内建命令与 /exit 退出。
- CLI 新增 `vcpdeck terminal shells/list/close`：Shell 探测与会话生命周期管理（关闭为写操作需确认门）；交互式 PTY 输入输出保留在 Frontend（Socket.IO），CLI 仅管理生命周期。
- CLI 新增 `vcpdeck pi models/sessions/new/run/abort`：在目标机驱动 Pi Agent 执行子任务——prompt 提交后轮询 agent.state 至 idle，从会话上下文提取最后一条助手文本回复；缺省自动创建新会话，`--session` 复用既有会话；扩展输入等待时明确报错（需到 Frontend 处理）。写操作需最强确认门。
- CLI 新增 `vcpdeck frp instances/mappings` 与 `vcpdeck storage status`（只读）：FRP 服务实例/映射状态查询（凭据字段安全投影，token/密码绝不进入输出）与存储后端状态；映射支持 `--client` 名称/ID 过滤。
- 新增 CLI 能力端到端测试脚本 `scripts/test-cli-capabilities.cjs`（`pnpm test:cli`）：真实 Server + Client 上驱动 CLI 构建产物逐域验证（clients/jobs 失败闭环/files 全周期与直传往返/frp/storage/terminal/pi/错误路径），临时物全部隔离在 `.tmp/cli-e2e/`；AI Agent 会话运行需以操作者同意文本设置 `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`。

## [0.3.0] - 2026-08-22

### Fixed

- 修复 Launcher 自动下载 Node 运行时后 spawn ENOENT 的死循环：官方压缩包解压后的顶层目录（`node-v<version>-<plat>-<arch>`）未归一化为缓存标准布局 `node-<version>`，导致返回的路径永远不存在，目标机在系统无合格 Node 时反复崩溃重启、无法上线；现解压后归一化目录并校验二进制存在，缓存扫描跳过二进制缺失的损坏条目。

### Added

- 引入 Biome 作为仓库 lint 门禁：`pnpm lint` 覆盖 `packages/*/src` 与 `scripts`（仅 linter，不含格式化）；错误级诊断阻塞，存量风格/测试类噪音规则降级为 warning 并记录为技术债。修复全部存量错误（可选链不安全用法、void 返回、pi-panel hook 顺序缺陷、a11y 基础项）。
- CLI 新增 `vcpdeck files download/upload`（写操作，需确认门）：文件传输走 Storage Provider 直传链路——download 导出后经短期签名 URL 拉取并校验 sha256（不一致删除本地半成品）；upload 经 upload-sessions 协商后分片直传 Provider（403 仅刷新该分片 URL），由 Client 从存储拉取导入；字节流不经过 Server。
- CLI 新增 `vcpdeck files write/mkdir/delete/move`（写操作，需确认门）：覆盖写（原子 tmp+rename，内容来自 `--input` 或 stdin 不进 argv）、递归建目录、删除（不可恢复，非空目录需 `--recursive`）、移动重命名（目标存在默认拒绝，`--overwrite` 解锁）；失败带稳定错误码。Skill 确认门扩展到文件域（删除/覆盖影响单独强调）。
- CLI 新增 `vcpdeck files roots/list/stat/read`（只读）：授权根探测（多根 fail closed）、目录列表、元信息与文本读取（默认上限 256KB），失败带稳定错误码；`--json` 输出纯 JSON 供 Agent 解析。文件传输后续必须复用 Storage Provider 直传链路，不经 Server 中转。
- CLI 新增 `vcpdeck jobs run/cancel`（写操作）：在指定机器上执行 shell 命令（exec command 模式，`--` 分隔符保护命令 token），`--wait` 轮询终态且失败时自动带出错误摘要与完整 stdout/stderr 现场（非零退出）；取消请求返回 Server 权威状态。同步在 vcpdeck Skill 中确立写操作确认门（展示环境/机器/命令/影响并取得用户明确确认）。参数解析器支持 `--` 分隔符。
- Job 失败根因闭环：Server 在 Client 实时上报 stdout/stderr 时旁路落盘到 `data/job-outputs/<jobId>.log`（完整保留不封顶、无自动清理），新增只读端点 `GET /api/jobs/:id/output`；SDK 新增 `jobs.output()`。
- CLI 新增 `vcpdeck jobs list/get`（只读）：分页查询 Job、按机器名/ID 与状态过滤，`get` 展示错误摘要与完整失败现场输出；`--json` 输出纯 JSON 供 Agent 解析。同步更新 vcpdeck Skill（含失败诊断流程）与 CLI/部署文档。

## [0.2.5] - 2026-08-21

### Fixed

- 修复 Client 一键安装在 Windows 上无法安装 PM2 的问题：安装器此前优先直接 spawn `npm.cmd`，Node 18.20+ 因 CVE-2024-27980 防护返回 EINVAL 且无任何输出，导致四个 registry 尝试全部静默失败；现改为用 `node + npm-cli.js` 执行 npm，全局 `pm2.cmd` 也解析为 `node + bin/pm2` 执行，并把进程启动错误纳入失败摘要。

## [0.2.4] - 2026-08-21

### Fixed

- 修复 Client 一键安装的 Windows 引导脚本通过 `node -e` 传递探测表达式时，Windows PowerShell 5.1 删除 JavaScript 内嵌引号，导致已满足要求的 Node.js 24+ x64 被误判为不可用并反复下载的问题。

## [0.2.3] - 2026-08-21

### Fixed

- Launcher 在 Windows 上拉起 Client 时未设置 `windowsHide`，导致 Client 控制台以可见黑窗出现（用户关闭窗口会杀死 Client 并被再次拉起、再弹新窗）；现已隐藏，并同步覆盖更新解压（powershell/tar/unzip）、frpc 守护与 Job 命令执行等子进程。
- Client 一键安装生成的 PM2 ecosystem 增加 `windowsHide`，Launcher 自身不再可能弹出控制台。

## [0.2.2] - 2026-08-21

### Fixed

- Client 一键安装：PM2 安装失败时每个 registry 尝试一次重试，并把真实 npm/网络错误透出到错误摘要，不再只报“国内与官方 registry 均无法安装 PM2”。
- Client 一键安装：先等待 Client 上线验收，再配置开机自启；非管理员无法创建根目录计划任务时，安装不再整体失败，而只降级为“未配置自启”的明确警告（安装仍成功），以管理员身份重跑可补齐自启。

## [0.2.1] - 2026-08-21

### Fixed

- 修复启用阿里云存储后 Release 构件仍先完整上传到 Server、再由 Server 转存，导致大构件受 Node.js HTTP 请求接收时限影响且占用 Server 带宽与临时磁盘的问题。
- CLI 现在先创建持久化 Release 上传会话，再把 zip 分片直接 PUT 到阿里云盘；分片 URL 失效时经 Server 刷新，完成后由 Server 合并、登记 Release 并触发既有自更新编排。

### Security

- 阿里云后端强制使用 Release 直传会话，旧 raw 上传入口在读取构件正文前拒绝；预签名 URL 仅通过 `no-store` 响应返回，不写入数据库、日志或错误。
- Provider 原始错误归一化为稳定安全摘要；CLI 日志只显示平台、SHA-256 前缀和百分比，不输出预签名 URL 或凭据。

### Migration

- 新增持久化 `ReleaseUploadSession`，保存版本、平台、声明 SHA-256/大小、Provider file/upload id、分片大小、操作者与有效期，不保存预签名 URL。
- Local Storage 继续使用 Server raw stream 上传；从不支持直传协议的旧 Server 首次升级仍可使用 legacy 引导，升级后 Alibaba Release 上传必须直连。

## [0.2.0] - 2026-08-21

### Added

- `/releases` 新增默认关闭、持久化的 Client 一键安装入口，为 Windows x64 和 Linux x64/glibc/systemd 提供固定命令；自动准备 Node.js、Client、Launcher、PM2、自启并等待 Server 验收。
- SDK 新增 `clientInstaller` API；发布构件的 Server 目录携带 PowerShell/Bash 引导和统一 Node.js 安装器。

### Security

- 一键安装命令与公开脚本不包含 PSK；启用入口后 bootstrap 会向任何可访问 Server 的机器返回现有共享 PSK，禁用只关闭后续安装，不撤销已有 Client 或已泄露凭据。

### Migration

- 新增默认 `enabled=false` 的 `ClientInstallerConfig` 单例配置。升级后需在 `/releases` 显式启用；已有 Client 和自更新不受影响。

## [0.1.2] - 2026-08-20

### Added

- CLI 新增 `release status <version>`、`release wait <version>` 和 `release upload ... --wait`，同时核对 Server 版本、Release 状态与逐台 Client 明细。

### Fixed

- 修复发布上传后只能依赖 `/api/status.activeRelease` 或浏览器人工核对、无法区分 Client 失败的问题；Release failed、Client failed、终态不一致和超时现在均返回非零退出。
- 等待 Server 重启时只重试安全 GET，并使用显式 `AbortController` 清理请求超时，避免临时轮询脚本在 Windows 退出时触发 libuv 句柄断言。

## [0.1.1] - 2026-08-20

### Added

- CLI 新增只读 `env check`：复用 SDK 请求 `/api/auth/me`，验证 Server、凭据和 Token 对应身份，输出不包含 Token。

### Changed

- 新命名环境改为 Token-first：在 Frontend `/settings/tokens` 创建专用 Token 后，`env add --token-env=<VAR>` 自动使用 Bearer；CLI 与 SDK 可共用该 Token，个人资料修改用户名不影响身份。`--auth=bearer` 和既有 password 环境保持兼容。
- Pi Skill、CLI Help 与运维文档不再把 bootstrap 管理员密码作为生产 CLI 首选凭据。

### Fixed

- 修复 CLI 默认引导使用用户名/密码，导致 `/settings/profile` 修改用户名后环境持续返回 401 的问题。

## [0.1.0] - 2026-08-20

首个对外版本：Server 控制中心 + Client 出站代理的远程驾驶台闭环，含命令/脚本、文件、FRP、终端、Pi 会话、身份认证、自更新、React 驾驶台与 SDK。

### Added

- 支持从同一 Git Tag 以 pnpm 10.26+ 安装 `@vcpdeck/sdk` / `@vcpdeck/shared` 子目录，安装期生成未提交的 `dist` 与类型声明。
- Pi Skill 可通过 `pi install git:github.com/xuzhen97/VCPDeck@vX.Y.Z` 用户级安装；`vcpdeck.cjs` 随 Tag 提交并支持不同项目 cwd 的 `.vcpdeck.json` 环境选择。
- CLI 多环境配置（ADR-0017）：`env add/list/show/current/use/remove` 管理 `~/.vcpdeck/cli/config.json`，按 `--env` → `VCPDECK_ENVIRONMENT` → 项目配置 → 全局默认解析，凭据只保存环境变量名。
- SDK 新增 Cookie 登录会话与 Release 流式上传；`release upload` 校验两平台构件版本一致且互补。
- 发布构件接入 Storage Provider 直连分发（ADR-0016）：zip 转存外部存储（阿里云盘等），下载统一走 `GET /api/releases/:version/file` 并 302 到临时直链，目标机直连存储不占 Server 带宽；Local 后端行为不变。
- Server 端口可用 `VCPDECK_PORT` 覆盖（默认 3001，非法值启动即退出）；`install.cjs --port` 安装时写入。
- 新增 `scripts/install.cjs` / `uninstall.cjs` 一键安装卸载：TTY 引导或 `--psk` / `--admin-password` / `--server-url` / `--client-id` 显式传参，写入 `<app-dir>/launcher.env`（权限 600）；支持 `--db-url` 建库、多版本卸载与 current 重定向。
- 新增 `docs/quickstart.md` 端到端快速开始手册及长期文档体系（架构/协议/部署/运维/安全/ADR 等）。
- 阿里云盘真环境一键集成测试 `scripts/test-release-alibaba.cjs`：打包、安装、上传、自更新全链路自动验收。

### Changed

- `pnpm release --version=x.y.z` 同步 SDK、Shared、CLI 和运行时版本，冻结校验 lockfile，构建并冒烟验证 Skill CLI；Git commit/Tag/push 仍由维护者确认。
- 发布包改为 esbuild 单文件打包，按平台产出 win-x64 / linux-x64 两份 zip，体积约 513MB → 120–130MB；根 `package.json` 新增 `pnpm release --version=<x.y.z>` 一键打包。
- 发布 zip 内嵌 launcher/server/client 三构件，install/uninstall 脚本与 zip 平级提供，安装时自动放置 Launcher。
- Frontend 打进 server 构件由 Server 同源托管，访问 `http://<host>:3001/` 即驾驶台，无需单独静态托管。
- 更新协议按平台归档（archives JSON），两平台上传齐备才触发更新，客户端按目标机平台选包。
- Client 终端依赖 `node-pty` → `@lydell/node-pty`（预编译随包分发；已知限制：无 musl/Alpine 预编译）。
- Server preStart 改为显式路径调用随包 prisma CLI；Launcher 解压支持 Linux zip 与 Windows bsdtar。

### Fixed

- 修复自更新误判：`/prepare` 改为立即受理后台下载，`/apply` 后以新进程重启对账为准；下载超时 5 → 15 分钟；Server 重启窗口内旧版本重连自动重发更新。
- 修复 `--app-dir` 安装时自更新控制通道连错路径，以及 Local Storage 相对路径随版本目录漂移（改为锚定 `VCPDECK_APP_DIR`）。
- 修复 Windows 发布打包：bsdtar `--force-local` 不兼容、安全软件误删 frp 裸 ELF（改从 `.gz` 内存注入 zip）、发布包混入测试产物与多余平台绑定。

### Security

- 明确 Client PSK 实际配置变量为 `VCPDECK_PSK`（`VCPDECK_CLIENT_PSK` 尚未被代码读取）。

### Migration

0.1.0 是首个版本，无既有部署升级路径。首装凭据与 `DATABASE_URL` 由 `install.cjs` 引导写入 `launcher.env`；`VCPDECK_APP_DIR` 决定控制通道与存储锚点；改端口用 `VCPDECK_PORT`。当前生产路径仍含 `db push --accept-data-loss`，仅适用个人/测试环境。卸载用 `uninstall.cjs`；自更新失败可手动回切 `current` 指针。
