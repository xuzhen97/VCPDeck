# VCPDeck

你的个人 AI 协作驾驶台 —— 与 [VCPToolBox](https://github.com/lioensky/VCPToolBox) 深度集成，按你的工作流程调度编排一切。

## 项目定位

VCPDeck 是一个面向你的独立驾驶台。它是你每天跟 AI 助手协同工作的地方，不是 VCPToolBox 的后台管理面板。

- **VCPToolBox** = Agent 平台（管理 Agent 身份、知识库、插件生态）
- **VCPDeck** = 你的驾驶台（TODO 追踪、机器调度、流程编排、与 Agent 对话）

两者双向集成：VCPToolBox 可以把 VCPDeck 当插件调用它的调度能力，VCPDeck 也可以直接调用 VCPToolBox 的 Agent 来对话和推理。

## 背景

VCPToolBox 是一个强大的 AI Agent 中间件，能在上面创建 Agent、配置插件、管理知识库。但它是面向 Agent 管理的，不是面向你的日常工作流程的。

VCPDeck 的角色是：**把你的工作流程组织起来**。你手头有多台机器、各种项目、一堆 TODO，Agent 可以帮你分担 —— 但它需要知道你的上下文：什么项目在哪台机器、排查问题的固定套路、你现在关注什么任务。

同时，VCPDeck 的调度能力不止服务于 VCPToolBox。当你在使用 coding agent（如 Pi）编码时，也可以直接调用驾驶台的能力 —— 发布到目标机器、查看线上日志、重启服务 —— 不用切换上下文。一个驾驶台，多种 Agent 共用。

这就是 VCPDeck 做的事。

## 核心理念

```text
VCPToolBox  = Agent 引擎（对话、推理、知识记忆、插件能力）
VCPDeck      = 你的驾驶台（TODO、机器调度、流程编排、聊天协作）
```

- **你有自己的聊天界面** — 在工作台里直接跟 VCP 的 Agent 对话，不需要切到 VCPToolBox
- **双向集成** — VCP 作为插件调用 VCPDeck 的调度能力；VCPDeck 调用 VCP 的 Agent 进行对话和推理
- **按你的习惯定义流程** — 把重复的工作套路沉淀为可复用的流程模板
- **经验记忆复用 VCP** — 你教给 Agent 的项目路径、机器信息等，交给 VCPToolBox 的 RAG 记忆系统存储

## 核心流程

### TODO 驱动的协作模式

1. **创建 TODO** — 你在工作台创建任务，打上标签（如 `project:vcptoolbox`、`type:bug`）
2. **环境关联** — 系统根据标签和规则，自动关联对应的机器、项目路径、历史操作记录
3. **Agent 主动执行** — VCP 的 Agent 拿到上下文，通过网关去目标机器执行操作（跑命令、查日志、改文件等）
4. **结果回写** — 执行结果回写到 TODO，你来审核，决定下一步怎么做
5. **经验积累** — 你在这个过程中教给 Agent 的信息，交给 VCPToolBox 的记忆系统，下次自动召回

### 一个典型场景

> 有人反馈了一个 bug
> → 你在 VCPDeck 驾驶台创建 TODO，打上项目标签
> → 跟 Agent 聊：这个 bug 是什么现象、可能跟哪个模块有关
> → Agent 知道这个项目在哪台机器、什么路径
> → 你忙别的时候，Agent 自动去排查：拉日志、跑测试、git log 分析
> → 初步结论写回 TODO
> → 你回来审核，跟 Agent 继续讨论，决定修复方向

## 系统架构

```text
         ┌─────────────┐    ┌──────────────┐
         │  Coding Agent │    │ VCPToolBox   │
         │  (如 Pi)      │    │  Agent 平台   │
         └──────┬───────┘    └──────┬───────┘
                │                   │
                │   调用驾驶台能力    │  双向集成
                │   (发布/查日志等)   │  (Plugin ⇄ API)
                │                   │
                └─────────┬─────────┘
                          │
┌─────────────────────────┴────────────────────────┐
│                  VCPDeck 驾驶台                     │
│                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ TODO 面板 │ │ 机器管理  │ │  与 Agent 聊天    │  │
│  └──────────┘ └──────────┘ └──────────────────┘  │
│                                                    │
│  ┌────────────────────────────────────────────┐   │
│  │         流程引擎 · 规则配置 · 标签系统        │   │
│  └────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌─────────────┐              ┌────────────────┐  │
│  │   网关服务    │              │  VCP 桥接层     │  │
│  │ · 客户端管理  │◄── 双向 ──►│ · VCP Plugin   │  │
│  │ · 任务下发    │              │ · 调用 Agent   │  │
│  │ · FRP 隧道   │              │ · 复用 RAG     │  │
│  └──────┬───────┘              └────────────────┘  │
├─────────┼──────────────────────────────────────────┤
│         │         客户端层 (每台机器)                │
│  ┌──────┴───────────────────────────────────────┐  │
│  │  Node.js 执行环境                              │  │
│  │  · 命令执行  · 文件读写  · 脚本运行              │  │
│  │  · FRP 映射  · 心跳上报  · (未来) Pi Agent     │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

## 功能边界

**VCPDeck 做：**

- **驾驶台界面** — 你日常跟 Agent 协作的主入口（未来延伸到手机）
- **TODO 管理** — 任务创建、标签分类、状态追踪、结果审核
- **聊天协作** — 在工作台内直接与 VCPToolBox 的 Agent 对话
- **机器管理** — 多台机器的客户端注册、心跳监控、远程操作
- **远程执行** — 下发命令、运行 Node.js 脚本
- **远程文件管理** — 浏览目录、读写文本、流式传输文件（export/import）、路径安全隔离 → [实现文档](docs/file-transfer-implementation.md)
- **FRP 端口映射** — 让内网或无外网的机器可达
- **远程 Pi Tab** — 结构化多轮编码代理界面：项目级 Session、工具调用监督、分支导航、图片提示 → [实现文档](docs/remote-pi-tab.md)
- **自定义流程** — 把你自己的工作套路沉淀为可复用的流程
- **规则配置** — 标签规则、环境关联、自动化触发条件

**VCPDeck 不做：**

- Agent 管理与创建 → VCPToolBox 的 Admin Panel 负责
- 知识向量检索 → VCPToolBox 的 RAG 记忆系统负责
- 插件生态管理 → VCPToolBox 的 Plugin 系统负责

## 技术栈

技术选型详情见 [`docs/tech-stack.md`](docs/tech-stack.md)。

## 本地开发与测试

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

先复制 Server 配置并设置首次启动所需的管理员密码：

```bash
# macOS / Linux
cp packages/server/.env.example packages/server/.env

# Windows PowerShell
Copy-Item packages/server/.env.example packages/server/.env
```

默认配置会使用 `http://localhost:3001`、`admin` 用户和 `test123` 密码。常用启动方式：

```bash
# 只启动 Server 和 Frontend
pnpm dev

# 启动 Server、Frontend 和 Client（远程机器测试推荐）
pnpm dev:all
```

访问前端：<http://localhost:5173>。

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

运行 Server、Client、Frontend 和 SDK 中声明的 Vitest 测试：

```bash
pnpm -r test
```

也可以按包运行：

```bash
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/sdk test
```

#### 项目端到端集成测试

根目录的 `pnpm test` 会自动启动临时 Server 和 mock Client，覆盖认证、任务、文件传输等核心链路；测试结束后会清理进程。它会占用 `3001` 端口，并重建本地测试数据库：

```bash
pnpm test
```

不要在有未备份数据的开发数据库上运行该命令。

#### FRP 全链路集成测试

`pnpm test:frp` 会自动启动随机端口的 FRPS、Server 和真实 Client，验证 TCP/HTTP 映射、Dashboard 代理状态、删除和错误场景，测试完成后自动清理：

```bash
pnpm build
pnpm test:frp
```

该测试需要先执行 `pnpm download:frp`。如果输出 `SKIP`，表示 FRP 二进制缺失，此次没有真正执行 FRP 测试，不应视为全链路测试通过。

#### 构建检查

```bash
pnpm build
```

`pnpm build` 会构建所有 workspace 包；Client 构建时如果缺少 `frpc`，会尝试自动下载当前平台版本。

## 后续扩展方向

- **移动端** — 延伸到手机，随时随地查看 TODO、跟 Agent 对话、审核结果
- **客户端 Pi Agent 代理** — 每台机器上的客户端内置 Agent 能力，网关下发子任务，客户端自主执行并返回
- **主动监控巡检** — Agent 自主巡视机器状态，异常自动创建 TODO 并通知你
