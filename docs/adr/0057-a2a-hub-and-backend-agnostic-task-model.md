# ADR-0057：A2A Hub、多轮执行与 Task 审计事件链

- 状态：Accepted
- 日期：2026-10-18
- 决策者：项目维护者
- 关联：[ADR-0004](./0004-typed-job-kernel.md)、[ADR-0005](./0005-shared-contracts-and-communication-channels.md)、[ADR-0007](./0007-client-owned-interactive-runtime.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)、[ADR-0049](./0049-retire-pi-dsh-integrations-and-focus-on-core-capabilities.md)、[ADR-0054](./0054-job-log-event-chain.md)、[ADR-0056](./0056-feature-registry-declared-contracts.md)、[A2A Protocol v1.0](https://a2a-protocol.org/latest/specification/)、[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)

## 背景

目标是让一个 agent（例如 DSH）通过 VCPDeck 调用目标机器上的另一个 agent 完成任务。这个任务不是一次性的命令执行，而是需要多轮交互：目标 agent 可能先给计划、再提问、等待授权、继续执行，最后产出 diff、文件或报告。与此同时，调用方需要审计整个任务，判断它有没有偏离原始意图。

当前系统的三个事实不足以支撑这个目标：

- `Job` 是一次远程操作，适合一次性执行；它没有 Task/Turn 语义，也没有跨轮的上下文。`waiting_input` 实测是 `file.import` 等上传会话的占位，不是通用的任务输入通道（`packages/server/src/job/job.service.ts`）。
- `Terminal` 是交互式 PTY，不是任务模型，也没有结构化的工具调用、权限与产物事件。
- Pi／DSH 专用集成与 session-host 已由 [ADR-0049](./0049-retire-pi-dsh-integrations-and-focus-on-core-capabilities.md) 决定退役；本决策不得复活旧运行体系。

协议分层也要说清楚：

- **A2A** 是 agent 与 agent 之间的任务协议：`Agent Card`、`Task`、`Message`、`Artifact`，支持多轮消息、`input-required`、`auth-required`、流式与长任务。它适合作为调用方契约，但不提供 Agent Registry、路由、执行适配器或审计事件模型。
- **ACP** 是编辑器/客户端与编码 agent 之间的协议：`session/prompt` 天然按轮推进，`session/update` 暴露消息、思考、工具调用、计划、usage，`session/request_permission` / `elicitation` 提供中断与追问，`session/load` / `resume` 支持恢复。它适合作为目标机执行适配器，但不是 agent 间的任务契约。
- **MCP** 是 agent 与工具/数据之间的协议，不等于 agent 间委派。

多轮是硬需求时，CLI/Job 的一次性模型不够：要么每轮重开进程，要么依赖每个 agent 私有的 `--resume` 参数，既不通用，也难以形成结构化审计证据。ACP 是目前编码 agent 生态里最现实的多轮执行适配器。

审计也不是“把日志留下来”这么简单。要判断任务有没有偏差，必须先有基线（意图、验收标准、约束），再把计划、工具调用、权限决定、产物和最终验收串成证据链。A2A 和 ACP 都不提供这套审计模型，必须由 VCPDeck 在 Task 层建立。

## 决策

1. **A2A 是跨 agent 的外部任务契约。** VCPDeck 对外提供 A2A v1.0 服务面：Agent Card、Task、Message、Artifact，以及 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask` 和可选的流式与 push。ACP 不暴露给调用方作为任务契约；它只能作为 Hub 背后的执行适配器。

2. **Task 独立于 Job，Task 也不等于一次执行尝试。**
   - Server 持有 Task 域，语义对齐 A2A：`taskId`、`contextId`、`state`、`intent`、`acceptanceCriteria`、`constraints`、`agentRef`、workspace、timestamps、error、artifacts、可选 usage；
   - 一个 Task 可以包含多个 `turn`（一轮调用方消息与 agent 响应），也可以有一次或多次执行尝试（attempt）；每次尝试可以对应一个 Job、一个 ACP 会话或一个下游 A2A Task；
   - `taskId` 不得等于 `jobId`，也不得把 Job 状态枚举直接当 A2A 状态；
   - Task 到达 A2A 终态后不可重启；需要重试或继续时，创建新的 Task，并在发起消息的 `referenceTaskIds` 中引用旧 Task；
   - 不新增 `agent.*` JobType，不复用 `AgentSession`／`AgentRun`。

3. **Agent Registry 是任务路由的目录，不是 Feature Registry，也不是 agent 账号表。**
   - 对外只暴露逻辑 `agentId`、技能、workspace 别名和 adapter 类型，不暴露 `clientId`、真实路径或凭据；
   - agent 子进程不注册、不持有 VCPDeck 身份，也不建立心跳；登记的是“这台机器上的一个 agent placement”（逻辑 `agentId` + preset + workspace + client 绑定）。v1 由操作者在 Server 侧声明；后续 Client 可上报已安装 inventory 作为运行时事实，但不得覆盖 Registry 或替代操作者授权；
   - 同一逻辑 `agentId` 可以有多台机器／多套 preset 的 placement；v1 若调用方未指定 placement／client 且存在歧义，必须 fail closed，不得静默选一个；自动选择留给后续 Router；
   - 与 [ADR-0056](./0056-feature-registry-declared-contracts.md) 的功能条目保持分离：功能条目是“可复用能力的声明式契约”，Agent Registry 是“可被派任务的 agent 目录”，不得把功能条目当 agent；
   - v1 只支持调用方显式选择 `agentId`；按技能自动路由、负载与 fallback 是后续决策，不写入 v1 行为。

4. **执行适配器从属于 Task；ACP 是多轮主路径，CLI/Job 是一次性兜底。**
   - 适配器统一承担 `submitMessage`、`cancel`、`get`、`stream`、`artifacts`、`resume`，并接受幂等键；
   - **ACP adapter**：VCPDeck Client 侧新增 ACP Host，负责 `initialize`、`session/new`、`session/prompt`、`session/update`、`session/request_permission`、`session/cancel`、`session/load/resume`；Client 把标准化事件投影给 Server；Server 不持久化 `session/update` 正文；
   - **CLI/Job adapter**：沿用现有 Typed Job 执行 headless CLI，用于一次性任务、没有可用 ACP 的 agent、以及快速兜底；CLI adapter 不得伪装支持多轮；
   - **原生 A2A adapter**：下游 agent 自己就是 A2A Server 时使用；作为后续能力另立实现 ADR；
   - 本 ADR 授权新增 Client 侧 ACP Host，但仅限协议宿主：不内嵌 agent SDK，不管模型、Provider、凭据、Bundle 或会话正文。实现前仍需完成安全、进程监管与协议设计；
   - 任何适配器都不得把调用方输入直接变成目标机命令、参数、环境变量或 MCP 配置；只能引用 Registry 中已声明的 agent、preset 与 workspace。

5. **多轮与中断的映射必须显式。**
   - 一个 A2A Task 可以承载多个 Message/Turn；每个 Turn 映射到 ACP 的一次 `session/prompt`（或 CLI adapter 的一次执行）；
   - A2A 的 `input-required` 映射为 ACP 的 `session/request_permission` / `elicitation` 暂停点；调用方回答后继续；
   - `auth-required` 表达目标机 agent 需要先登录；VCPDeck 只返回可操作的安全错误，不集中保管凭据；
   - `CancelTask` 映射为 `session/cancel` 或 Job cancel；取消后必须等 `stopReason: cancelled` 或 Job 终态，不能只发信号就宣布成功；
   - `session/load` / `resume` 只在下游 agent 声明能力时使用；不支持时就如实要求新会话；
   - `waiting_input` 不得映射为 `input-required`；CLI adapter 不支持多轮时必须 fail closed，返回稳定错误，不得假装成功。

6. **审计是 Task 的一等证据链，不是完整正文镜像。**
   - Server 持有 append-only 的 `TaskEvent` 链与 Turn ledger，带 `taskId`、`contextId`、`turnId`、`attemptId`、`agentRef`、`source`（a2a/acp/cli/human）、`fidelity`（structured/text/summary/hash-only）；
   - 事件至少覆盖：`task.created`（意图、验收标准、约束、agentRef）、`task.routed`、`turn.started`／`turn.completed`、`message`、`plan`、`tool_call`／`tool_call_update`、`permission.requested`／`permission.decided`、`artifact.created`／`artifact.updated`、`state.changed`、`deviation.detected`／`deviation.reviewed`、`human.intervention`、`task.completed`；
   - 偏差判断必须有基线：Task 创建时记录 intent、acceptance criteria、constraints（允许的路径／命令／agent）与预期产物；检查点至少覆盖计划、工具调用、产物 diff 与最终验收；
   - 偏差信号包括：越界路径、未批准命令、agent／模型切换、重试循环、前后矛盾、缺失产物、成本／时长异常；结论为 `aligned`／`drifted`／`failed`，模糊情况必须人工复核；
   - 默认只持久化事件元数据、轮次摘要、hash 与 Artifact 引用；不默认持久化完整 prompt／回复、完整工具输出或终端全文。需要全文时按任务策略显式开启、加密、限制保留期，且不得成为第二事实来源（[ADR-0007](./0007-client-owned-interactive-runtime.md)）；
   - 审计只提供证据，不等同于自动判定“没有偏差”；UI/CLI 必须区分 `fidelity` 与未知项。

7. **安全边界沿用单信任域，但外部入口必须重新收口。**
   - 调用方必须是已认证的业务身份；A2A 入口不能是公开匿名端点；
   - 只允许 Registry 中的逻辑 agent 与 workspace；不接收调用方提交的命令、参数、环境变量、MCP Server 或任意路径；
   - agent 继承目标机 Client OS 账户权限，不是沙箱；ACP 的 `session/request_permission` 也是 agent 自愿请求，不是强制拦截；
   - ACP Host 默认不声明 `fs/*` / `terminal/*` 能力，或只在受控 workspace 内实现；不得让上游调用方替目标机读写文件；
   - Agent Card 与 Task 事件不得包含 `clientId`、真实路径、凭据或完整命令；push notification 后置，若引入必须做 SSRF 与出口校验；
   - 审计事件可能包含源码、路径与命令摘要，必须脱敏、限额并设定保留策略；普通日志不得回显正文。

8. **兼容与灰度。**
   - 新增 A2A 路由、Task/Audit 表、Agent Registry、ACP Host 与 CLI/Job adapter；旧 Client、旧 Server 组合不因本决策改变注册、心跳、Job、Terminal 或 Files 行为；
   - ACP adapter 只在 Client 上报 ACP Host 能力后启用；CLI adapter 不要求 Client 新增协议字段；共享 parser 对 ACP 帧采用“信封严格、payload 容忍未知”策略，未知 `session/update` 不得杀会话；
   - 回滚需要移除 A2A 路由与调用入口，并按数据库迁移规则处理 Task/Audit 表；已经产生的目标机副作用不回滚；
   - ACP Host 的引入必须单独完成进程监管、启动探测、取消与进程树清理设计，不与 Job 调度槽混淆。

9. **v1 明确不做。**
   - agent 市场、安装器、版本管理；
   - 模型、Provider 或 agent 凭据的集中管理；
   - 完整会话正文持久化、全文检索或跨机器迁移；
   - 按技能自动路由、负载均衡、fallback、fan-out／fan-in、pipeline 编排；
   - 多租户隔离、按 agent 的资源级授权；
   - push notification、公开 Agent 发现市场；
   - 把 ACP 作为调用方契约，或让调用方直接充当 ACP 客户端；
   - 用 CLI adapter 冒充多轮能力；
   - 自由形式的人机直连会话（Interactive Session）不属于本决策；它应复用 Client ACP Host 或独立 Web 代理，但使用独立会话生命周期，不冒充 A2A Task；DSH 原生 Web UI 的访问属于独立的 Web 代理决策；
   - 面向人机直连的端口转发、服务代理与调试适配器（DAP）不属于本决策；它们属于独立的 Interactive Dev Session 数据面决策。

10. **与 ADR-0049 的关系。**
    - 本决策不是复活 Pi／DSH 专用集成或 session-host；VCPDeck 不拥有 agent 运行时、模型、凭据、会话正文或扩展 Bundle；
    - ACP Host 只是协议适配器，不是 Agent 平台；它按需拉起外部 agent、投影事件、按 Task 终止，不提供模型选择、凭据托管或会话内容搜索；
    - 任何超出“任务契约 + 注册表 + 执行适配器 + 审计证据”的 Agent 产品面，必须另立 ADR，不得借本决策扩张。

## 候选方案

- **CLI/Job-only**：不采用。一次性任务够用，但多轮只能依赖各 agent 私有 `--resume`，不通用，也无法稳定产出结构化审计事件。
- **调用方直接说 ACP（ACP 端到端）**：不采用。调用方会被迫处理 `session/request_permission`、`fs/*`、`terminal/*` 和目标机 cwd；没有 Task／Artifact／审计基线，自动放行权限还会形成安全洞。
- **A2A over Job（Task 直接等于 Job）**：不采用。状态语义、多轮、Artifact、审计与路由都不匹配；后续会要求重写合同。
- **把审计等同于完整正文镜像**：不采用。会把 Server 变成 agent 正文的第二权威，与 ADR-0007 冲突，并扩大敏感数据面。
- **只做审计日志、不做基线**：不采用。没有 intent／acceptance／constraints 就只能记录“发生了什么”，无法判断“有没有偏差”。
- **让 agent 自己注册**：不采用。agent 是短生命周期子进程，没有稳定身份、入站连接或独立凭据；会多出一套认证与生命周期面。
- **Agent 之间直接 A2A 网状互联，不经 Hub**：不采用。目标机 Client 是出站连接，没有稳定入站入口；Hub 是符合现有拓扑的会合点。
- **把 agent 包装成 MCP 工具**：不采用。工具语义无法表达多轮、Task 生命周期、Artifact 与审计。
- **复用 `AgentSession`／`AgentRun` 表**：不采用。它们是 ADR-0049 退役后的历史数据，复用会复活旧语义。
- **v1 就做自动技能路由与编排**：不采用。先把显式选择、多轮与审计跑通；路由与编排需要独立的任务图、策略与验收。

## 后果

正面：

- 多轮任务有了稳定的 A2A 契约与 ACP 执行路径，调用方不需要理解 ACP 或目标机拓扑；
- Task 事件链让“完成了但跑偏了”可被检查，而不是只看退出码；
- 审计与正文分离，既保留证据，又不让 Server 变成聊天记录库；
- 执行后端可替换：ACP 主路径、CLI 兜底、后续原生 A2A；
- 不恢复 Agent 平台：没有模型、凭据、会话正文和 Bundle 的集中所有权。

负面与风险：

- 新增 ACP Host、Task/Audit 域、Registry、A2A 路由，是一块真实的运行与数据面；
- ACP 在 Client 侧引入 stdio/JSON-RPC、ESM/CJS、进程监管、权限中转与会话映射，复杂度明显高于 CLI adapter；
- ACP 权限是 agent 自愿请求，审计能看到“请求了什么”，但不能证明“没有偷偷执行”；
- `fidelity` 不齐：CLI adapter 只有文本，ACP 才有结构化 tool call；审计必须诚实地标记未知；
- 审计事件的保留、脱敏、访问控制与全文开启策略都需要单独设计；
- ACP 协议仍在演进（v1 稳定、v2 Draft），需要版本协商与能力门控；
- 两个 adapter 增加维护面，CLI 与 ACP 的行为差异需要测试矩阵。

安全与运维影响：

- 新增外部 A2A 入口，必须复用现有身份认证并加限流；匿名暴露不可接受；
- Agent Registry 的写入需要操作者权限，但不能把写入权限等同于目标机命令执行权限；
- ACP Host 必须按 Client 能力启用，不能对未上报能力的旧 Client 下发 ACP 指令；
- 审计事件、Agent Card、A2A 错误不得回显凭据、clientId、真实路径或完整命令；
- ACP Host 的进程树清理、超时、断线取消与孤儿回收必须单独验收；
- Task 生命周期审计与 Job 日志链（ADR-0054）分开记录，不把 agent 正文写进 Job 日志。

## 验证与退出条件

实现完成后必须验证：

- 多轮链路：`prompt#1` → `input-required` → 调用方回答 → `prompt#2` → `completed`；Task 有独立 Turn 记录，ACP session 不被错误重启；
- `input-required` 与 ACP `session/request_permission`／`elicitation` 的映射不会自动放行；`auth-required` 只返回安全错误；
- `CancelTask` 能映射到 `session/cancel` 或 Job cancel，并等待终态；不会出现“发了取消但实际还在跑”；
- 审计链：`task.created` 中有 intent／acceptance／constraints；每个 Turn 有 started/completed；工具调用、权限决定、Artifact 与最终验收都有事件；
- 偏差检查：越界路径、未批准命令、缺失产物至少各有一个可复现用例，并能产出 `drifted` 结论与证据；
- 默认不持久化完整 prompt／回复／工具输出；开启全文时有加密、保留期与访问控制；
- CLI adapter 对多轮请求 fail closed，不伪装成功；
- 调用方不能提交 command／args／env／MCP／任意路径；workspace 越界被拒绝；
- 旧 Client 注册、心跳、Job、Terminal、Files 与 FRP 不回归；ACP Host 未上报时不启用 ACP 路径；
- Agent Card 与审计事件不泄露 clientId、真实路径、凭据或内部拓扑。

出现以下情况时应创建新 ADR supersede 或扩展本决策：

- 需要按技能自动路由、负载均衡、fallback、fan-out／fan-in 或任务图编排；
- 需要把 Agent Registry 扩展为跨组织发现、市场或公开 Agent Card；
- 需要持久化完整任务历史、全文检索或跨机器迁移；
- 需要 push notification、公开回调或多租户隔离；
- A2A／ACP 协议发生破坏性变化，或原生 A2A adapter 引入新的运行组件／数据权威；
- ACP 的运行成本或权限缺口证明不可接受，需要退回 CLI-only 并明确只支持一次性任务；
- 实际需求证明“多轮 + 审计”可以缩窄为“一次性任务 + 结果摘要”时，应重新评估是否需要 Task 域与 ACP Host。
