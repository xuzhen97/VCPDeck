# 远程 Pi Tab 设计

> 状态：设计已确认，待书面规格审阅 | 日期：2026-08-07
>
> 页面与会话行为基准：`examples/pi-web`

## 1. 背景

当前机器工作区的 `/machines/:clientId/execute` 采用一次性 Typed Job：Frontend 通过 REST 创建 `exec` Job，Server 经 Socket.IO 下发到 Client，Client 用 `child_process.spawn()` 执行并回报 stdout、stderr 与退出码。该链路适合命令和脚本，但不适合 Pi 的多轮 Session、Tool Call、分支、compaction、模型切换或 Extension UI。

项目已经为后续 Agent 能力预留：

- `JobType.AGENT_RUN`；
- `agent.pi` capability；
- `waiting_input` Job 状态；
- Typed Job、Socket.IO 和 Client dispatcher 扩展点。

`examples/pi-web` 已实现成熟的 Pi Web 交互：直接读取 Pi Session JSONL，按需创建 `AgentSession`，通过结构化事件驱动网页，并覆盖 Session 树、fork、同文件分支、模型、thinking、compaction、Tool Call、Extension UI 和断线对账。本功能应参考其核心页面与运行语义，而不是通过 PowerShell、Bash、PTY 或 ANSI 解析重新模拟 Pi TUI。

## 2. 目标

在机器工作区增加独立的 **Pi Tab**，让可信操作者可以：

1. 从现有 VCPDeck 文件目录选择器选择远程项目；
2. 查看该项目已有的 Pi Session；
3. 新建、恢复、重命名、删除、fork、clone Session；
4. 查看和切换同一 Session 文件内的分支树；
5. 向远程 Pi 发送多轮 prompt、steer 和 follow-up，并可 abort 或 compact；
6. 查看结构化 Agent 文本、Tool Call、Tool Result、错误、usage 与 context；
7. 选择远程 Pi 已配置且已认证可用的模型和 thinking level；
8. 处理 Pi Extension 发起的 select、confirm、input 和 editor 请求；
9. 关闭页面或发生短暂网络断开后重新附着正在运行的回合；
10. 在 Windows 与 Linux 上采用同一协议，并在运行时不兼容时安全禁用 Pi Tab。

验收以 `examples/pi-web` 的核心交互语义、远程执行闭环和本规格的安全边界为准。

## 3. 已确认决策

| 决策 | 结论 |
| --- | --- |
| 用户体验 | 结构化 Pi 对话，不做原生 Pi TUI 镜像 |
| 页面布局 | 三栏 IDE 面板：Session / 时间线 / Run Details |
| 页面逻辑基准 | `examples/pi-web` 核心页面与状态机 |
| Pi 集成 | 独立 Node 子进程中的 Pi SDK Worker |
| SDK 来源 | VCPDeck Client 固定携带，与 `examples/pi-web` 精确对齐的 Pi SDK 版本；当前为 `0.84.0` |
| 远程配置 | 复用运行 Client 的 OS 用户的 `~/.pi/agent`、环境变量和项目配置 |
| 全局 Pi CLI | 不查找、不调用 `pi`、`pi.cmd` 或 `pi --mode rpc` |
| 项目选择 | 复用 VCPDeck Files 的根目录与目录选择器；保存最近项目 |
| Session 范围 | 只列出当前选定项目的 Session |
| Session 管理 | 新建、恢复、重命名、删除、fork、clone、同文件 branch 导航 |
| 并发 | 同一 canonical cwd 只允许一个活动回合；不同项目可并行 |
| 页面断开 | Worker 继续运行，可重新附着 |
| Client/机器重启 | 不恢复未完成回合；保留 Pi Session 文件 |
| 凭据 | 不由 VCPDeck 分发；只使用远程 Pi 当前用户凭据 |
| 工具权限 | 继承远程 Pi 配置、extensions、skills 与 `AGENTS.md` |
| 模型 | 可切换远程已配置且认证可用的模型与 thinking level |
| 时间线 | Agent 文本 + 可折叠 Tool Call/Result + 错误；不传输 thinking 正文 |
| Shell | Pi Tab 不提供 `!`/`!!`；一次性命令继续使用 Execute Tab |
| Session 正文 | 事实来源在远程 Pi；Server 不长期镜像正文 |
| 实时可靠性 | 保证最终结构化历史完整；不精确补传每个 delta |
| 多浏览器 | 回合 Owner 可控制，其他身份只读观察 |
| 图片 | 首版支持，使用临时 Storage + FileRef，不在 Socket.IO 中传文件体 |
| 旧 Windows | 不做 PowerShell 降级；能力不满足时禁用 Pi Tab 并说明原因 |

## 4. 非目标

首版不实现：

- xterm.js、node-pty、ConPTY、PTY 字节流或 ANSI 终端模拟；
- 通过 PowerShell、cmd.exe 或 Bash 启动并解析 Pi TUI；
- 自动安装、升级或上传 Node/Pi 兼容运行时；
- Server 端模型凭据托管或向 Client 分发 API Key；
- Pi Web 的 Models 凭据配置、Skills 安装、Plugins 管理、Worktree 管理；
- Pi Web 的 File Explorer、File Viewer、Chat Minimap、Mermaid、KaTeX 或完整语法高亮套件；
- `ctx.ui.custom()` 的通用远程 TUI 渲染；首版只支持标准对话式 Extension UI；
- Server 端完整 Session、prompt、Tool Result、thinking 或图片镜像；
- Client 或机器重启后的工具调用续跑；
- 每个实时 token/tool progress delta 的持久 spool 与精确补传；
- 多操作者共享写入控制或控制权转移 UI；
- 将 Execute Tab 合并进 Pi Tab。

## 5. 现有链路与新链路

### 5.1 现有 Execute 链路

```text
ExecutePanel
  -> POST /api/jobs { type: "exec" }
  -> JobService / ClientGateway
  -> job:dispatch
  -> Client executeExec()
  -> job:stdout / job:stderr / job:done
```

该链路保持不变。

### 5.2 新 Pi 链路

```text
Frontend Pi Tab
  -> Server Pi REST / SSE
  -> PiRequestBroker / PiEventBroker
  -> Client Socket.IO /client namespace
  -> PiSupervisor
  -> Pi SDK child worker
  -> AgentSessionRuntime + SessionManager
  -> remote ~/.pi/agent and project files
```

Pi Tab 是临时 Attachment。Pi Session 是远程上下文事实来源。`agent.run` Job 是一次 prompt 回合的调度与审计信封。三者不互相替代。

## 6. `examples/pi-web` 复用边界

### 6.1 行为基准

VCPDeck 应参考或移植以下核心逻辑：

| VCPDeck 模块 | Pi Web 基准 |
| --- | --- |
| `PiSessionSidebar` | `examples/pi-web/components/SessionSidebar.tsx` |
| `PiChatWindow` | `examples/pi-web/components/ChatWindow.tsx` |
| `PiChatInput` | `examples/pi-web/components/ChatInput.tsx` |
| `PiMessageView` | `examples/pi-web/components/MessageView.tsx` |
| `PiBranchNavigator` | `examples/pi-web/components/BranchNavigator.tsx` |
| `usePiSession` | `examples/pi-web/hooks/useAgentSession.ts` |
| Client `PiAgentSessionWrapper` | `examples/pi-web/lib/rpc-manager.ts` |
| Client `PiSessionReader` | `examples/pi-web/lib/session-reader.ts` |
| 结构化类型与 Tool Call 规范化 | `examples/pi-web/lib/types.ts`、`pi-types.ts`、`normalize.ts` |

### 6.2 不直接跨项目 import

`examples/pi-web` 是独立 Next.js 16 / React 19 应用；VCPDeck Frontend 是 Vite / React 18。不得让生产包跨目录引用示例应用源码，也不得把 Next.js route、AppShell 巨型模块或整套依赖复制进 VCPDeck。

实施时应：

- 移植协议无关的 reducer、事件状态机、Session 树算法和必要回归测试；
- 将本地 `/api/...` fetch 替换为 VCPDeck SDK 的机器命名空间接口；
- 使用 VCPDeck 现有 UI primitive、路由、认证和机器工作区；
- 按 VCPDeck 当前样式拆成聚焦模块，避免复制 `AppShell.tsx` 或 `useAgentSession.ts` 的单文件体量；
- 只引入实现已确认 Markdown 显示所需的最小依赖，不引入 Next.js、Pi Web 文件预览或配置管理依赖。

### 6.3 必须保留的 Pi Web 语义

1. **浏览与运行分离**：查看 Session 直接读 `SessionManager`/JSONL；只有发送命令时创建 Worker。
2. **事件流先连接再发送 prompt**：避免首批事件在订阅前丢失。
3. **实时流 + 状态对账**：事件是实时主通道；刷新、`visibilitychange`、`online` 和运行期定时快照用于恢复漏事件。
4. **`agent_end` 不是逻辑终态**：retry、compaction、extension queue 或 follow-up 可能继续运行。
5. **终态需再对账**：`prompt_done` 或 `agent_settled` 触发 settlement check；只有状态快照显示不再 streaming、prompting、compacting 且队列为空，才把 Job 写成终态。
6. **事件流 idle grace**：回合结束后短暂保留订阅，捕获紧随其后的 extension 注入运行；基准为 Pi Web 的 30 秒 grace。
7. **迟到事件保护**：每个回合使用唯一 `runId`；旧事件和慢快照不得覆盖当前回合。
8. **Fork 后销毁旧 Wrapper**：Fork 会替换 AgentSession 内部状态；旧 registry 映射必须立即清理。
9. **区分两种分支**：fork/clone 创建新 JSONL；`navigate_tree` 只移动同一文件活动叶。
10. **Tool Call 规范化**：历史与实时事件统一为 `toolCallId`、`toolName`、`input` 后再与 Tool Result 配对。

## 7. 模块设计

### 7.1 Shared 协议模块

`@vcpdeck/shared` 增加 Pi 判别联合与稳定枚举，只描述跨进程接口，不包含 Pi SDK 类型的未裁剪对象。

核心类型：

```ts
interface PiCwdRef {
  rootDir: string;
  relativePath: string;
}

type PiCapabilityStatus =
  | {
      available: true;
      sdkVersion: string;
      nodeVersion: string;
      shellKind: "configured" | "git-bash" | "path" | "system";
    }
  | {
      available: false;
      code:
        | "PI_CLIENT_UNSUPPORTED"
        | "PI_NODE_UNSUPPORTED"
        | "PI_BASH_NOT_FOUND"
        | "PI_RUNTIME_UNAVAILABLE"
        | "PI_AUTH_UNAVAILABLE";
      message: string;
      nodeVersion?: string;
    };

interface PiRequest {
  requestId: string;
  action: PiAction;
  cwdRef?: PiCwdRef;
  sessionId?: string;
  jobId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

interface PiResponse {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface PiEvent {
  clientId: string;
  sessionId: string;
  jobId: string;
  runId: string;
  event: PiClientEvent;
}
```

首版一条普通 prompt 对应一个 `agent.run` Job，也只对应一个 VCPDeck Run，因此 `runId` 直接使用 `jobId`。接口保留 `runId` 命名用于前端状态机和未来多 attempt 扩展，但不新增 AgentRun 数据表。

### 7.2 Client `PiCapabilityProbe`

Client 启动时执行一次轻量探测，注册信息中：

- 新版 Client 总是声明 `pi.probe`；
- 只有探测成功时声明 `agent.pi`；
- 通过可选注册字段 `capabilityDetails.pi` 上报不含密钥和路径的 `PiCapabilityStatus`；旧 Client 缺少该字段时按不支持处理。

探测内容：

1. 当前 `process.versions.node` 是否至少为 `22.19.0`；
2. 固定版本 Pi SDK Worker 是否可加载；
3. Windows 是否能按 Pi 官方顺序找到 Bash：
   - `~/.pi/agent/settings.json` 的 `shellPath`；
   - `C:\Program Files\Git\bin\bash.exe`；
   - PATH 中的 `bash.exe`；
4. `PI_CODING_AGENT_DIR` 或默认 `~/.pi/agent` 是否可读取；
5. Worker 能否安全创建 Pi services 并列出至少一个已认证可用模型；没有可用模型时返回 `PI_AUTH_UNAVAILABLE`。

注册与 API 只返回 Bash 来源类别，不返回 `shellPath`、Agent 目录或 Session 目录。探测失败只禁用 Pi 功能，不影响 exec、files、FRP、心跳或 Client 连接。

### 7.3 Client `PiSessionReader`

`PiSessionReader` 只在 Pi SDK 子进程中使用 Pi `SessionManager`：

- 按 canonical cwd 列 Session；
- 由 `sessionId` 解析远程 Session 文件；
- 获取 Session metadata、活动叶、投影后的分支树和当前上下文；
- 以 entry cursor 分页返回活动分支历史，默认先返回最新窗口；
- 对图片、thinking 和超出 256 KiB 的 Tool Result 正文返回延迟加载占位，不塞入列表响应；
- 重命名、删除、fork、clone 和读取指定 leaf context；
- 返回给 Server 的 `SessionInfo` 不包含 JSONL 绝对路径。

业务上“只读浏览”可复用空闲 project worker，但不创建 `AgentSession`、不加载项目 extensions，也不获取 active-turn lock。如果 Pi SDK 打开旧格式 Session 时执行官方格式迁移，该行为与 Pi/Pi Web 一致，属于兼容性迁移，不代表启动 Agent。

Session 操作必须验证：

- `sessionId` 对应的 header cwd 与所选 canonical cwd 相同；
- 请求不能通过 sessionId 跨项目访问其他 Session；
- 运行中的 Session 不允许删除、fork、clone 或 `navigate_tree`；
- 空闲 Wrapper 可以先 graceful shutdown，再执行删除。

删除语义参考 Pi Web：

1. 读取目标 Session 的 `parentSession`；
2. 将直接子 Session 的 header 重新挂到目标父级；
3. graceful shutdown 空闲 Wrapper；
4. 删除目标 JSONL；
5. 失效 Session list/path cache。

删除不回滚项目文件，也不修改 Git 工作树。

### 7.4 Client `PiSupervisor`

`PiSupervisor` 是 Client 对外的深模块，接口只暴露：

- `probe()`；
- `request(PiRequest)`；
- `getRunningReports()`；
- `shutdown()`。

内部规则：

- registry 按 canonical cwd 管理；
- 一个项目最多一个 Pi SDK 子进程和一个活动回合；
- 不同 canonical cwd 可以并行；
- 浏览 Session 不创建 `AgentSession`、不获取 active-turn lock，可复用空闲 project worker；
- 同项目切换 Session 时，若旧 Wrapper 空闲则 graceful shutdown 后在同一子进程或新子进程中打开目标 Session；
- Worker 空闲 10 分钟后 graceful shutdown，Session 文件保留；
- Client 与 Server 断线不终止 Worker；
- Client 主进程 IPC 断开时 Worker abort、dispose 并退出，避免成为孤儿进程；
- Client 重启后未完成 Job 上报 `PI_CLIENT_RESTARTED`，不尝试重放工具调用。

Worker 使用 `child_process.fork()` 或等价 Node 子进程 IPC，`shell: false`。启动 Worker 不依赖 PowerShell、cmd.exe 或 Bash。Bash 只由 Pi 的 bash 工具在真正执行工具调用时按 Pi 配置使用。

### 7.5 Client `PiAgentSessionWrapper`

该模块移植 Pi Web `AgentSessionWrapper` 的核心行为：

- `AgentSessionRuntime` / `SessionManager` 创建与替换；
- prompt、steer、follow-up、abort、compact；
- set model、set thinking、get state、get stats、get commands；
- fork、clone、navigate tree、rename；
- Extension UI 标准请求；
- 事件订阅、运行状态和 idle cleanup；
- graceful extension shutdown。

支持的命令：

```text
prompt
steer
follow_up
abort
compact
abort_compaction
get_state
get_session_stats
get_commands
set_model
set_thinking_level
set_session_name
fork
clone
navigate_tree
extension_ui_response
```

首版不暴露直接 `bash`、`abort_bash`、`set_tools`、凭据管理或 `ctx.ui.custom()`。工具集合继承远程 Pi 配置，VCPDeck 不额外切换工具 preset。

### 7.6 Server `PiRequestBroker`

`PiRequestBroker` 负责：

- 验证 Client 在线且支持 `pi.probe`/`agent.pi`；
- 生成 `requestId`；
- 将请求发到目标 Client；
- 以 `requestId` 关联 `PiResponse`；
- 对普通控制命令应用有限等待超时；prompt 在 Worker 接受后立即返回，执行结果走事件流；
- Client 断线时失败所有 pending request；
- 不记录 request payload 正文。

Broker 不解析 Pi Session，也不保存远程 Session 路径。

### 7.7 Server `PiEventBroker`

`PiEventBroker` 接收 Client `PiEvent`，按 `clientId + sessionId + runId` 扇出给浏览器 SSE。

投影规则：

- 允许有界的 Agent 文本 delta、Tool Call 生命周期、usage、错误、队列、compaction 和标准 Extension UI；
- 去掉 thinking 正文；只保留 `thinking_start`/`thinking_end` 推导出的阶段和耗时；
- 去掉 `turn_start`、`turn_end` 和高频 `tool_execution_update`；
- `message_update` 不转发携带完整累计内容的 partial message，只转发裁剪后的 text delta 和生命周期字段；
- Tool Result、assistant/tool 图片与超大 Tool 参数不直接进入实时事件；事件只提示历史已更新，Frontend 随后读取 JSONL 分页历史；
- 单个投影事件 JSON 编码后不得超过 256 KiB；超限内容替换为可延迟读取的摘要；
- `agent_end` 只作为阶段事件，不写 Job 终态；
- SSE 每 30 秒发送 heartbeat；
- SSE 断开只取消浏览器订阅，不取消远程 Worker。

### 7.8 Server `agent.run` Job

每个普通 prompt 创建一个 `agent.run` Job。持久化 payload 只包含安全元数据：

```json
{
  "mode": "interactive",
  "operation": "prompt",
  "sessionId": "...",
  "hasImages": true,
  "imageCount": 2
}
```

不得持久化：

- prompt 文本；
- steer/follow-up 文本；
- 图片内容或 FileRef URL；
- Tool Call 参数与 Tool Result；
- Agent 回答正文；
- thinking；
- `rootDir`、`relativePath` 或其他远程项目路径；
- Session JSONL 路径。

`cwdRef` 只用于当次远程校验，不复制到 Job。需要展示项目位置时，Frontend 以 `sessionId` 向在线 Client 查询；Client 离线时 Job 只显示机器和 Session 标识。

Job result 只保存：

```json
{
  "sessionId": "...",
  "runId": "<same as jobId>",
  "stopReason": "settled | aborted | worker_exited",
  "model": { "provider": "...", "modelId": "..." }
}
```

状态映射：

```text
created                     -> pending
Client accepts               -> running
Extension dialog blocks turn -> waiting_input
Owner answers dialog         -> running
Client socket lost           -> disconnected
settlement check passes      -> done
owner abort confirmed        -> cancelled
provider/worker failure      -> error
Client reconnect reports active/terminal -> running/waiting_input/done/error/cancelled
```

标准 Extension UI 对话存在时，Client 上报 `waiting_input`，同时继续持有该项目锁；Owner 回答后回到 `running`。该状态只表示一个 prompt 回合正在等待扩展输入，不用于两个独立 prompt 之间的空闲 Session。

`prompt_done` 或 `agent_settled` 只触发 settlement check。只有 `get_state` 证明不再 streaming、prompting、compacting、等待 Extension UI，且 steer/follow-up 队列为空，Job 才进入终态。

用户主动 compact、模型切换、Session 重命名等控制操作不另建 Job；它们通过已认证 Pi 控制接口执行。首版的审计信封只覆盖实际 prompt 回合。

## 8. HTTP 与 Socket 接口

### 8.1 Frontend 到 Server

接口使用机器命名空间，并保持与 Pi Web 相近的资源语义：

```text
GET    /api/clients/:clientId/pi/capability
GET    /api/clients/:clientId/pi/models?rootDir=&relativePath=
GET    /api/clients/:clientId/pi/sessions?rootDir=&relativePath=
GET    /api/clients/:clientId/pi/sessions/:sessionId
GET    /api/clients/:clientId/pi/sessions/:sessionId/context?leafId=&cursor=
GET    /api/clients/:clientId/pi/sessions/:sessionId/entries/:entryId/content
PATCH  /api/clients/:clientId/pi/sessions/:sessionId
DELETE /api/clients/:clientId/pi/sessions/:sessionId
POST   /api/clients/:clientId/pi/agent/new
GET    /api/clients/:clientId/pi/agent/:sessionId
POST   /api/clients/:clientId/pi/agent/:sessionId
GET    /api/clients/:clientId/pi/agent/:sessionId/events
GET    /api/clients/:clientId/pi/running
POST   /api/clients/:clientId/pi/attachments
POST   /api/clients/:clientId/pi/attachments/:attachmentId/complete
```

具体 DTO 使用 `PiCwdRef`，不允许提交 JSONL 路径。Controller 继续采用当前项目的手动参数校验和稳定错误响应，不引入全局 ValidationPipe。

SSE 使用现有 Web Cookie 认证。普通 SDK 请求继续兼容 Cookie/Bearer；Pi Tab 浏览器本身使用 Cookie。

### 8.2 Server 到 Client

在现有 `/client` Socket.IO 连接上增加：

```text
pi:request   Server -> Client
pi:response  Client -> Server
pi:event     Client -> Server
pi:state     Client -> Server（注册/重连时的运行状态与最终摘要）
```

所有事件复用现有 PSK 认证连接，不建立额外公网监听端口。

## 9. 项目路径模型

### 9.1 选择与最近项目

Pi Tab 顶部项目选择器复用 Files Panel 的 `file.roots` 和目录浏览能力。选择结果保存为：

```ts
{ clientId, rootDir, relativePath }
```

最近项目只保存在浏览器 `localStorage`，按机器分组并限制数量。再次使用前必须由 Client 重新验证；不存在或越界时从最近列表移除。

不扫描整台磁盘寻找 Git 仓库，不允许自由提交任意绝对 cwd。

### 9.2 Canonical cwd

Client 用专门的 Pi 项目路径解析器完成：

1. 解析允许根的 realpath；
2. 解析目标目录 realpath；
3. 使用 `path.relative(root, target)` 验证不越界；
4. Windows 校验卷标并按大小写不敏感规则生成 key；
5. Linux 保持大小写敏感；
6. 目标必须是可读目录。

不能直接复用当前会吞掉自身 `PATH_NOT_ALLOWED` 的 `resolveSafePath()` 行为。该修复属于 Pi 项目安全所必需的目标内工作。

`cwd` 是 Pi 资源发现与工具执行目录，不是 OS 沙箱。页面必须显示高权限告警。

## 10. Session 语义

### 10.1 列表

只返回当前 canonical cwd 的 Session，并包含：

- `id`；
- `name`；
- `created` / `modified`；
- `messageCount`；
- `firstMessage` 的安全截断预览；
- `parentSessionId`；
- 当前是否 running。

不返回 Session 文件绝对路径。

### 10.2 新建

Frontend 先创建按 `clientId + cwdRef` 隔离的本地草稿，不提前生成空 Session。发送首条 prompt 时严格沿用 Pi Web 的两阶段顺序：

1. `agent/new` 以唯一临时 key 创建持久 `SessionManager`，原子应用显式 model/thinking，并返回真实 `sessionId`；
2. Frontend 用真实 `sessionId` 建立事件流并等待 connected；
3. 事件流就绪后再发送 prompt。

如果第 2 或第 3 步失败，保留可重试/可删除的空 Session，不自动删除；自动删除可能与“prompt 已被远端接受但响应丢失”竞争。唯一临时 key 避免同毫秒请求被合并为同一个 Session。

### 10.3 恢复

点击 Session 时只读取当前活动叶的上下文。若状态快照显示该 Session 正在运行，Frontend 自动建立事件流并进入附着状态。

### 10.4 Rename / Delete

- Rename 使用 `appendSessionInfo(name)`；空名称被拒绝。
- Delete 需要二次确认；不提供 Shift 绕过确认。
- 运行中的 Session 返回 `PI_PROJECT_BUSY`。
- Delete 只删除 Session JSONL，不删除项目文件，不回滚代码。

### 10.5 Fork / Clone / Branch

- **Fork**：从选定用户消息之前创建新 JSONL，并设置 `parentSession`；
- **Clone**：复制当前活动分支到新 JSONL；
- **Branch navigation**：调用 `navigateTree(targetId)`，仍在同一文件内；
- 活动回合期间禁用以上操作；
- Fork 完成后销毁旧 Wrapper，避免 registry 指向已变更的内部 Session。

## 11. 并发与控制权

### 11.1 项目锁

canonical cwd 是并发锁 key：

- 同一项目不同 Session 不能同时生成或执行工具；
- 同一项目的第二个 prompt 返回 `PI_PROJECT_BUSY`，并提供只读附着入口；
- 不同项目可以各自启动 Worker 并行；
- Session 列表和历史浏览不受项目锁限制。

### 11.2 Owner / Observer

Owner 按 `ActorContext.identityId` 认定，而不是按瞬时 WebSocket 连接认定，避免刷新或重新登录后任务失去控制。

- 发起 prompt 的 identity 成为该 Job Owner；
- 活动 Job 的 Owner 可 steer、follow-up、abort，以及回答该回合的 Extension UI；
- 其他 identity 只读观察；
- 同一 identity 的多个浏览器视为同一 Owner；
- Job 终止后控制权释放；
- Session 空闲时，任一认证操作者可发起 model/thinking/compact/rename/fork/clone/navigate；Server 对该操作短暂获取项目锁，操作完成即释放；
- admin 首版没有静默接管活动 Job 的能力，但可使用现有机器/Client 管理手段停止 Client；
- 所有写控制请求都在 Server 再校验 Owner 或空闲项目锁，不能只依赖前端禁用按钮。

## 12. 页面设计

路由：

```text
/machines/:clientId/pi
```

机器工作区增加 `Pi` Tab。只有新版 Client 声明 `pi.probe` 时展示探测结果；旧 Client 显示“Client 版本不支持 Pi”。只有 `agent.pi` 可用时开放操作。

### 12.1 左栏：项目与 Session

- 当前项目选择器；
- 最近项目；
- 新建 Session；
- fork 父子 Session 树；
- running / unread / message count / modified time；
- rename / delete；
- 收起/展开子 Session。

### 12.2 中栏：结构化时间线

- 用户 prompt；
- Agent Markdown 文本；
- 中间过程折叠为 `Process Details`；
- Tool Call 显示工具名、摘要、状态、耗时；
- 展开后显示参数与 Tool Result；
- edit 工具优先显示 diff；
- Provider 错误以安全错误卡展示；
- Extension select/confirm/input/editor 以模态交互；
- 历史消息分页/惰性渲染；
- 底部输入区固定，滚动历史时不强制拉回底部。

Tool 参数与结果可能包含敏感内容。它们仅向当前可信已认证操作者临时展示，不写 Server 日志或数据库；首版不承诺自动识别并遮盖任意业务密钥。

thinking 处理：

- 实时只显示“思考中”和耗时；
- 历史响应删除 thinking 正文；
- 不提供展开 thinking 的 endpoint；
- 远程 Pi Session 仍按 Pi 原生格式保存 thinking，VCPDeck 不修改原文件内容。

Markdown 首版支持普通 Markdown 与 GFM；不允许原始 HTML，避免 XSS。Mermaid、KaTeX 和重量级代码高亮不在范围内。

### 12.3 输入区

支持：

- 普通 prompt；
- 运行中的 steer；
- follow-up；
- abort；
- compact / abort compact；
- slash command；
- 图片选择与拖放；
- 每 Session/新项目独立的本地草稿。

不支持：

- `!` / `!!` 直接 shell；
- 运行中附加图片到 steer/follow-up；图片只允许在空闲状态的 prompt 中发送；
- 切换工具 preset。

键盘：

- Enter 发送；
- Shift+Enter 换行；
- Esc 仅在 Owner 且有活动回合时 abort；
- 所有弹框、折叠和 Session 操作具备可访问名称与键盘焦点。

### 12.4 右栏：Run Details

显示：

- running / retrying / compacting / waiting extension input / settled；
- provider / model 选择；
- thinking level 选择；
- context tokens / context window / percent；
- Session stats、usage 与 cost；
- canonical cwd 的可读展示；
- Session ID、Job/Run ID；
- steer / follow-up 队列；
- Owner 或 read-only observer 状态。

模型列表只包含远程 `ModelRuntime.getAvailable()` 与远程 `enabledModels` scope 共同允许的项。不展示或传输 API Key。

运行期间禁止切换 model/thinking；空闲时的切换写入 Pi Session 原生 change entry。

### 12.5 响应式

- 桌面：三栏，可拖动调整宽度；
- 中屏：右栏变抽屉；
- 小屏：左、右栏均变抽屉，中央时间线优先；
- 不为移动端复制第二套业务状态。

## 13. 图片附件

### 13.1 限制

沿用 Pi Web 的上限：

- 每条 prompt 最多 10 张；
- 每张解码后最多 10 MiB；
- 总量最多 100 MiB；
- 首版接受 PNG、JPEG、GIF、WebP；
- Browser、Server、Client 三层都校验数量和大小；
- Client 校验 SHA-256、声明 MIME 与文件魔数；
- 当前模型不支持 image input 时，在创建 Job 前返回错误。

### 13.2 传输

禁止在 Pi REST JSON 或 Socket.IO 中传大体积 base64：

```text
Browser
  -> temporary Storage upload
  -> short-lived FileRef
  -> transient PiRequest attachment descriptors
  -> Client GET
  -> size/hash/MIME verification
  -> Client-local base64
  -> Pi SDK prompt
```

Job 只记录 `hasImages` 和 `imageCount`。FileRef URL 不入 Job、日志或普通事件。

Client 确认读取后删除临时对象；未完成对象由 TTL 清理。prompt 被拒绝或 Worker 启动失败时同样清理。

### 13.3 历史图片

Session JSONL 中的图片正文仍留在远程机器。Session history 初始响应只返回媒体占位元数据，不经 Socket.IO 回传 base64。用户按需展开历史图片时：

1. 请求指定 `sessionId + entryId + blockIndex`；
2. Client 验证它属于当前项目与 Session；
3. Client 将该图片写入临时 Storage；
4. Browser 用短期 FileRef 获取；
5. TTL 到期自动清理。

这保留完整历史能力，同时避免大型 Session 响应占满 Socket 和 Server 内存。

## 14. Extension UI

支持：

- `select`；
- `confirm`；
- `input`；
- `editor`；
- `notify`；
- `setStatus`；
- 字符串行形式的 `setWidget`；
- `setTitle`；
- `set_editor_text`。

只有 Owner 可以提交对话响应，Observer 只看到等待状态。请求自带 timeout 时尊重原值；未声明 timeout 时 30 分钟后按取消处理。

`ctx.ui.custom()` 首版返回 `undefined` 并发出安全通知，不实现远程按键/ANSI 自定义 TUI。

Project Trust 通过标准 `confirm` 请求转发给 Owner。没有 Owner 或超时未确认时不加载项目本地 settings/extensions，不自动信任。

## 15. 断线与恢复

### 15.1 浏览器断开

- SSE cleanup 只移除订阅；
- Worker 与 Job 继续；
- 重新打开页面先读取 Session history 和 `get_state`；
- 若仍运行则重建 SSE；
- 以 Session JSONL 修正漏掉的文本与 Tool Result。

### 15.2 Server 与 Client 短暂断开

- Client Worker 继续；
- 不为每个 delta 落盘；
- Client 保留活动 Job 状态和最终终态摘要；
- 重连 `pi:state` 上报 running/terminal；
- Server 恢复 Job 状态并让 Frontend 重新读取 JSONL；
- 断线期间的动画/delta 可以丢失，最终结构化历史不得丢失。

### 15.3 Client/机器重启

- Worker IPC 断开后自行 abort/dispose/exit；
- 旧 Job 标记 `error`，错误码 `PI_CLIENT_RESTARTED`；
- Session JSONL 保留；
- 用户重新打开 Session 后发送新 prompt 继续；
- 不自动重放尚未确认是否产生副作用的 Tool Call。

## 16. 错误模型

稳定错误码：

| code | 含义 | UI 动作 |
| --- | --- | --- |
| `PI_CLIENT_UNSUPPORTED` | 旧 Client 无 `pi.probe` | 提示升级 Client |
| `PI_NODE_UNSUPPORTED` | Node < 22.19.0 | 禁用 Pi Tab，显示检测版本 |
| `PI_BASH_NOT_FOUND` | Windows 无 Pi 可用 Bash | 提示安装 Git Bash 或配置 shellPath |
| `PI_RUNTIME_UNAVAILABLE` | 固定 SDK Worker 无法加载 | 禁用 Pi Tab |
| `PI_AUTH_UNAVAILABLE` | 远程没有可用模型凭据 | 显示远程 Pi 配置提示，不接收密钥 |
| `PI_MODEL_NOT_FOUND` | 模型不可用 | 刷新模型列表 |
| `PI_PROJECT_NOT_ALLOWED` | cwd 越界、不存在或不是目录 | 清除最近项目并重新选择 |
| `PI_SESSION_NOT_FOUND` | Session 不存在或不属于项目 | 刷新 Session 列表 |
| `PI_PROJECT_BUSY` | 同 cwd 已有活动回合 | 切换只读观察或等待 |
| `PI_CONTROL_FORBIDDEN` | 非 Owner 发起写控制 | 保持只读 |
| `PI_CLIENT_DISCONNECTED` | Client Socket 断开 | Job 标记 disconnected，自动重试附着 |
| `PI_WORKER_EXITED` | Worker 意外退出 | 当前 Job error，保留 Session |
| `PI_CLIENT_RESTARTED` | Client 重启导致回合中断 | 当前 Job error，允许新回合继续 |
| `PI_IMAGE_INVALID` | MIME、魔数、base64 或 hash 无效 | 拒绝 prompt 并清理附件 |
| `PI_IMAGE_TOO_LARGE` | 单图/总量超限 | 拒绝上传或 prompt |
| `PI_REQUEST_TIMEOUT` | 控制请求没有响应 | 显示可重试错误 |

错误只返回稳定 `code` 与安全 `message`，不包含 stack、API Key、签名 URL、Session 文件路径或文件内容。

## 17. 安全与隐私

1. Pi 继承 Client OS 用户权限，VCPDeck 不宣称这是沙箱。
2. Server 与 Client 的 Pi Bridge 复用现有 PSK Socket.IO 连接。
3. Frontend Pi API 使用现有身份认证；每个写控制请求在 Server 检查 Owner。
4. Session 访问同时校验 `clientId`、canonical cwd 和 `sessionId`。
5. Server 普通日志只记录 requestId、clientId、sessionId、jobId、action、状态和耗时。
6. 日志不记录 prompt、图片、工具参数、工具结果、签名 URL、thinking 或 Session 正文。
7. Server 数据库不保存 Pi 正文；远程 Session JSONL 仍遵循 Pi 原生持久化。
8. Tool Call/Result 可能包含敏感内容，只在认证 UI 临时显示，不自动写入日志。
9. Project Trust 不自动通过；远程项目 extensions 具有任意代码执行能力。
10. 图片临时对象短期有效、按目标 Client 限权并有 TTL。

当前 VCPDeck 的任意认证身份都相当于可信远程机器操作者。本规格只增加回合控制权，不引入新的租户权限系统。

## 18. 依赖与版本

### 18.1 Client

Pi SDK 依赖必须与 `examples/pi-web/package.json` 的当前版本精确一致，首版为 `0.84.0`，不得使用 `^` 浮动升级。只添加 Worker 实际直接 import 的 Pi 包。

Client 主入口不得静态 import Pi SDK。探测通过后才启动子进程并加载 SDK，使旧环境仍能运行现有 Client 功能。

SDK 升级必须同时：

- 更新能力探测的最小 Node 版本；
- 复核 Pi Web 基准实现；
- 运行 Session 格式、事件和模型 scope 回归测试；
- 更新注册上报的 sdkVersion。

### 18.2 Frontend

保留 React 18 / Vite。Markdown 只引入普通 Markdown + GFM 所需的最小库；不引入 Next.js、React 19、Mermaid、KaTeX 或整套 Pi Web 构建依赖。

## 19. 测试策略

### 19.1 Shared

- 所有 Pi request/response/event 判别联合；
- 事件名和稳定错误码；
- payload 不允许远程 Session 绝对路径；
- 非法 action、缺失相关 ID 和超限 attachment descriptor。

### 19.2 Client 单元测试

- Node 22.18 拒绝、22.19 接受；
- Windows settings shellPath、Git Bash、PATH Bash 和缺失组合；
- Pi SDK 加载失败不影响 Client 其他功能；
- canonical cwd 的 Windows 跨盘、大小写、`..`、symlink 与 Linux 大小写；
- Session 只按当前 cwd 列出；
- Session get/context/rename/delete/fork/clone/navigate；
- 删除时子 Session re-parent；
- 同 cwd 串行、不同 cwd 并行；
- Worker idle shutdown 与 parent IPC 断开退出；
- Fork 后 registry 不保留已变异 Wrapper；
- `agent_end` 不提前终止，settlement check 正确；
- Extension UI 期间 `running -> waiting_input -> running`、timeout 和 Owner 响应；
- thinking 正文从出站事件和历史响应中移除；
- 图片数量、单图/总量、MIME、魔数、hash 与清理。

### 19.3 Server 单元测试

- requestId 关联、并发响应、timeout；
- Client 断线失败 pending request；
- Pi event SSE 投影、256 KiB 上限与 30 秒 heartbeat；
- 实时 text delta 与最终 JSONL 历史对账，Tool Result/图片不进入 Socket 大事件；
- `clientId + sessionId + runId` 丢弃迟到事件；
- Owner/Observer 权限；
- prompt 创建 sanitized `agent.run` Job；
- prompt/图片/工具正文不进入 Job payload/result；
- disconnected/reconnect/terminal summary 状态恢复；
- 稳定安全错误响应。

### 19.4 Frontend 单元测试

从 Pi Web 移植关键回归，而不是只做快照：

- 事件流在 idle grace 内保持；
- 发送前事件流必须 ready；
- 第一个 `agent_end` 不关闭运行；
- `prompt_done` / `agent_settled` 后对账；
- visibility/online 恢复漏事件；
- 旧 runId 的 SSE/快照不能复活 streaming bubble；
- Session fork 树、BranchNavigator 与 active leaf；
- Process Details 折叠；
- Tool Call 与 Tool Result 配对；
- thinking 正文不可见；
- Observer 控件只读；
- 图片 idle-only、数量/大小提示；
- 三栏、右抽屉、双抽屉响应式；
- Enter/Shift+Enter/Escape 和可访问名称。

### 19.5 集成测试

使用临时 `PI_CODING_AGENT_DIR`、临时项目目录和假模型/测试 provider，验证：

1. 新建 Session -> prompt -> Tool Call -> 最终回答；
2. 恢复 Session 后继续下一轮；
3. rename/delete/fork/clone/navigate；
4. Browser -> Server -> Client 事件流；
5. 浏览器断开、重连和最终 JSONL 对账；
6. Client Socket 断开后 Worker 继续并在重连上报终态；
7. Worker 崩溃与 Client 重启；
8. 同项目冲突与不同项目并行；
9. Owner 控制与 Observer 只读；
10. Project Trust confirm；
11. 图片 FileRef 全链路与 TTL 清理；
12. 数据库和日志不包含 prompt、图片、thinking 或 Tool 正文。

平台人工验收：

- Windows + Git Bash；
- Windows 缺少 Bash；
- Windows 上 Node 版本不足；
- Linux + Bash；
- 桌面三栏和窄屏抽屉。

## 20. 验收标准

### 20.1 能力与兼容

- 新版 Client 可上报 Pi 探测详情。
- 不兼容机器不会因 Pi SDK 导致 Client 启动失败。
- 旧 Windows/旧 Node 明确禁用 Pi Tab，不降级到 PowerShell 解析。
- Pi Worker 不调用全局 `pi` 命令。

### 20.2 Session

- 只显示选定项目的 Session。
- 新建、恢复、重命名、删除、fork、clone 和同文件 branch 均可用。
- 运行中禁止破坏性 Session 操作。
- Server 不获得远程 Session 文件绝对路径。

### 20.3 交互

- 页面行为与 Pi Web 核心逻辑一致。
- Tool Call/Result 可监督和展开。
- 模型、thinking、compact、slash command 和标准 Extension UI 可用。
- thinking 正文不经过 Server 或 Frontend。
- 图片 prompt 可用且不在 Socket.IO 传文件体。

### 20.4 运行与恢复

- 每个普通 prompt 有一个 sanitized `agent.run` Job。
- 同项目只有一个活动回合，不同项目可并行。
- 关闭/刷新页面不终止回合。
- 短暂断线后最终 Session 历史和 Job 终态可恢复。
- Client/机器重启不重放未完成 Tool Call。

### 20.5 安全

- 非 Owner 不能 steer、follow-up、abort、compact 或回答 Extension UI。
- cwd 与 Session 都在 Client 重新校验。
- Project Trust 不自动批准。
- Server 日志和数据库不含 prompt、图片、thinking、Tool 参数/结果或签名 URL。

## 21. 推荐实施顺序

该规格是一个完整的 Pi Tab 纵向功能，实施计划应拆成可独立验证的里程碑：

1. Shared 协议、能力探测和固定 SDK Worker 启动；
2. Client SessionReader、Supervisor、AgentSessionWrapper 与项目锁；
3. Server Broker、SSE、Owner 和 sanitized `agent.run` Job；
4. Frontend 三栏基础、Session 浏览和文本 prompt 流；
5. 完整 Session 管理、模型/thinking、compact、slash、Extension UI；
6. 图片 FileRef、历史媒体惰性加载、断线恢复和安全加固；
7. Windows/Linux 集成验收与 Pi Web 回归测试迁移。

每个里程碑必须保持现有 exec、files、FRP 和 Job 页面可用。

## 22. 被否决方案

### 22.1 `pi --mode rpc` 子进程

优点是进程隔离和结构化事件；缺点是当前 RPC 不完整覆盖 Session 列表、删除和同文件 tree 管理，需要旁路解析 Session。既然 Client 是 Node.js，直接使用 SDK 可以复用完整 `SessionManager`，接口更深、事实来源更单一。

### 22.2 PowerShell/Bash + Pi TUI/PTY

该方案依赖 shell、node-pty、ConPTY、ANSI 解析与终端尺寸，难以表达 Tool Call、Session 分支和审计语义，也不利于断线对账。它不符合已确认的结构化体验。

### 22.3 动态加载全局 Pi 包

全局 npm/pnpm/nvm 路径和 Windows `pi.cmd` shim 不稳定，版本无法保证与页面状态机兼容。固定携带 SDK、复用远程用户 `~/.pi/agent` 更接近 Pi Web 的实际做法。

### 22.4 Server 镜像完整 Session

会重复保存代码、命令、Tool Result、图片和可能的密钥，增加权限、容量、脱敏与保留策略。首版以远程 Session JSONL 为事实来源，Server 只保存安全 Job 元数据。

## 23. 最终原则

> **Job 管一次远程 prompt 的调度、Owner 和安全审计元数据；Pi Session 管持续上下文；Client Pi Worker 管实际 Agent 生命周期；Pi Tab 是可重新附着的结构化界面；远程 Session JSONL 是正文事实来源。**

该设计以 `examples/pi-web` 的核心行为为基准，但保持 VCPDeck 的机器路由、Typed Job、安全路径、Storage、认证和 UI 外壳，不引入第二套终端协议，也不复制整套 Pi Web 产品。

## 24. 规格自审

- **占位符**：无临时占位标记、未完成章节或悬而未决的实现选择。
- **内部一致性**：Pi SDK 固定为 Client 依赖；Session 正文只在远程机器持久化；Server 仅转发有界实时事件并保存安全 Job 元数据。
- **状态一致性**：普通 prompt 对应一个 Job/Run；Extension UI 等待映射为 `waiting_input`；`agent_end` 不作为终态；断线与重启语义已区分。
- **范围**：完整覆盖 Pi Tab 纵向闭环；明确排除 PTY、Pi Web 配置管理、Server Session 镜像和重启续跑，可拆成同一实施计划下的七个里程碑。
- **歧义处理**：浏览历史不创建 `AgentSession`；新 Session 采用“先创建、再订阅、后 prompt”；同项目并发锁、Owner/Observer、图片大内容和 thinking 处理均有单一语义。
