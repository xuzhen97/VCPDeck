# 更新日志

VCPDeck 尚未发布稳定版本。本文件记录用户或运维人员可感知的变化；内部重构若不改变行为可以不单列。

格式参考 Keep a Changelog，版本采用语义化版本。日期使用 `YYYY-MM-DD`。

## [Unreleased]

### Added

- `scripts/install.cjs` 新增启动参数引导：TTY 交互（回车用强随机默认值）或 `--psk` / `--admin-password` / `--server-url` / `--client-id` / `--releases-dir` 显式传入，安装完成后写入 `<app-dir>/launcher.env`（Non-Windows 权限 600），启动变为一行 `node --env-file=<app-dir>/launcher.env <app-dir>/dist/main.js`；server 引导的 `DATABASE_URL` 同时驱动建库，`VCPDECK_RELEASES_DIR` 默认 `<app-dir>/releases`（版本目录外，避免自更新切换版本后漂移）；未显式传 `--app-dir` 时 Server 默认 `~/.vcpdeck/launcher`、Client 默认 `~/.vcpdeck/launcher-client`，避免同机安装冲突。`--no-env` 可跳过生成。
- 新增应用构件快速安装/卸载脚本 `scripts/install.cjs` / `scripts/uninstall.cjs`：一条命令完成发布包解压安装到 Launcher 版本目录、current 指针设置、Server 数据库初始化（`--db-url`）、多版本卸载与 current 重定向/清空；随附 node:test 单元测试；`docs/quickstart.md` 补充对应章节。
- 新增 `docs/quickstart.md`：从构建、解压部署、Launcher 启动到 Server/Client 通讯验证的端到端快速开始手册；`docs/index.md` 与 `docs/deployment.md` 增加对应入口。
- 根 `package.json` 新增 `release` script，可直接 `pnpm release --version=<x.y.z>` 生成发布构件，不再需要手动调用 `npx tsx scripts/pack-release.ts`。
- 建立长期维护文档体系：架构、技术栈、领域模型、协议、兼容性、部署、运维、安全、测试、ADR、路线图和专题/归档索引。

### Changed

- Frontend 构建产物打进 server 构件（`server/public/`），由 Server express.static 同源托管 + SPA 路由回退，访问 `http://<host>:3001/` 即驾驶台，无需单独静态托管/反向代理；socket.io 增加同源 CORS 放行（自定义 IoAdapter），跨源部署仍可显式配置 `VCPDECK_FRONTEND_ORIGIN`。见 `docs/adr/0013-frontend-bundled-with-server.md`。
- 发布 zip 不再内嵌安装/卸载脚本，`install.cjs` / `uninstall.cjs` 改为与 zip 平级提供于 `dist-release/` 目录（纯 Node 标准库，无仓库依赖）：消除“先解压 zip 拿脚本、脚本又依赖 zip 再解压一遍”的重复解压；发布 zip 现在同时包含 `launcher/`、`server/`、`client/`，首次安装自动将 Launcher 放入 `<app-dir>/dist/main.js`，已有 Launcher 默认保留。
- 发布构件改为 esbuild 单文件打包 + 最小外部依赖：业务代码与纯 JS 依赖内联，仅保留原生/引擎/SDK 依赖（Prisma 栈、libsql 双平台绑定、Pi SDK、node-pty 预编译）；单平台发布 zip 从约 513MB 降至约 120–130MB。
- 发布包改为按平台产出 `vcpdeck-x.y.z-win-x64.zip` / `vcpdeck-x.y.z-linux-x64.zip` 两份；Server 更新协议同步改造：Release 按平台归档（archives JSON）、上传接口带 `platform` 参数（两平台齐备才触发更新）、下载与客户端更新按目标机平台选包，CLI `release upload` 一次上传两个平台包。
- Client 终端后端依赖由 `node-pty`（需目标机编译）替换为 `@lydell/node-pty`（预编译多平台，随包分发）；已知限制：无 musl/Alpine 预编译。
- 发布包 manifest 的 server preStart 改为显式路径调用 prisma CLI（不依赖 PATH 中的 `.bin`），并随包携带 `prisma.config.cjs`。
- Launcher 解压支持 Linux 下的 `.zip`（unzip），并修复 `.tar.gz` 解压在 Windows 系统 bsdtar 下 `--force-local` 不兼容问题。

### Fixed

- 修复 Local Storage 相对 `baseDir` 随自更新版本目录漂移的问题：相对路径改为锚定到 `VCPDECK_APP_DIR`（版本目录外），与 `VCPDECK_RELEASES_DIR` 引导修复闭环；存量相对配置需按 ADR-0014 一次性搬迁旧文件。
- 修复 `scripts/download-frp.ts` 在 Windows 解压 `.tar.gz` 时使用 GNU tar 专属 `--force-local` 导致系统 bsdtar 报 “Option --force-local is not supported” 而发布打包失败的问题；现 Windows 统一使用系统 bsdtar 解压。
- 修复发布 zip 内容卫生：server 构件 frp 复制改为只取平台目录，不再把 tsc 中间产物与测试文件（如 `server/dist/frp/*.test.js`）打进发布包；win-x64 包同步排除 `@libsql/linux-x64-musl`，平台绑定裁剪与 linux-x64 对称。

### Security

- 明确 Client PSK 当前实际配置变量为 `VCPDECK_PSK`，示例中的 `VCPDECK_CLIENT_PSK` 尚未被代码读取。

### Migration

- 当前开发数据库和构件版本仍为 `0.0.0`，尚无稳定版本迁移承诺。

<!--
发布时：
1. 将 Unreleased 内容移动到 `## [x.y.z] - YYYY-MM-DD`；
2. 至少保留 Added / Changed / Fixed / Security / Deprecated / Removed / Migration 中适用的小节；
3. 在 Migration 写明数据库、配置、Launcher、协议和回滚限制；
4. 创建新的空 Unreleased。
-->
