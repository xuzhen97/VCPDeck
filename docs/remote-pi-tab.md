# 远程 Pi Tab

机器工作区的 **Pi** Tab 提供参考 `examples/pi-web` 核心逻辑的结构化远程编码代理界面：项目级 Pi Session 管理、多轮对话、工具调用监督、分支导航、Owner/Observer 控制与图片提示。

## 架构总览

```text
Browser (React 三栏 UI)
  │ REST + SSE（cookie 认证）
  ▼
VCPDeck Server（NestJS 代理）
  │ 只保存 sanitized agent.run Job 元数据；不镜像正文
  ▼
远程 Client（Node.js）
  │ 每 canonical cwd 一个 Pi SDK Worker 子进程（child_process.fork IPC）
  ▼
Pi SDK 0.84.0 → 远程用户 ~/.pi/agent（凭据/模型/扩展/skills）
```

- **Session JSONL 是正文事实来源**（保存在远程机器的 `~/.pi/agent/sessions`）；
- Server 只做代理、Owner 校验与安全 Job 元数据；
- 每个普通 prompt 创建一个 `agent.run` Job，`runId === jobId`；
- Browser/Server 断线不会停止远程 Worker；关闭页面也不会终止回合。

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
3. 新建/选择 Session。
4. 输入 prompt；运行中可 Steer / Follow-up / 中止 / Compact；Esc 中止。
5. 中间过程折叠在 **Process Details**，最终回答单独展示；Tool Call 可展开参数与结果。
6. 图片：仅空闲时可附加（最多 10 张、单张 ≤ 10 MiB、总量 ≤ 100 MiB；PNG/JPEG/GIF/WebP）。

## 与 Execute Tab 的区别

- **Execute Tab**：一次性 shell 命令（`exec` Job）。
- **Pi Tab**：结构化多轮 Agent 会话（不提供 `!`/`!!` 直接 shell、PTY 或 ANSI 终端）。

## 并发与权限

- 同一项目（canonical cwd）同时只允许一个活动回合；不同项目可并行。
- 发起 prompt 的身份是该回合 **Owner**：可 steer/follow-up/abort/compact/回答 Extension UI。
- 其他身份是只读 **Observer**；所有写操作由 Server 校验。
- 空闲时任一认证身份可切换模型/thinking、重命名/删除/fork/clone Session（短暂项目锁）。

## 断线与恢复

- 浏览器断开：只取消 SSE 订阅，Worker 与 Job 继续；重新打开页面后自动附着。
- Server/Client 短暂断开：活动回合标记 `disconnected`，重连后按 Client 上报恢复。
- Client/机器重启：未完成回合标记 `PI_CLIENT_RESTARTED`；Session JSONL 保留，可继续会话。

## 隐私

- thinking 正文永不离开远程 Session JSONL；界面只显示"思考中/已思考 N 秒"。
- Server 数据库与日志不保存 prompt、回答、Tool 参数/结果、thinking、图片、签名 URL 或项目路径。
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
| `PI_CLIENT_DISCONNECTED` | Client 离线或连接中断 |
| `PI_WORKER_EXITED` | 远程 Worker 异常退出 |
| `PI_CLIENT_RESTARTED` | Client 重启导致回合中断 |
| `PI_IMAGE_INVALID` / `PI_IMAGE_TOO_LARGE` | 图片校验失败 / 超限 |
| `PI_REQUEST_TIMEOUT` | 请求超时 |
| `PI_PROTOCOL_INVALID` | 协议/请求体非法 |

## 排障

- **Pi Tab 显示不可用**：查看原因码；Node 版本、Bash 路径、模型认证按上文核对。
- **提示"项目已有活动回合"**：等待当前回合结束，或由 Owner 中止。
- **页面显示断线后恢复**：事件流自动重连；历史与 Job 状态会自动对账。
- **图片上传失败**：确认格式/大小符合限制，附件 TTL 15 分钟内完成发送。
