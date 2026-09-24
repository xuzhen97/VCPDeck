# ADR-0029：Server 管理 Pi 配置，Client 使用隔离的 VCPDeck Pi Runtime

- 状态：Proposed
- 日期：2026-09-20
- 决策者：项目维护者
- 关联：[`docs/design/remote-pi-control-plane.md`](../design/remote-pi-control-plane.md)、[`docs/design/remote-pi.md`](../design/remote-pi.md)、[ADR-0007](./0007-client-owned-interactive-runtime.md)、[ADR-0008](./0008-pi-session-job-and-run-lifecycle.md)、[`docs/roadmap.md`](../roadmap.md)

## 背景

当前 VCPDeck 远程 Pi 直接复用目标机器运行账户的 Pi agentDir。Client 的 Pi capability 会读取本地 Pi settings、检查默认 agentDir，Pi Worker 创建 AgentSession 时通过 Pi SDK 的 `getAgentDir()`、SettingsManager、ModelRuntime、ProjectTrustStore 和默认 Session 目录读取目标机器已有的 Pi 配置、模型凭据、资源与 Session。

这种方式使远程 Pi 能快速工作，但不满足下一阶段的产品边界：

1. VCPDeck 需要由 Server 集中管理模型、凭据、thinking、工具策略、Skills、Extensions、Prompts 及其启用状态；
2. Client 不应持久保存上述配置和 Secret；
3. VCPDeck 自带的 Pi 与目标机器上用户自行安装、配置和使用的 Pi 必须互不污染；
4. Pi SDK、受信 Extensions、Skills 和 Prompt 资源需要与 Client Release 一起版本化、升级和回退，而不能在 Client 上形成第二套独立包管理器；
5. 远程 Pi Session 的正文仍应留在目标 Client，不能为了集中配置而把高敏感对话正文迁入 Server；
6. Frontend 希望复用开源 Pi Web UI 的成熟交互，但不能复用其“直接读写本地 Pi 配置和 Session”的数据模型，否则会绕过 VCPDeck 控制面。

现有 ADR-0007 已决定真实 Pi Worker 与 Session JSONL 驻留 Client、Server 只保存控制元数据；ADR-0008 已决定 Session Job/Run 生命周期。本 ADR 不改变这两个结论，而是补充 **Pi 配置、运行时目录和扩展资源的权威边界**。

## 决策

### 1. Server 成为 Pi 配置与策略的唯一权威

Server 持久化并管理 Pi Profile、模型允许范围、默认模型、thinking、工具策略、资源启用项、Client→Profile 绑定和 Provider Credential。

Client 不把 Server 下发的 Profile、Credential、模型配置、工具策略、资源启用项或 Project Trust 决策写入本地 Pi settings/auth/models 文件。Server 下发的是带版本的 `PiRuntimeSpec` 快照，不是对 `settings.json`、`models.json`、`auth.json` 的远程文件同步。

### 2. Client 使用显式、独立的 VCPDeck Pi 数据根

VCPDeck Pi 必须始终使用 VCPDeck 自己的数据根，任何生产路径都不得 fallback 到用户原生 Pi 的 `~/.pi` 或 Pi SDK 默认 agentDir。

VCPDeck Pi 与用户 Pi 唯一允许共享的是用户明确选择的项目工作目录 cwd。settings、models、credentials、Session JSONL、cache、临时文件、global Extensions/Skills/Prompts、Project Trust 和 Package 状态全部隔离。

Client 通过统一 runtime path resolver 显式向 Pi SDK 提供 agentDir 和 sessionDir，并在 Worker 进程环境中设置隔离的 `PI_CODING_AGENT_DIR` 作为防御性兜底。

### 3. Session 正文继续由 Client 持有，但进入 VCPDeck 专属 Session 目录

远程 Pi Session JSONL 仍由 Client/Pi SDK 管理并继续作为对话正文事实来源，保持 ADR-0007。新 Session 必须创建于 VCPDeck 专属数据目录；list/open/fork/clone 也必须显式限定在该目录。不得扫描、列出、打开或修改用户原生 Pi Session（唯一例外：用户显式发起的旧会话导入，见 [ADR-0031](./0031-native-pi-session-explicit-import.md)；该路径仍只读、单向、只操作副本）。

Server 不默认镜像 prompt、回复、thinking、工具结果或 Session JSONL。

### 4. Pi SDK 与受信资源随 Client Release 发布

Pi SDK、VCPDeck 受信 Extension 代码、Skills、Prompts 和必要静态资源构成 `PiResourceBundle`，作为 Client Release 的一部分发布。

Server 只决定某个 Profile“允许/启用哪些 resource ID”，不向 Client 动态下发可执行 JavaScript/TypeScript，不在运行中的 Client 上执行 npm/git package install。

Bundle manifest 至少声明 Bundle 版本、Pi SDK 版本、资源 ID/版本和完整性摘要。Client 注册时上报 Bundle 能力；Server 仅向兼容 Bundle 下发可执行的 RuntimeSpec。

### 5. RuntimeSpec 对 Worker 不可变，配置更新通过换代生效

每个 Pi Worker 创建时绑定明确的 `runtimeRevision`。Server 配置改变后：

- 活跃 Run 不热替换模型 runtime、工具或 Extension；
- 活跃 Run 按旧 revision 完成本轮，然后 Worker drain；
- idle Worker 可立即关闭并在下一次操作时按新 revision 重建；
- 新 Worker 只使用新 revision；
- 紧急 kill/禁用属于独立安全控制，不通过普通热配置实现。

### 6. Secret 只在 Server 持久化，Client 仅持有运行期材料

Provider Secret 在 Server 以加密形式持久化，明文不得进入普通 REST 响应、日志、Job payload/result 或审计正文。

Client 仅在运行期取得当前 RuntimeSpec 所需 Credential material，并优先直接注入 Pi 的 credential/model runtime，不把 Secret 写入 VCPDeck Pi 目录，也不以通用 shell 环境变量形式暴露给 Agent 工具。

如果锁定 Pi SDK 无法在不落盘、不向 shell 子进程泄露的前提下提供某 Provider Credential，该 Provider 在完成兼容层前应 fail closed，而不是回退到用户 `~/.pi` 或明文文件。

### 7. 项目本地 Pi 资源默认不加载

第一阶段默认禁止加载项目目录中的 `.pi/extensions`、项目 settings 和其他可执行 Pi 资源；VCPDeck 仅加载 Release Bundle 中的受信资源。

未来如允许项目本地资源，必须新增明确 Server policy/审批语义，并保证审批状态不落入用户原生 Pi trust store。

### 8. 新协议显式协商，不得静默回退旧本地 Pi 模式

Client capability 增加 RuntimeSpec/Bundle/隔离模式版本摘要。新 Server 只在 Client 明确声明 server-managed isolated runtime 能力且版本兼容时启用新的 Pi。

混合版本或协议不匹配时 Pi 明确不可用；不得为了兼容而 fallback 到用户 `~/.pi`。

### 9. Frontend 保留 VCPDeck 控制层，开源 UI 仅作为可替换 renderer

VCPDeck 继续以 Server REST/SSE、Owner/Observer、Session Job/Run 和 Extension UI 协议为控制事实。

仓库中的 `examples/pi-web` 可作为 UI/交互实现来源和设计参考，但不直接运行其本地后端、配置 API、Credential 管理或默认 `~/.pi` 数据路径。复用位于消息、Markdown、Tool Call、Thinking、Composer、Session 列表等展示组件层，并通过 VCPDeck Pi UI Adapter 接入。

### 10. RuntimeSpec 版本化：Client 拒绝自己无法施加的策略字段

`PiRuntimeSpec` 的 schema 版本只随「Client 是否真正执行该字段」演进。Server 不得向 Client 下发该 Client 不施加的策略或资源字段；Client 的严格 parser 必须拒绝未知字段与不支持的 `schemaVersion`，并以稳定错误码 fail closed。

理由：接受但忽略字段会形成「Server 认为策略已生效、Client 实际未执行」的静默绕过，而且不会被常规测试发现。

后果：首版 RuntimeSpec 只包含模型策略与 Profile 标识；Pi Resource Bundle、Tool Policy 与资源启用项必须以更高的 `schemaVersion` 引入，Client 与 Server 同批升级。

### 11. 模型元数据的权威在 Client 运行时的 Pi 目录

Provider 的模型条目必须声明元数据来源：`catalog` 表示 Server 只保存 `modelId` 与展示名，完整元数据（上下文窗口、`maxTokens`、成本、`compat`、`thinkingLevelMap`、`promptCache`）由 Client 用自身 SDK 的内置目录解析；`explicit` 表示 Server 保存完整元数据，只允许用于内置目录没有的自定义端点。

理由：内置目录包含 Pi 实际使用的真实参数与全部扩展字段，Server 无法获知也无法维护；若 Server 用占位值下发元数据，会静默篡改 Pi 的上下文压缩阈值、成本统计与思考等级映射，而且不会在常规测试中暴露。

后果：

- Client 注册 Provider 时**永不下发空 `models`**：Pi 的 `registerProvider` 在未提供 `models` 时会保留该 Provider 的全量内置目录，把可用面扩大到 Server 的 `modelPolicy.allowedModels` 之外；解析结果为空时必须不注册该 Provider 并记入 `unavailableModels`。
- `catalog` 模型在 Client 目录中不存在时必须单项 fail closed（`model_not_in_catalog`），不得回退为占位元数据。
- 自定义端点必须显式提供元数据（含可用 `baseUrl`），且元数据在 UI 中标注为未确认。

## 候选方案

### Server 同步 Pi 配置文件到 Client

不采用。它会产生配置残留、Secret 落盘、版本漂移和“Server 权威 + Client 文件权威”双事实源，并容易误写用户 `~/.pi`。

### 继续复用用户原生 Pi

改动最小，但无法满足“不污染本机 Pi”和集中扩展治理；本机用户更新 Pi/插件也会改变 VCPDeck 行为，不采用。

### Server 运行 Pi，Client 只提供远程工具

会改变 ADR-0007 的运行态归属并扩大数据面；当前不采用。

### Server 动态下发 Extension 代码

相当于建立远程代码分发/包管理系统，扩大供应链、签名、回滚和审计责任；当前用 Client Release Bundle 替代。

### 整体嵌入 Pi Web

Pi Web 默认共享本地 Pi 配置、Credential 和 Session，并拥有自己的后端与配置语义；会绕过 VCPDeck Server 权威。当前只复用 UI 层和交互模式。

## 后果

### 正面

- VCPDeck Pi 与用户原生 Pi 可在同一机器并存且文件边界明确；
- Server 统一管理模型、Secret、策略和资源启用项；
- Client Release 同时锁定 Pi SDK 与受信扩展，升级/回滚组合可复现；
- Session 正文仍留在 Client；
- 配置更新按 revision 换代；
- UI 可复用开源成熟组件而不引入第二套控制面。

### 负面与风险

- Server 新增 Pi 配置、Credential、Binding 和 RuntimeSpec 生命周期；
- Client 新增 VCPDeck Pi data root、sessionDir、resource loader 和 Worker revision；
- Server↔Client Pi 协议需要能力协商和 RuntimeSpec 同步；
- Client 运行账户被完全攻陷时，运行期 Credential 仍可被读取；
- 旧 VCPDeck Pi Session 与用户原生 Session 当前混在原 Pi agentDir 中，不能自动判定来源；
- 跨入隔离版本后回退旧 Client 可能重新触碰用户 Pi 目录。

## 迁移原则

1. 不自动搬迁、删除或修改用户 `~/.pi`；
2. 不自动导入用户 Pi Credential、settings、Extensions 或 Skills；
3. 历史 Session 如需继续在 VCPDeck 使用，只允许“显式选择、只读源、复制导入 VCPDeck Session 根”；
4. 新 Server 遇到不支持隔离 RuntimeSpec 的旧 Client 时禁用 Pi；
5. Client Release 更新不删除 VCPDeck Session data root；
6. Resource Bundle 随 Release 回滚，但 Session data 不随 Release 目录回滚；
7. 跨越隔离边界的整体降级必须单独声明 Pi 影响。

## 验证与退出条件

最低验收必须证明：

- 用户 `~/.pi` 预置 settings、models、credentials、Session 和可执行 Extension 后，VCPDeck Pi 启动、对话、升级和退出均不会新增、修改或删除该目录任何文件；
- 用户原生 Pi Session 不出现在 VCPDeck Session 列表，VCPDeck Session 不写入用户 Pi Session 目录；
- 未安装用户 Pi 的全新机器可仅凭 VCPDeck Client Release + Server Profile 使用 Pi；
- Client 磁盘不存在 Server Provider Secret、Profile 副本和动态下发 Extension 代码；
- Bundle/RuntimeSpec 不兼容时 fail closed；
- Client 更新/回滚 Bundle 不丢失 VCPDeck Session；
- 活跃 Run 在 Profile 更新时不发生中途热替换；
- 日志、错误、capability、PI_STATE 和审计不出现 Secret、真实 agentDir 或 RuntimeSpec 敏感字段；
- UI renderer 替换不改变 REST/SSE/Owner/Run 控制语义；
- RuntimeSpec 不包含 Client 无法施加的策略字段，未知字段或未知 `schemaVersion` 必须 fail closed，不得静默忽略。

未来若需要 Server 永久保存 Session 正文、动态安装第三方 Pi Package、允许项目任意本地 Extension、跨 Client 迁移 Session、多租户 Secret 隔离或把 Pi Runtime 移到 Server，应重新评估并新增/替代 ADR。

