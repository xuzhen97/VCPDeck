# VCPDeck 部署指南

> 状态：Current｜维护责任：发布/运维维护者｜最后核验：2026-08-15｜适用版本：当前 `main`

本文描述当前可验证的部署边界。项目尚未提供容器镜像或 systemd/Windows Service 安装器；发布 zip 含 Launcher，并由安装脚本自动部署，生产常驻由 Launcher 或外部服务管理器负责。

> 首次部署的端到端演练（构建 → 解压 → 配置 → 启动 → 验证通讯）见 [`quickstart.md`](./quickstart.md)。

## 1. 部署拓扑

最小部署包含：

- 一台控制面主机：Server、SQLite、可选 Local Storage、Server Launcher；
- 每台目标机器：Client、Client Launcher、frpc、Pi/PTY 运行环境；
- 可选 FRPS 实例；
- 可选阿里云存储后端。

Frontend 构建产物随 server 构件分发并由 Server 同源托管（`server/public/`，[ADR-0013](./adr/0013-frontend-bundled-with-server.md)）：控制面主机无需单独静态托管；开发者模式仍由 Vite :5173 提供。

Client 主动连接 Server，因此目标机器无需向 Server 开放入站控制端口。

## 2. 运行要求

- pnpm workspace 开发/源码部署；
- Node.js 24+（发布 manifest 默认 `>=24`）；
- Server 需要可写的数据库、Storage 和 Release 目录；
- Client 的远程 Pi 依赖本机 Pi 配置、模型认证和受支持 Shell；
- 交互式终端依赖 `@lydell/node-pty` 预编译后端（随包携带 win-x64/linux-x64 预编译，Linux 仅 glibc；Alpine/musl 目标机终端能力不可用）；
- FRP 能力需要匹配平台的 frpc/frps 构件（win-x64 与 linux-x64 均随包）；
- 目标机不再需要编译工具链或网络下载依赖引擎（详见 ADR-0012）。

## 3. 构建

```bash
pnpm install
pnpm build
```

开发模式：

```bash
# Server + Frontend
pnpm dev

# Server + Frontend + Client
pnpm dev:all
```

生产构件统一为 zip，每次发版产出两份按平台分开的包（详见 [ADR-0012](./adr/0012-bundled-release-artifacts.md)）：

```bash
pnpm release --version=x.y.z
```

- `dist-release/vcpdeck-x.y.z-win-x64.zip` / `vcpdeck-x.y.z-linux-x64.zip`：对应平台构件（均含 `launcher/`、`server/`、`client/`），既供手动分发，也供自动更新上传（两个平台各上传一次）；首次安装时 Launcher 放入 `<app-dir>/dist/main.js`，已有 Launcher 默认保留；
- 业务代码为 esbuild 单文件，仅原生/引擎/SDK 依赖保留为 node_modules。Linux 目标机自动更新依赖系统 `unzip` 命令（手动分发无此要求）。发布前应完成发布验收冒烟（Server 启动与 `/api/status`、Client 注册与能力上报、终端与 Pi 探测），不建议将工作区源码目录直接当作长期版本目录。

## 4. 配置

### 4.1 Server

> 使用 `install.cjs`（与发布 zip 平级提供于 `dist-release/`）安装时，脚本会从 zip 自动安装 Launcher 到 `<app-dir>/dist/main.js`，引导生成 `VCPDECK_PSK`、`VCPDECK_ADMIN_PASSWORD`、`DATABASE_URL`、`VCPDECK_RELEASES_DIR`（可选 `VCPDECK_PORT`，见下方 `--port`）并写入 `<app-dir>/launcher.env`（敏感值 Non-Windows 权限 600）；启动命令由脚本打印为 `node --env-file="<app-dir>/launcher.env" "<app-dir>/dist/main.js"`；下表为手铺环境变量时的完整清单。`install.cjs` 支持 `--port=<1-65535>` 覆盖 Server 监听端口（写入 `VCPDECK_PORT`）；改端口时需同步 client `--server-url` 与 Server Launcher `VCPDECK_PROBE_URL`，见 quickstart §3.1。

| 变量 | 当前默认/要求 | 说明 |
| --- | --- | --- |
| `VCPDECK_ADMIN_USERNAME` | `admin` | 首个管理员用户名 |
| `VCPDECK_ADMIN_PASSWORD` | 首次启动必填 | 仅无 admin 时用于 bootstrap；不得保留示例密码 |
| `VCPDECK_FRONTEND_ORIGIN` | `http://localhost:5173` | CORS 和 `/app` Origin |
| `VCPDECK_SESSION_TTL_SECONDS` | `604800` | 浏览器会话 TTL |
| `VCPDECK_COOKIE_SECURE` | 未设时为 `true` | HTTP 开发环境需显式 `false`；生产必须 HTTPS + true |
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite URL；相对路径依赖 Server 工作目录 |
| `VCPDECK_RELEASES_DIR` | `./data/releases`（install 引导默认 `<app-dir>/releases`） | **Local 后端**的发布构件目录；必须为**版本目录外绝对路径**，否则自更新切换版本后目录漂移、构件丢失。配置外部存储后端（OSS/网盘）后，发布包转存 Provider，此目录不再承载新构件 |
| `VCPDECK_PSK` | `vcpdeck-dev-psk` | `/client` PSK，生产必须随机替换 |
| `VCPDECK_CORS_ORIGIN` | `http://localhost:5173` | `/client` Gateway CORS Origin |
| `VCPDECK_PORT` | `3001` | Server 监听端口（1–65535 整数）；改端口时必须同步配置 Client `VCPDECK_SERVER` 与 Server Launcher `VCPDECK_PROBE_URL` |

**已知配置不一致：** 根目录和 `packages/server/.env.example` 目前写的是 `VCPDECK_CLIENT_PSK`，但 Server 与 Client 实际代码都读取 `VCPDECK_PSK`；`VCPDECK_CLIENT_PSK_FILE` 当前也未实现。部署必须设置 `VCPDECK_PSK`，不要依赖示例中的旧变量。

Server 默认监听 `3001`，可用 `VCPDECK_PORT` 覆盖。改端口时三处必须同步（默认均为 3001）：Client 的 `VCPDECK_SERVER`、CLI 环境注册的 Server origin（或兼容 `--server`）、Server Launcher 的 `VCPDECK_PROBE_URL`；浏览器驾驶台随之访问 `http://<host>:<port>/`。

### 4.2 CLI 多环境配置

CLI 用户级环境注册表位于 `~/.vcpdeck/cli/config.json`，项目默认环境选择器为从当前目录向上查找的最近 `.vcpdeck.json`。项目文件只能保存环境名，不能保存 Server 或凭据；完整命令、优先级和故障边界见 [`design/cli.md`](./design/cli.md) 与 ADR-0017。

先在 Frontend `/settings/tokens` 创建专用 CLI Token，将明文只保存到本机 `VCPDECK_DEV_TOKEN` 环境变量，再注册环境：

```bash
node packages/cli/dist/index.js env add dev \
  --server=http://127.0.0.1:3001 \
  --token-env=VCPDECK_DEV_TOKEN
node packages/cli/dist/index.js env use dev --global
node packages/cli/dist/index.js env use dev --local   # 写入最近项目/Git 根 .vcpdeck.json
node packages/cli/dist/index.js env current
node packages/cli/dist/index.js env check
```

Token 是与 Identity 关联的服务端 Credential，CLI 与 SDK 可共用；修改个人用户名不会使 Token 失效。Token/兼容密码的真实值只放在相应环境变量。用户级配置应限制读取并纳入本机配置备份，不得提交 Git；项目 `.vcpdeck.json` 不含秘密，可按项目需要提交。

### 4.3 Client

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VCPDECK_SERVER` | `http://localhost:3001` | Server 基址，不含 `/client` |
| `VCPDECK_PSK` | `vcpdeck-dev-psk` | 必须与 Server 一致 |
| `VCPDECK_CLIENT_ID` | 自动生成 | 可选固定 ID；默认保存在 `~/.vcpdeck/client-id` |
| `VCPDECK_FRPC_PATH` | 随构件探测 | 自定义 frpc 路径 |
| `VCPDECK_FRPC_WORK_DIR` | Client 默认目录 | frpc 配置/运行目录 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | 远程 Pi 配置与 Session 根目录 |

Client 使用运行账户的权限执行命令、文件、PTY 和 Pi。应为其创建权限受控的专用账户，不能仅依赖 UI 确认。

### 4.4 Launcher

| 变量 | 默认/要求 | 说明 |
| --- | --- | --- |
| `VCPDECK_APP_DIR` | Server：`~/.vcpdeck/launcher`；Client：`~/.vcpdeck/launcher-client` | Launcher 状态、Node 缓存和 apps 目录；同机 Server/Client 使用不同默认目录 |
| `VCPDECK_ARTIFACT` | 必填 | `server` 或 `client` |
| `VCPDECK_PROBE_URL` | `http://127.0.0.1:3001/api/status` | Server 探活地址 |

Launcher 首次启动要求 `apps/current` 已指向可用初始版本。发布 zip 同时包含 `launcher/`、`server/`、`client/`；快速安装/卸载脚本（`install.cjs` / `uninstall.cjs`）与 zip 平级于 `dist-release/` 目录，仓库内为 `scripts/`，见 [`quickstart.md`](./quickstart.md) §3.1–3.2。安装后 Launcher 位于 `<app-dir>/dist/main.js`；安装脚本默认使用 Server `~/.vcpdeck/launcher`、Client `~/.vcpdeck/launcher-client`，显式 `--app-dir` 时可覆盖。Client 还可从 `/releases` 启用一键安装，由平台引导脚本补齐 Node.js、PM2 和自启；Server 系统服务仍由运维准备。

### 4.5 FRPS 迁移配置

当数据库中不存在 FRPS 实例时，Server 可从下列变量迁移默认实例：

- `FRP_PUBLIC_HOST`
- `FRPS_BIND_PORT`
- `FRPS_TOKEN`
- `FRP_DASHBOARD_SCHEME/HOST/PORT/USER/PASSWORD`
- `FRP_PORT_RANGE_START/END`

迁移后以数据库配置为准。不要长期同时维护两份不同配置。当前缺省迁移会使用 `test-frp-token` 和 Dashboard `admin/admin` 等开发默认，生产首次启动必须显式覆盖并在 API 中 probe 验证。

FRPS Token 和 Dashboard 密码当前明文存入 SQLite、通过实例 REST 返回，并写入 Job payload 和 Client `frpc-combined.toml`。相关数据库、备份、Client 工作目录和页面访问都必须限制。Server 虽可保存多个实例，但同一 Client 当前只有一个 frpc runtime；不要为同一 Client 创建跨多个 FrpsInstance 的活动映射。完整边界见 [`design/frp.md`](./design/frp.md)。

### 4.6 使用 PM2 托管 Launcher（可选）

项目不提供 systemd/Windows Service 安装器。除手工 `node` 运行外，可用 PM2 等外部进程管理器守护 **Launcher** 进程；业务进程（Server/Client）仍由 Launcher 拉起、切换与回退，不要把业务进程交给 PM2。

基本约束：

- **只托管 Launcher**。若把 `apps/<version>/server/dist/main.js` 或 `client/dist/index.js` 交给 PM2，自更新时 Launcher 会主动停止业务进程再启动新版本，PM2 会将其误判为崩溃并强行拉起，破坏版本切换与失败回退；
- 使用 **fork 模式、单一实例**：Server 是单控制面节点（默认 3001 端口，可用 `VCPDECK_PORT`/`--port` 覆盖，仍不支持多实例/cluster）；
- 与安装时相同的运行账户和 `--app-dir`，保证 `launcher.env` / `control.json` / `apps/` 的读写权限一致。

`ecosystem.config.cjs` 示例（路径替换为实际绝对路径；Windows 用 `C:/...`，Linux 用 `/opt/vcpdeck/...`）：

```js
module.exports = {
  apps: [
    {
      name: "vcpdeck-server-launcher",
      script: "C:/vcpdeck/launcher/dist/main.js",
      interpreter: "node",
      node_args: "--env-file=C:/vcpdeck/launcher/launcher.env",
      cwd: "C:/vcpdeck/launcher",
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 15000,
    },
    {
      name: "vcpdeck-client-launcher",
      script: "C:/vcpdeck/launcher-client/dist/main.js",
      interpreter: "node",
      node_args: "--env-file=C:/vcpdeck/launcher-client/launcher.env",
      cwd: "C:/vcpdeck/launcher-client",
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 15000,
    },
  ],
};
```

```bash
pm2 start ecosystem.config.cjs
pm2 save            # 保存进程列表，重启机器后按保存列表拉起
pm2 logs vcpdeck-server-launcher --lines 100
```

Linux（Bash）路径版本：把示例中的 `C:/vcpdeck/launcher` 换成 `/opt/vcpdeck/launcher` 即可；`pm2 startup` 会生成 systemd 自启脚本。

开机自启：手工部署时 Linux 运行 `pm2 startup` 并按提示执行输出的命令。Client 一键安装会自动为 Linux 注册 PM2 systemd startup；Windows 不依赖第三方 `pm2-windows-startup`，而是创建当前用户登录触发的计划任务执行 `pm2 resurrect`，因此无人登录时不保证 Client 在线。

注意事项：

- PM2 收集的 stdout/stderr 同样受 [`operations.md`](./operations.md) §4 的敏感信息规则约束；
- 更新进行中**不要**重启 Launcher：进行中的 prepare/`pendingVersion` 存在 Launcher 内存，重启即丢失，`/apply` 会报“尚未 prepare”，Release 失败后需发布新版本重试；日常非更新窗口重启无影响，Launcher 会按 current 重新拉起业务进程并重写 `control.json`（新随机端口/Token 对业务进程透明）；
- `kill_timeout` 只作用于 Launcher 本身；业务进程的停止由 Launcher 自己的 SIGTERM→10s→SIGKILL 流程负责；
- Windows 下 PM2 的服务化与自动重启行为与 Linux 有差异；Client 一键安装的明确语义是当前用户登录后恢复，不是 Windows Service。

### 4.7 从 `/releases` 一键安装 Client

任意已登录操作者可在发版页启用或禁用入口。入口默认关闭，状态保存在 SQLite；启用后页面按当前 Origin 显示固定 Windows PowerShell 和 Linux Bash 命令。命令每次动态选择与 Server 版本完全一致、状态为 `done` 且含对应平台 archive 的 Release。

安装器会询问显示名称和安装目录（均有默认值），然后：检测平台、复用合格 Node.js 24+ x64或安装用户私有 Node、下载并校验 Release、保留 `~/.vcpdeck/client-id`、写入 `launcher.env`、复用/私装 PM2、只托管 `vcpdeck-client-launcher`、注册自启并等待 Server 确认在线/版本/能力。失败保留现场，重跑同一命令继续修复。若已有配置指向其他 Server则拒绝。

支持范围：Windows 10/11 x64、Windows Server 2019+ x64；Ubuntu 22.04+、Debian 12+、Rocky/AlmaLinux 9+ x64 + glibc + systemd。不支持 ARM64、Alpine/musl、CentOS 7、WSL、容器及无 systemd Linux。Node 和 PM2 下载优先国内镜像，失败回退官方源。

启用入口意味着任何能访问 Server 的机器都可取得共享 PSK；禁用只阻止新安装，不影响或撤销已有 Client。完整信任边界见 ADR-0018 和 [`security.md`](./security.md)。

## 5. 持久化目录

至少持久化：

- SQLite 文件及其同目录数据库文件；
- `data/storage`（使用 Local Provider 时；相对 baseDir 自动锚定到 `<VCPDECK_APP_DIR>/data/storage`，见 ADR-0014）；
- `data/job-outputs`（Job stdout/stderr spool；相对路径同样锚定 `<VCPDECK_APP_DIR>`，完整保留不封顶、无自动清理，可能含敏感输出，备份与访问权限应与 Storage 同级对待）；
- `data/releases` 或 `VCPDECK_RELEASES_DIR`；
- Launcher `VCPDECK_APP_DIR`；
- Client `~/.vcpdeck/client-id`；
- 远程用户的 Pi 配置和 Session 目录；
- frpc 工作目录（需要恢复映射运行信息时）。

持久数据必须位于版本目录之外，否则 Launcher 切换版本会造成数据丢失。

## 6. 数据库初始化与迁移

开发启动脚本执行：

```text
prisma generate
prisma db push --accept-data-loss
```

该方式便于开发，但不适合作为生产迁移策略。生产部署应：

1. 停止写入或进入维护窗口；
2. 备份数据库和 Storage；
3. 审查 Prisma schema 差异与 migration；
4. 执行受控迁移；
5. 启动新 Server 并检查 `/api/status`；
6. 验证关键查询和 Job 创建；
7. 再进入 Client 更新阶段。

## 7. Frontend 托管

发布包的 server 构件已内置 Frontend 构建产物（`server/public/`），Server 启动时用 express.static 同源托管并回退 SPA 路由到 `index.html`（`/api`、`/client`、`/app` 前缀不参与回退），访问 `http://<host>:3001/` 即为驾驶台（[ADR-0013](./adr/0013-frontend-bundled-with-server.md)）。无需反向代理即可使用；浏览器终端的 `/app` Socket.IO 由 Server 同源 CORS 放行。

开发模式仍由 Vite 提供：

```bash
pnpm --filter @vcpdeck/frontend build
```

跨源部署（不随包或单独托管）时，Server 静态托管不生效，需自备静态 SPA 托管并配置未知路由回退到 `index.html`。反向代理至少应转发：

- `/api/*` → Server `3001`
- `/socket.io/*` → Server `3001`，启用 WebSocket upgrade

SSE 需要关闭不必要的代理缓冲并允许长连接。若跨 Origin，必须同步设置 `VCPDECK_FRONTEND_ORIGIN`，且 Cookie Secure 需要 HTTPS。

示意配置：

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_buffering off;
}
location /socket.io/ {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
location / {
  try_files $uri /index.html;
}
```

## 8. 首次部署步骤

1. 准备专用运行账户和持久目录；
2. 生成强随机 `VCPDECK_PSK` 和管理员密码；
3. 配置数据库绝对路径、Release 和 Storage 目录；
4. 构建并启动 Server；
5. 检查 `GET /api/health` 和 `GET /api/status`；
6. 登录并立即确认/更新管理员凭据；当前无法通过业务 API 创建第二个 admin，且最后 admin 可被禁用后锁死管理面，应保护 bootstrap admin 并避免自禁用；
7. 验证 `GET /` 返回驾驶台首页（随包 Frontend 同源托管）；
8. 在目标机器配置 `VCPDECK_SERVER`、相同 PSK 后启动 Client；
9. 检查 Client 在线、能力、Job、文件和终端/Pi；
10. 如使用 FRP，创建并 probe FRPS 实例后再建映射；
11. 配置备份、日志采集和定期恢复演练。

## 9. 升级与回滚（利用自更新机制）

自更新机制与实现边界见 [`design/release-and-update.md`](./design/release-and-update.md)，兼容规则见 [`compatibility.md`](./compatibility.md)。本节是日常发版的操作流程。

### 9.1 发布前准备

1. 按 [`operations.md`](./operations.md) §6 备份 SQLite、Storage 与 Release 目录；数据库 schema 变化不能由回退自动逆转，备份必须与当前应用版本对应；
2. 确认 `VCPDECK_RELEASES_DIR` 为版本目录外**绝对路径**（`install.cjs` 引导默认如此）；Local Storage 相对 `baseDir` 已锚定到 `VCPDECK_APP_DIR`，若曾在旧版本目录内写过 storage 文件，先按 [ADR-0014](./adr/0014-storage-basedir-anchor.md) 搬迁；
3. 确认目标 Linux 机器已安装 `unzip`（自动更新解压依赖）；
4. 确认版本号从未用过：同一版本重复上传会被拒绝（`RELEASE_DUPLICATE_VERSION`），且失败后不能“重试同一版本”，只能发布新版本号；
5. 若发布说明要求新的 Launcher（`launcherMinVersion` 当前不强制），先按 §9.8 升级各主机 Launcher。

### 9.2 构建并上传

```bash
pnpm release --version=x.y.z
```

产出 `dist-release/vcpdeck-x.y.z-win-x64.zip` / `vcpdeck-x.y.z-linux-x64.zip`，并打印各自的 sha256。推荐统一使用 CLI：Alibaba 后端会协商分片并把构件直接 PUT 到 Provider，Server 只处理认证、会话和登记；Local 后端由 CLI 自动选择 Server raw stream。

#### 方式一：CLI（推荐命名环境；第二个平台齐备即自动开始更新）

```bash
# 首次配置，凭据值在本机环境变量 VCPDECK_PROD_TOKEN 中
node packages/cli/dist/index.js env add prod \
  --server=https://<server>:3001 \
  --token-env=VCPDECK_PROD_TOKEN
node packages/cli/dist/index.js env use prod --global

# 后续可使用全局/项目默认，或显式 --env=prod
node packages/cli/dist/index.js release upload \
  dist-release/vcpdeck-x.y.z-win-x64.zip \
  dist-release/vcpdeck-x.y.z-linux-x64.zip \
  --env=prod --wait --timeout=1800
```

已有自动化仍可使用 `--server=<url> --username=<name>` 直连，并由 `VCPDECK_ADMIN_PASSWORD` 提供密码；不推荐把 `--password` 写入命令行。

Alibaba 直传会话把版本、平台、SHA-256、大小、Provider file/upload id 和过期时间持久化；URL 只驻留 CLI 内存。网络失败时重新执行同一命令：相同会话会刷新全部 URL，相同已登记构件会跳过，不同构件拒绝覆盖。Local 后端和不支持会话 API 的旧 Server仍使用 raw stream。

> raw `curl --data-binary` 只适用于 Local 后端或从旧 Server 首次升级时的引导。`0.2.1+` 的 Alibaba 后端会在读取正文前返回 `RELEASE_DIRECT_UPLOAD_REQUIRED`，不得通过延长超时或代理中转绕过直传要求。

从 `0.1.2` 等旧 Server 首次升级到支持直传的版本时，如果公网 legacy 上传超过 Server 接收时限：先用 `rsync/scp` 将两个 zip 和 CLI 构件复制到 Server 主机，再从 `http://127.0.0.1:<port>` 运行同一 `release upload --wait` 命令。该近端 raw 上传只用于一次性引导；升级后后续 Alibaba Release 必须直传。

两个平台构件齐备后编排自动开始，无需其他触发。

### 9.3 自动编排过程

1. `uploaded → updating_server`：Server 通知本机 Launcher prepare（后台下载、SHA-256 校验、解压）；
2. Server 关闭新 Job 派发并等待活跃 Job 收敛，向 Client 广播即将重启；
3. Launcher 执行 preStart（`prisma db push`）→ 停止旧 Server → 切换 current → 启动新 Server → 探活版本一致；探活失败自动切回上一版本；
4. 新 Server 从 SQLite 恢复编排 → `updating_clients`：按每台在线 Client 注册的 OS 选择对应平台包，逐台下发更新；
5. Client Launcher 完成同样流程后以新版本重连注册；单台失败不影响后续机器，明细进入 `clientStates`；
6. 全部在线 Client 处理完 → `done`。离线 Client 不阻塞完成，后续注册时自动补更（该 Release 中已标记 failed 的 Client 除外）。

Windows 大包下载+解压可能耗时数分钟，`/api/status` 短时间仍显示旧版本属正常，不要误判失败。

### 9.4 监控进度

推荐直接用 CLI 查询或等待，它会同时核对 Server 版本、Release 状态和逐台 Client 明细；Server 重启期间只重试安全 GET，不重复上传：

```bash
node packages/cli/dist/index.js release status x.y.z --env=prod
node packages/cli/dist/index.js release wait x.y.z --env=prod --timeout=1800
```

需人工排障时仍可在 Frontend“发版”页面查看完整明细，或使用已认证 REST 查询。`/api/status` 公开端点只显示 Server 版本与活动 Release，`activeRelease=null` 单独不能证明 Client 全部成功。

### 9.5 完成核对

- `release wait` 以零退出码结束；
- Server 版本等于目标版本；Release `status=done`，`clientStates` 中全部为 `done`（有 failed 时 CLI 非零退出）；
- `/api/clients` 中所有在线机器的 `clientVersion` 等于目标版本；
- 下发一个最小 exec Job 验证 Server→Client 链路仍正常。

### 9.6 失败处置与重试

- Release `failed`：查 `errorMessage` 定位阶段（prepare 下载/校验、drain 超时、launcher 回退等），修复后**发布新版本号**重新触发，不支持对同一版本重试；
- 单台 Client `failed`（`clientStates` 里有 reason）：修复该机器后，发布新版本会重新覆盖它；`done` 的 Release 不会自动重试已 failed 的 Client；
- Server drain 超时后派发闸门不会自动解除：核对活跃 Job，通常重启 Server 恢复派发；
- 新 Server 探活失败时 Launcher 已自动回退上一版本，Release 会被恢复编排标记为 failed（“版本不符”）。

### 9.7 手动回滚

Launcher 的自动回退只覆盖“新版本探活失败”。需要人工回滚时：

1. 停止 Server Launcher（确认没有进行中的 Release/Job/Terminal/Pi）；
2. 备份当前数据库与日志；
3. 将 current 指回上一版本：Windows 写 `apps/state.json` 的 `current`，Linux 重建 `apps/current` 软链；或直接用上一版本发布包重新执行 `install.cjs --artifact=server --force`；
4. 若 schema 已变化且旧 Server 无法读取，恢复与旧版本匹配的数据库备份（Launcher 回退不回退数据库）；
5. 启动后核对 `/api/status`、登录、Client 列表与 Job。

### 9.8 Launcher 升级（仅需要时）

Launcher 随发布包分发但**不随业务版本自动更新**（[ADR-0015](./adr/0015-launcher-distributed-with-release.md)）。仅当发布说明要求新 Launcher 时，在各主机停止当前 Launcher 后，用新包内的 `launcher/dist/main.js` 替换 `<app-dir>/dist/main.js` 并重启；同机 Server/Client 分别替换各自 app-dir。

关键限制：

- Server 先于 Client；
- Launcher 负责应用版本回退，但不会自动回退数据库；
- 发布前必须备份；
- Frontend 随 Server 构件同版本分发，无需单独部署对齐；自定义跨源托管时需与 Server 同版本部署；
- 当前 `launcherMinVersion` 尚未强制，依赖新 Launcher 的版本必须先人工升级 Launcher。

## 10. 当前非目标

项目当前不提供：Kubernetes/容器生产模板、高可用 Server、多实例共享 SQLite、自动 TLS、自动系统服务安装、集中日志/指标后端。采用这些部署方式前应新增 ADR 和相应运行测试。
