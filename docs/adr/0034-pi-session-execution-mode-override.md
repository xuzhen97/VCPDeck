# ADR-0034：Pi 会话级持久执行模式覆盖

- 状态：Accepted（工具策略与模式语义由 ADR-0039 替代，其余会话控制约束保留）
- 日期：2026-09-26
- 决策者：项目维护者
- 关联：[ADR-0007](./0007-client-owned-interactive-runtime.md)、[ADR-0008](./0008-pi-session-job-and-run-lifecycle.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)、[ADR-0029](./0029-server-managed-isolated-pi-runtime.md)、[ADR-0030](./0030-pi-resource-bundle-and-tool-policy.md)、[ADR-0033](./0033-pi-tool-approval-mode.md)、[`docs/design/remote-pi.md`](../design/remote-pi.md)、[`docs/design/pi-tool-approval-mode.md`](../design/pi-tool-approval-mode.md)

## 后续决策范围

[ADR-0039](./0039-pi-two-mode-execution.md) 已接受删除三桶、采用 `supervised / automatic` 的长期方向，替代本文继承的工具策略、三种模式与旧枚举语义；尚未表示新行为已实现。本文的 Server 权威、Owner/空闲限制、覆盖与 Run 接纳排序、Run 内模式固化及 Worker 一致性约束继续有效。以下正文保留为原决策历史，不改写旧结论。

## 背景

ADR-0033 确立 Pi 的 `approval / auto / yolo` 执行模式，并将默认模式作为 Profile/RuntimeSpec 配置；它明确不提供 Session override。聊天体验需要 Owner 对当前会话选择模式，同时保留其他会话的 Profile 默认值。由于执行模式会改变 Client SDK 工具集合和 Bundle 扩展的实际许可判定，该选择不能只存在浏览器状态中，也不能在活跃 Run 中途改变。

## 决策

1. **Owner 可为单个 Pi Session 持久覆盖执行模式。** 可选值为 ADR-0033 已定义的 `approval`、`auto`、`yolo`；覆盖仅作用于该 Session，不修改 Profile，也不影响同 Profile 的其他 Session。Owner 可清除覆盖恢复「跟随 Profile」。
2. **Server Session Job 控制面是覆盖值的持久权威。** 使用独立可空字段保存覆盖值；NULL 表示未覆盖。不得把它塞入保存 `runId`/删除预留信息的易清空 Job payload。该字段不包含提示词、回复、思考、工具结果或真实 cwd。Client 持有的 Session JSONL 仍是对话正文事实来源。
3. **未覆盖的 Session 动态跟随当前 Profile 默认模式。** 每次开始 Run 时解析当时绑定 Profile 的模式，而非在新建 Session 时固化默认值。若有效 Profile/运行时模式不可确认，则不向 UI 或 Client 猜测；不得接纳 Run。
4. **有效模式在每个 Run 开始前固化。** 执行中的 Run 不因 Session 覆盖值或 Profile 默认值变化而改变模式。Server 必须串行化模式更新与 Run 接纳，或采用等效原子条件，保证已接受 Run 的模式与实际下发值一致。Run 请求的模式必须经 Shared 严格校验并与该 Run 绑定；Client 不得信任缺失、未知或旧协议字段。
5. **切换受现有 Owner 与空闲状态约束。** 仅 Session Owner 可更改或清除覆盖。Session 处于 `idle`/可继续的 `done` 状态且 Client 状态已可靠对账时才可切换；`pending`、`running`、`waiting_input`、`disconnected`、不确定状态或目标项目 Worker 正执行其他 Run 时拒绝。Observer 只读查看。UI 禁用控件不是授权边界，Server 必须独立执行校验。
6. **Client 项目 Worker 必须与 Run 模式一致。** SDK 工具白名单与 Tool Policy Bundle bridge 必须使用同一有效模式。若项目 Worker 空闲但其模式不同，可安全关闭并按当前已验证 RuntimeSpec 重建；活跃 Worker 不得被切换或抢占。无法确认 RuntimeSpec revision、Worker 模式或工具集合与 bridge 一致时 fail closed，不能沿用旧模式或回退默认。跨会话复用项目时，每次 Run 都按所属 Session 的有效模式核对。
7. **Profile 默认值和既有安全边界保持不变。** Profile 更新继续通过 RuntimeSpec revision 机制生效，活跃 Run 不热换。`approval / auto / yolo` 的 Tool Policy 语义、受信 Bundle 加载面、Owner/Observer 生命周期、Client OS 权限上限及 Server 不存正文原则沿用 ADR-0007/0008/0029/0030/0033。
8. **协议不兼容时明确拒绝。** 支持本决策的新 Client/Server 必须协商新的 Session/Run 协议能力；旧 Client 不支持 Run 级有效模式时不得忽略该字段或静默降级，Pi 控制明确不可用。
9. 本 ADR 只确立长期行为决策，**不表示功能已经实现**。落地须同步更新 Shared、Server、Client、SDK、Frontend、兼容门控、测试和 Current 文档；实现后的 REST 路由与协议字段以代码和 Shared 契约为准。

## 候选方案

### 只改 Profile 模式

会影响绑定该 Profile 的其他 Session，违反「仅当前会话」的产品语义，不采用。

### 将覆盖仅存浏览器

刷新以外的浏览器、设备或本地存储清理都会丢失选择；Browser 也不是 Session 控制状态的权威，不采用。

### 把覆盖写入 Client Session JSONL 或目录旁文件

会将控制策略混入正文存储，并要求 Server 在每次接纳 Run 前跨端读取、解决延迟与并发；不采用。

### 在同一个活跃 Run 内热切换

一个 Run 的 SDK 工具集合和审批 bridge 可能不一致，造成模式显示与真实执行权限偏离，不采用。

### 为每种模式常驻独立 Worker

会增加 Worker 与资源占用，并引入同项目 Session 间共享运行时的复杂性；优先在项目空闲时安全换代，不采用。

## 后果

### 正面

- Owner 可在聊天流程中按会话改变监督/自动化级别，刷新后仍可恢复；
- 未覆盖会话持续受 Profile 默认管理，管理者更新默认不会覆盖用户显式选择；
- Server 保存最小控制元数据，不复制高敏感正文；
- Run 身份、执行模式、SDK 工具集合及策略扩展桥接可保持一致。

### 负面与风险

- Session Job 增加持久控制字段；REST/Shared/Client 协议和能力门控须协同升级；
- 同一项目不同 Session 采用不同模式时，空闲 Worker 可能需要频繁换代；
- 模式更新与 Prompt 接纳、Client 重连和 Server 状态恢复需要并发及故障测试；
- Client/Server 版本不匹配时 Pi 明确不可用，不能承诺向旧 Client 保持兼容运行。

## 验证与退出条件

实现至少验证：Owner 设置/清除与 Observer 拒绝；跨刷新及重新打开；Profile 默认变化只影响未覆盖会话；状态非空闲或 Client 未对账时拒绝；模式更新与 Prompt 并发的原子顺序；Run 中途模式不可变；同项目不同 Session 切换及其他活跃 Run 不被抢占；SDK 工具集合与 Bundle bridge 同模式；准备失败、未知字段和旧 Client 均 fail closed；Session Job/日志没有正文或真实 cwd；所有三种模式仍满足 ADR-0033 工具决策矩阵，YOLO 不加载未启用资源且不越过 OS 权限。

若需要会话间共享覆盖、Owner 转移、多租户授权、同一 Run 热切换、服务端持久正文或跨 Client 会话迁移，应重新评估并由新 ADR supersede 本决策。
