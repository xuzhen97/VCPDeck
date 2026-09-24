# ADR-0030：Pi Resource Bundle 的校验规则与工具策略执行

- 状态：Proposed
- 日期：2026-09-22
- 决策者：项目维护者
- 关联：[ADR-0029](./0029-server-managed-isolated-pi-runtime.md)、[`docs/design/remote-pi-control-plane.md`](../design/remote-pi-control-plane.md)、[`docs/security.md`](../security.md)、[`docs/deployment.md`](../deployment.md)

## 背景

ADR-0029 已确定：Pi SDK 与受信资源随 Client Release 发布、Server 只引用 resource ID、Client 注册时上报 Bundle 能力、仅向兼容 Bundle 下发可执行 RuntimeSpec（决策 4）；Server 是工具策略与资源启用项的权威（决策 1）；项目本地资源默认不加载（决策 7）；RuntimeSpec 版本化且 Client 拒绝自己无法施加的字段（决策 10）。

把这些原则落到阶段 D/E 时，有三个边界无法从原则直接推出，而它们恰好都包含最容易 fail-open 的分支：

1. Bundle 相对**版本目录**与**数据根**的位置，以及 Client 如何定位属于自己的那一份；
2. 策略对「未列出的工具」与「审批超时」的默认判定；
3. Bundle 资源（扩展）如何在**不落盘、不进环境变量**的前提下取得 Server 下发的策略。

第 3 点由 SDK 现状强制：Pi 0.86.0 没有提供任何自定义数据通道（`SessionStartEvent` 只有 `reason`/`previousSessionFile`，`ExtensionContext` 与 `ExtensionBindings` 均无自定义槽位，`ExtensionFactory` 不接收参数）。同时 Pi 的 `bash` 工具会派生子进程并继承环境变量，因此「用环境变量传策略」会把控制面策略暴露给模型可执行的任意命令。

## 决策

### 1. Bundle 位于版本目录，由 Client 按自身路径定位并逐资源校验

`pi-resources/` 随 Client Release 发布在 `apps/<version>/` 内，包含 `manifest.json` 与资源目录。manifest 声明 `protocolVersion`、`bundleVersion`（与 Release 版本一致）、`piSdkVersion`，以及每个资源的 `id`、`kind`、`version`、`path` 与 `sha256`。

Client 从**自身模块位置**推导版本目录（不读取 `apps/current` 或 `state.json`，避免指针与实际运行版本不一致），断言结果位于 `apps/` 下，然后严格解析 manifest 并逐个校验路径合法性（拒绝绝对路径、`..` 与逃逸）与文件摘要。

校验未通过时**不上报 Bundle 能力，也不加载任何资源**；需要资源的 Profile 因此不会被下发 RuntimeSpec。Bundle 属于不可变版本目录，校验结果允许在进程内缓存，但不得写入任何文件。Server 只保存与引用 resource ID，既不下发资源内容也不校验资源内容。

### 2. 工具策略默认拒绝，`confirm` 每次调用审批，超时即拒绝

策略是三个互斥的桶：`allow`、`confirm`、`deny`。`allow ∪ confirm` 作为 SDK 原生 `tools` 白名单下发，`deny` 同时进入 `excludeTools`；**未出现在任何桶的工具不可用**。这样新增能力（新 SDK 版本的内置工具、新扩展注册的工具）不会自动进入可用面。

`confirm` 的语义是**每次调用**都需要操作者明确批准，复用既有 Extension UI 审批链路；拒绝、取消与超时一律判定为**拒绝**，向 Pi 返回稳定错误码，会话继续而不中断 Run。策略不回显工具参数到持久化层；审批决策本阶段不持久化审计（后续可增量补充，不改变本决策的契约面）。

`confirm` 的执行依赖随 Bundle 发布的策略扩展，因此启用 `confirm` 的 Profile 必须同时启用对应的 resource ID；这一依赖由 Server 写入校验保证，不能只靠界面提示。

### 3. 策略经进程内 host bridge 传给 Bundle 资源；不落盘、不进环境变量

Worker 在加载 Bundle 扩展之前安装一个带 `bridgeVersion` 的进程内对象，扩展在 factory 阶段读取其中的策略快照。策略随 Worker 生命周期存在，Spec 换代即新 Worker、新快照。

明确禁止两条通道：写入数据根或任何磁盘位置；通过进程环境变量传递。

若 bridge 缺失或版本不符，策略扩展必须对**所有**工具调用返回阻塞（fail closed），而不是放行。

## 候选方案

1. **用环境变量把策略传给扩展**：实现最省，但会被 `bash` 派生的子进程继承，等于把策略暴露给模型可执行的任意命令；未选择。
2. **把策略写入数据根临时文件供扩展读取**：与「Client 不落盘 Server 下发的配置」（ADR-0029 决策 1、2）冲突，并引入残留与清理问题；未选择。
3. **用 inline extension（客户端代码内联工厂）代替 Bundle 资源**：技术上可行，但会让 Bundle 通道失去真实消费者，无法验证「随 Release 发布 + 校验 + 只加载启用资源」；未选择，仅保留为降级手段。
4. **在 Server 侧集中执行策略**：与「运行态驻留 Client、Server 不下发可执行代码」的边界冲突，且策略必须在工具真正执行前生效；未选择。
5. **`confirm` 记住选择（会话内不再询问）**：UX 更好，但引入会话级授权状态并需与换代、重连对齐，一次误批会在整段会话持续生效；本阶段未选择。

## 后果

正面：

- Bundle 与版本目录绑定，更新与回滚天然一致，不会出现「旧资源配新运行时」；
- 默认拒绝使可用面只能通过显式配置扩大；审批超时与桥接异常都指向拒绝而非放行；
- 策略与凭据一样只存在于内存，磁盘与环境变量都不残留控制面材料。

负面与风险：

- 存量 Profile 在补齐策略前会因默认拒绝而不可用，需要界面提示与基线套用，并在发布说明中明示；
- RuntimeSpec 升到 v3 后，新 Server + 未升级 Client 会出现 Pi 不可用（符合 ADR-0029 决策 8，但要求 Server 先行发布）；
- host bridge 是自定契约，Bundle 与 Client 版本错配会静默失效，靠 `bridgeVersion` 断言与「失败即阻塞」兜底；
- 工具目录必须与 SDK 内置工具名保持同步：不同步的失败方向是「新工具被拒绝」（安全），但需要显式维护与测试。

## 验证与退出条件

- 篡改或缺失任一 Bundle 资源时，Client 不上报 Bundle 能力且不加载任何资源；
- 需要资源的 Profile 不下发给未上报兼容 Bundle 的 Client；
- 未列出的工具无法调用；`confirm` 工具在批准前不执行，拒绝或超时后不执行并返回稳定错误码；
- 校验与加载 Bundle 前后，用户 `~/.pi` 的递归清单与内容 hash 保持零变化；
- 策略与资源内容在磁盘与环境变量中均不可见。

以下情况应重新评估本决策：Pi SDK 提供官方的策略或资源通道、或为扩展提供自定义数据槽位；出现跨信任域、多租户或合规审计要求。
