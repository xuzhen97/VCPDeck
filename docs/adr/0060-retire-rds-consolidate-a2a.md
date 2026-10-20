# ADR-0060：退役 Remote Dev Session，agent 任务统一收敛到 A2A Task

- 状态：Accepted
- 日期：2026-10-20
- 决策者：项目维护者
- 关联：[ADR-0057](./0057-a2a-hub-and-backend-agnostic-task-model.md)（A2A Hub）、[ADR-0058](./0058-remote-dev-session.md)（本 ADR 使其 Superseded）、[ADR-0059](./0059-remote-dsh-webui-channel.md)（远程 DSH）

## 背景

RDS（Remote Dev Session）与 A2A Hub 都在驱动 Client 上的 ACP agent：前者用 `RemoteDevSession` 模型 + `rds:*` 事件，后者用 `Task` 模型 + `task:*` 事件。两套并行意味着两套会话表、两套事件流、两套审计，以及两份前端与 SDK。

2026-10-20 实测确认了 A2A 通道可用，并且补上了结果回传（agent 输出正文落库 + `GetTask.history`）与可发现性（`agent-card.skills` 列出口 agentId）。逐项对账后：

| 能力 | A2A | RDS |
| --- | --- | --- |
| 派活 / 多轮 / 取消 | ✅ `SendMessage` / `taskId` 追加 / `CancelTask` | ✅ |
| 过程可见 | ✅ `GET /api/tasks/:id/events` | ✅ |
| 结果回传 | ✅ `history` + `agent-reply` artifact | ✅ transcript |
| 脚本/CLI 入口 | ✅ `vcpdeck tasks send/get/list/cancel/answer/events` | ✅ SDK + `forward` |
| 标准协议与发现 | ✅ A2A v1.0 + Agent Card | ❌ |
| 人机开发界面 | ❌（由远程 DSH 承担） | ❌（对话 UI 已于同日删除） |
| **临时端口隧道** | ❌ | ✅ `/remote-dev/tunnel` + `/remote-dev/forward` |

RDS 的对话式 UI 已在同一天的菜单重组中删除（人工介入开发改由远程 DSH 承担），因此它保留的独有价值只剩「会话级临时端口隧道」。而这一项并不需要自建：FRP 已能映射 Client 的 loopback 端口，VCPDeck 也已有映射管理、页面与 `probe` 探测——自建隧道是在重复已有能力。

## 决策

1. **退役 RDS**：删除 `RemoteDevSession` / `RemoteDevPort` / `RemoteDevAuditEvent` / `RemoteDevEvent` 四张表、`packages/server/src/remote-dev/`、`packages/shared/src/remote-dev*.ts`、Client 的 RDS runtime/bridge/tunnel、前端三个页面、SDK `remoteDev`、CLI `forward`。

2. **agent 任务只有一条通道**：A2A Task。人发起用 `vcpdeck tasks send`，agent 发起用 A2A JSON-RPC / SDK；人要看代码用远程 DSH（ADR-0059）。

3. **临时端口隧道不再重建**。端口暴露一律用 FRP：临时调试就建一条映射，用完删掉，与长期映射共用同一套 API、页面、探测与清理逻辑。理由有三：其一，旧 forward 链路（token → port 表 → session 归属 → relay key）从未真机验证，重建等于重新养一套约 500 行、8 处鉴权与流控的数据面；其二，FRP 已经解决了它要解决的问题（`frpc` 把 Client 的 loopback 端口映射出来，VCPDeck 已有映射管理与 `probe` 探测）；其三，两套隧道并存会再次出现「同一件事两种做法、语义不同步」——这正是本 ADR 要消除的问题。

4. **兼容处理**：`register.remoteDevSessions` 与 `capabilityDetails.remoteDev` 在 Shared 解析层保留（旧 Client 上报不被拒绝），但 Client 不再上报、Server 不再消费。`rds:*` 事件常量删除——Socket.IO 未注册事件的投递会被忽略，不会让旧 Client 断连。

5. **`TerminalSession.parentRemoteDevSessionId` 一并删除**：它的唯一用途是「关闭 RDS 会话时连带关终端」，随 RDS 消失而失去语义。

## 后果

- 正面：减少约 5000 行与四张表；agent 任务只保留一条被真实验证过的通道（A2A），CLI/SDK/JSON-RPC 三入口一致；端口暴露只剩 FRP 一条路径，不再出现「两套会话模型语义不同步」，也不再出现「两套隧道语义不同步」。
- 负面：临时端口调试要显式建一条 FRP 映射再删除，比 `ssh -L` 式的一行命令重；这是用一致性换取的取舍，且映射可被 `probe` 验证、可被页面管理，比旧 forward 更可观测。
- 风险：FRP 依赖 frps 可达（自建或机房实例），纯离线场景下没有替代手段；若将来出现「零配置临时隧道」的真实需求，应另立 ADR 评估，不能悄悄复活 forward。

## 迁移

1. 已有 RDS 数据直接丢弃（该能力从未投入真实使用，无迁移价值）。
2. 旧 Client 无需升级即可注册；升级后不再上报 RDS 相关字段。
3. 依赖 `vcpdeck forward` 的脚本不会得到替代命令：改走 `vcpdeck frp` 建映射（或页面的「映射」页），用完删除。

## 验证

2026-10-20 在单机真机环境确认「FRP 可替代 forward」这一判断成立：`POST /api/frp/mappings`（`localPort=3001`、`remotePort=17055`）→ 经 frps `127.0.0.1:17055/api/health` 拿到 Client 上服务的响应 → `DELETE` 该映射后端口立即不可达。这正是旧 forward 承诺的用途，且多出映射管理与 `probe` 探测。
