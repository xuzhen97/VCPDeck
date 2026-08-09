# Pi Session Job 生命周期设计

**日期：** 2026-08-08
**状态：** 已批准，待实施
**范围：** Remote Pi 的 Session Job、Prompt Run、`waiting_input` 收敛和手动完成

## 1. 背景

当前 Remote Pi 将每次 Prompt 建模为一条 `agent.run` Job，并保持 `jobId === runId`。交互式 Extension UI 会把 Job 从 `running` 切换为 `waiting_input`，用户响应后再恢复 `running`，最终由 settlement 将 Job 置为 `done`。

现有模型有三个问题：

1. 用户通常把 Pi Session 视为一个可长期继续的任务，而不是把每次 Prompt 视为独立任务；
2. Extension UI 在页面刷新、超时或 Client 重连后可能失去恢复入口，使 Job 永久残留在 `waiting_input`；
3. 模型回答结束只表示当前 Prompt 结束，不等于用户认为整个 Session 已完成。

本设计将 Job 提升为 Session 级生命周期记录，并将每次 Prompt 的执行身份独立为 `runId`。

## 2. 目标

- 每个 Pi Session 对应唯一的 `agent.session` Job；
- `sessionId` 与 `jobId` 使用完全相同的值；
- 每次 Prompt 生成独立 `runId`，用于隔离迟到事件和控制操作；
- 模型回答结束后 Session Job 回到 `idle`，不自动进入 `done`；
- `done` 由 Owner 手动标记，并允许后续 Prompt 自动重新激活；
- `waiting_input` 只表示当前 Prompt 被真实交互式 Extension UI 阻塞；
- 页面刷新能够恢复待处理的 Extension UI；
- Extension 回答、取消和超时都能退出 `waiting_input`；
- Client 每次 Socket 连接成功后都重新上报权威状态，对账并清理不可恢复的活动状态；
- Prompt、响应正文、路径、弹框输入、图片和 thinking 正文不得进入 Job、数据库或日志。

## 3. 非目标

- 不持久化 Extension UI 的标题、消息、选项或用户输入；
- 不把 `done` 设为不可逆终态；
- 不增加 Session 自动完成或闲置超时；
- 不允许一个 Pi Session 对应多条活动 Job；
- 不实现多人共同控制或隐式 Owner 转移；
- 不批量扫描所有远程 Client 来迁移历史 Session；
- 不删除旧 `agent.run` 历史记录。

## 4. 身份模型

### 4.1 三个标识符

```text
sessionId = jobId：Pi Session 与 agent.session Job 的共同生命周期 ID
runId：一次 Prompt/回答的独立执行 ID
requestId：一次协议请求或 Extension UI 请求的相关 ID
```

约束：

- 同一 `sessionId` 在 Job 表中最多存在一条 `type = "agent.session"` 的记录；
- 新建、Fork 或 Clone Pi Session 时立即创建同 ID 的 Job；若 Job 创建失败，Server 必须幂等重试，仍失败则 best-effort 删除刚创建的远程 Session并让本次 API 失败；若 DB 故障与删除响应丢失同时发生，残留远程 Session 后续按旧 Session `/open` 规则补建，不伪称已完成分布式清理；
- 旧 Session 首次打开时按 `sessionId` 幂等补建；
- 每次 Prompt 必须生成新的 `runId`；
- Server、Client、SSE 和 Frontend 必须同时携带并校验 `jobId + runId`；
- 旧 `runId` 的迟到事件不得改变当前 run 或 Session Job 状态。

### 4.2 Owner

- 新建 Session 的创建者成为固定 Owner；
- 旧 Session 首次补建 Job 时，当前访问者成为固定 Owner；
- 只有 Owner 可以发送 Prompt、Steer、Follow-up、响应 Extension UI、停止生成、压缩、标记完成和重新激活；
- 其他已登录用户只能观察 Session 历史和实时事件；
- Owner 不随最后发送消息者变化。

## 5. Job 类型与状态模型

### 5.1 Job 类型

新 Session Job 使用：

```text
agent.session
```

旧 `agent.run` 仅作为历史数据保留；新实现不再创建 `agent.run`。

### 5.2 状态语义

| 状态 | 含义 | 是否占项目锁 |
| --- | --- | --- |
| `idle` | Session 可继续，但没有 Prompt 正在执行 | 否 |
| `pending` | Prompt 已接受，尚未由 Client 接受；属于活动状态 | 是 |
| `running` | 当前 `runId` 正在执行、生成或调用工具 | 是 |
| `waiting_input` | 当前 run 被 `select`、`confirm`、`input` 或 `editor` 阻塞 | 是 |
| `done` | Owner 已手动标记 Session 完成；可再次激活 | 否 |
| `disconnected` | Client 暂时离线，当前活动 run 可能恢复 | 是 |
| `error` | Session/Worker 的执行上下文不可恢复，或协议失败 | 否 |
| `cancelled` | 保留给未来删除或废弃等不可继续语义 | 否 |

`idle` 必须加入共享 `JobStatus`。全局活动任务筛选只包括 `pending`、`running` 和 `waiting_input`；`idle` 不属于活动任务。

### 5.3 状态转换

```text
Session 创建/补建
  → idle

idle/done
  → 发送 Prompt 并获取项目锁
  → pending
  → running

running
  → 交互式 Extension UI
  → waiting_input
  → 回答/取消/超时
  → running

running
  → Agent settle + 权威状态为空闲
  → idle

running/waiting_input
  → 停止生成
  → abort 当前 run
  → idle

idle/running/waiting_input/disconnected/error
  → Owner 标记完成
  → 必要时先 abort
  → done

done
  → Owner 发送 Prompt
  → pending
  → running
```

普通模型回答结束不会进入 `done`。Session 是否完成由 Owner 明确控制。

### 5.4 原子状态转换

所有活动 run 转换必须使用带条件的数据库 CAS（Prisma `updateMany`），条件至少包含 Job ID、`payload` 中当前 `runId` 的精确安全 JSON 编码和允许的源状态。禁止“先读取再无条件 update”。具体规则：

- `accept` 只执行 `pending → running`；若交互事件提前把同一 run 改为 `waiting_input`，accept 视为已接受但不得覆盖 waiting 状态；
- `finishRun`、`completeSession`、`reconcileGeneration` 内部对账、删除保留和断线恢复都必须通过 CAS；
- settlement timer 必须由 `jobId + runId` 唯一标识；旧 run 的迟到事件不能取消或执行新 run 的 timer；
- complete 与 settlement 并发时，只允许先成功的转换生效；done 不能被迟到 settlement 改回 idle；
- 新 Prompt 与 complete、删除并发时，未取得 CAS 的一方返回稳定冲突；
- 删除前先将 `idle/done/error` 通过 CAS 保留为带安全 `deleteToken + previousStatus` 的 `cancelled`；只有 Client 明确返回“未删除”或后续 `session.get` 权威确认仍存在时才用该 token 精确回滚；timeout/disconnect 属于不确定结果，必须保留 reservation 并允许 Owner 幂等重试删除，成功后清除 token 并设置 `finishedAt`；
- 项目锁只随成功 CAS 获取或释放；锁的内存记录必须带 `jobId + runId`，旧 run 只能释放自己的锁。

## 6. Session Job 创建与补建

### 6.1 新 Session

现有 `POST .../pi/agent/new` 在 Client 返回 `sessionId` 后：

1. 以 `id = sessionId` 创建 `agent.session` Job；
2. `status = idle`；
3. 只保存安全元数据；
4. 设置当前 Actor 为固定 Owner；
5. 如果同 ID Job 已存在，则按幂等成功处理。

### 6.2 Fork、Clone 与删除

`session.fork` 和 `session.clone` 成功返回新 `sessionId` 后，Server 必须立即按新 ID 创建 `agent.session / idle` Job，当前 Actor 成为新 Session 的固定 Owner。Job 创建遇到并发唯一键冲突时读取并校验已有记录；其他失败先做有限幂等重试，仍失败则 best-effort 调用 Client 删除刚创建的远程 Session，并且本次 API 返回失败而不是返回无 Job 的成功结果。若 DB 故障与删除 timeout/disconnect 同时发生，分布式边界无法保证远程 Session 已删除；残留 Session 继续出现在远程 Session 列表中，并按现有旧 Session 规则由后续首次成功 `/open` 惰性补建 Job/Owner。首版不为极少数补偿不确定结果新增事务表、sidecar 或后台协调器。重复响应按 ID 幂等处理。

删除 Session 只允许固定 Owner 在没有活动 run 时执行；`pending`、`running`、`waiting_input` 或 `disconnected` 均拒绝删除。Server 必须先用 CAS 将 `idle/done/error` 保留为 `cancelled + {deleteToken, previousStatus}`，取得删除权后才调用 Client；Client 明确返回未执行时或后续 `session.get` 权威确认仍存在时才以 token 精确回滚。timeout/disconnect 时远程删除结果不确定，Job 保持 reservation、禁止 Prompt，Owner 再次删除复用同一 reservation 做幂等重试；确认不存在后 commit。这样删除与新 Prompt 竞争时只有一方能越过 CAS，也不会把可能已删除的远程 Session错误恢复为 idle。

### 6.3 旧 Session

新增幂等接口：

```http
POST /api/clients/:clientId/pi/agent/:sessionId/open
Content-Type: application/json

{
  "rootDir": "...",
  "relativePath": "..."
}
```

处理流程：

1. 先请求 Client 验证 Session 存在于允许的项目目录；
2. 查找 `id = sessionId` 的 Job；
3. 缺失时创建 `agent.session / idle`，当前 Actor 成为 Owner；
4. 已存在时不得覆盖 Owner；
5. 返回 Job 的安全状态、Owner 摘要和当前 `runId`；
6. 不在 GET `session.get/context` 请求中隐式写数据库。

Frontend `openSession()` 在加载历史和 `agent.state` 前调用该接口。

## 7. Prompt 与 Run 生命周期

### 7.1 发送 Prompt

Prompt Endpoint 保持现有 URL，处理规则改为：

1. 验证 `jobId === sessionId` 的 `agent.session` 存在；
2. 验证当前 Actor 是固定 Owner；
3. 验证 Session Job 当前没有活动 run；
4. 只允许 `idle` 或 `done` 竞争项目锁；可恢复的单次失败必须已收敛为 `idle`，不可恢复的 `error` 禁止直接发送 Prompt；
5. 为本次 Prompt 生成新的 UUID `runId`；
6. Job 更新为 `pending`，清空 `finishedAt`、`errorCode` 和 `errorMessage`；
7. 发布 `run_created`，其中 `jobId = sessionId` 且 `runId` 为新值；
8. Client Worker 绑定 envelope、创建可取消的后台 Prompt pipeline 后立即返回 accepted，Job 进入 `running`；accepted 不等待 Project Trust 回答或模型完成；
9. 若同一 Owner 在上一 run 的 30 秒 settlement grace 内立即发送新 Prompt，Server 先读取上一 `runId` 的权威 `agent.state`；确认 idle、队列为空且无 pending Extension 后，通过 CAS 提前完成上一 run，再创建新 run，不返回 `PI_PROJECT_BUSY`；
10. Prompt dispatch 或模型调用失败时，若 Session JSONL 与 Worker 仍可继续，则回到 `idle` 并仅在当前页面显示瞬时错误；只有 Client/Worker 上下文不可恢复时才进入 `error`；
11. `error` 是不可自动重新激活的 Session 级状态；Owner 可将其手动标记为 `done`，但不能直接发送新 Prompt。

### 7.2 回答结束

收到 `prompt_done` 或 `agent_settled` 后，继续使用 30 秒可取消 settlement grace。timer key 必须包含 `jobId + runId`，创建、取消和执行时都重新确认当前 run；旧 run 的迟到 activity 不得取消新 run 的 grace。再次读取权威 `agent.state`，只有满足以下条件才结束当前 run：

- `status === "idle"`；
- `streaming === false`；
- `prompting === false`；
- `compacting === false`；
- 没有 pending Extension UI；
- Steering 和 Follow-up 队列为空。

确认后：

- Job 更新为 `idle`；
- 不设置 `finishedAt`；
- Server 和 Client 清除当前 `runId`；
- 释放项目锁；
- Frontend 清理当前 run 状态，但保留 Session。

### 7.3 停止生成

停止生成只作用于当前 `runId`：

1. 校验 Owner、`jobId` 和当前 `runId`；
2. 调用 Pi abort；Client 只有在 Pi 不再 streaming/prompting/compacting 且 pending Extension 已清空后才响应成功；该响应就是权威停止确认；
3. 取消当前已展示的 pending Extension UI，并恰好发出一次 `extension_resolved(reason = "cancelled", hasPending = false)`；从未展示的排队请求只在 Client 内部 resolve，不发送虚假关闭事件；
4. 收到权威停止确认；
5. Job 回到 `idle`；
6. 释放项目锁；
7. 不把 Job 标记为 `cancelled`。

## 8. 手动完成与重新激活

新增接口：

```http
POST /api/clients/:clientId/pi/agent/:sessionId/complete
Content-Type: application/json

{
  "runId": "optional-current-run-id"
}
```

规则：

- 只有固定 Owner 可以调用；
- `idle` 时直接更新为 `done` 并设置 `finishedAt`；
- `pending` 时允许直接标记 `done`；Prompt dispatch 无论随后成功、失败、超时或断线，都必须重新读取精确 `jobId + runId` 快照；若已为 `done/cancelled`，立即 best-effort 补发同 runId abort，防止不确定响应产生孤儿 run；
- `running` 或 `waiting_input` 时必须先 abort 当前 run、清理 pending UI 并确认停止，然后更新为 `done`；
- `done` 时幂等成功；
- `disconnected` 时不向离线 Client 发送请求；Server 使用精确 `runId` 原子标记 `done`，Client 重连后通过 PI_STATE ack 中的 `closedRunIds` 中止并清除旧 run，不得复活；
- 释放项目锁；
- 下一次 Prompt 自动重新激活同一 Job，清空 `finishedAt` 并生成新 `runId`。

右侧“运行详情”提供唯一入口：

- 空闲时：`标记完成`；
- 活动时：`停止并标记完成`；
- 完成时：显示 `已完成，可继续提问以重新激活`。

## 9. Extension UI 与 `waiting_input`

### 9.1 权威内存状态

`PiAgentState` 增加：

```ts
pendingExtension?: PiExtensionUiRequest;
```

该摘要只存在于 Client Worker 内存、`agent.state` 响应和当前浏览器内存，不写入 Job、数据库或日志。

### 9.2 关闭事件

新增 Client Event：

```ts
{
  type: "extension_resolved";
  sessionId: string;
  requestId: string;
  reason: "answered" | "cancelled" | "timeout";
  hasPending: boolean;
}
```

规则：

- `extension_request` 只有在 kind 为 `select`、`confirm`、`input` 或 `editor` 时进入 `waiting_input`；
- `notify`、`setStatus`、`setWidget`、`setTitle` 和 `set_editor_text` 永不进入 `waiting_input`；
- Client 同一时刻只激活一个交互式请求；并发请求进入内存队列，前一个解决后才发出下一个 `extension_request`；
- 用户回答或取消后 Client 删除当前 pending UI 并发出 `extension_resolved`；
- 30 分钟超时继续使用 SDK 的 `undefined`/`false` 语义，同时发出 `extension_resolved(reason = "timeout")`；
- `hasPending` 表示队列中是否仍有阻塞请求；Server 只在其为 `false` 时把当前 run 从 `waiting_input` 恢复为 `running`；
- Frontend 只关闭 requestId 匹配的弹框。

### 9.3 页面刷新恢复

Frontend 打开 Session 时：

1. 调用 `/open` 获取 Session Job；
2. 若 Job 有当前 run，Server 以该 `jobId + runId` 请求 `agent.state`；若没有 run，仍使用现有 `agent.state` action，但 Client 只通过 `SessionReader` 返回不会加载项目 Extension 的只读 idle state，不创建 Agent wrapper；
3. 只有当前 Job 有匹配 runId 且 `pendingExtension` 存在时，才重建原 `select/confirm/input/editor` 弹框；
4. `/open` 由 Server 同时取得 Session Job、已校验的 Client state 和当前 run 报告，并在返回前执行一次原子对账；
5. 若 Server Job 为 `waiting_input`，但 Client 状态没有 pending Extension，则以 Client 权威状态原子修正为 `running` 或 `idle`，必要时释放项目锁；
6. 若 Client 报告 pending Extension 但 Job 没有匹配 runId，视为不一致并在 Client 内取消/清理，不向浏览器暴露不可回答的弹框；Project Trust 必须在 `startRun` 生成 runId、Worker 提前绑定 envelope 后才可触发。Worker 先绑定 envelope 和 cancellation token，立即创建并保存后台 `promptPipeline`，然后 ack；受限 wrapper 的创建是 pipeline 第一项 await，不得在 pipeline 登记前等待。若用户信任，持久化 trust、销毁受限 wrapper并按已信任状态重建一次，最后调用 Prompt；若拒绝/超时则继续使用受限 wrapper。abort/complete 会先使 cancellation token 失效、取消 pending UI、清除 matching active run并等待 pipeline 停止；pipeline 在受限 wrapper 创建、信任、shutdown、重建和附件下载每个 await 后检查 token + jobId + runId，失效后不得开始模型，任何晚到/已重建 wrapper 必须关闭。不得依赖 SDK 未公开的 reload 接口；
7. 所有异步恢复仍受 Session generation guard 保护。

## 10. Client 重连对账

`PI_STATE` 上报活动 run 时必须携带：

```ts
{
  jobId: sessionId;
  runId: string;
  sessionId: string;
  status: "running" | "waiting_input" | "idle" | "error";
  projectKey?: PiProjectKey;
}
```

Client 每次 Socket `connect` 对应的 REGISTER 成功确认后都必须发送一次 `PI_STATE`；防重范围只限当前连接代次，不能使用进程生命周期布尔值阻止后续重连上报。

`PiRunService` 为每个 client 维护当前 `socketId`、ready 标记和一条短期串行队列。REGISTER 在 ack 前通过该队列切换到新 socket并标记未就绪，同时把经认证的 clientId 固定到 `socket.data`；`withReconciledClient(clientId, operation)` 只在 ready 时向一次 REST/settlement 编排提供 `{clientId,socketId}` lease，并持有队列直到该编排的 Client request 与 CAS 全部完成。新 REGISTER 等当前短编排结束后再切换代次，因此不会在跨 await 中途把旧操作投递到新 socket。`PiRequestBroker` 按 lease.socketId 精确 emit，并只接受同 socket 的 response；response handler 直接按 socketId 匹配 pending request，不获取 generation queue，避免与等待 response 的 REST lease 死锁。不得向 client room 广播 Pi request。Gateway 通过 generation lease 只接受当前 ready socket 的 PI_EVENT；旧/pending socket 事件忽略，重连权威状态由 PI_STATE 和 Session JSONL 恢复。

只有同一 Socket 的合法 PI_STATE 完成数据库对账和项目锁重建后，本连接代次才进入 ready；在此之前所有需要向 Client 发送 PI_REQUEST 的 REST（只读或写入）都返回稳定临时错误 `PI_STATE_PENDING`。disconnect handler 先按 socketId 失败该 socket 的 pending request，使等待 response 的 REST lease 退出，再经同一队列执行 `disconnectGeneration(clientId,socketId)`；只有 socketId 仍是当前代次时才清 readiness、把 Job 标记 disconnected 和释放/保留相应资源；旧 socket 的迟到 PI_STATE/断线没有副作用。这样 Server 重启清空内存项目锁后，不会在 REGISTER 与 PI_STATE 之间接受第二个同项目 run；不新增数据库字段、独立服务或长期锁。

Server 的 PI_STATE ack 返回：

```ts
{
  acceptedRunIds: string[];
  closedRunIds: string[];
  reportAgain: boolean;
}
```

Client 按 `acceptedRunIds` 清理已确认的 idle/error 摘要；按 `closedRunIds` abort Server 已手动完成、删除或因 projectKey 冲突关闭的旧活动 run，只有权威停止成功才清理。只要 `closedRunIds` 含 Client 活动 run，本次 ack 必须 `reportAgain=true` 且 Server 保持 not-ready；若全部关闭成功，Client 必须在同一连接代次立即再发送 PI_STATE，Server 只在新的无冲突且无需关闭活动 run的报告完成锁重建后 ready。abort timeout/Worker error 时保留摘要、保持 Server not-ready，并在当前 generation 做有界延迟重试；重试耗尽后 Client 执行受控重连：调用 `socket.disconnect()` 后由 generation-scoped timer 显式调用 `socket.connect()`，重新启用 Socket.IO 的后续 reconnect/backoff并建立新 generation。timer 触发前必须确认仍是原 generation 且 socket 未连接，避免旧 timer 扰动新连接；不能误认为主动 `disconnect()` 会自动重连，也不能被动等待一个未必发生的 reconnect。

Server 对账规则：

- 报告中存在当前 `jobId + runId`：恢复上报状态，并用 report 中仅存内存的 projectKey 重建带 `jobId + runId` 的项目锁；同一 projectKey 若出现两个活动 run，使用精确 run CAS 将冲突记录收敛为安全 error，把相关 run 全部放入 `closedRunIds`，本次不 ready；Client 权威 abort 后立即二次 PI_STATE，只有无冲突报告才 ready；
- 报告表明 run 已结束：Job 回到 `idle`，清除 run 并释放锁；
- 数据库为 `pending/running/waiting_input/disconnected`，但 Client 权威报告中不存在该 run：
  - Job 更新为 `error`；
  - `errorCode = "PI_CLIENT_RESTARTED"`；
  - 设置 `finishedAt`；
  - 释放项目锁；
- 已手动 `done` 的 Job 不得因旧 PI_STATE 或迟到事件重新激活；若报告中仍有该 Job 的活动 run，放入 `closedRunIds`、设置 `reportAgain=true` 并保持 not-ready，直到二次报告确认消失；
- 旧 run 的终态确认必须使用 `jobId + runId`，不能只按 `jobId`。

旧 `agent.run/waiting_input` 不自动删除，也不在本次改动中提供缺少实时 Client 权威证据的批量清理命令；它们保留为历史审计记录。

## 11. 数据与隐私

`agent.session` Job 可以持久化：

- `sessionId`（同时为 Job ID）；
- 当前活动 run 的安全 `payload = { "runId": "..." }`；通常 idle/done/error/cancelled 时 payload 恢复 `{}`；删除请求执行期间只允许保存安全 `{ "deleteToken": "...", "previousStatus": "idle|done|error" }` 作为 CAS 保留；不得复用仅用于文件字节进度的 `Job.progress`；
- Client ID；
- 状态；
- Owner 审计字段；
- 当前模型的安全摘要；
- 稳定错误码和由 Server allowlist 映射生成的安全错误消息；原始 Client/Provider `Error.message` 绝不进入 Job，持久化消息只能由 `safePiErrorMessage(code)` 生成；
- 时间戳。

禁止持久化或记录：

- Prompt 和模型响应正文；
- thinking 正文；
- Extension UI 的 message、options、prefill 和用户输入；
- 图片内容或临时 URL；
- 绝对路径、cwd 或 `projectKey`；
- 凭据、环境变量和工具原始输出。

## 12. 前端展示

右侧运行详情显示：

- `idle`：空闲，可继续；
- `running`：运行中；
- `waiting_input`：等待扩展输入；
- `done`：已完成，可继续提问以重新激活；
- `disconnected`：客户端已断开；
- `error`：显示稳定错误摘要，禁止直接发送新 Prompt。

标识区显示：

```text
Session / Job: <sessionId>
Current Run: <runId 或 —>
```

`agent.session` 继续从全局任务铃铛隐藏，由 Pi 页面管理；Jobs 页面保留该记录用于审计。发送框只在 `idle` 和 `done` 时可用，在 `error`、`running`、`waiting_input` 和 `compacting` 时禁用或按现有规则转为 Steer/Follow-up。Observer 的 Prompt、Steer、Follow-up、abort、compact、model、thinking、rename、fork、clone、navigate、delete 和 complete 控件全部禁用；Server 仍执行最终 Owner 校验。

## 13. 兼容与迁移

- Prisma 不新增 Session 表，也不增加 Job 外键；复用 Job 主键承载 `sessionId`；
- `JobType` 新增 `AGENT_SESSION = "agent.session"`，保留 `AGENT_RUN` 读取兼容；
- `JobStatus` 新增 `IDLE = "idle"`；
- 旧 `agent.run` 不转换为 `agent.session`，避免把单回合历史误合并；
- 旧 Session 通过 `/open` 惰性补建新 Job；
- Shared 定义固定的 `PI_SESSION_JOB_PROTOCOL_VERSION = 1`；Client 在可用的 Pi capability 中上报 `sessionJobProtocolVersion: 1`，Server 在 `/open`、Prompt 和控制操作前要求精确匹配，否则返回 `PI_CLIENT_UNSUPPORTED`，不猜测旧 Client 状态；
- 删除 Session 时，关联 `agent.session` 必须先终止活动 run，再按产品规则保留审计记录或标记 `cancelled`，不得留下项目锁。

## 14. 测试策略

### Shared

- `idle` 是合法 Job 状态；
- `agent.session` 是合法 Job 类型；
- `jobId === sessionId` 校验；
- `runId` 可独立于 `jobId`；
- `extension_resolved`、`pendingExtension` 和完整 `PiAgentState` 的信任边界校验；Shared 提供 `parsePiAgentState()`，Server settlement/open 和 SDK state 都必须调用；
- 非交互 Extension kind 不得形成 pending Extension。

### Client

- 新 Prompt 对同一 Session 使用稳定 jobId 和新 runId；
- Extension 回答、取消和超时都删除当前 pending UI 并发送 `extension_resolved`；
- 两个并发交互请求串行展示，解决一个后仍有请求时保持 waiting_input；
- `agent.state` 返回当前 pending Extension 摘要；
- abort 清理 pending UI并回到 idle；
- PI_STATE 报告当前 jobId + runId；
- 同一 Socket 进程断开再连接后再次上报 PI_STATE，并按 ack 的 accepted/closed run IDs 清理；
- wrapper 创建或附件下载失败后清除提前绑定的 run envelope，不产生幽灵活动 run；
- 旧 run 事件不污染新 run。

### Server

- Session 新建、Fork、Clone 和 `/open` 幂等创建 `agent.session / idle`；
- 删除 Session 后对应 Job 保留并进入 `cancelled`；
- 固定 Owner 校验；
- 旧 Client 缺少 Session Job 协议版本时返回 `PI_CLIENT_UNSUPPORTED`；
- `done` 和 `idle` 可创建新 run；可恢复的单次失败先收敛为 idle，不可恢复 error 禁止直接 Prompt；
- 每个 Prompt 生成新 runId；
- settlement 进入 idle 而不是 done；
- 停止生成进入 idle 而不是 cancelled；
- 手动完成直接或 abort 权威确认后进入 done；
- pending complete、disconnected complete、active delete 拒绝和远程 Session 创建补偿；
- done 后发送消息重新激活；
- Extension request/resolved 正确切换 waiting_input/running；
- 重连缺失 run 进入 `PI_CLIENT_RESTARTED`；
- 手动 done 不被旧事件、旧 PI_STATE 或并发 settlement 复活；
- 所有 run 状态更新使用带 `id + runId + 源状态` 条件的原子 CAS；`accept` 不能覆盖提前到达的 waiting_input；
- 原始 Client/Provider 错误消息含路径、token 或 Prompt sentinel 时，持久化字段只保存按 code 映射的安全消息；
- Job、日志和数据库中没有敏感正文。

### SDK 与 Frontend

- `/open` 和 `/complete` SDK 方法；
- 打开旧 Session 时先补建 Job；
- 刷新时通过 `pendingExtension` 恢复弹框；
- timeout/answered/cancelled 后关闭正确 requestId 的弹框；
- 右侧详情显示 idle/done/error 和手动完成按钮；
- Observer 的全部写操作控件禁用；
- 活动时按钮显示“停止并标记完成”；
- done 后发送 Prompt 自动恢复 running，结束后回 idle；
- error 禁止直接 Prompt，Observer 的所有写操作控件禁用；
- Session generation guard 和 runId guard 拒绝迟到结果。

### 端到端

使用独立 `PI_CODING_AGENT_DIR` 和 Playwright 验证：

1. 创建 Session 后 `jobId === sessionId` 且状态为 idle；
2. 发送 Prompt 后生成独立 runId，状态 running；
3. 回答结束后状态 idle；
4. 触发真实 Extension UI，状态 waiting_input；
5. 刷新页面后恢复相同弹框；
6. 回答或超时后退出 waiting_input；
7. 手动标记完成后状态 done；
8. 再次发送消息后同一 Job重新激活，新 runId 不同；
9. 全局通知中不出现 `agent.session`；
10. Job、数据库和日志中不出现 Prompt、thinking、路径或弹框输入。

## 15. 验收标准

- 正常回答结束后 Session Job稳定为 `idle`，不再残留 `waiting_input`；
- 只有真实、尚未解决的交互式 Extension UI 才显示 `waiting_input`；
- 页面刷新能够继续原待输入操作；
- Extension 超时后 Job最终回到 `running` 或 `idle`；
- `done` 只能由 Owner 手动触发，但后续 Prompt 可以重新激活；
- 同一 Session 始终只有一条 `agent.session` Job；
- 每次 Prompt 使用独立 runId，旧 run 事件无法污染新 run；
- Client 重启后不可恢复的活动 run 进入明确 error 并释放项目锁；
- 每次 Socket 重连都会重新上报 PI_STATE；
- Server 状态转换通过原子 CAS 抵抗 complete、settlement、Extension 和 reconnect 的并发交错；
- 所有现有 Shared、Client、Server、SDK、Frontend 和根集成测试通过；
- Playwright 完成真实 UI 生命周期验证；
- `.gitmodules`、`examples/pi-web` 和无关工作区改动不进入相关提交。
