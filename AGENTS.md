# AGENTS.md

## 项目概述

VCPDeck 是一个个人 AI 协作驾驶台，当前阶段实现了**远程机器管理与命令执行**的核心闭环：

- Server（NestJS 网关）— WebSocket + REST API，管理客户端连接、任务调度、状态追踪
- Client（Node.js 代理）— 部署在目标机器上，注册、心跳、执行命令、上报结果
- Frontend（React + Vite）— 驾驶台界面（骨架阶段）
- CLI — 命令行工具（骨架阶段）

事实来源：`README.md`（定位与愿景）、`docs/`（设计文档）、代码本身。

## 构建与运行命令

- `pnpm install` — 安装依赖
- `pnpm build` — 全量构建（所有包）
- `pnpm dev` — 并行启动所有包的 dev 模式
- `pnpm lint` — 全量 lint
- 单包构建：`pnpm --filter @vcpdeck/server build`

## 代码风格

- 业务文档、设计文档使用简体中文；代码标识符、包名、协议字段、数据库字段、枚举值使用英文
- 注释使用简体中文；公共 surface（导出类型、函数、类）写简体中文 JSDoc
- TypeScript：ESM + strict，NodeNext 相对导入保留 `.js` 后缀
- 先复用现有模块和 Node 标准库，不提前加 interface、factory、配置层或空目录
- 错误对象保持稳定 `code`、合适 `statusCode`、安全 message；不泄露 stack、密钥或文件内容
- `git commit` 使用简体中文

## 架构边界

```
packages/
  shared/     — 协议类型、事件名、枚举、接口（@vcpdeck/shared）
  server/     — NestJS 网关：WebSocket 事件、REST API、Prisma 持久化
  client/     — Node.js 执行代理：注册、心跳、命令执行、取消
  frontend/   — React + Vite 驾驶台界面
  cli/        — 命令行入口
```

- `shared` 无内部依赖；其余包只依赖 `shared`
- Server 模块：`prisma/`（数据库）、`client/`（机器管理）、`job/`（任务调度）、`events/`（WebSocket + REST）
- 新目录或新包必须服务当前阶段验收

## 关键术语（与 `@vcpdeck/shared` 一致）

| 术语 | 含义 |
|------|------|
| Client / 客户端 | 一台注册到网关的远程机器 |
| Job | 下发到客户端执行的命令单元，状态见 `JobStatus` 枚举 |
| Event | WebSocket 消息，事件名见 `Events` 常量 |
| PSK | Pre-Shared Key，客户端与网关的连接凭证 |
| Dispatch | 网关将 pending job 发送到对应客户端执行 |

## 安全

- Job command、stdout/stderr、环境变量和路径都可能含敏感信息；日志默认脱敏
- WebSocket 连接通过 PSK 认证；REST API 当前无鉴权（内部使用）
- Client 不执行未验证的协议输入
- 示例和测试不执行真实破坏性命令

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **VCPDeck** (328 symbols, 485 relationships, 4 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/VCPDeck/context` | Codebase overview, check index freshness |
| `gitnexus://repo/VCPDeck/clusters` | All functional areas |
| `gitnexus://repo/VCPDeck/processes` | All execution flows |
| `gitnexus://repo/VCPDeck/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
