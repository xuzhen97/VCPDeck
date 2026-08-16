# VCPDeck 部署指南

> 状态：Current｜维护责任：发布/运维维护者｜最后核验：2026-08-15｜适用版本：当前 `main`

本文描述当前可验证的部署边界。项目尚未提供容器镜像、systemd/Windows Service 安装器或完整生产安装脚本；生产常驻应由 Launcher 或外部服务管理器负责。

## 1. 部署拓扑

最小部署包含：

- 一台控制面主机：Server、SQLite、可选 Local Storage、可选 Server Launcher；
- 一个静态 Frontend 托管位置；
- 每台目标机器：Client、可选 Client Launcher、frpc、Pi/PTY 运行环境；
- 可选 FRPS 实例；
- 可选阿里云存储后端。

Client 主动连接 Server，因此目标机器无需向 Server 开放入站控制端口。

## 2. 运行要求

- pnpm workspace 开发/源码部署；
- Node.js 24+（发布 manifest 默认 `>=24`）；
- Server 需要可写的数据库、Storage 和 Release 目录；
- Client 的远程 Pi 依赖本机 Pi 配置、模型认证和受支持 Shell；
- 交互式终端依赖 `node-pty` 原生模块；
- FRP 能力需要匹配平台的 frpc/frps 构件。

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

生产构件应使用 `scripts/pack-release.ts` 生成并经发布验收，不建议将工作区源码目录直接当作长期版本目录。

## 4. 配置

### 4.1 Server

| 变量 | 当前默认/要求 | 说明 |
| --- | --- | --- |
| `VCPDECK_ADMIN_USERNAME` | `admin` | 首个管理员用户名 |
| `VCPDECK_ADMIN_PASSWORD` | 首次启动必填 | 仅无 admin 时用于 bootstrap；不得保留示例密码 |
| `VCPDECK_FRONTEND_ORIGIN` | `http://localhost:5173` | CORS 和 `/app` Origin |
| `VCPDECK_SESSION_TTL_SECONDS` | `604800` | 浏览器会话 TTL |
| `VCPDECK_COOKIE_SECURE` | 未设时为 `true` | HTTP 开发环境需显式 `false`；生产必须 HTTPS + true |
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite URL；相对路径依赖 Server 工作目录 |
| `VCPDECK_RELEASES_DIR` | `./data/releases` | 发布构件目录 |
| `VCPDECK_PSK` | `vcpdeck-dev-psk` | `/client` PSK，生产必须随机替换 |
| `VCPDECK_CORS_ORIGIN` | `http://localhost:5173` | `/client` Gateway CORS Origin |

**已知配置不一致：** 根目录和 `packages/server/.env.example` 目前写的是 `VCPDECK_CLIENT_PSK`，但 Server 与 Client 实际代码都读取 `VCPDECK_PSK`；`VCPDECK_CLIENT_PSK_FILE` 当前也未实现。部署必须设置 `VCPDECK_PSK`，不要依赖示例中的旧变量。

Server 固定监听 `3001`，当前没有环境变量覆盖端口。

### 4.2 Client

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VCPDECK_SERVER` | `http://localhost:3001` | Server 基址，不含 `/client` |
| `VCPDECK_PSK` | `vcpdeck-dev-psk` | 必须与 Server 一致 |
| `VCPDECK_CLIENT_ID` | 自动生成 | 可选固定 ID；默认保存在 `~/.vcpdeck/client-id` |
| `VCPDECK_FRPC_PATH` | 随构件探测 | 自定义 frpc 路径 |
| `VCPDECK_FRPC_WORK_DIR` | Client 默认目录 | frpc 配置/运行目录 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | 远程 Pi 配置与 Session 根目录 |

Client 使用运行账户的权限执行命令、文件、PTY 和 Pi。应为其创建权限受控的专用账户，不能仅依赖 UI 确认。

### 4.3 Launcher

| 变量 | 默认/要求 | 说明 |
| --- | --- | --- |
| `VCPDECK_APP_DIR` | `~/.vcpdeck/launcher` | Launcher 状态、Node 缓存和 apps 目录 |
| `VCPDECK_ARTIFACT` | 必填 | `server` 或 `client` |
| `VCPDECK_PROBE_URL` | `http://127.0.0.1:3001/api/status` | Server 探活地址 |

Launcher 首次启动要求 `apps/current` 已指向可用初始版本。仓库当前没有完整安装器，初始版本目录和 current 指针需要由发布流程或运维脚本准备。

### 4.4 FRPS 迁移配置

当数据库中不存在 FRPS 实例时，Server 可从下列变量迁移默认实例：

- `FRP_PUBLIC_HOST`
- `FRPS_BIND_PORT`
- `FRPS_TOKEN`
- `FRP_DASHBOARD_SCHEME/HOST/PORT/USER/PASSWORD`
- `FRP_PORT_RANGE_START/END`

迁移后以数据库配置为准。不要长期同时维护两份不同配置。当前缺省迁移会使用 `test-frp-token` 和 Dashboard `admin/admin` 等开发默认，生产首次启动必须显式覆盖并在 API 中 probe 验证。

FRPS Token 和 Dashboard 密码当前明文存入 SQLite、通过实例 REST 返回，并写入 Job payload 和 Client `frpc-combined.toml`。相关数据库、备份、Client 工作目录和页面访问都必须限制。Server 虽可保存多个实例，但同一 Client 当前只有一个 frpc runtime；不要为同一 Client 创建跨多个 FrpsInstance 的活动映射。完整边界见 [`design/frp.md`](./design/frp.md)。

## 5. 持久化目录

至少持久化：

- SQLite 文件及其同目录数据库文件；
- `data/storage`（使用 Local Provider 时）；
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

## 7. Frontend 与反向代理

Frontend 构建：

```bash
pnpm --filter @vcpdeck/frontend build
```

部署 `packages/frontend/dist` 为静态 SPA，并配置未知路由回退到 `index.html`。反向代理至少应转发：

- `/api/*` → Server `3001`
- `/socket.io/*` → Server `3001`，启用 WebSocket upgrade

SSE 需要关闭不必要的代理缓冲并允许长连接。生产建议同源部署 Frontend 和 API；若跨 Origin，必须同步设置 `VCPDECK_FRONTEND_ORIGIN`，且 Cookie Secure 需要 HTTPS。

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
7. 部署 Frontend 和反向代理；
8. 在目标机器配置 `VCPDECK_SERVER`、相同 PSK 后启动 Client；
9. 检查 Client 在线、能力、Job、文件和终端/Pi；
10. 如使用 FRP，创建并 probe FRPS 实例后再建映射；
11. 配置备份、日志采集和定期恢复演练。

## 9. 升级与回滚

自动发布详见 [`compatibility.md`](./compatibility.md) 和 [`design/release-and-update.md`](./design/release-and-update.md)。关键限制：

- Server 先于 Client；
- Launcher 负责应用版本回退，但不会自动回退数据库；
- 发布前必须备份；
- Frontend 应与 Server 同版本部署；
- 当前 `launcherMinVersion` 尚未强制，依赖新 Launcher 的版本必须先人工升级 Launcher。

## 10. 当前非目标

项目当前不提供：Kubernetes/容器生产模板、高可用 Server、多实例共享 SQLite、自动 TLS、自动系统服务安装、集中日志/指标后端。采用这些部署方式前应新增 ADR 和相应运行测试。
