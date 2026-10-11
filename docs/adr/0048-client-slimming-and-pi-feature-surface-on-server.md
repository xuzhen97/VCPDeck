# ADR-0048：Client 瘦身与 Pi 功能面归 Server

- 状态：Accepted
- 日期：2026-10-11
- 决策者：项目维护者
- 实施状态：尚未实施；本 ADR 只批准方向与边界，不表示迁移已完成、也不表示任何一侧已瘦身。
- 关联：[ADR-0007](./0007-client-owned-interactive-runtime.md)、[ADR-0020](./0020-cli-dataplane-namespace.md)、[ADR-0029](./0029-server-managed-isolated-pi-runtime.md)、[ADR-0030](./0030-pi-resource-bundle-and-tool-policy.md)、[ADR-0036](./0036-pi-sdk-single-file-and-shell-capability.md)、[ADR-0039](./0039-pi-two-mode-execution.md)、[ADR-0041](./0041-agent-session-run-and-audit-separation.md)、[ADR-0042](./0042-standard-pi-community-extensions.md)、[ADR-0043](./0043-project-local-pi-resources-unconditional-trust.md)、[ADR-0044](./0044-pi-bundle-tree-delivery-and-verification.md)、[ADR-0045](./0045-central-pi-and-native-agent-environments.md)、[ADR-0046](./0046-independent-session-host-and-client-restart-survival.md)、[ADR-0047](./0047-dsh-web-access-via-authenticated-reverse-proxy.md)、[`remote-pi.md`](../design/remote-pi.md)、[`remote-pi-control-plane.md`](../design/remote-pi-control-plane.md)

## 背景

既有远程 Pi 体系把 Pi 运行时、SDK、Bundle 分发与校验、模型/插件策略、工具策略与会话语义一并压在 Client 上：`packages/client/src/pi` 共 43 个实现与测试文件（约 12,300 行），另加 `packages/client/src/pi-bundle/` 与随 Release 交付的扩展 Bundle。这使 Client 承担了与"远程操作底座"无关的 Agent 管理责任，也让每次 Agent 生态变化都变成一次 Client 发布。

维护者已明确目标：**瘦身 Client；Pi 功能搬进 Server；Client 作为基础让 Pi 使用；Client 虽然不包含 Pi，但可以利用环境本身的 pi 或 dsh 来做事，以支持 Server 的 Pi 工作；同时给外置的 Agent 提供功能。**

[ADR-0045](./0045-central-pi-and-native-agent-environments.md) 已定下"Client 退出专用 Agent 运行时管理、目标机 Pi/DSH 使用自身原生安装"的方向，但未覆盖**外置 Agent 的能力面**，也没有明确"Pi 功能面归属与迁移顺序"，而 [ADR-0044](./0044-pi-bundle-tree-delivery-and-verification.md) 与 [ADR-0042](./0042-standard-pi-community-extensions.md) 仍以 Accepted 状态描述随 Client Release 交付 Bundle 与社区扩展。因此需要一条决定，把归属、边界与退役顺序一次说清。

## 决策

### 1. Pi 功能面的权威在 Server

会话与运行编排、模型与凭据、Profile、插件与工具策略、对话内容与历史解读、推送给前端的对话投影，全部以 **Server** 为权威。Server 已有的 Pi 模块是这一层的落点，不新建第二套。

Client 不再解释 Pi 语义：不认识 Profile、工具策略、扩展、对话格式与 Run 语义。

### 2. Client 退为通用能力底座

Client 保留并对外提供通用基础能力：命令执行、文件读写与传输、终端、网络接入，以及为这些能力所需的进程与 PTY 托管。新路径**不内嵌 Pi SDK**、不构建或校验 Pi Bundle、不解析对话与扩展、不承担模型策略。

判断标准：Client 侧代码若需要知道"这是 Pi / 这是某个扩展 / 这是哪种 Run"，即归属错误，应移到 Server 或降级为不含语义的通用动作。

### 3. 目标机上的 Pi/DSH 由环境自带

目标机 Pi/DSH 使用**环境自身的安装与配置**，不是 Client Release 的组成部分，不随 Client 更新覆盖（沿用 [ADR-0045](./0045-central-pi-and-native-agent-environments.md) 决策 2）。

Client 使用它们做事的范围限于"按 Server 下发的明确命令启动、接入、观察与停止"，**不静默安装、不代为配置模型与插件、不建立第二套包管理器**。探测不到时如实上报不可用，不伪装、不猜测可执行文件。

定位方式：由安装器探测目标机已有的 `pi` / `dsh`，并允许环境变量显式覆盖探测结果。

### 4. 交互进程与接入仍驻目标机（限定 ADR-0046 候选方案 5 的适用范围）

PTY、屏幕状态、工作进程与 DSH 反向代理继续驻留目标机（[ADR-0046](./0046-independent-session-host-and-client-restart-survival.md)、[ADR-0047](./0047-dsh-web-access-via-authenticated-reverse-proxy.md)）。这是物理约束而非偏好：Pi 必须在目标机的项目目录与原生配置/凭据下运行，DSH 的会话 Cookie 绑定 authority，跨机器终止会直接破坏登录。

[ADR-0046](./0046-independent-session-host-and-client-restart-survival.md) 候选方案 5 所拒绝的是**把交互式工作进程搬到 Server 上运行**；本 ADR 不改变该结论，只明确它**不适用于"Pi 功能面"的归属**。Server 持有脑与账本，目标机持手与现场。

### 5. 外置 Agent 的能力面

第 2 条的通用能力要能被**外置 Agent**使用，而不只是被 VCPDeck 自己的 Pi 使用。承接形式沿用并整理现有 CLI（`packages/cli`）与 VCPDeckBridge 插件/技能面；**是否新增 MCP 等新协议形态另行决策**，不在本 ADR 内默认引入。外置 Agent 的接入仍受 VCPDeck 身份与业务控制约束，不引入 Client 到 Client 直连。

### 6. 迁移与退役顺序：先可用，再切换，最后删除

1. Server 侧功能面可用（会话、编排、投影、历史）；
2. Client 补齐脱去 Pi 语义的通用执行与接入能力；
3. 前端切到 Server 路径，新旧路径并存期间必须**在界面与文档中标注适用范围**；
4. 确认无调用方后，删除 `packages/client/src/pi` 中被接管的实现及其测试，以及 Bundle 交付/校验体系；
5. 退役旧 ADR、改写受影响的 Current 文档与兼容说明。

**不得伪装**：未迁移的机器与实例继续走旧路径；不得把"Server 侧可用"描述为"Client 已瘦身"，也不得在删除完成前宣称新路径是唯一路径。

### 7. 数据、安全与运行账户边界沿用既有决策

正文与凭据边界沿用 [ADR-0045](./0045-central-pi-and-native-agent-environments.md) 决策 5；本机接口与运行账户沿用 [ADR-0046](./0046-independent-session-host-and-client-restart-survival.md) 决策 6；本 ADR 不新增数据权威、不放宽任何校验、不改变"日志与审计默认脱敏"。

## 与既有决策的适用关系

- **ADR-0044**：状态改为 **Superseded by ADR-0048**。Client 不再交付 Pi Bundle 目录树，`treeSha256` 判别联合与协议 v2 不再推进。已写实现若存在，按第 6 条顺序退役。
- **ADR-0042**：状态改为 **Superseded by ADR-0048**。社区扩展不再随 Client Release 统一交付；扩展生态回归目标机 Pi 自身。
- **ADR-0029、ADR-0030**：状态改为 **Rejected**。二者为 Proposed 且方向相反（Server 统一管理 Pi 运行时与随 Release 校验的 Bundle），不予采纳。
- **ADR-0045**：结论不变；本 ADR 补充其未覆盖的**外置 Agent 能力面**与**迁移顺序**。
- **ADR-0046**：结论不变；候选方案 5 的适用范围由本 ADR 第 4 条限定。
- **ADR-0047**：结论不变；DSH 反代继续驻目标机。
- **ADR-0007**：保留"真实资源驻留目标机、界面不是事实来源、Server 最小持久化"；Client 不再独占 Pi/Worker 生命周期的部分由 ADR-0046 与本 ADR 共同界定。
- **ADR-0036、ADR-0039 至 ADR-0043**：描述旧 Client 侧 Pi 路径。按 [ADR-0045](./0045-central-pi-and-native-agent-environments.md) 决策 6 的退役序列处理，**不因本 ADR 立即失效**，也不据此删除持久化数据。

实施本 ADR 时必须同步 Shared 契约、SDK、CLI、前端、部署与运维文档、兼容说明和 `CHANGELOG.md`；在切换完成前，Current 文档仍描述旧代码。

## 候选方案

1. **维持现状：Pi 运行时继续放 Client**：与维护者"瘦身 Client"的目标相反，且每次 Agent 生态变化都要发 Client，不采用。
2. **把交互进程也搬到 Server**：破坏目标机原生环境、项目目录与凭据归属，并与 DSH 的 authority 绑定冲突；[ADR-0046](./0046-independent-session-host-and-client-restart-survival.md) 已拒绝，不采用。
3. **Pi 功能面归 Server + Client 通用底座 + 环境自带 Pi/DSH**：采用。
4. **由 VCPDeck 重做统一远端聊天界面取代原生 TUI/Web**：[ADR-0045](./0045-central-pi-and-native-agent-environments.md) 已拒绝，不重复。

## 后果

正面：Client 体积与责任显著减少（约 12,300 行 Pi 实现加 Bundle 体系）；Pi 能力集中一处，减少两套语义漂移；外置 Agent 获得统一能力入口；Client 发布不再被 Agent 生态节奏绑架。

成本与风险：Server 侧会话与编排复杂度上升；迁移期双路径并存，必须有明确的适用范围标注；"环境自带 Pi"意味着各机器版本、插件与凭据不同，**不能承诺同一 Client Release 下远端 Pi 能力一致**（[ADR-0045](./0045-central-pi-and-native-agent-environments.md) 已接受该代价）；删除 Client 实现前若漏查调用方，会直接破坏现有功能。

安全：能力面外置 Agent 后，通用能力（命令、文件、终端）的授权边界成为主要风险面，必须继续经 Server 身份与业务控制，不得因为"外置 Agent 也要用"而放宽校验。

## 验证与退出条件

- Server 侧可独立完成一次真实会话，执行经 Client 通用能力下发到目标机的环境自带 Pi/DSH；前端 `/agent/chat` 走 Server 路径且行为对等。
- 目标机无 pi/dsh 时如实上报不可用；不静默安装、不伪装可用。
- 删除 `packages/client/src/pi` 中被接管的实现后，仓库级测试与构建通过，且无任何 frontend/server/sdk 引用残留（以全仓引用检索与代码图影响分析证明，不凭文件名判断）。
- 外置 Agent 通过既有 CLI/插件面完成一次真实操作，且未放宽 VCPDeck 身份校验。
- 迁移期内新旧路径均可用，并已明确标注适用范围；未迁移实例不被描述为已迁移。

若未来要求把交互进程移入 Server、要求 Server 成为 Pi 插件/凭据的统一配置权威、或为外置 Agent 引入新的公网或直连协议形态，应另立 ADR。
