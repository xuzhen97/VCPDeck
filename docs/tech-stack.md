# VCPDeck 技术栈

> 状态：Current｜维护责任：架构维护者｜最后核验：2026-08-15｜适用版本：当前 `main`
>
> 本文记录当前仓库已经采用并落地的技术选型、包职责与关键技术边界。产品定位见 [`README.md`](../README.md)，具体功能的协议与实现细节见对应设计文档；尚未实现的产品规划不在本文展开。

## 总览

| 领域 | 技术 | 当前用途 |
| --- | --- | --- |
| 语言与模块 | TypeScript、ESM、NodeNext | 全仓库使用严格类型检查；Node.js 包的相对导入保留 `.js` 后缀 |
| 仓库管理 | pnpm workspace | `packages/*` 组成 monorepo，根脚本统一编排构建、开发与测试 |
| 前端 | React 18、Vite 5、React Router 7 | 纯客户端渲染的 SPA |
| UI | Tailwind CSS 4、Radix UI、Lucide React | 样式、无障碍基础组件与图标 |
| 后端 | NestJS 10、Express adapter | 提供 REST API、Socket.IO Gateway 与业务模块组织 |
| 数据持久化 | SQLite、Prisma 7、libSQL adapter | 持久化机器、Job、身份、文件元数据、FRP、终端会话与发布记录 |
| 实时通信 | Socket.IO 4、Server-Sent Events | Server ↔ Client 调度和终端使用 Socket.IO；远程 Pi 的浏览器事件流使用 SSE |
| 远程终端 | node-pty、xterm.js / xterm-headless | Client 创建 PTY，Frontend 渲染终端，Server 代理会话并记录最小审计信息 |
| 远程 Pi | `@earendil-works/pi-agent-core@0.84.0`、`@earendil-works/pi-coding-agent@0.84.0` | Client 通过 fork Worker 嵌入 Pi SDK，Server 代理请求/状态，Frontend 提供交互界面 |
| FRP | frpc / frps | Client 管理 frpc 映射，Server 管理 FRPS 实例与映射元数据 |
| SDK | Fetch API、TypeScript | Node.js 与浏览器共用的类型安全 REST 客户端 |
| CLI | Node.js、esbuild | 当前提供发布包上传命令，并产出 Pi Skill 使用的单文件 CLI |
| 进程与更新 | Node.js launcher | 守护 Server/Client，负责版本切换、探活、失败回退与崩溃重启 |
| 测试 | Vitest、Testing Library、jsdom、自定义 E2E 脚本 | 包级单元/组件测试及跨进程集成测试 |

## Workspace 结构

```text
vcpdeck/
├── packages/
│   ├── shared/       # 跨包协议、类型、事件名与运行时解析函数
│   ├── sdk/          # 框架无关的 REST API 客户端
│   ├── server/       # NestJS 网关与持久化服务
│   ├── client/       # 部署在目标机器上的执行代理
│   ├── frontend/     # React/Vite 驾驶台 SPA
│   ├── cli/          # vcpdeck 命令行入口与单文件打包脚本
│   └── launcher/     # Server/Client 进程守护与更新器
├── skills/
│   └── vcpdeck/      # Pi Skill 描述；CLI 构建产物写入此处
├── scripts/          # 构建、下载 FRP 与集成测试脚本
└── docs/             # 架构、协议、实现与验证文档
```

依赖方向以共享协议为中心：`shared` 不依赖其他内部包；`sdk` 只依赖 `shared`；Frontend 和 CLI 消费 `sdk` 与 `shared`；Server、Client、Launcher 直接消费 `shared`。内部包通过 package export 复用，不跨包引用源码；运行时之间通过 REST、Socket.IO、SSE 和发布构件交互。

## 各包职责

### `packages/shared`

跨运行时的协议事实来源，包含：

- Socket.IO 事件名和 Server ↔ Client 消息类型；
- Job、文件传输、FRP、远程 Pi、远程终端与更新协议；
- REST API 的请求/响应类型、错误码和分页包装；
- 对不可信协议输入进行校验的运行时解析函数。

该包没有第三方运行时依赖。它不承载数据库模型或具体业务实现。

### `packages/sdk`

基于标准 Fetch API 的框架无关 REST 客户端，核心类为 `VcpDeckClient`。当前按功能域暴露：

- `auth`、`identities`；
- `clients`、`jobs`、`files`；
- `storage`、`aliyundrive`；
- `frp`、`pi`、`terminals`；
- `releases`、`health`。

SDK 支持 Cookie 会话和 Bearer Token，并统一将失败响应转换为 `VcpDeckApiError`。它只封装 REST API；终端 Socket.IO 连接和 Pi SSE 事件流由 Frontend 的对应模块管理。

### `packages/server`

NestJS 网关服务，同时承载 HTTP、Socket.IO 与持久化。当前业务模块包括：

- `auth`、`identity` — 登录会话、API Token 与身份管理；
- `client`、`job`、`events` — 机器连接、心跳、Job 调度和协议事件；
- `file`、`storage` — 远程文件操作、传输会话及本地/阿里云存储后端；
- `frp` — FRPS 实例和端口映射管理；
- `pi` — 远程 Pi 请求代理、运行状态机及 REST/SSE 接口；
- `terminal` — 交互式终端代理、控制权和最小审计；
- `release` — 发布包管理及 Server/Client 更新编排；
- `prisma` — 数据库连接与 Prisma Client 生命周期。

数据库默认使用 SQLite 文件，通过 Prisma 的 libSQL adapter 访问。Prisma 隔离了数据访问，但切换其他数据库仍需评估 schema、迁移与运行特性，不能视为无成本替换。

### `packages/client`

运行在目标机器上的 Node.js 代理，通过 Socket.IO `/client` namespace 连接 Server。主要能力包括：

- 注册、心跳、能力探测与断线重连；
- 执行和取消命令 Job，上报输出、结果与恢复状态；
- 文件操作及导入/导出传输；
- 管理 frpc 映射；
- 使用 `node-pty` 承载交互式终端；
- 通过 fork Worker 和 Pi SDK 承载远程 Pi 会话并桥接请求/事件；
- 接收并应用客户端更新。

Client 是普通 Node.js 进程；常驻、拉起和更新由 `packages/launcher` 负责，而不是由 Client 自身注册 Windows Service 或 systemd 服务。

### `packages/frontend`

React + Vite SPA，使用 React Router 进行客户端路由。数据访问以 `@vcpdeck/sdk` 为主，并针对实时能力分别使用：

- Socket.IO `/app` namespace — 远程终端双向数据；
- EventSource / SSE — 远程 Pi 事件流；
- xterm.js — 浏览器终端渲染。

当前界面覆盖认证、机器与机器工作区、Job、FRP、存储、发布和设置等已落地能力。Frontend 不直接访问数据库，也不复刻 Server 的业务状态机。

### `packages/cli`

无命令框架的 Node.js CLI。当前已实现：

```text
vcpdeck env add|list|show|current|use|remove
vcpdeck release upload <vcpdeck-x.y.z-win-x64.zip> <vcpdeck-x.y.z-linux-x64.zip> [--env=<name>]
```

CLI 使用 `~/.vcpdeck/cli/config.json` 注册多个环境，项目 `.vcpdeck.json` 只选择默认环境；解析顺序为显式 `--env`、`VCPDECK_ENVIRONMENT`、最近项目配置、全局默认，错误配置 fail closed（ADR-0017）。`release upload` 负责参数/文件校验、SHA-256 与人类可读输出；登录会话、Bearer、Release 原始流上传和 API 错误归一化复用 `@vcpdeck/sdk`。现有 `--server` 直连模式保持兼容。构建时 TypeScript 编译，再由 esbuild 打包为随 Git Tag 提交的 `skills/vcpdeck/vcpdeck.cjs`；Skill 从绝对路径调用它但保留当前项目 cwd。机器管理、Job 操作等尚未形成 CLI 命令。

### `packages/launcher`

Server/Client 的 Node.js 进程守护与更新层，负责：

- 检查并准备满足约束的 Node.js 运行时；
- 启动当前版本并对崩溃进行退避重启；
- 下载、校验和解压发布构件；
- 执行版本切换、健康探测与失败回退；
- 通过本机控制通道协调 Server 自更新。

Launcher 管理的是发布构件生命周期，不参与 Job 调度或业务协议处理。

### `skills/vcpdeck`

Pi Agent Skill 的描述目录。`SKILL.md` 是 VCPDeck CLI 的统一能力入口，维护当前命令目录、通用安全规则和各功能操作流程；Release/自更新是目前首先落地的功能章节。`vcpdeck.cjs` 由 CLI 构建生成，是仓库唯一提交的 `dist` 类产物，保证 `pi install git:github.com/xuzhen97/VCPDeck@vX.Y.Z` 后立即可用。Skill 不是另一套 SDK 或服务端实现，其可用能力始终以当前 CLI 命令为准；未来 CLI 逐步对齐 Server 能力时，在同一 Skill 中增量补充对应章节。

## 通信与安全边界

VCPDeck 不是“所有实时能力都走同一条 WebSocket”的结构：

| 通道 | 用途 | 认证方式 |
| --- | --- | --- |
| REST `/api/*` | 资源管理、Job、文件、FRP、Pi 控制、发布等 | Cookie 会话或 Bearer Token；少量公开端点除外 |
| Socket.IO `/client` | Server ↔ Client 注册、心跳、Job、文件、终端、Pi、更新事件 | PSK |
| Socket.IO `/app` | Browser ↔ Server 终端交互 | Cookie 会话或握手 Bearer Token |
| SSE | Server → Browser 的远程 Pi 事件流 | 浏览器 Cookie 会话 |

Job 状态持久化在数据库中，由 Server 调度并通过 Socket.IO 下发；项目没有引入 Redis、BullMQ 等独立消息队列。命令、路径、终端内容和文件内容都可能包含敏感信息，因此协议错误和日志应保持安全消息，终端持久化只记录会话元数据与生命周期审计，不记录终端正文。

## 选型理由

- **TypeScript + shared 协议包** — 在 Server、Client、Frontend、SDK 和工具链之间共享协议，同时保留运行时输入校验。
- **pnpm workspace** — 适合多包并行开发，并通过 workspace 依赖保持内部包版本一致。
- **NestJS** — REST Controller、Socket.IO Gateway 和领域 Service 可在同一依赖注入体系中协作。
- **SQLite + Prisma** — 当前个人驾驶台场景部署简单，关系数据和状态审计清晰；Prisma 统一数据访问和迁移工具。
- **Socket.IO + SSE 分工** — 双向、需确认的控制流使用 Socket.IO；单向且适合自动重连的 Pi 事件流使用 SSE。
- **React + Vite SPA** — 驾驶台无需 SEO 或服务端渲染，客户端路由和独立 API 服务更符合当前部署方式。
- **node-pty + xterm.js** — 分别承担目标机器上的真实 PTY 和浏览器终端渲染，避免自行实现终端仿真。
- **Pi SDK + fork Worker** — 复用 Pi 的 Session、模型、工具和资源加载能力，同时把项目级 Agent 生命周期与 Client 主进程隔离；当前不依赖全局 Pi CLI/RPC。
- **独立 Launcher** — 将进程守护和可回退更新从业务进程中分离，降低 Server/Client 自更新时的生命周期耦合。
