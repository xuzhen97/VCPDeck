# ADR-0021：FRP 映射以 Client Runtime 与 FRPS Dashboard 双重确认并持续对账

- 状态：Accepted
- 日期：2026-08-24
- 更新：2026-08-30
- 决策者：项目维护者
- 关联：[`docs/design/frp.md`](../design/frp.md)、[`docs/design/cli.md`](../design/cli.md)、[`ADR-0004`](./0004-typed-job-kernel.md)

## 背景

FRP 映射的本地配置动作与远端 proxy 注册不是同一件事。Client 成功调用 `spawn(frpc)` 不能证明 frpc 持续运行或 FRPS 已注册 proxy；删除时若先移除 Server 记录，再派发 Client 清理，则派发或清理失败会失去控制面记录并可能遗留孤儿 proxy。因此创建和删除必须同时依据 Client 本地动作与 FRPS Dashboard 观察结果收敛。

该完成门解决了显式创建和删除，却没有覆盖持续运行：Server/SQLite 持久化 FrpMapping 期望配置，Client 只在进程内保存 proxy registry 和 frpc 子进程。Client 重启后本地状态丢失，映射不会自动重建；frpc 单独退出时也只留下本地日志，Server 可能继续显示 `active`。Server 重启或控制 Socket 短暂断线时，系统同样缺少将 SQLite 期望、Client runtime 与 Dashboard 实际状态重新比较的统一机制。

需要在保持 Server 权威和 Dashboard 完成门的前提下，将一次性操作收敛扩展为持续 reconciliation 与 frpc runtime supervision。

## 决策

1. Server 继续作为 FrpMapping、Typed Job 和状态收敛的唯一控制面权威。本地 TOML、Client 内存 registry 与 FRPS runtime 都不是持久化期望权威。
2. 映射成功继续使用双重确认：Client 的 `JOB_DONE` 只证明本地 frpc 配置动作完成；Server 必须从目标 FRPS Dashboard 观察到对应 proxy 出现或消失，才能完成创建、删除或恢复。
3. 创建状态为 `provisioning`。Dashboard 确认 proxy 出现后才进入 `active`；确认失败时自动派发删除回滚，回滚失败保留 `error` 和稳定、安全的错误摘要。
4. 删除先进入 `deleting` 并保留数据库记录。Client 完成本地删除且 Dashboard 确认 proxy 消失后，Server 才删除记录并释放端口；失败时保留 `error` 供排查和显式重试。
5. 新增公开状态 `reconciling`，表示系统正在自动恢复映射，不表示 proxy 已可用。只有 `inactive` 自动进入恢复；`provisioning`、`deleting` 和 `error` 不参与自动恢复。遗留 `reconciling` 在 Server 启动时回收到 `inactive`，由新 Client 快照重新触发。
6. 支持 reconciliation protocol 的 Client 在注册完成后上报不含凭据的 FRP runtime 快照。Server 比较 SQLite 期望映射、Client runtime 快照和 FRPS Dashboard：三方一致时不重启 frpc；不一致时才执行恢复。
7. 自动恢复使用系统 `frp.reconcile` Typed Job。Server 一次下发该 Client 的完整期望映射和唯一 FRPS 信息；Client 一次替换内存 registry、一次原子写入合并配置并只启动一次 frpc。Client 本地结果仍需 Dashboard 按 mapping 分别确认。
8. Client 重连、空 registry 或三方不一致时，Server 是唯一重试所有者：首次立即尝试，失败后约 5 秒、30 秒各重试一次。重试耗尽后未确认映射回到 `inactive`，保存稳定、安全的恢复摘要，不自动升级为 `error`。
9. Client 在线期间 frpc 非计划退出时，Client 是唯一重试所有者：使用当前内存中可信的完整配置按首次、5 秒、30 秒有限重启，并持续上报 runtime 状态。Server 此时标记相关映射 `reconciling` 并执行 Dashboard 确认，不并发下发另一组 reconcile。重试耗尽后映射回 `inactive`。
10. Client 必须区分 create、delete、reconcile、shutdown 等计划内停止与 frpc 异常退出；计划内停止不得触发崩溃重启循环。旧 child callback 不能影响新 runtime generation。
11. 每轮恢复绑定当前 Client socket lease 与单调递增的 runtime generation。旧连接、旧 timer、旧 Job 和迟到结果不得覆盖新 generation；断线或 socket 换代时取消旧恢复上下文。
12. 同一 Client reconciliation 期间，显式 FRP create/delete 不排队并返回稳定错误 `FRP_RECONCILE_BUSY`（HTTP 409），避免完整快照与用户写操作交叉覆盖。
13. Client 或 Dashboard 中出现 Server 不认识的 mapping/proxy 时，不自动导入，也不自动删除；只记录脱敏告警。已知映射仍可继续对账，除非名称或端口冲突使应用无法安全进行。
14. 能力协商使用 `capabilityDetails.frp.reconcileProtocolVersion`，不依据 Client 版本号推断。新 Server 只向明确声明支持版本 1 的 Client发送新协议；旧 Client 维持手工恢复行为，新 Client 连接旧 Server 时不得从残留 TOML 猜测 Server 意图。
15. `active` 只表示确认时 Client runtime 已加载映射且 FRPS Dashboard 已观察到 proxy，不表示公网访问、TLS、DNS或目标本地服务健康。
16. FRPS Dashboard 配置、可达性和认证仍是写操作与恢复确认的必要条件，不降级为仅依据 Client 回报。Dashboard 错误必须收敛为稳定、安全的错误，不保存凭据、原始响应或堆栈。
17. proxy name 在同一 FrpsInstance 内唯一，由数据库约束兜底。TCP 映射允许指定或自动分配 remotePort，禁止 customDomain；HTTP/HTTPS 要求 customDomain，不分配 remotePort。
18. 当前仍不支持同一 Client 同时连接多个 FRPS 实例；Server 拒绝会破坏 Client 单 frpc runtime 不变量的跨实例映射。

## 候选方案

### 仅等待 Client JOB_DONE

实现最小，但无法区分 frpc 启动后立即退出、认证失败或 FRPS 未注册，也无法在 Client/frpc 重启后恢复真实状态，因此不采用。

### Client 重连后逐条重放 frp.create

可以复用既有 Job，但每条映射都会重写配置并重启唯一 frpc，多映射恢复会产生明显抖动和部分应用竞态，因此改用完整快照的批量 `frp.reconcile`。

### Client 启动时直接读取本地 TOML

能在 Server 不可达时启动 frpc，但会把含明文 Token 的本地文件变成第二权威，无法可靠体现 Server 删除或修改意图，因此不采用。

### 每次 Client 重连都强制重建 frpc

实现直接，但 Server 重启或短暂控制 Socket 断线也会中断仍健康的 proxy。因此先比较 SQLite、Client runtime 与 Dashboard，只有不一致时才重建。

### Client 与 Server 同时执行重试

会形成嵌套或乘法重试、重复重启和竞态。故障触发点必须只有一个重试所有者：重连对账由 Server负责，在线 frpc 崩溃由 Client负责。

### CLI 直接轮询 FRPS Dashboard

会迫使 CLI 获取 Dashboard 凭据，扩大秘密暴露面并产生第二套状态判断逻辑，因此不采用。

### 验证公网与本地服务可达

不同协议、认证、TLS 和应用健康语义差异很大，超出 FRP 控制面的职责。本决策只确认 Client runtime 与 proxy 注册状态。

## 后果

### 正面

- Client/Launcher 恢复上线后可自动重建 `inactive` 映射，无需人工拉起 frpc；
- frpc 单独崩溃可有限自愈，并把最终失败准确投影到 Server；
- Server 重启或短暂断线时，健康 frpc 不会被无条件重启；
- 多映射通过一次完整配置应用恢复，避免逐条重启抖动；
- CLI、Frontend 和 SDK 可区分 `inactive`、`reconciling` 与 `active`；
- Dashboard 完成门、Server 权威和 Typed Job 审计模型保持一致。

### 负面

- Shared、Server、Client、SDK、Frontend 和 CLI 都需要配套协议升级；
- Server 需要维护按 Client 的 generation、busy lease、有限重试和 Dashboard 确认上下文；
- Client runtime manager 需要处理计划内停止、异常退出、timer 和旧 child callback 等并发边界；
- FRP 写操作在恢复期间会返回 409，需要操作者稍后重试；
- 旧 Client 不具备自动恢复能力，混合版本期间行为存在明确差异；
- FRP 恢复仍依赖 Dashboard 可用性，且不能保证目标服务或公网端到端健康。

### 安全与运维影响

- Client → Server runtime 快照不得包含 authToken、Dashboard 凭据、完整 TOML 或原始 stderr；
- Server → Client 的 reconcile payload 仍含 FRPS Token，Job 记录、SQLite、备份和 Client 工作目录必须按秘密保护；
- runtime、Dashboard 或 frpc 错误只能持久化稳定 code 与安全摘要；
- 运维必须把 Client 在线、FRP `reconciling`、FRP `active` 和公网服务可达视为不同层次；
- 本决策不解决 PM2 daemon 或 Launcher 自身的 OS 级监督。Client 无法重新上线时，FRP reconciliation 不会启动，该问题需单独处理。

## 验证与退出条件

必须验证：

- TCP/HTTP/HTTPS 创建与删除仍通过 Client + Dashboard 双重确认；
- Client 重启后空 registry 能用单次完整配置恢复多条 `inactive` 映射；
- 三方一致时不重启 frpc；
- `error`、`deleting`、`provisioning` 不自动恢复；
- reconnect reconciliation 由 Server独占首次/5 秒/30 秒重试；
- 在线 frpc 崩溃由 Client独占有限重启，Server不并发下发 reconcile；
- 计划内停止不触发异常恢复；
- Dashboard 部分确认按 mapping 分别收敛；
- 重试耗尽后回 `inactive` 并保留安全摘要；
- reconciliation 期间 create/delete 返回 `FRP_RECONCILE_BUSY` 与 HTTP 409；
- socket/runtime generation 能拒绝迟到结果；
- Server 重启能回收遗留 `reconciling`；
- 新旧 Server/Client 能力协商 fail closed；
- 未知本地或 Dashboard proxy 不被自动导入或删除；
- 跨实例映射继续拒绝；
- Token、完整 TOML、原始 stderr、Dashboard 原始响应和堆栈不进入状态上报、普通日志、Frontend 或 CLI 输出。

若未来取消 Dashboard、支持每 Client 多 FRPS runtime、允许 Client 离线自治、引入 FRPS 主动事件或要求端到端应用健康保证，应新增 ADR 重新定义完成门、数据权威和运行边界。
