# AGENTS.md

## 1. 核心规则

- VCPDeck 是个人 AI 协作驾驶台；当前能力包括远程机器、Job、文件、Terminal、Pi、FRP、Storage 和 Release/更新。
- **当前运行事实**以代码、`packages/shared/src/`、Prisma schema 和配置读取逻辑为准；**长期决策意图**以有效 Accepted ADR 为准；Current 文档负责解释当前边界。
- 开发前先读 [`docs/index.md`](./docs/index.md)、相关 Current 专题和 Accepted ADR。
- 代码、ADR 与 Current 文档冲突时停止猜测并报告，由维护者确认长期方向。
- 只描述和实现已经确认的当前需求；未实现方向只进入 [`docs/roadmap.md`](./docs/roadmap.md) 或 Issue，不能写成现有能力。
- 优先最小、直接、可验证的修改；先复用现有模块和 Node.js 标准库，不提前增加抽象层、配置层、factory、interface 或空目录。

## 2. 工作流程

1. 查明事实来源和相关调用链；修改代码符号前执行下方 GitNexus impact 分析。
2. 修改跨运行时协议时，同步检查 Shared、Server、Client、SDK、Frontend、兼容性和测试。
3. 运行行为变化时，同一变更更新对应 Current 文档；重大长期取舍先写 ADR。
4. 用户或运维可感知的变化更新 `CHANGELOG.md`。
5. 完成前运行相关 LSP、测试、构建、`git diff --check`；提交前执行 GitNexus `detect_changes()`。
6. 不把无关的既有问题混入当前修改；发现后记录并报告。

## 3. 临时材料

- Agent 生成的任务计划、分析过程、实施清单和验证草稿统一放在根目录 `.tmp/`。
- `.tmp/` 已被 Git 忽略，不属于项目事实来源，也不得被正式文档引用。
- 不在 `docs/` 中创建一次性计划、TDD 清单或临时验证草稿。
- 任务完成后删除对应临时材料；长期价值只提炼到代码、Accepted ADR、Current 文档、Roadmap 或 Issue。
- 只有具备独立历史价值的正式材料才进入 `docs/archive/`。完整规则见 [`docs/documentation-governance.md`](./docs/documentation-governance.md)。

## 4. 架构边界

```text
packages/
  shared/    跨运行时协议、事件、枚举、DTO 和 parser；无内部依赖
  sdk/       类型安全 REST 客户端；只依赖 shared
  server/    NestJS 中心控制面、Socket.IO/SSE、Prisma
  client/    目标机器代理：Job、Files、FRP、PTY、Pi
  frontend/  React + Vite 驾驶台
  cli/       命令入口和 Pi Skill 构件
  launcher/  Server/Client 守护、更新和回退
```

- Frontend、SDK 和 CLI 不直接控制目标机器；所有业务操作先进入 Server。
- Server 与 Client/Frontend 通过 Shared 契约和网络协议协作，不跨包引用彼此源码。
- `/client` Socket.IO 用于 Server ↔ Client；`/app` Socket.IO 当前用于 Browser Terminal；SSE 用于 Pi 事件投影。
- 需要持久化、调度、取消、恢复或审计的远程操作使用 Typed Job；Terminal 使用专门 Session，不是普通 Job。
- PTY、Pi Worker/Session 和 frpc 等实时资源在 Client；Server 保存控制面状态和最小审计。
- 新目录、包或运行组件必须服务当前阶段验收；新增运行组件或数据权威变化必须先写 ADR。

## 5. 协议与数据约束

- 跨信任边界输入必须运行时校验；未知 type、action、event、状态和字段不得宽松猜测。
- `@vcpdeck/shared` 是协议字段、事件、枚举、错误码、capability 和 parser 的统一维护位置。
- TypeScript 使用 ESM + strict；NodeNext 相对导入保留 `.js` 后缀。
- 列表接口统一返回 `PaginatedResult<T>`：`data/total/page/pageSize/totalPages`。
- Service 并发查询列表与总数；Controller 将 `pageSize` 限制在 1–100；SDK 使用 `URLSearchParams`。参考 `packages/server/src/frp/` 和 `packages/sdk/src/frp.ts`。
- 错误保持稳定 `code`、合适 `statusCode` 和安全 message；不得泄露 stack、密钥、签名 URL、文件内容或原始外部响应。

## 6. 安全边界

- 当前是少量可信操作者单信任域；任意有效业务 Identity 都是远程操作员，admin 只额外管理身份。
- `/client` 使用 PSK；REST 使用 Cookie/Bearer，只有显式 `@Public()` 端点公开。
- 命令、脚本、stdout/stderr、环境变量、路径、Job payload/result、终端/Pi 正文和文件内容都可能敏感；日志与错误默认脱敏。
- Client 不执行未通过协议与 capability 校验的输入。
- 远程命令、Terminal、Pi 和 Files 继承 Client OS 账户权限，不是沙箱。
- 示例和测试不得执行真实破坏性命令或使用真实凭据。

## 7. 代码与文档风格

- 业务和设计文档使用简体中文；代码标识符、协议字段、数据库字段、包名和枚举值使用英文。
- 注释使用简体中文；导出类型、函数和类提供简体中文 JSDoc。
- `git commit` 使用简体中文。
- 不复制大段 DTO 或实现到文档；Current 文档解释语义、权威、状态、安全、故障与已知偏移。

## 8. 常用命令

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm -r test
pnpm --filter @vcpdeck/server build
```

`pnpm lint` 当前依赖仓库提供可用的 ESLint executable；若命令因工具缺失未运行，必须明确报告，不能声称 lint 通过。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **VCPDeck** (8487 symbols, 21543 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
