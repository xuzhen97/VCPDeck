# ADR-0058：Remote Dev Session 作为跨机人机开发会话与独立数据面

- 状态：Superseded by [ADR-0060](./0060-retire-rds-consolidate-a2a.md)
- 日期：2026-10-18
- 决策者：项目维护者
- 关联：[ADR-0001](./0001-control-plane-and-outbound-clients.md)、[ADR-0007](./0007-client-owned-interactive-runtime.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)、[ADR-0049](./0049-retire-pi-dsh-integrations-and-focus-on-core-capabilities.md)、[ADR-0053](./0053-retire-p2p-tunnel-and-browser-remote-desktop.md)、[ADR-0054](./0054-job-log-event-chain.md)、[ADR-0057](./0057-a2a-hub-and-backend-agnostic-task-model.md)、`docs/design/remote-dev-session.md`（已随 ADR-0060 删除）

## 背景

当前 VCPDeck 是一台 Server 加多台出站 Client 的结构。主人有两台机器、两个 Client，希望从任意一端方便地调用另一端 Client 上的 agent 做开发：不仅要能对话，还要能看工具调用、处理权限、跑终端、看文件、访问 dev server、连接调试端口。

现有能力是碎片化的：

- `Terminal` 提供 PTY、attach、快照和重连，但它是“终端会话”，不是开发会话；
- `Files` 提供目标机文件浏览与读写，但没有和 agent/终端/端口绑定；
- `Job` 适合一次性执行，不是人机直连；
- `FRP` 适合长期网络暴露，不适合按开发会话创建、带认证、自动回收的端口访问；
- [ADR-0057](./0057-a2a-hub-and-backend-agnostic-task-model.md) 的 A2A Task 面向“被委托的工作”，有 `intent/acceptance/constraints` 和 TaskEvent 审计，不适合自由探索式的人机开发；
- DSH 的 ACP 入口（`dsh --profile acp`）是 automation-only，原生交互 UI 在 `dsh --profile web`，两者不能混成一个 Task。

如果直接把开发会话塞进 A2A Task，会把任务审计淹没在聊天和端口访问里；如果只靠 Terminal + FRP + Files，体验会碎片化，而且端口暴露过大。因此需要一个新的 **Remote Dev Session** 会话域和一个 session 级数据面。

## 决策

1. **Remote Dev Session（RDS）是独立会话域。** 它既不是 `Job`，也不是 A2A `Task`，也不复用 `TerminalSession` 的状态机。一个 RDS 组合若干子资源：ACP agent 会话、PTY、Files workspace、端口转发；Server 持有会话元数据、attachment/lease 与轻量审计，Client 持有真实运行资源。

2. **一个 RDS 绑定一个目标 Client、一个 agent placement、一个 workspace。** workspace 必须来自 Client 的文件 roots 并经 canonical 校验；调用方只提交 workspace 别名，不提交任意路径。目标 Client 必须在线且声明所需能力。

3. **Agent 交互走 Client 侧 ACP Host。** RDS 复用 ADR-0057 的 ACP Host 与标准化事件，但**不创建 A2A Task、不写 TaskEvent、不做 intent/acceptance 偏差判定**。DSH 的 `dsh --profile acp` 可作为目标；它的 automation-only 限制（无 plan/todo/terminal/elicitation、无 `session/load`）必须在 UI 中如实降级。DSH 原生 Web UI 的访问属于独立的 Web 代理决策，不在本 ADR。

4. **Terminal 与 Files 复用现有能力。** RDS 下的 PTY 复用 TerminalManager，但作为 RDS 的子会话管理；文件操作复用 Files roots 与 Job/文件接口。Server 不持久化终端输入/输出、文件正文或 agent 正文。

5. **端口访问使用 session 级数据面，不默认使用 FRP。**
   - 主路径是 **TCP forward**：`vcpdeck forward --session <id> --remote-port <p> --local-port <lp>` 在用户机器上建立本地监听，经 Server 的认证隧道到 Client，再由 Client 连接目标机 `127.0.0.1:<p>`；
   - 辅助路径是 **HTTP preview proxy**：Server 为 session 提供受认证的 URL，反向代理到目标端口，支持 WebSocket；它只用于简单预览，必须记录 path/Host/绝对路径等兼容限制；
   - 隧道使用独立的认证 WebSocket（二进制帧、stream 多路复用、OPEN/DATA/CLOSE/ERROR、流量控制、心跳），不与 `/client` Socket.IO 的业务事件混用；
   - 目标端口只能是目标机 loopback；必须在会话中显式打开；有数量、协议、生命周期和权限限制；会话结束自动关闭；默认不绑定公网地址。FRP 仍用于长期服务暴露，不作为开发会话端口默认路径。

6. **数据权威与最小持久化。** Client 是 ACP 进程、PTY、端口监听和文件系统的权威；Server 只保存 RDS 元数据、attachment/lease、端口记录和轻量审计，不保存 agent 对话正文、工具输出、终端正文或文件内容。Browser 刷新或 Server 重启后通过 Client 状态报告与重新 attach 恢复；Client 进程重启后旧运行资源收敛为 `interrupted`，不得伪装恢复。

7. **生命周期与所有权。** RDS 状态从 `starting` 进入 `active`/`detached`，可进入 `disconnected`，最终 `closed`（含 TTL/最大生命周期过期）/`failed`/`interrupted`。首个有效 attachment 是 operator，其他为 viewer；operator 才能发 prompt、输入终端、打开端口和回答权限。支持刷新重连、takeover、空闲 TTL 与最大生命周期。关闭必须等待 agent/PTY/端口清理后才结算，未知结果不得报告成功。

8. **安全边界沿用单信任域。** 任意有效业务身份仍是远程操作员；RDS 不引入多租户或按会话的强隔离。agent/PTY 继承 Client OS 账户权限，不是沙箱；ACP `session/request_permission` 是 agent 自愿请求，不是强制拦截。端口代理必须校验会话、attachment、owner、端口 allowlist 和 token；不得转发 VCPDeck Cookie 到目标服务；不得成为访问目标机任意 localhost 服务的通用 SSRF 跳板。

9. **新增数据模型（拟议）。** `RemoteDevSession`、`RemoteDevPort`、`RemoteDevAuditEvent`；不新增 `agent.*` JobType，不复用 `AgentSession`/`AgentRun`，不与 A2A Task 表混用。字段与状态以设计文档为准。

10. **v1 范围。** 第一版包含 RDS 核心、ACP agent、PTY、Files、TCP forward；HTTP preview proxy 作为紧随其后的便利能力，默认不承诺复杂前端路由兼容；DAP 代理、端口自动发现、DSH 原生 Web UI 代理、多租户均后置，涉及新运行组件或数据权威时另立 ADR。

11. **与 ADR-0049 的关系。** RDS 不是复活 Pi／DSH 专用集成或 session-host；VCPDeck 不拥有 agent 模型、凭据、会话正文或扩展 Bundle。它只提供跨机人机会话、终端/文件复用和按会话的数据面。任何超出“会话 + 数据面”的 Agent 平台能力必须另立 ADR。

12. **与 ADR-0057 的关系。** RDS 与 A2A Task 并列：Task 面向自动化委派与审计，RDS 面向人机开发。两者可以共用 Client ACP Host、Terminal、Files；端口隧道由 RDS 引入，Task 不依赖它。两者不得互相冒充；如果未来允许从 Task 打开 RDS，只记录引用，不把 RDS 的聊天/端口事件写进 TaskEvent。

## 修订（2026-10-19）：会话历史与续接（v1.1）

v1 落地后暴露一个产品缺口：会话关闭后前端没有任何入口能找回它，"每次都要重建"。经维护者确认，补两条能力，边界如下：

13. **会话历史是元数据视图，不是回放。** Server 的 `RemoteDevSession` 行本身即历史；前端新增「会话历史」页与侧栏二级导航。Server 仍然**不保存 agent 对话正文、工具输出或事件回放**，历史页只展示状态、workspace、agent、时间与关闭原因。

14. **续接 = 新建 RDS 会话 + 复用原 ACP 会话标识。** Client 在创建成功后通过新增事件 `rds:acp-session` 上报 ACP 侧 `sessionId`，Server 把它作为**元数据**落在会话行上（`RemoteDevSession.acpSessionId`）。操作者对**已终态**且带该标识的会话点「继续」时，Server 新建一条 RDS 会话并在 `session.create` 命令里带上该标识，Client 改走 ACP `session/resume` 而不是 `session/new`。原会话行不被改写，审计保持线性。

15. **续接的硬约束。** 必须同 Client、同 agent placement、同 workspace（ACP 会话绑定 cwd）；源会话必须已终态（对仍活动的会话 resume 会被 agent 以 `session is already active` 拒绝）；只使用 `session/resume`，**不使用 `session/load`**，Server 不参与上下文传输，也不因此获得正文。

16. **兼容性约束。** 上报走**新增事件**而不是给 `rds:command-result` 加字段：旧 Server 对结果做严格解析，多一个字段会让整条结果被丢弃、创建退化成超时。`session.create` 只新增可选字段，因此旧 Client 的普通创建不受影响，只有"请求续接"这一动作会在旧 Client 上明确失败（fail closed）。矩阵见 `docs/compatibility.md`。

本修订不改变 §决策 3、6、8 的边界：RDS 仍不落正文、仍不是沙箱、仍是单信任域；`acpSessionId` 是不透明标识，不是会话内容。

## 修订（2026-10-19 · 二）：transcript 回放与 Client 存活对账

v1.1 之后验收暴露两个缺口：刷新页面后对话内容消失、Client 重启后遗留会话仍显示「运行中」。二者都不是渲染问题，而是**权威数据缺失**，因此按最小协议增量补齐。

### 决策

17. **会话 transcript 落库。** Server 在收到 Client 的 `rds:event` 时，把其中的 agent 事件写入 `RemoteDevEvent(sessionId, seq, kind, payload)`；`kind=prompt` 由 `prompt()` 在**发起命令之前**写入（失败则回滚），保证回放时用户消息排在 agent 回复之前。
18. **增量合并。** 连续 `agent.message.delta`（同 `messageId`）、连续 `agent.thought.delta` 合并成一行；`tool.updated` 就地更新对应工具行；`usage.updated`/`plan.updated` 覆盖上一行。行数因此约等于"对话块数"，而不是 token 数。
19. **保留上限 400 条/会话。** 插入时按 `seq <= seq - 400` 一次 `deleteMany` 截断，不做逐条计数；`rds:transcript.truncated` 标明是否发生过截断。
20. **回放走独立事件 `rds:transcript`**，由 `/app` 在 `rds:attach` 成功后单独下发，**不塞进 attach 响应**——attach 响应是严格解析的既有消息，加字段会让旧前端整条丢弃（与 v1.1 的 `rds:acp-session` 同理）。
21. **Client 存活对账。** 新增可选注册字段 `remoteDevSessions: {sessionId, generationId}[]`：缺省 = 旧 Client 未报告（Server 不得据此判死任何会话）；空数组 = 新 Client 明确报告没有存活会话。
22. **断开与判死分两步。** Client socket 断开时只把该机器非终态会话降级为 `disconnected`（`convergeOfflineClient`），避免网络抖动就误杀；重新注册时按上报列表对账：命中且 generation 一致 → 恢复 `active`；未命中 → `interrupted`（`closeReason=client-restarted`，写审计），从而在历史页可选「继续」。

### 验证与退出条件（增量）

- 刷新 `/remote-dev/:sessionId` 后历史对话仍在，且顺序为用户消息→agent 回复；
- 流式回复 400 条以内不产生"每 token 一行"，超出后 `truncated=true` 且只保留最近 400 条；
- Client 重启后其遗留会话在历史页显示「已中断」并可「继续」，不再伪装成「运行中」；
- 旧 Client（不带 `remoteDevSessions`）重连不会导致任何会话被判死。

## 候选方案

- **把开发会话做成 A2A Task**：不采用。Task 的 intent/acceptance/审计语义不适合自由探索；聊天和端口访问会污染 TaskEvent。
- **只做 Terminal + FRP + Files**：不采用。能力都在，但体验碎片化；FRP 静态公开，不适合按会话创建/回收的 dev 端口。
- **只做 DSH 原生 Web UI 反向代理**：不作为 RDS 的唯一路径。它体验最好，但把产品绑死在 DSH 的 Web 表层，且 ADR-0047 已被 ADR-0049 退役；重引入需要通用 Web 代理 ADR。
- **把 agent 包装成 A2A/ACP 的纯自动化接口**：不采用。缺少终端、文件、端口与人工权限交互，无法满足“开发驾驶舱”。
- **每个会话直接开公网 FRP 端口**：不采用。暴露面过大、缺少 session 级认证/回收，容易把开发端口变成长期公网入口。
- **自建完整 IDE/语言服务器**：不采用。超出 VCPDeck 边界；RDS 的 Files 只做浏览与小改，完整编辑交给外部 IDE/git。
- **多租户隔离**：当前不采用。会改变 ADR-0009 的信任模型，需要独立的安全/授权 ADR。

## 后果

正面：

- 一台浏览器/一个 DSH 即可从任意机器进入另一台 Client 的开发会话；
- agent 对话、终端、文件、端口在同一个会话里，减少在 Terminal/FRP/Files/Agent 之间切换；
- 端口按会话创建、认证、自动回收，避免长期公网暴露；
- 复用 ACP Host、Terminal、Files、Job 与 `/client` 出站模型，不需要目标机入站；
- 与 A2A Task 解耦，任务审计不被开发会话污染。

负面与风险：

- 新增 RDS 域、端口隧道、Server 端口代理、Frontend 组合页面，是一块真实的运行与数据面；
- 浏览器 HTTP 预览受绝对路径、Cookie、Host、WebSocket 影响，不能承诺“所有 dev server 都能无感代理”；TCP forward 是更可靠的路径；
- 文件编辑能力有限，不是完整 IDE；
- 端口代理是新的 SSRF/认证面，必须严格限制 loopback、显式打开、会话绑定与 token；
- 会话正文不落 Server，故障后无法从数据库还原 agent/终端内容；
- 双端进程监管、重连、清理与 Windows 进程树处理增加运维复杂度。

安全与运维影响：

- 仍为单信任域；RDS 不是沙箱，agent/PTY 继承 Client OS 权限；
- 端口代理不得转发 VCPDeck 凭据到目标服务，不得默认绑定公网；
- 审计只记录生命周期、attachment、端口开关、权限决定等安全元数据，不记录正文；
- 新增隧道需要认证、限流、最大帧、空闲超时、心跳与异常断开清理；
- Client 重启/断线必须如实标记 `interrupted`/`disconnected`，不得用旧快照伪装在线。

## 验证与退出条件

实现完成后必须验证：

- 从机器 A 的浏览器创建机器 B 的 RDS，能发 prompt、看流式事件、处理 permission、取消；
- Terminal 在 B 上运行，刷新/重连后仍可 attach；Client 重启后会话收敛为 `interrupted`；
- Files 能浏览/读写 B 的 workspace，越界路径被拒绝；
- `vcpdeck forward` 能把 B 的 dev server/调试端口映射到 A 的 loopback，浏览器/IDE 可用；会话关闭后监听与隧道流全部回收；
- HTTP preview 对简单应用可用，绝对路径/Cookie/WebSocket 的限制有明确文档与错误；
- 端口只能 loopback、显式打开、会话绑定、带认证；不能通过代理访问任意目标主机；
- 同一浏览器多标签/多用户按 operator/viewer 处理；无权限的输入/端口操作被拒绝；
- Server 重启后元数据保留、attachment 重建；Client 状态报告可对账；无伪造恢复；
- DB、普通日志与错误中不出现 agent 正文、终端正文、文件内容、token 或完整路径；
- 旧 Client 未声明 RDS 能力时明确拒绝，不静默降级为 Terminal；
- 会话历史页能列出历史会话（含已关闭），并能按 Client/状态筛选；
- 对已终态会话「继续」后，新会话复用原 ACP sessionId 且能接回上下文（用"暗号"验证）；跨 workspace/placement 的续接被拒绝；
- Windows/Linux 至少各一台真实 Client 完成 agent、PTY、端口、清理验收。

出现以下情况时应创建新 ADR supersede 或扩展本决策：

- 需要 DAP 代理、端口自动发现或原生 IDE/语言服务器；
- 需要把 DSH 原生 Web UI 作为正式入口（通用 Web 代理 ADR）；
- 需要多租户、按身份的资源级授权或公网暴露；
- 需要从 A2A Task 直接编排 RDS 或把 RDS 事件并入 TaskEvent；
- 新的隧道/端口代理被证明是过重的运行组件，需要退回 FRP 或其他数据面；
- 实际需求证明“agent + terminal + TCP forward”已经足够，HTTP preview/Files 编辑器应收缩。
