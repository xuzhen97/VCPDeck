# AGENTS.md

## 项目概述

VCPDeck 是一个个人 AI 协作驾驶台，当前阶段已形成远程机器管理、命令与文件操作、交互式终端、远程 Pi、FRP 和自更新的核心闭环：

- Server（NestJS 网关）— REST、Socket.IO、SSE、任务调度和 Prisma 持久化
- Client（Node.js 代理）— 部署在目标机器，执行命令、文件、PTY、Pi 和 frpc
- Frontend（React + Vite）— 身份认证、机器、Job、文件、终端、Pi、FRP 和发布界面
- SDK — Browser/Node.js 共用的类型安全 REST 客户端
- CLI — 当前提供发布包上传命令和 Pi Skill 单文件入口
- Launcher — 守护并更新 Server/Client，负责探活和失败回退

事实来源：当前代码、`packages/shared/src/`、Prisma schema 和配置读取逻辑决定实际行为；有效 Accepted ADR 解释长期决策；Current 文档解释当前边界。文档治理见 `docs/documentation-governance.md`。

## 文档维护

- 开发前阅读 `docs/index.md`、相关 Current 文档和 Accepted ADR。
- 判断当前行为时以代码、Shared、Prisma 和配置读取逻辑核验，不把规划或归档材料当作现状。
- 代码、ADR 与 Current 文档冲突时必须停止猜测并报告，由维护者确认修复实现还是用新 ADR 替代旧决策。
- 运行行为变化时，在同一变更中更新对应 Current 文档；重大长期取舍先写 ADR。
- 未实现方向只进入 `docs/roadmap.md` 或 Issue，不能写成 README/Current 的当前能力。
- 用户或运维可感知变化更新 `CHANGELOG.md`。
- 一次性过程材料在有效知识收敛后删除；只有确有历史价值的失效材料才进入 `docs/archive/`。
- 完整分类、状态、生命周期、归档和检查规则见 `docs/documentation-governance.md`。

## 构建与运行命令

- `pnpm install` — 安装依赖
- `pnpm build` — 全量构建（所有包）
- `pnpm dev` — 启动 Shared watch、Server 和 Frontend
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

```text
packages/
  shared/     — 协议类型、事件名、枚举和运行时解析器（@vcpdeck/shared）
  sdk/        — 类型安全 REST API 客户端
  server/     — NestJS 控制面：REST、Socket.IO、SSE、Prisma 持久化
  client/     — 目标机器执行代理：Job、文件、FRP、PTY、Pi
  frontend/   — React + Vite 驾驶台界面
  cli/        — 命令行入口和 Pi Skill 构件
  launcher/   — Server/Client 进程守护、更新和回退
```

- `shared` 无内部依赖；`sdk` 依赖 `shared`；其余运行包通过 Shared 契约和网络协议协作，不跨包引用彼此源码
- Server 模块覆盖身份、机器、Job、文件/Storage、FRP、Terminal、Pi、Release 和 Prisma
- 新目录或新包必须服务当前阶段验收

## 关键术语（与 `@vcpdeck/shared` 一致）

| 术语 | 含义 |
| ------ | ------ |
| Client / 客户端 | 一台注册到网关的远程机器 |
| Job | 下发到客户端执行的命令单元，状态见 `JobStatus` 枚举 |
| Event | WebSocket 消息，事件名见 `Events` 常量 |
| PSK | Pre-Shared Key，客户端与网关的连接凭证 |
| Dispatch | 网关将 pending job 发送到对应客户端执行 |

## 分页规范

列表接口统一用 `PaginatedResult<T>`（`packages/shared/src/index.ts`），字段：`data`、`total`、`page`、`pageSize`、`totalPages`。

各层写法：

```ts
// Service — Promise.all 并发取数据和总数
async listXxx(
  clientId?: string,
  page: number = 1,
  pageSize: number = 20,
): Promise<PaginatedResult<XxxInfo>> {
  const where = clientId ? { clientId } : {};
  const [list, total] = await Promise.all([
    this.prisma.xxx.findMany({
      where, orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize, take: pageSize,
    }),
    this.prisma.xxx.count({ where }),
  ]);
  return { data: list.map(toApi), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

// Controller — @Query 手动解析字符串，不引入 ValidationPipe
@Get("xxx")
async list(
  @Query("clientId") clientId?: string,
  @Query("page") page?: string,
  @Query("pageSize") pageSize?: string,
) {
  return this.service.listXxx(
    clientId,
    page ? Math.max(1, parseInt(page, 10)) : undefined,
    pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined,
  );
}

// SDK — URLSearchParams 拼接 query string
list: (options?, signal?) => {
  const params = new URLSearchParams();
  if (options?.clientId) params.set("clientId", options.clientId);
  if (options?.page) params.set("page", String(options.page));
  if (options?.pageSize) params.set("pageSize", String(options.pageSize));
  const qs = params.toString();
  return client.request<PaginatedResult<XxxInfo>>(
    "GET", `/api/xxx${qs ? `?${qs}` : ""}`, undefined, signal,
  );
},
```

参考实现：`packages/server/src/frp/frp.service.ts` `listMappings()`、`packages/server/src/frp/frp.controller.ts`、`packages/sdk/src/frp.ts`。

## 安全

- Job command、stdout/stderr、环境变量和路径都可能含敏感信息；日志默认脱敏
- `/client` Socket.IO 使用 PSK；REST 默认使用 Cookie/Bearer 认证，只有显式 `@Public()` 端点公开
- Client 不执行未验证的协议输入
- 示例和测试不执行真实破坏性命令

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **VCPDeck** (2638 symbols, 5178 relationships, 141 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
| ---------- | --------- |
| `gitnexus://repo/VCPDeck/context` | Codebase overview, check index freshness |
| `gitnexus://repo/VCPDeck/clusters` | All functional areas |
| `gitnexus://repo/VCPDeck/processes` | All execution flows |
| `gitnexus://repo/VCPDeck/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| ------ | --------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
