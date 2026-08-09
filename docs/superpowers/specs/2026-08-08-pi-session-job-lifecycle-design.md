# Pi Session Job 生命周期设计

**日期：** 2026-08-08  
**状态：** 待书面复核  
**范围：** Remote Pi 的 Session Job、Prompt Run、`waiting_input` 收敛和手动完成

## 1. 背景

当前 Remote Pi 将每次 Prompt 建模为一条 `agent.run` Job，并保持 `jobId === runId`。交互式 Extension UI 会把 Job 从 `running` 切换为 `waiting_input`，用户响应后再恢复 `running`，最终由 settlement 将 Job置为 `done`。

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
- Client 重连时通过权威状态对账清理不可恢复的活动状态；
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
- 新建、Fork 或 Clone Pi Session 时立即创建同 ID 的 Job；
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
| `pending` | Prompt 已接受，尚未由 Client 接受 | 是 |
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

idle/done/可恢复 error
  → 发送 Prompt并获取项目锁
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
  → running
```

普通模型回答结束不会进入 `done`。Session 是否完成由 Owner 明确控制。

## 6. Session Job 创建与补建

### 6.1 新 Session

现有 `POST .../pi/agent/new` 在 Client 返回 `sessionId` 后：

1. 以 `id = sessionId` 创建 `agent.session` Job；
2. `status = idle`；
3. 只保存安全元数据；
4. 设置当前 Actor 为固定 Owner；
5. 如果同 ID Job 已存在，则按幂等成功处理。

### 6.2 Fork、Clone 与删除

`session.fork` 和 `session.clone` 成功返回新 `sessionId` 后，Server 必须立即按新 ID 创建 `agent.session / idle` Job，当前 Actor 成为新 Session 的固定 Owner。创建失败时不得返回一个没有 Job 的新 Session；重复响应按 ID 幂等处理。

删除 Session 只允许固定 Owner 在没有活动 run 时执行。Client 删除成功后，对应 `agent.session` Job 更新为 `cancelled` 并设置 `finishedAt`，保留安全审计元数据，不删除 Job 记录。

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
4. 对 `idle`、`done` 或可恢复的 `error` 竞争项目锁；
5. 为本次 Prompt生成新的 UUID `runId`；
6. Job 更新为 `pending`，清空 `finishedAt`、`errorCode` 和 `errorMessage`；
7. 发布 `run_created`，其中 `jobId = sessionId` 且 `runId` 为新值；
8. Client 接受后 Job 进入 `running`；
9. Prompt dispatch 失败时按错误可恢复性进入 `idle` 或 `error`，并释放锁。

### 7.2 回答结束

收到 `prompt_done` 或 `agent_settled` 后，继续使用 30 秒可取消 settlement grace。再次读取权威 `agent.state`，只有满足以下条件才结束当前 run：

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
2. 调用 Pi abort；
3. 取消当前 pending Extension UI；
4. 等待权威停止事件；
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
- `running` 或 `waiting_input` 时必须先 abort 当前 run、清理 pending UI并确认停止，然后更新为 `done`；
- `done` 时幂等成功；
- `disconnected` 时清理 Server 活动状态并标记 `done`，Client 重连后不得复活旧 run；
- 释放项目锁；
- 下一次 Prompt 自动重新激活同一 Job，清空 `finishedAt` 并生成新 `runId`。

右侧“运行详情”提供唯一入口：

- 空闲时：`标记完成`；
- 活动时：`停止并标记完成`；
- 完成时：显示 `已完成，可继续提问以重新激活`。

## 9. Extension UI 与 `waiting_input`

### 9.1 权威内存状态

`PiAgentState` 墝加：

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
}
```

规则：

- `extension_request` 只有在 kind 为 `select`、`confirm`、`input` 或 `editor` 时进入 `waiting_input`；
- `notify`、`setStatus`、`setWidget`、`setTitle` 和 `set_editor_text` 永不进入 `waiting_input`；
- 用户回答或取消后 Client 删除 pending UI 并发出 `extension_resolved`；
- 30 分钟超时继续使用 SDK 的 `undefined`/`false` 语义，同时发出 `extension_resolved(reason = "timeout")`；
- Server 收到关闭事件后把当前 run 从 `waiting_input` 恢复为 `running`；
- Frontend 只关闭 requestId 匹配的弹框。

### 9.3 页面刷新恢复

Frontend 打开 Session 时：

1. 调用 `/open` 获取 Session Job；
2. 调用 `agent.state`；
3. 若 `pendingExtension` 存在，重建原 `select/confirm/input/editor` 弹框；
4. 若 Server Job 为 `waiting_input`，但 Client 状态没有 pending Extension，则以 Client 权威状态修正为 `running` 或 `idle`；
5. 所有异步恢复仍受 Session generation guard 保护。

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

Server 对账规则：

- 报告中存在当前 `jobId + runId`：恢复上报状态；
- 报告表明 run 已结束：Job 回到 `idle`，清除 run 并释放锁；
- 数据库为 `running/waiting_input/disconnected`，但 Client 权威报告中不存在该 run：
  - Job 更新为 `error`；
  - `errorCode = "PI_CLIENT_RESTARTED"`；
  - 设置 `finishedAt`；
  - 释放项目锁；
- 已手动 `done` 的 Job不得因旧 PI_STATE 或迟到事件重新激活；
- 旧 run 的终态确认必须使用 `jobId + runId`，不能只按 `jobId`。

旧 `agent.run/waiting_input` 不自动删除。提供显式维护脚本，只把确认不在任何 Client 权威活动报告中的旧记录标记为 `error / PI_CLIENT_RESTARTED`。

## 11. 数据与隐私

`agent.session` Job 可以持久化：

- `sessionId`（同时为 Job ID）；
- Client ID；
- 状态；
- Owner 审计字段；
- 当前模型的安全摘要；
- 稳定错误码和安全错误消息；
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
- `error`：显示稳定错误摘要。

标识区显示：

```text
Session / Job: <sessionId>
Current Run: <runId 或 —>
```

`agent.session` 继续从全局任务铃铛隐藏，由 Pi 页面管理；Jobs 页面保留该记录用于审计。发送框在 `idle`、`done` 和可恢复 `error` 时可用，在 `running`、`waiting_input` 和 `compacting` 时按现有规则禁用或转为 Steer/Follow-up。

## 13. 兼容与迁移

- Prisma 不新增 Session 表，也不增加 Job 外键；复用 Job 主键承载 `sessionId`；
- `JobType` 新增 `AGENT_SESSION = "agent.session"`，保留 `AGENT_RUN` 读取兼容；
- `JobStatus` 新增 `IDLE = "idle"`；
- 旧 `agent.run` 不转换为 `agent.session`，避免把单回合历史误合并；
- 旧 Session 通过 `/open` 惰性补建新 Job；
- Client/Server 协议升级期间，旧 Client 缺少新字段时 Server 返回稳定的不支持错误，不猜测状态；
- 删除 Session 时，关联 `agent.session` 必须先终止活动 run，再按产品规则保留审计记录或标记 `cancelled`，不得留下项目锁。

## 14. 测试策略

### Shared

- `idle` 是合法 Job 状态；
- `agent.session` 是合法 Job 类型；
- `jobId === sessionId` 校验；
- `runId` 可独立于 `jobId`；
- `extension_resolved` 和 `pendingExtension` 的信任边界校验；
- 非交互 Extension kind 不得形成 pending Extension。

### Client

- 新 Prompt 对同一 Session 使用稳定 jobId 和新 runId；
- Extension 回答、取消和超时都删除 pending UI 并发送 `extension_resolved`；
- `agent.state` 返回当前 pending Extension 摘要；
- abort 清理 pending UI并回到 idle；
- PI_STATE 报告当前 jobId + runId；
- 旧 run 事件不污染新 run。

### Server

- Session 新建、Fork、Clone 和 `/open` 幂等创建 `agent.session / idle`；
- 删除 Session 后对应 Job 保留并进入 `cancelled`；
- 固定 Owner 校验；
- `done`、`idle` 和可恢复 `error` 可创建新 run；
- 每个 Prompt 生成新 runId；
- settlement 进入 idle 而不是 done；
- 停止生成进入 idle 而不是 cancelled；
- 手动完成直接或 abort 后进入 done；
- done 后发送消息重新激活；
- Extension request/resolved 正确切换 waiting_input/running；
- 重连缺失 run 进入 `PI_CLIENT_RESTARTED`；
- 手动 done 不被旧事件复活；
- Job、日志和数据库中没有敏感正文。

### SDK 与 Frontend

- `/open` 和 `/complete` SDK 方法；
- 打开旧 Session 时先补建 Job；
- 刷新时通过 `pendingExtension` 恢复弹框；
- timeout/answered/cancelled 后关闭正确 requestId 的弹框；
- 右侧详情显示 idle/done/error 和手动完成按钮；
- 活动时按钮显示“停止并标记完成”；
- done 后发送 Prompt 自动恢复 running，结束后回 idle；
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
- 所有现有 Shared、Client、Server、SDK、Frontend 和根集成测试通过；
- Playwright 完成真实 UI 生命周期验证；
- `.gitmodules`、`examples/pi-web` 和无关工作区改动不进入相关提交。
