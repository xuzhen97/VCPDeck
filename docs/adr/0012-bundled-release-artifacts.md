# ADR-0012：发布构件采用 esbuild 打包与最小外部依赖

- 状态：Accepted
- 日期：2026-08-16
- 决策者：项目维护者
- 关联：[`docs/design/release-and-update.md`](../design/release-and-update.md)、[`docs/deployment.md`](../deployment.md)、[`ADR-0003`](./0003-separate-launcher-for-updates.md)

## 背景

原发布构件把 `server/` 与 `client/` 的**整个生产 node_modules**（约 500MB、十余万文件）原样复制进 archive，再依赖构建机平台差异产出 zip/tar.gz。存在以下问题：

1. 体积与文件数不适合分发（一次发布 zip 约 513MB）；
2. 大量纯 JS 依赖（NestJS、socket.io、xterm、bcryptjs 等）本可编译进业务代码，无需保留为独立模块文件；
3. archive 格式随构建机变化（Windows 产 zip、Linux 产 tar.gz），但 Server 上传与 Launcher 下载都按 `.zip` 处理，Linux 路径从未端到端可用；
4. 原生依赖（node-pty）在 staging 安装时针对构建机平台编译，产出的包只能运行在与构建机相同的平台，与"单包跨平台分发"矛盾；
5. Windows 打包依赖系统 bsdtar 与 PowerShell 追加 zip 条目，跨平台打包脚本不可移植。

本 ADR 决定发布构件格式与打包管线，解决上述问题，同时保持 manifest 结构与 Launcher 行为不变。

## 决策

### 1. esbuild 打包业务代码

- `scripts/bundle-apps.ts` 用 esbuild 将业务代码与**全部纯 JS 依赖**内联为 CJS 单文件（与 tsc 产物模块格式一致）：
  - server：`dist/main.js`（含 NestJS 全套、socket.io、bcryptjs、dotenv、Prisma generated client 及其 WASM 查询编译器）；
  - client：`dist/index.js` + `dist/pi/worker.js` + `dist/probe-worker.js`（主进程与两个 fork worker 各自独立打包，保持 `fork(__dirname/...)` 入口语义）。
- 保留 tsc 全量构建作为类型检查门禁；esbuild 不承担类型检查。
- 不 minify，保证线上排障时可读。

### 2. 外部保留清单（staging 只安装这些依赖）

| 包 | 平台 | 理由 |
| --- | --- | --- |
| `prisma`（CLI）及传递依赖 | 纯 JS/WASM | preStart `db push`；Prisma 7 的 schema 构建已 WASM 化，无需下载原生 engine |
| `@prisma/client-runtime-utils`、`@prisma/adapter-libsql` | 纯 JS | generated client 运行时外部 require |
| `@libsql/client` + `libsql` + `@libsql/win32-x64-msvc` + `@libsql/linux-x64-gnu` | win32/linux x64 原生绑定 | SQLite 驱动唯一原生运行时依赖；双平台绑定随包 |
| `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` | 纯 JS | Pi SDK 大量动态 import 与子进程加载，bundle 收益低、风险高 |
| `@lydell/node-pty` + 双平台预编译包 | win32/linux x64 原生绑定 | 终端 PTY 后端 |

- `@vcpdeck/shared` 内联进各 bundle，不再作为独立依赖安装。

### 3. node-pty 后端替换为 @lydell/node-pty

- 原 `node-pty` 依赖 node-gyp 现场编译，无法跨平台分发；
- `@lydell/node-pty`（node-pty 的维护 fork，API 兼容）以 `@lydell/node-pty-<platform>` 可选依赖包发布预编译二进制，无需安装脚本、无需目标机构建工具；
- Windows 后端为 ConPTY（含 conpty.dll/OpenConsole.exe 随包），Linux 后端为 pty.node（预编译覆盖 Node ABI 115–147，覆盖 manifest 要求的 Node ≥24）；
- **已知限制**：预编译包不含 musl（Alpine）变体，Alpine 目标机需自行编译或不在支持范围；依赖为 beta 版本线（1.2.0-beta.x），升级时需要回归终端冒烟。

### 4. 单一 zip 格式 + 构建机无关打包

- 压缩改用纯 JS 库 `archiver`（根 devDependency），Windows/Linux/macOS 构建机产出同一 `.zip`，消除 tar.gz 全链路缺口；
- 每次发版产出**两份平台 zip**：
  - `vcpdeck-<x.y.z>-win-x64.zip` / `vcpdeck-<x.y.z>-linux-x64.zip`：仅含对应平台构件，既供手动分发（解压到 Launcher `apps/<version>/`），也供自动更新上传；
  - 不再产出 universal 包：双平台构件分离后体积更小，Server 更新流程按目标机平台选择对应包；
- linux 平台的 frpc/frps 裸 ELF 由 `.gz` 包装副本**内存解压**后直接写入 zip（不落盘，规避开发机杀毒删除裸 ELF）；`.gz` 副本仍随包作为冗余；
- 打包过程中不再调用 bsdtar / PowerShell / GNU tar，脚本可移植；
- Launcher 解压 `.zip` 在 Windows 用 Expand-Archive、Linux/macOS 用系统 `unzip`（目标机需可用）。

### 4.1 更新协议按平台归档

单一 universal 包被移除后，Server 更新链路按平台选择构件：

- `Release` 表由单归档列（sha256/fileName/size）改为 `archives` JSON（平台 → { sha256, size, fileName }），迁移见 `packages/server/prisma/migrations/20260816000000_release_platform_archives`；
- 上传接口按 `platform=win-x64|linux-x64` 分两次上传；两个平台构件齐备后才自动触发更新；
- 下载接口 `GET /api/releases/:version/file?platform=...` 按平台选包；
- 编排器：服务端自更新按本机 `process.platform` 选包；客户端逐台更新按注册上报的 `os` 映射平台（`win32→win-x64`、`linux→linux-x64`），不支持平台或构件缺失的客户端标记 failed 并跳过；
- CLI `release upload` 一次接收两个平台 zip 并依次上传。

### 5. staging 安装配置

- Launcher 入口由 esbuild 打为 `launcher/dist/main.js`，随两个平台 zip 分发；安装脚本首次安装到 `<app-dir>/dist/main.js`，已有 Launcher 默认保留，避免覆盖正在运行的稳定生命周期组件；
- staging 目录（OS 临时目录内）用 `pnpm install --prod --ignore-scripts --prefer-offline`；
- `pnpm-workspace.yaml` 写入 `nodeLinker: hoisted` 与 `supportedArchitectures: {os: [win32, linux], cpu: [x64]}`：
  - hoisted 保证 node_modules 是真实目录（无软链），zip 解压后模块可解析；
  - supportedArchitectures 允许在 Windows 构建机安装 linux 平台绑定包，实现单包双平台；
  - 注意 pnpm 11 起不再读取 package.json 的 `pnpm` 字段，必须写在 pnpm-workspace.yaml。

### 6. manifest preStart 调整

- preStart 由 `prisma db push` 改为 `node node_modules/prisma/build/index.js db push`：Launcher 以 shell 执行 preStart 时不保证 PATH 含 `node_modules/.bin`，直接以相对路径调用 CLI 入口，Windows/Linux 行为一致；
- server 构件额外携带 `prisma.config.cjs`（Prisma 7 CLI 强制要求 config 文件，且与运行时共用 DATABASE_URL 解析）。

## 不做的事

- 不把 Pi SDK、Prisma CLI 栈打进 bundle（动态加载与体积风险大于收益）；
- 不裁剪 prisma CLI 的 studio 等传递依赖（脆弱，收益有限，留作后续优化）；
- 不引入发布者数字签名（仍是 ADR-0003/当前文档已声明的非目标）；
- 不改变 manifest 结构、Launcher 解压与 Node 运行时选择逻辑；Launcher 作为首次安装构件随包提供，但不随业务版本自动覆盖。

## 后果

**正面**：

- 发布 zip 由约 513MB 降至约 150MB，业务代码文件数由数千降至 4 个 bundle；
- 单一 zip 同时含 win-x64 与 linux-x64 全部原生构件，跨平台分发不再依赖构建机；
- 目标机安装不再需要编译工具链或网络下载引擎（db push 为 WASM，libsql/node-pty 预编译随包）。

**风险与代价**：

- 发布运行的是 esbuild 产物，与开发 tsc 产物不同，必须依赖发布冒烟（server 启动 + /api/status、client 注册与能力上报、终端/Pi 探测）作为门禁；依赖升级（尤其 NestJS/Prisma/pi SDK/node-pty）后需重新跑冒烟；
- `@lydell/node-pty` 为 beta 版本线且无 musl 预编译，Alpine 目标机终端能力不可用；
- esbuild 对 NestJS 未安装的可选 peer（class-validator 等）保持 external，行为与现状一致（用到才报错）；
- 旧版本发布流程不再适用；回滚到旧包时 Launcher 行为不受影响（archive 仍是 zip + 原 manifest 结构）。
