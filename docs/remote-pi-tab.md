# 远程 Pi Tab

机器工作区的 **Pi** Tab 提供参考 `examples/pi-web` 核心逻辑的结构化远程编码代理界面：项目级 Pi Session 管理、多轮对话、工具调用监督、分支导航、Owner/Observer 控制与图片提示。

## 架构总览

```text
Browser (React 三栏 UI)
  │ REST + SSE（cookie 认证）
  ▼
VCPDeck Server（NestJS 代理）
  │ 只保存 sanitized agent.session Job 元数据；不镜像正文
  ▼
远程 Client（Node.js）
  │ 每 canonical cwd 一个 Pi SDK Worker 子进程（child_process.fork IPC）
  ▼
Pi SDK 0.84.0 → 远程用户 ~/.pi/agent（凭据/模型/扩展/skills）
```

- **Session JSONL 是正文事实来源**（保存在远程机器的 `~/.pi/agent/sessions`）；
- Server 只做代理、固定 Owner 校验与安全 Job 元数据；
- 每个 Pi Session 唯一对应一条 `agent.session` Job，且 `jobId === sessionId`；
- 每次 Prompt 都生成新的 `runId`，用于隔离本次执行及其迟到事件，不再为每个 Prompt 创建 Job；
- 旧 `agent.run` 只作为历史审计记录保留，不转换、不自动改写或清理；
- Browser/Server 断线不会主动停止远程 Worker；关闭页面也不会终止回合。

## 运行要求（Client）

| 项 | 要求 |
|----|------|
| Node.js | Pi 能力要求 `>= 22.19.0`；旧 Node 下 Client 的 exec/files/FRP 仍正常运行，仅 Pi Tab 禁用 |
| Windows Bash | 按顺序探测：`~/.pi/agent/settings.json` 的 `shellPath` → `C:\Program Files\Git\bin\bash.exe` → PATH 中的 `bash.exe`；找不到时 Pi Tab 禁用（`PI_BASH_NOT_FOUND`） |
| Pi SDK | 随 Client 打包锁定 `0.84.0`（不使用全局 `pi`/`pi.cmd`/`pi --mode rpc`） |
| 凭据/模型 | 复用远程 Pi 用户已配置的模型凭据；无已认证模型时 Pi Tab 禁用（`PI_AUTH_UNAVAILABLE`） |

## 使用

1. 打开机器 → **Pi** Tab；能力不满足时页面显示具体原因。
2. 选择项目目录（复用 Files roots 浏览；最近项目保存在浏览器 localStorage）。
3. 新建/选择 Session。旧 Session 首次打开时由 `/open` 校验远程 Session，并幂等补建同 ID 的 `agent.session` Job。
4. 输入 prompt；运行中可 Steer / Follow-up / 中止 / Compact；Esc 中止。模型回答结束后 Job 回到 `idle`，不会自动标记完成。
5. Owner 可在右侧“运行详情”手动**标记完成**：空闲时直接进入 `done`，活动时先权威中止当前 run 再进入 `done`。`done` 可继续提问并以新 `runId` 重新激活同一 Job。
6. 中间过程折叠在 **Process Details**，最终回答单独展示；Tool Call 可展开参数与结果。
7. 图片：仅空闲时可附加（最多 10 张、单张 ≤ 10 MiB、总量 ≤ 100 MiB；PNG/JPEG/GIF/WebP）。

### 模型与思考深度

打开 Session 后，右侧“运行详情”可切换当前 Session 的模型和思考深度。模型显示为 `provider / modelId`；思考深度支持自动、关闭、最低、低、中、高、超高、最大。Agent 运行、压缩或等待扩展输入时不能切换。

“自动”是页面侧选项，不会向 Pi SDK 发送 `auto`；它保留远程 Session 当前默认值。切换只影响当前 Session，不会修改项目或全局 Pi 配置。远程 Client 仍会校验模型认证、模型可用性和项目空闲状态。

## 与 Execute Tab 的区别

- **Execute Tab**：一次性 shell 命令（`exec` Job）。
- **Pi Tab**：结构化多轮 Agent 会话（不提供 `!`/`!!` 直接 shell、PTY 或 ANSI 终端）。

## 生命周期、并发与权限

`agent.session` Job 的主要状态语义如下：

| 状态 | 语义 |
|------|------|
| `idle` | Session 可继续，没有 Prompt 正在执行；普通回答完成后回到此状态 |
| `pending` | Prompt 已被 Server 接受，但 Client 尚未接受；属于活动状态 |
| `running` | 当前 `runId` 正在生成、压缩或调用工具 |
| `waiting_input` | 当前 run 正被真实的交互式 Extension UI 阻塞 |
| `done` | 固定 Owner 已手动标记完成；后续 Prompt 可重新激活 |
| `disconnected` | Client 暂时离线，当前活动 run 可能在重连对账后恢复 |
| `error` | Session/Worker 上下文不可恢复或协议失败；不可直接发送 Prompt，Owner 可手动标记为 `done` |
| `cancelled` | Session 删除保留或已删除等不可继续状态 |

- 同一项目（canonical cwd）同时只允许一个活动回合；不同项目可并行。
- 新建 Session 的创建者是固定 **Owner**；旧 Session 首次补建 Job 时由当前访问者成为固定 Owner，Owner 不随之后发送消息者变化。
- 只有 Owner 可 Prompt、steer/follow-up/abort/compact、回答 Extension UI、切换模型/thinking、重命名、fork/clone、删除和标记完成。
- 其他已登录身份是只读 **Observer**；历史和 SSE 仍可见，前端禁用写控件，Server 继续做最终 Owner 校验。
- 所有当前 run 的状态写入都以 `jobId + runId + 源状态` 做原子 CAS；complete、settlement、删除、重连或迟到事件竞态时，只有先取得 CAS 的操作生效，旧 run 不能覆盖新 run。

## Extension 交互

- 只有未解决的 `select`、`confirm`、`input`、`editor` 会进入 `waiting_input`；通知、状态、Widget、标题和编辑器文本更新不会阻塞 run。
- Client 同时只展示一个交互请求，其余请求仅在内存排队。回答、取消或 30 分钟超时会解决当前请求；若队列仍有请求则继续保持 `waiting_input`，全部解决后才恢复 `running`，最终结算为 `idle`。
- 刷新或重新打开页面时，`/open` 返回已对账的 Session Job 与 Client 权威 `agent.state`；只有 `jobId + runId` 匹配的 `pendingExtension` 才恢复相同弹框。
- Extension 的标题、消息、选项、预填值和用户输入只存在于 Client Worker、`agent.state`、受限 SSE 与当前浏览器内存，不写入 Job、数据库或日志。

## 断线、对账与删除

- 浏览器断开：只取消 SSE 订阅，Worker 与 Job 继续；重新打开页面时经 `/open` 对账并自动附着。
- Client 每次 Socket 连接或重连完成 REGISTER 后都重新上报一次权威 `PI_STATE`，不能用进程级“已上报”标记跳过重连报告。
- REGISTER 与合法 `PI_STATE` 完成对账之间，该连接尚未 ready；所有需要向 Client 发送 `PI_REQUEST` 的 REST 请求返回稳定临时错误 `PI_STATE_PENDING`。
- Server/Client 短暂断开：活动回合原子标记为 `disconnected`。重连报告仍存在的 matching run 时恢复权威状态；报告缺少不可恢复的 run 时进入 `error / PI_CLIENT_RESTARTED` 并释放项目锁。
- Server 已手动完成或删除的旧 run 不会因重连复活：PI_STATE ack 通过 `closedRunIds` 要求 Client 权威中止，Client 再次报告无冲突状态后连接才 ready。
- 删除只允许 Owner 在 `idle`、`done` 或 `error` 时发起；`pending`、`running`、`waiting_input`、`disconnected` 均拒绝删除。Server 先以原子 CAS 保留删除权，因此删除与 Prompt 竞态只有一方成功。
- Client 明确未删除时可精确回滚；超时或断线表示远程结果不确定，Job 保持删除 reservation、禁止 Prompt，Owner 可幂等重试，直至权威确认 Session 存在或已删除。

## 隐私

- 当前回合的 thinking 正文会通过受限 SSE 实时发送到前端，仅保存在当前页面内存，默认折叠，可手动展开；不写入 Job、数据库或日志。
- 重新打开已有 Session 时不恢复 thinking 正文，只显示历史耗时占位。
- thinking 单次实时增量限制为 16 KiB；超出部分截断。

- Server 数据库与日志不保存 prompt、回答、Tool 参数/结果、thinking、图片、签名 URL、项目路径、`projectKey` 或 Extension 输入。
- Session Job 只持久化 Session/Client ID、状态、Owner 审计、当前安全 `{runId}`、模型安全摘要、时间戳以及稳定错误码和 Server allowlist 消息；原始 Client/Provider 错误消息不会写入 Job。
- 图片使用 15 分钟 TTL 的临时 Storage 引用，Client 校验 SHA-256/MIME/魔数后使用，过期自动清理。
- Pi 继承远程机器用户权限：工作目录不是沙箱；项目扩展可执行任意代码（Project Trust 需 Owner 确认）。

## 稳定错误码

| 错误码 | 含义 |
|--------|------|
| `PI_CLIENT_UNSUPPORTED` | Client 版本不支持 Pi |
| `PI_NODE_UNSUPPORTED` | Node < 22.19.0 |
| `PI_BASH_NOT_FOUND` | Windows 未找到 Pi 兼容 Bash |
| `PI_RUNTIME_UNAVAILABLE` | Pi 运行环境不可用（SDK 加载失败等） |
| `PI_AUTH_UNAVAILABLE` | 无已认证可用模型 |
| `PI_MODEL_NOT_FOUND` | 模型不在可用/启用范围 |
| `PI_PROJECT_NOT_ALLOWED` | 项目目录不在允许根内或越界 |
| `PI_SESSION_NOT_FOUND` | Session 不存在或不属于该项目 |
| `PI_PROJECT_BUSY` | 项目已有活动回合 |
| `PI_CONTROL_FORBIDDEN` | 非 Owner 尝试控制回合 |
| `PI_STATE_PENDING` | 当前 Socket 代次尚未完成 PI_STATE 对账，请稍后重试 |
| `PI_CLIENT_DISCONNECTED` | Client 离线或连接中断 |
| `PI_WORKER_EXITED` | 远程 Worker 异常退出 |
| `PI_CLIENT_RESTARTED` | Client 重启导致回合中断 |
| `PI_IMAGE_INVALID` / `PI_IMAGE_TOO_LARGE` | 图片校验失败 / 超限 |
| `PI_REQUEST_TIMEOUT` | 请求超时 |
| `PI_PROTOCOL_INVALID` | 协议/请求体非法 |

Server 只把稳定错误码映射为 allowlist 中的安全消息；未知错误统一返回安全通用文案，不透传可能包含 prompt、路径、凭据或 Provider 正文的原始消息。

## 排障

- **Pi Tab 显示不可用**：查看原因码；Node 版本、Bash 路径、模型认证按上文核对。
- **提示"项目已有活动回合"**：等待当前回合结束，或由 Owner 中止。
- **页面显示断线后恢复**：事件流自动重连；历史与 Job 状态会通过 `/open` 或 PI_STATE 自动对账。
- **提示 PI_STATE_PENDING**：等待当前 Socket 完成权威状态对账后重试，不要并发创建新 run。
- **Session 为 error**：不可直接 Prompt；由 Owner 检查稳定错误摘要并手动标记完成，之后才可重新提问激活。
- **图片上传失败**：确认格式/大小符合限制，附件 TTL 15 分钟内完成发送。
