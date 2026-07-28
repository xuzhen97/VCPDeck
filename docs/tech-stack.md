# VCPDeck 技术栈

## 总览

| 层 | 技术 | 说明 |
|---|---|---|
| 语言 | TypeScript | 全栈统一 |
| 包管理 | pnpm (workspace) | monorepo |
| 前端 | React + Vite | SPA，纯客户端渲染 |
| 后端 | NestJS | 模块化，内置 WebSocket |
| 数据库 | SQLite + Prisma | 零运维，Prisma 隔离切换 |
| 实时通信 | Socket.IO | 双向，内置心跳/重连 |
| 远程执行 | Socket.IO + job 队列 | server → client 指令下发 |
| CLI | Node.js (无框架) | `vcpdeck xxx` 命令 |
| Pi 集成 | Skill (SKILL.md + vcpdeck.cjs) | `pi install git:github.com/...` |

## 模块

```
vcpdeck/
├── packages/
│   ├── shared/       # 跨包共享类型
│   ├── sdk/          # 框架无关 REST 客户端（Node / 浏览器）
│   ├── server/       # NestJS 网关服务
│   ├── client/       # 机器端守护进程 (Windows/Linux)
│   ├── cli/          # vcpdeck 命令行工具
│   └── frontend/     # React/Vite 驾驶台 SPA
├── skills/
│   └── vcpdeck/      # Pi Agent Skill（薄封装 CLI）
└── docs/
```

### packages/shared

共享 TypeScript 类型定义：REST API 请求/响应、Socket.IO 事件、TODO 状态枚举、流程模板、VCPToolBox 桥接类型。运行时零依赖，同时被 server、client、cli、frontend、sdk 消费。

### packages/sdk

框架无关的 TypeScript REST 客户端，提供类型安全的 VCPDeck Server API 调用封装。可在 Node.js 或浏览器中运行。

核心类 `VcpDeckClient`，按功能域暴露子 API：

- `jobs` — Job 创建/查询/取消 + 轮询 wait（指数退避）
- `files` — 远程文件操作（基于 Job，封装创建+等待+结果返回）
- `auth` — 登录/登出/当前用户 + Token 管理
- `identities` — 管理员身份 CRUD
- `clients` — 在线 Client 列表
- `storage` — 签名上传/下载 URL、存储后端切换
- `aliyundrive` — 阿里云盘 OAuth 流程 + 配置
- `frp` — FRP 端口映射 CRUD
- `health` — 健康检查

认证支持 Cookie 和 Bearer Token 两种模式。仅依赖 `@vcpdeck/shared`，零框架依赖。

### packages/server

NestJS 应用，SQLite + Prisma 持久化。按功能域拆 module：

- `client` — 机器注册、心跳、在线状态
- `task` — TODO CRUD、状态流转
- `job` — 远程命令下发、脚本执行、结果回写
- `file` — 远程文件读写、上传下载
- `tunnel` — FRP 端口映射管理
- `workflow` — 流程模板配置与执行
- `bridge` — VCPToolBox 双向集成
- `chat` — Agent 聊天消息

### packages/client

跑在远程机器上的 Node.js 守护进程。Socket.IO 连接 server，接收 job 指令并执行。启动后可注册为 Windows Service 或 systemd。

### packages/cli

本机命令行工具，命令前缀 `vcpdeck`。通过 HTTP/WebSocket 调 server API。构建产物供 `skills/vcpdeck` 加载。

### packages/frontend

React + Vite SPA。页面：Dashboard（TODO 面板）、Machines（机器管理）、Chat（Agent 对话）、Workflows（流程配置）、Settings（规则配置）。

### skills/vcpdeck

Pi Agent Skill。`SKILL.md` 描述触发条件，`vcpdeck.cjs` 为可直接执行的 bundled CLI 入口。Pi agent 在工作流中直接调用驾驶台能力。

## 安装 / 卸载

```bash
pi install git:github.com/lioensky/vcpdeck
pi remove git:github.com/lioensky/vcpdeck
```

Pi 自动发现 `skills/` 目录下的 `vcpdeck` skill。

## 选型理由

- **TypeScript 全栈** — 共享类型定义，monorepo 内类型安全贯穿前后端和客户端
- **NestJS** — 功能域天然映射为 Module，新加业务不写胶水代码；内置 WebSocket Gateway 与 HTTP 共享 service
- **SQLite** — 个人驾驶台无并发压力，零部署；Prisma 隔离差异，未来可切 PostgreSQL
- **Socket.IO** — 双向实时，心跳/重连/房间内置；server ↔ client 和 server ↔ frontend 都用它
- **Vite SPA** — 驾驶台不需要 SEO/SSR，轻量快速
- **Conventional skills/** — Pi 约定目录，无需配置即可自动发现
