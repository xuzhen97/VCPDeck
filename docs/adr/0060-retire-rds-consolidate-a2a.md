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

RDS 的对话式 UI 已在同一天的菜单重组中删除（人工介入开发改由远程 DSH 承担），因此它保留的独有价值只剩「会话级临时端口隧道」。

## 决策

1. **退役 RDS**：删除 `RemoteDevSession` / `RemoteDevPort` / `RemoteDevAuditEvent` / `RemoteDevEvent` 四张表、`packages/server/src/remote-dev/`、`packages/shared/src/remote-dev*.ts`、Client 的 RDS runtime/bridge/tunnel、前端三个页面、SDK `remoteDev`、CLI `forward`。

2. **agent 任务只有一条通道**：A2A Task。人发起用 `vcpdeck tasks send`，agent 发起用 A2A JSON-RPC / SDK；人要看代码用远程 DSH（ADR-0059）。

3. **临时端口隧道本轮一并移除，另行重建**。不改造旧的 session 级实现：它的鉴权链（token → port 表 → session 归属）与 relay key 都绑定会话，改造要动 8 处约 500 行，且该链路从未真机验证过。重建时按「client 级」设计：`forward --client=<id> --remote-port=<p>`，与 FRP 划清边界（长期/对外用 FRP，临时/本机用 forward）。

4. **兼容处理**：`register.remoteDevSessions` 与 `capabilityDetails.remoteDev` 在 Shared 解析层保留（旧 Client 上报不被拒绝），但 Client 不再上报、Server 不再消费。`rds:*` 事件常量删除——Socket.IO 未注册事件的投递会被忽略，不会让旧 Client 断连。

5. **`TerminalSession.parentRemoteDevSessionId` 一并删除**：它的唯一用途是「关闭 RDS 会话时连带关终端」，随 RDS 消失而失去语义。

## 后果

- 正面：减少约 5000 行与四张表；agent 任务只保留一条被真实验证过的通道（A2A），CLI/SDK/JSON-RPC 三入口一致；不再出现「两套会话模型语义不同步」。
- 负面：临时端口隧道暂时不可用，调试远程端口需用 FRP 建临时映射并手动删除；这是已知的、有意的能力空窗。
- 风险：若将来需要「会话级临时隧道」，重建时必须补真机验证（本轮删除前该链路同样未验证过）。

## 迁移

1. 已有 RDS 数据直接丢弃（该能力从未投入真实使用，无迁移价值）。
2. 旧 Client 无需升级即可注册；升级后不再上报 RDS 相关字段。
3. 依赖 `vcpdeck forward` 的脚本会失效——这是预期行为，重建后再提供新参数形态。
