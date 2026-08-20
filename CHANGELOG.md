# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本采用[语义化版本](https://semver.org/lang/zh-CN/)。日期 `YYYY-MM-DD`。

## [Unreleased]

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
