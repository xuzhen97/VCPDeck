# ADR-0040：受信 Pi 扩展的网页交互边界

- 状态：Accepted
- 日期：2026-10-07
- 决策者：项目维护者
- 实施状态：尚未实现；本 ADR 确定目标边界，不表示当前端到端交互已补齐。
- 关联：[ADR-0005](./0005-shared-contracts-and-communication-channels.md)、[ADR-0007](./0007-client-owned-interactive-runtime.md)、[ADR-0008](./0008-pi-session-job-and-run-lifecycle.md)、[ADR-0036](./0036-pi-sdk-single-file-and-shell-capability.md)、[ADR-0039](./0039-pi-two-mode-execution.md)、[`remote-pi.md`](../design/remote-pi.md)

## 背景

当前 Pi Worker 已加载随 Client Release 发布并校验的受信扩展，网页支持 select/confirm/input/editor 阻塞对话，但命令发现尚无完整外部入口，通知与文本状态存在跨边界投影缺口。SDK 扩展同时提供终端组件、会话替换与运行时重载等能力，不能把“加载成功”当成“网页全面兼容”。

需要明确一个有限、可验证的网页交互契约，复用 VCPDeck 控制面而不引入第二套会话管理、包管理或终端渲染运行时。

## 决策

### 1. 只支持受信 Release 扩展，沿用现有权威边界

扩展代码与依赖随 Client Release 固定版本发布，Client 校验 Bundle 并仅加载 Profile 启用的资源。Server 选择 resource ID，不下发可执行代码；不增加 npm/git 安装或用户、项目扩展扫描。

网页操作统一经过 Server，再进入 Client Worker/Pi SDK；Frontend 不直接控制 Client。扩展实际运行与 Session 正文继续由 Client 持有，Server 保留认证、Owner/Observer、Run 编排和临时投影，不持久化扩展正文。

### 2. 扩展命令受既有会话与 Run 生命周期约束

网页发现当前 Session/runtime 实际注册的扩展命令，仅投影调用名、描述等必要字段，不回显本地来源路径。本期不顺带开放 Skills、Prompt 模板或 SDK 内置管理命令；未知、重复或歧义命令明确拒绝，不能静默当作普通 Prompt。

执行必须由 Owner 显式发起，运行时就绪且会话与项目权威空闲。复用现有 Run 接纳、项目互斥、取消、重连对账与结算链路，不建立独立后台命令通道。命令处理完成、其启动的 Agent 工作结束且无待回答 UI 后才能结算；超时或断线不代表未执行，不盲目重试。

本期不支持扩展命令替换 Session、树导航、reload Runtime 或绕过宿主模型范围。命令上下文的这些宿主敏感操作必须在发生前明确拒绝；无法可靠限制时不得宣称该类命令兼容。该约束保护控制面一致性，不是对受信扩展任意代码的安全沙箱。

### 3. 网页提供有限 UI 语义，不执行扩展终端组件

- select/confirm/input/editor：沿用阻塞队列、Owner 回答与超时取消；Observer 只读。
- notify：展示带级别的非阻塞通知，不进入 waiting_input。
- setStatus：按 key 更新或清除会话状态。
- setWidget：仅支持文本行数组，按 key 更新/清除，支持 aboveEditor/belowEditor；不支持组件工厂。
- setTitle：只改变扩展显示标题，不修改持久 Session 名称或浏览器全局标题。
- set_editor_text：只向 Owner 提供编辑器填充；空草稿且无上传附件时可填充，否则须选择应用/忽略，不静默覆盖、不自动提交。
- custom 与其他 TUI-only 能力：明确不支持或按 SDK 非终端模式降级；custom 返回 undefined，不承诺任意终端布局、快捷键、主题或 renderer 在网页工作。

文本是待安全展示的数据，不执行 HTML/脚本或终端控制序列。扩展工具使用既有工具结果与历史渲染，不运行扩展提供的终端 renderer。UI 降级不能伪造成功或破坏权威执行状态。

### 4. 持续 UI 状态留在 Client 内存，短暂动作不重放

Client 按会话运行时保存 status/widget/title 的最新有界快照；Worker 销毁或 Session 替换时清空。Browser 重连读取最新快照，并核对 Session、运行时身份与 revision，晚到的旧状态不得覆盖新状态。

快照不进入 Server DB、Session JSONL 或浏览器长期存储。notify 与编辑器填充属于短暂动作，不在重连时重放；编辑器填充应用前再次核对会话及请求有效性，不能改变 Observer 草稿。

阻塞对话仍使用既有权威待回答状态与请求身份校验，非阻塞状态不能创建待回答记录或改变 waiting_input。

### 5. 跨边界严格校验并保持敏感内容边界

Shared 分别定义阻塞请求、非阻塞事件与状态快照的判别联合和严格 parser；校验字段、枚举、清除语义、数量及文本/总字节预算，不宽松透传任意 SDK 对象。超限拒绝更新并提供安全摘要，不无限累计或静默截断编辑输入。

无法可靠取得真实扩展来源时使用宿主桥接标识，不伪造归属，也不将该标识当作授权依据。扩展输入、命令参数、通知、Widget 和工具结果可能敏感，不进入普通日志、Job payload/result、持久审计或遥测；错误不回显本地路径、原始堆栈或凭据。

模型工具执行遵循 ADR-0039。工具审批不覆盖扩展工厂、事件及命令处理器直接访问系统；启用扩展意味着信任代码，网页桥接不是 OS 沙箱。

## 候选方案

1. **逐台运行独立 Pi Web 后端或 iframe**：增加服务、认证与第二套本地配置/会话权威，绕开现有控制面；不采用。
2. **原样透传全部扩展 UI 对象**：终端能力不能自然变成网页，未知字段与无界内容还会破坏严格协议；不采用。
3. **只保留四类阻塞对话**：实现成本最低，但命令、通知与持续文本状态仍缺失，无法满足受信扩展网页接入目标。
4. **完整模拟 TUI 与会话替换**：需要新的渲染、输入与控制面重新绑定机制，显著扩大当前范围；本期不采用。

## 后果

正面：命令与 UI 能力有明确支持范围；既有 Owner/Run/项目互斥复用；重连可恢复持续状态而不重放编辑动作；受信扩展加载与网页兼容不再混为一谈。

成本与限制：需同步 Shared、Server、Client、SDK 与 Frontend 协议；支持范围小于原生 Pi TUI，涉及会话替换或重载的扩展需改造或保持不可用。通知可能在断线期间丢失，持续 UI 状态在 Worker 重启后消失，这是不持久化正文的明确取舍。

实施须以真实 SDK 与单文件 Release 布局验证，不仅依赖 mock。同步相关 Current、协议、安全、兼容文档及 CHANGELOG；不因本 ADR 将未实现能力写成当前事实，不顺带改变旧 Proposed ADR 状态。

## 验证与退出条件

至少验证命令发现无本地来源路径、Owner/空闲/项目锁约束、未知命令拒绝、命令触发 Agent/对话后正确结算，以及不支持宿主操作在发生前被拒绝。

验证四类对话、全部支持的非阻塞事件、key 清除、Widget placement、编辑草稿冲突与 Observer 不应用；覆盖 Shared→Server→SDK→Frontend 完整链路、超限/未知字段拒绝、刷新重建快照与迟到状态隔离，通知/编辑动作不得重放。

单文件 Release 布局验证扩展工具与命令运行时导入；继续通过 native Pi 零污染、正文不持久化、Worker 换代/崩溃及 Run 重连对账门禁。不承诺所有第三方扩展即插即用。

未来若要求动态安装扩展、项目资源、任意 TUI、自定义网页组件、Session 替换、持久化扩展 UI 或跨信任域，应重新评估并新增 ADR，不静默放宽此契约。
