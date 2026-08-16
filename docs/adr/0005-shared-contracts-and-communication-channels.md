# ADR-0005：Shared 统一治理协议并按职责划分通信通道

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：`docs/protocols.md`、`docs/compatibility.md`、`packages/shared/src/`

## 背景

VCPDeck 包含 Server、Client、Frontend、SDK、CLI 和 Launcher 多个运行环境，并同时使用 REST、Socket.IO、SSE、签名 URL 和本机控制接口。仅依赖各端的 TypeScript 静态类型，无法保护实际网络边界；若每个功能自行选择通道、复制 DTO 或宽松解析未知消息，会产生协议漂移、隐式兼容和错误执行。

不同数据流对方向、可靠性和生命周期的要求也不同：资源管理适合请求响应，远程控制需要双向连接，Pi 浏览器事件是单向实时投影，文件正文不应被 JSON 控制协议承载。

## 决策

1. `@vcpdeck/shared` 是跨运行时协议契约的事实来源，集中定义事件名、枚举、Job 类型、capability、DTO、稳定错误码、协议版本和运行时解析器。
2. 跨信任边界的 payload 必须经过 Shared 解析函数或等价的严格运行时校验；TypeScript 类型本身不构成输入验证。
3. 禁止只在某一端增加未进入 Shared 的隐式字段或状态。协议变化必须同步评估 Server、Client、SDK、Frontend、CLI、Launcher 和测试中的实际消费者。
4. 通信通道按职责划分：
   - REST `/api/*`：资源查询、管理和控制命令；
   - Socket.IO `/client`：Server 与 Client 的注册、心跳、Job、文件、FRP、Terminal、Pi 和更新控制；
   - Socket.IO `/app`：Browser 与 Server 的终端双向交互；
   - SSE：Server 向 Browser 投影 Pi 实时事件；
   - Storage 签名 URL或外部短期 URL：传输文件正文；
   - Launcher 本机 HTTP：业务进程与 Launcher 的更新控制。
5. SSE 是可重新订阅的实时投影，不是持久消息队列或正文事实来源。断线恢复必须重新读取 REST/Client 权威状态。
6. capability 只表示 Client 的可用能力，不表示操作者权限。
7. 未知事件、状态、错误码和不合法字段应明确拒绝，不做可能导致错误执行的宽松猜测。
8. 当前正式支持的标准组合是 Server、Client、Frontend 和 SDK 同版本部署；Pi Session Job 协议必须精确匹配。
9. 破坏性变化必须通过协议版本、迁移窗口或明确拒绝表达，并更新兼容文档和 CHANGELOG。

## 候选方案

### 每个包维护自己的 DTO

可减少共享包依赖，但会复制字段和枚举，难以保证双端同时修改，也无法复用运行时校验，因此不采用。

### 所有实时能力统一使用一个 WebSocket 通道

表面统一，但浏览器认证、Client PSK、终端双向流、Pi 单向投影和文件大字节流具有不同信任与传输要求，统一通道会扩大耦合和消息体风险，因此不采用。

### 对未知字段和旧版本做尽力兼容

可能减少升级期间的拒绝，但对远程命令和状态机而言，错误理解比明确不可用更危险，因此采用保守拒绝策略。

## 后果

### 正面

- 多运行时共享同一套命名和语义；
- 网络输入具备明确的运行时安全边界；
- 通道选择可预测，后续 AI 和开发者无需为每个功能重新发明协议；
- 不兼容版本会明确失败，而不是静默执行错误行为。

### 负面

- 协议变更需要协调多个包；
- Shared 需要避免掺入具体运行时实现和数据库模型；
- 当前同版本策略限制独立部署节奏；
- 尚无统一的通用控制协议版本，非 Pi 能力主要依赖版本、capability 和严格解析。

### 安全与运维影响

- REST、`/app`、`/client`、Storage 和 Launcher 分别使用不同凭据，不得相互替代；
- Socket 断开或 HTTP 超时不能直接证明远端未执行，调用方必须查询资源状态；
- 协议错误必须返回稳定、安全的信息，不回显原始 payload、Token 或 stack。

## 验证与退出条件

通过 Shared parser 测试、双端集成测试、未知字段/状态拒绝、协议版本不匹配、Socket 重连和 SSE 重新同步测试验证。

需要长期支持 N-1/N-2 组件组合、引入消息系统或 API Gateway，或现有通道不能满足可靠性和扩展要求时，应创建新 ADR，定义统一协议版本、兼容窗口和迁移机制。
