# VCPDeck

你的个人 AI 协作驾驶台。当前阶段已形成远程机器管理、命令与文件操作、交互式终端、远程 Pi、FRP 和自更新的核心闭环。

## 项目定位

VCPDeck 是面向个人工作流的独立控制面，不是 VCPToolBox 的后台管理面板。

- **VCPDeck 当前负责**：可信操作者、远程机器、Job、文件、终端、Pi Session、FRP 和发布更新；
- **VCPToolBox 负责**：Agent 身份、知识库、RAG 和插件生态；
- **长期愿景**：在现有远程执行基础上增加 TODO、工作流、聊天和 VCPToolBox 双向集成。

愿景中的 TODO、规则引擎、聊天和 VCPToolBox 桥接尚未实现，不应视为当前系统能力。规划见 [`docs/roadmap.md`](docs/roadmap.md)。

## 当前能力

- Client 注册、心跳、能力探测、别名和断线重连；
- Typed Job、命令/脚本执行、取消和状态对账；
- 远程文件浏览、读写、导入/导出及本地/阿里云 Storage；
- 交互式远程终端，包括 PTY、快照、重连和控制权；
- 人机交互式远程 Pi Session，包括 REST 控制、SSE 事件和运行状态机；
- FRPS 实例与 FRP 映射管理；
- Cookie/Bearer 身份认证、操作审计和 React 驾驶台；
- Release、Launcher、Server/Client 更新与失败回退基础实现；
- CLI 多环境注册与项目默认环境选择，以及双平台 Release 上传。

## 当前架构

VCPDeck 采用 Server 中心控制面：Frontend、SDK 和 CLI 只访问 Server；每台目标机器上的 Client 通过 PSK 主动建立 Socket.IO 出站连接，实际执行命令、文件、PTY、Pi 和 frpc。Server 使用 SQLite 保存控制面状态，Launcher 独立守护并更新 Server/Client。

完整架构图、通信边界和关键链路见 [`docs/architecture.md`](docs/architecture.md)。

## 当前边界

- 系统面向少量可信操作者，普通身份同样具有远程操作能力；
- TODO、工作流、聊天、规则和 VCPToolBox 双向桥接仍是规划；
- Server 当前是单控制面节点，使用 SQLite，不提供高可用多实例；
- Release/Launcher 已有基础实现，但全链路真实环境演练仍需继续固化；
- Agent 创建、知识向量检索和插件生态不属于 VCPDeck。

## 项目文档

- [文档中心](docs/index.md) — 长期维护文档的统一入口
- [系统架构](docs/architecture.md) — 当前组件、通信、数据归属与关键链路
- [技术栈](docs/tech-stack.md) — 技术选型、版本与约束
- [领域模型](docs/domain-model.md) — 核心实体、状态机与不变量
- [协议说明](docs/protocols.md) — REST、Socket.IO、SSE 与兼容规则
- [兼容策略](docs/compatibility.md) — 组件版本、升级顺序与破坏性变更规则
- [部署指南](docs/deployment.md) / [运维手册](docs/operations.md) / [安全模型](docs/security.md)
- [测试策略](docs/testing.md) / [CLI 与多环境配置](docs/design/cli.md) / [架构决策](docs/adr/README.md) / [路线图](docs/roadmap.md)
- [参与开发](CONTRIBUTING.md) / [更新日志](CHANGELOG.md)

## 从 GitHub 安装

### Pi Skill

Node.js 24+ 环境中按稳定 Tag 用户级安装：

```bash
pi install git:github.com/xuzhen97/VCPDeck@v0.1.1
```

Pi 会克隆整个仓库并发现 `skills/vcpdeck/SKILL.md`；同目录 `vcpdeck.cjs` 已随 Tag 提交，无需在安装机编译。升级或回滚需显式切换 Tag，例如：

```bash
pi install git:github.com/xuzhen97/VCPDeck@v0.2.0
```

Skill 与 CLI 用户级只安装一份，但执行时保留当前项目 cwd，因此每个项目都可以用自己的 `.vcpdeck.json` 选择用户级已注册环境。

CLI 推荐先在 Frontend `/settings/tokens` 创建专用 Token，再将 Token 保存在本机环境变量并注册命名环境：

```bash
node "<vcpdeck-cli>" env add prod \
  --server=https://deck.example.com \
  --token-env=VCPDECK_PROD_TOKEN
node "<vcpdeck-cli>" env use prod --global
node "<vcpdeck-cli>" env check
```

`env check` 会通过 SDK 显示 Token 对应的实际身份，但不会输出 Token。修改个人用户名不会使 Token 环境失效；用户名/密码模式仅保留兼容。

### SDK 与 Shared

Node.js 24+、pnpm 10.26+ 的项目可从同一 Tag 安装 SDK 和协议类型：

```bash
pnpm \
  --allow-build="@vcpdeck/sdk" \
  --allow-build="@vcpdeck/shared" \
  add \
  "github:xuzhen97/VCPDeck#v0.1.1&path:/packages/sdk" \
  "github:xuzhen97/VCPDeck#v0.1.1&path:/packages/shared"
```

两个包必须使用同一 Tag。pnpm 会在 Git 获取阶段构建未提交的 `dist`，并把实际 commit 与构建许可记录到目标项目。SDK 不读取 CLI 环境配置；调用方显式提供 Server 和认证：

```ts
import { VcpDeckClient } from "@vcpdeck/sdk";
import { JobStatus, type JobInfo } from "@vcpdeck/shared";

const client = new VcpDeckClient({
  baseUrl: process.env.VCPDECK_SERVER!,
  auth: { type: "bearer", token: process.env.VCPDECK_TOKEN! },
});

const jobs = await client.jobs.list({ status: JobStatus.RUNNING });
```

目标项目可自行用 esbuild 等工具将脚本打成只依赖 Node.js 的 `.mjs`。

## 本地开发与测试

### 环境要求

- Node.js 24+
- pnpm 10.26+
- Git

远程 Pi 依赖目标机器已经配置可用的 Pi 模型凭据；交互式终端依赖 `node-pty` 能在当前平台正常安装。完整运行条件见 [`docs/deployment.md`](docs/deployment.md)。

### 初始化依赖

```bash
pnpm install
```

FRP 相关测试需要本机的 `frpc` 和 `frps` 二进制。下载当前平台版本：

```bash
pnpm download:frp
```

下载完成后，二进制位于：

- Client：`packages/client/dist/frp/<platform>/frpc[.exe]`
- Server：`packages/server/dist/frp/<platform>/frps[.exe]`

### 启动项目

先复制 Server 配置：

```bash
# macOS / Linux
cp packages/server/.env.example packages/server/.env

# Windows PowerShell
Copy-Item packages/server/.env.example packages/server/.env
```

首次启动必须设置 `VCPDECK_ADMIN_PASSWORD`。示例中的 `admin / test123` 只用于本机开发，使用前应改成自己的密码；数据库已有管理员后，修改该变量不会重置现有密码。

当前示例文件仍使用尚未被代码读取的旧变量 `VCPDECK_CLIENT_PSK`。Server 和 Client 实际都读取 `VCPDECK_PSK`，因此请在 `packages/server/.env` 中增加或改为：

```dotenv
VCPDECK_ADMIN_USERNAME=admin
VCPDECK_ADMIN_PASSWORD=<local-development-password>
VCPDECK_PSK=<same-high-entropy-psk-on-server-and-client>
```

运行远程 Client 时，必须通过进程环境向 Client 提供相同的 `VCPDECK_PSK`；Client 不会读取 `packages/server/.env`。默认开发 PSK 仅可用于本机验证。

常用启动方式：

```bash
# 只启动 Server 和 Frontend
pnpm dev

# 启动 Server、Frontend 和本机 Client
pnpm dev:all
```

使用自定义 PSK 启动 `dev:all` 的示例：

```bash
# macOS / Linux
VCPDECK_PSK='<same-psk>' pnpm dev:all

# Windows PowerShell
$env:VCPDECK_PSK='<same-psk>'
pnpm dev:all
```

访问前端：<http://localhost:5173>。Server API 默认监听 <http://localhost:3001>。

### 启动本地 FRPS 测试实例

`start-test-frps.cjs` 会生成临时 `frps.toml`，启动带 Dashboard 和 Token 鉴权的本地 FRPS。默认参数如下：

| 配置 | 默认值 |
| --- | --- |
| FRPS bind port | `17000` |
| Dashboard | <http://127.0.0.1:17500> |
| Dashboard 登录 | `admin / admin` |
| Token | `test-frp-token` |
| 临时目录 | `.tmp/test-frps/` |

在单独的终端运行：

```bash
node scripts/start-test-frps.cjs --clean
```

保持该终端运行，停止时按 `Ctrl+C`。`--clean` 会在退出时删除临时配置和日志。需要自定义端口或 Token 时：

```bash
node scripts/start-test-frps.cjs \
  --port=17000 \
  --dashboard-port=17500 \
  --token=test-frp-token \
  --clean
```

也可以使用环境变量覆盖默认值：`FRPS_BIN`、`FRPS_PORT`、`FRPS_DASHBOARD_PORT`、`FRPS_TOKEN`。

要让 VCPDeck Server 使用这台 FRPS，在 `packages/server/.env` 中补充：

```dotenv
FRP_PUBLIC_HOST=127.0.0.1
FRPS_BIND_PORT=17000
FRPS_TOKEN=test-frp-token
FRP_DASHBOARD_HOST=127.0.0.1
FRP_DASHBOARD_PORT=17500
FRP_DASHBOARD_USER=admin
FRP_DASHBOARD_PASSWORD=admin
FRP_PORT_RANGE_START=20000
FRP_PORT_RANGE_END=21000
```

然后在另一个终端启动项目：

```bash
pnpm dev:all
```

首次启动或数据库中还没有 FRPS 实例时，Server 会从这些环境变量迁移默认实例。之后可以在前端的 FRP 页面中创建实例、执行健康检查和管理映射。FRPS Dashboard 可用于确认代理是否已注册。

如果只验证 FRPS 实例管理接口，也可以在 Server 已启动后运行：

```bash
node scripts/test-frp-instances.cjs
```

该脚本使用 `http://localhost:3001`，会创建、探测、切换默认实例并删除测试实例。

### 运行项目测试

#### 各包单元测试

运行 Shared、Server、Client、SDK、Frontend 和 Launcher 中声明的 Vitest 测试：

```bash
pnpm -r test
```

也可以按包运行：

```bash
pnpm --filter @vcpdeck/shared test
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/launcher test
```

#### 项目端到端集成测试

根目录的 `pnpm test` 会自动启动临时 Server 和 mock/真实 Client，覆盖认证、任务、文件传输等核心链路；测试结束后会清理进程和隔离的临时数据库：

```bash
pnpm test
```

该脚本会占用 `3001` 端口，并在开始时强制停止占用该端口的现有进程。不要在开发 Server 正在运行时执行。测试数据库位于系统临时目录，不会重建 `packages/server/prisma/dev.db`。

#### FRP 全链路集成测试

`pnpm test:frp` 会自动启动随机端口的 FRPS、Server 和真实 Client，验证 TCP/HTTP 映射、Dashboard 代理状态、删除和错误场景，测试完成后自动清理：

```bash
pnpm build
pnpm test:frp
```

该测试需要先执行 `pnpm download:frp`。如果输出 `SKIP`，表示 FRP 二进制缺失，此次没有真正执行 FRP 测试，不应视为全链路测试通过。

#### Lint 与构建检查

```bash
pnpm lint
pnpm build
```

`pnpm build` 会构建所有 workspace 包；Client 构建时如果缺少 `frpc`，会尝试自动下载当前平台版本。更完整的测试矩阵、Launcher 冒烟和发布验收要求见 [`docs/testing.md`](docs/testing.md)。

## 路线图

TODO、工作流、VCPToolBox 桥接、Client 自主 Agent、主动巡检和移动端等方向统一维护在 [`docs/roadmap.md`](docs/roadmap.md)，不在 README 中重复声明为当前能力或交付承诺。
