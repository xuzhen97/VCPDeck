# ADR-0021：FRP 映射以 Client 动作与 FRPS Dashboard 双重确认收敛

- 状态：Accepted
- 日期：2026-08-24
- 决策者：项目维护者
- 关联：[`docs/design/frp.md`](../design/frp.md)、[`docs/design/cli.md`](../design/cli.md)、[`ADR-0004`](./0004-typed-job-kernel.md)

## 背景

现有 FRP 创建在 Client 成功调用 `spawn(frpc)` 后立即把映射标为 active，但没有确认 frpc 是否持续运行或 FRPS 是否已经注册 proxy。删除则先删除 Server 记录，再派发 Client 清理；派发或清理失败时会失去控制面记录并可能遗留孤儿 proxy。CLI 因此无法把成功退出解释为映射已经建立或移除。

FRPS Dashboard 已能提供按代理类型查询当前 proxy 的接口。操作者要求 CLI 的创建/删除在 Client 本地动作完成且 FRPS 已观察到对应 proxy 出现/消失后才成功，不要求进一步验证公网地址或目标本地服务可达。

## 决策

1. Server 继续作为 FrpMapping、Typed Job 与操作收敛的权威；Client 的 `JOB_DONE` 只证明本地 frpc 配置动作完成，不直接决定映射操作成功。
2. 创建状态为 `provisioning`，Server 在 Client 成功后轮询目标 FRPS Dashboard；对应类型和名称的 proxy 出现后才进入 `active` 并完成创建 Job。
3. 删除先进入 `deleting` 并保留数据库记录；Client 成功且 Dashboard 确认 proxy 消失后，Server 才删除记录并释放端口。
4. 创建确认失败时自动派发删除回滚。回滚确认成功后删除映射记录；回滚失败或删除失败时保留 `error` 记录及稳定、安全的错误摘要，允许人工排查和重试。
5. FRPS Dashboard 配置、可达性和认证是写操作的前置条件，不降级为仅依据 Client 回报成功。默认确认时限为 30 秒，调用方可在受限范围内指定。
6. proxy name 在同一 FrpsInstance 内唯一，由数据库约束兜底。用户可显式指定；缺省使用 `<proxyType>-<localPort>`，冲突时追加短映射标识。创建前同时检查数据库与 Dashboard，避免把非 VCPDeck 管理的同名 proxy误判为本次创建结果。
7. TCP 映射允许指定或自动分配 remotePort，禁止 customDomain；HTTP/HTTPS 要求 customDomain，不分配 remotePort。
8. `active` 只表示 Client 本地 frpc 动作成功且 FRPS Dashboard 已观察到 proxy，不表示公网访问、TLS、DNS或目标本地服务健康。
9. 当前仍不支持同一 Client 同时连接多个 FRPS 实例；Server 拒绝会破坏 Client 单 frpc runtime 不变量的跨实例映射。

## 候选方案

### 仅等待 Client JOB_DONE

实现最小，但无法区分 frpc 启动后立即退出、认证失败或 FRPS 未注册，不能满足“映射建立”的成功语义，因此不采用。

### CLI 直接轮询 FRPS Dashboard

会迫使 CLI 获取 Dashboard 凭据，扩大秘密暴露面并产生第二套状态判断逻辑，因此不采用。

### 删除后失败时恢复数据库记录

恢复会遇到端口是否已复用、记录字段和远端状态竞态。保留记录并在确认成功后再删除更直接可靠，因此不采用。

### 验证公网与本地服务可达

不同协议、认证、TLS 和应用健康语义差异很大，超出 FRP 控制面的职责。本决策只确认 proxy 注册状态。

## 后果

### 正面

- CLI、Frontend 与 SDK 获得一致、可解释的完成语义；
- 删除失败不再静默丢失控制面记录；
- FRPS 凭据继续只由 Server 使用；
- Typed Job 仍是远程动作的唯一持久化内核。

### 负面

- FRP 写操作强依赖 Dashboard 可用性和认证；
- 每次创建/删除会增加 Dashboard 轮询流量和最长 30 秒延迟；
- 创建失败回滚本身也可能失败，需要保留 error 记录并人工处置；
- 新 Server/CLI 的完整完成语义需要配套版本，旧 Server 不能提供该保证。

### 安全与运维影响

- Dashboard 错误必须映射为稳定安全错误码，不保存或输出凭据、原始响应、签名信息或堆栈；
- FRPS Dashboard 应位于受控管理网络并优先使用 HTTPS；
- 运维仍需把 active 与真实公网可达区分开；删除 error 记录不得直接手工从数据库移除，应先核对 Dashboard 和 Client。

## 验证与退出条件

验证 TCP/HTTP/HTTPS 创建、自动/显式名称、同名拒绝、Dashboard 缺失/不可达/认证失败、Client 启动失败、注册超时回滚、回滚失败保留、删除确认后移除、删除失败重试、跨实例拒绝和敏感信息不泄漏。

若未来取消 Dashboard、支持每 Client 多 FRPS runtime、引入 FRPS 主动事件或需要端到端应用健康保证，应新增 ADR 重新定义完成门与数据权威。
