---
name: vcpdeck
description: Use VCPDeck through its CLI to access cockpit capabilities exposed by the VCPDeck Server. Use when the user asks to operate VCPDeck from Pi, inspect available CLI capabilities, list registered Client machines and their online status, query Jobs and diagnose Job failures with full stdout/stderr output, run shell commands on a Client machine or cancel running Jobs (with mandatory user confirmation), browse directories and read text files on a Client machine, write/mkdir/delete/move remote files (with mandatory user confirmation), transfer files between a Client machine and local disk via Storage direct upload (with mandatory user confirmation), dispatch subtasks to the Pi agent running on a Client machine and retrieve its reply (with mandatory user confirmation), inspect FRP instances/mappings and Storage backend status, manage Terminal session lifecycle on a Client machine (close requires user confirmation; interactive PTY stays in Frontend), publish or update VCPDeck, or use machine, Job, file, Terminal, Pi, FRP, Storage, and other commands as they become available.
compatibility: Requires Node.js 24+, the bundled vcpdeck.cjs CLI beside this file, and network access to the VCPDeck Server. Individual capabilities may have additional requirements; Release packaging also requires the VCPDeck repository and pnpm 10.26+.
---

# VCPDeck CLI

本 Skill 是 **VCPDeck CLI 的统一能力入口**，负责说明当前可用命令、调用方式、安全边界和操作流程。Release/自更新只是当前首先落地的一项功能；后续 CLI 与 Server 能力逐步对齐时，在本 Skill 中继续增加机器、Job、文件、Terminal、Pi、FRP、Storage 等功能说明。

Skill 不实现 HTTP、认证、轮询或业务状态机。它调用同目录的 `vcpdeck.cjs`；CLI 复用 `@vcpdeck/sdk` 访问 Server，Server 仍是业务状态和远程操作的控制面。

## 入口与能力发现

先从本 `SKILL.md` 解析同目录 `vcpdeck.cjs` 的绝对路径，记为 `<vcpdeck-cli>`。执行时必须保持 Pi 当前项目为工作目录，**不得 `cd` 到 Skill/安装仓库目录**，否则 CLI 无法读取当前项目的 `.vcpdeck.json`：

```bash
node "<vcpdeck-cli>" --help
```

正式 Git Tag 必须已经包含 `vcpdeck.cjs`；若源码开发分支缺失，可在 VCPDeck 仓库根目录构建：

```bash
pnpm --filter @vcpdeck/cli build
```

以下命令中的 `<vcpdeck-cli>` 始终指绝对路径。以当前 CLI `--help` 和源码为命令事实来源。Server 或 SDK 已经具备某项 API，不代表 CLI 已经提供对应命令；不得自行猜测命令名或把规划能力描述为已实现。

## 当前能力

| 功能域 | CLI 命令 | 状态 | 说明 |
| --- | --- | --- | --- |
| 多环境配置 | `env add/list/show/current/check/use/remove` | 已实现 | 用户级注册环境，项目级只选择默认环境；`check` 验证 Token 对应身份 |
| 机器查询（只读） | `clients list` | 已实现 | 列出已注册 Client 及在线状态；`--json` 输出原始 `ClientInfo[]`，供 Agent 解析 |
| Job 查询（只读） | `jobs list` / `jobs get` | 已实现 | 分页查询 Job 及失败现场（错误摘要 + stdout/stderr spool 全文）；`--json` 供 Agent 解析 |
| Job 执行/取消（写操作） | `jobs run` / `jobs cancel` | 已实现 | 在目标机执行 shell 命令；**必须先取得用户明确确认**（确认门见功能章节） |
| 文件浏览（只读） | `files roots/list/stat/read` | 已实现 | 授权根探测、目录列表、元信息与文本读取（默认上限 256KB）；`--json` 供 Agent 解析 |
| 文件写入（写操作） | `files write/mkdir/delete/move` | 已实现 | 覆盖写/递归建目录/删除（不可恢复）/移动重命名；**必须先取得用户明确确认**（确认门见功能章节） |
| 文件传输（写操作） | `files download/upload` | 已实现 | 经 Storage Provider 直传链路（Server 只签名不承载字节）；download 校验 sha256；**必须先取得用户明确确认** |
| Pi 子任务（写操作） | `pi models/sessions/new/run/abort` | 已实现 | 在目标机驱动 Pi Agent 执行子任务并取回回复；**最强确认门：必须先取得用户明确确认** |
| FRP 查询（只读） | `frp instances/mappings` | 已实现 | 服务实例与映射状态；凭据字段（token/密码）绝不进入输出 |
| FRP 映射写操作 | `frp mapping create/delete` | 已实现 | Client frpc 动作与 FRPS Dashboard 双重确认；**必须先取得用户明确确认** |
| Storage 查询（只读） | `storage status` | 已实现 | 当前激活的存储后端类型 |
| Terminal 生命周期 | `terminal new/shells/list/close` | 已实现 | 创建会话（返回 sessionId 供 attach）、Shell 探测与会话列表（只读）、关闭会话（写操作需确认）；交互式 PTY 经 attach 直连 |
| Release / 自更新 | `release upload/status/wait` | 已实现 | 上传双平台构件；查询或等待 Server/Client 权威终态，失败或超时返回非零退出 |
| FRP 实例写操作、Storage 后端切换、机器写入 | — | 尚未形成 CLI 命令 | 等对应 CLI 落地后再在本 Skill 中增加正式说明 |

## 功能：环境选择

用户级环境定义保存在 `~/.vcpdeck/cli/config.json`；项目 `.vcpdeck.json` 只保存环境名。Skill 不直接读取或修改这些 JSON，统一调用 CLI：

```bash
node "<vcpdeck-cli>" env list
node "<vcpdeck-cli>" env current
```

推荐先在 Frontend `/settings/tokens` 为 CLI 创建独立 Token，立即保存到本机环境变量，再注册命名环境：

```bash
node "<vcpdeck-cli>" env add prod \
  --server=https://deck.example.com \
  --token-env=VCPDECK_PROD_TOKEN
node "<vcpdeck-cli>" env use prod --global
node "<vcpdeck-cli>" env check
```

`env check` 通过 SDK 请求 `/api/auth/me`，安全显示该 Token 对应的真实身份；个人资料修改用户名不会改变 Token 身份。`--auth=bearer` 仍兼容但可省略。用户名/密码环境仅为旧配置和临时兼容入口，不作为新环境首选。不得把密码或 Token 值写进配置、命令或对话。

环境选择顺序为：显式 `--env`、`VCPDECK_ENVIRONMENT`、最近项目配置、全局默认。执行任何业务操作前必须先运行 `env current` 展示并核对环境名、Server 和来源，并运行 `env check` 验证 Server 可达、凭据有效及 Token 身份；有副作用操作还需取得用户确认。项目配置损坏、引用不存在环境或目标 Server 不符合预期时停止，不通过 `--server` 绕过。

## 通用操作规则

1. 执行前先用 `--help` 核对命令和参数，不能根据 Server API 猜测 CLI 行为。
2. 向用户展示目标 Server、操作对象和预期副作用；写入、删除、执行、发布、重启等操作必须在执行前取得明确确认。
3. 密码、Cookie、Bearer Token、PSK、签名 URL、云端凭据和敏感正文不得写入命令、日志或回复。命名环境只保存凭据环境变量名，不保存值。
4. 非幂等 POST 的网络结果不明时先查询权威状态，不盲目重试。
5. CLI 成功退出只证明该命令定义的同步阶段成功；涉及异步 Job、Release 或远程运行态时，继续按对应功能说明核对终态。
6. 只报告安全摘要、资源 ID、稳定错误码、状态和下一步，不原样输出可能含敏感信息的 payload 或外部响应。
7. 当前没有对应 CLI 命令的能力应明确告知用户尚未落地，不通过临时 curl、任意 shell 或在 Skill 中复制 SDK 实现来伪造 CLI 能力。
8. Windows 盘符根路径统一写正斜杠形式（`--root=D:/`）：Git Bash 下 `--root="D:\\"` 的尾反斜杠会转义闭引号导致命令未执行即报错；正斜杠与授权根匹配等价。
9. Windows Git Bash/MSYS 会在启动 `node.exe` 前改写 `/root/...` 等参数。全局 `vcpdeck` shell 垫片已禁用该转换；直接运行 bundled CLI 时统一使用 `MSYS_NO_PATHCONV=1 node "<vcpdeck-cli>" ...`。

## 功能：Release 上传与 Server/Client 自更新

### 功能语义

`release upload` 上传两个平台 Release archive。第二个平台构件成功登记后，Server 自动编排：

```text
Server 更新并探活 → 逐台更新在线 Client → 离线 Client 后续注册时补更
```

这里的“自更新”是 Server/Client 业务构件更新，**不是 CLI 替换自身，也不包括 Launcher 自动更新**。

### 安全边界

- 第二个平台构件上传成功后会立即触发更新，没有额外确认关卡。
- 上传前必须复述 Server URL、目标版本和两个 archive 路径，并取得明确确认；Alibaba 模式还应说明构件将直接发送到 Provider。
- 优先使用用户在 Frontend `/settings/tokens` 创建并保存在本机环境变量中的专用 Bearer Token；不得让用户把 Token 贴到对话中。用户名/密码只用于旧环境或直连兼容。
- Release 控制面 POST 网络结果不明时先核对发版页面和 Release 记录。Alibaba 相同 SHA/大小的持久化会话可恢复，但不同构件和 legacy raw POST 不得盲目重试。
- 同一版本号不得复用。失败后修复问题并使用新版本号。
- Launcher 回退只切回应用版本目录，不回退数据库、Storage 或外部副作用；发布前必须确认备份。

### 发布流程

#### 1. 发布前检查

1. 阅读 `../../docs/design/release-and-update.md`、`../../docs/design/cli.md` 与 `../../docs/deployment.md` §9。
2. 在当前项目 cwd 运行 `node "<vcpdeck-cli>" env current` 展示环境名、Server 和来源，再运行 `node "<vcpdeck-cli>" env check` 验证 Token 对应身份并请用户确认；不要打印凭据值。
3. 确认已备份 SQLite、Storage 和 Release archive。
4. 确认目标 Linux 主机具备 `unzip`，Server/Client Launcher 正常，且没有其他活动 Release。
5. 确认凭据环境变量已由用户在本地设置，不打印其值。
6. 确认版本号严格为 `x.y.z`，并且从未使用。

#### 2. 生成构件

在仓库根目录运行：

```bash
pnpm release --version=x.y.z
```

必须同时得到：

```text
dist-release/vcpdeck-x.y.z-win-x64.zip
dist-release/vcpdeck-x.y.z-linux-x64.zip
```

缺少任一平台时停止，不把单边构件当作完整发布。

#### 3. 最终确认与上传

用户确认 Server、版本和文件后，保持当前项目 cwd 运行；默认添加 `--wait` 完成全链路验收：

```bash
node "<vcpdeck-cli>" release upload \
  <repo>/dist-release/vcpdeck-x.y.z-win-x64.zip \
  <repo>/dist-release/vcpdeck-x.y.z-linux-x64.zip \
  --wait --timeout=1800
```

命令默认使用刚确认的项目/全局环境，也可显式添加 `--env=<name>`。不要添加 `--password` 或临时改用 `--server` 绕过项目选择。CLI 从环境变量读取凭据并计算 SHA-256。两个构件必须版本相同且平台各一个。Alibaba 后端由 Server 创建持久化上传会话和短期分片 URL，CLI 把构件分片直接 PUT 到 Provider，403 时经 Server 刷新 URL；Server 不接收构件正文。CLI 对实际发送字节再次计算 SHA-256，URL 不输出、不落盘。相同 SHA/大小会话可恢复或幂等跳过，不同构件拒绝覆盖。Local 后端由 Server 协商为 legacy raw stream；旧 Server 会话端点 404 时也只为引导升级回退 legacy raw。`--wait` 只重试安全的 GET 查询，并容忍 Server 重启期间短暂不可达。

#### 4. 核对结果

`--wait` 查询 Release 列表与 `/api/status`，成功门槛为：Server 等于目标版本、Release 到达 `done`、所有已记录 Client 均为 `done`。Release `failed`、任一 Client `failed`、仍有 pending/updating 或等待超时均返回非零退出。

已有上传可单独查询或等待：

```bash
node "<vcpdeck-cli>" release status x.y.z
node "<vcpdeck-cli>" release wait x.y.z --timeout=1800
```

离线 Client 不进入本次在线更新明细，也不阻塞 `done`；其后续注册时才补更。若状态为 `failed`，只报告安全错误摘要和失败阶段。不要自行重复版本、删除数据库记录或覆盖 Launcher。

### 本功能当前不提供

- Launcher 自动更新；Launcher 升级遵循独立人工流程和兼容检查。
- 灰度、分组、暂停/恢复、维护窗口或数据库自动回滚。
- CLI 自身在线更新。

## 功能：机器查询（Clients，只读）

### 可用命令

```bash
node "<vcpdeck-cli>" clients list [--env=<name>] [--json]
```

以 CLI `--help` 和源码为命令事实来源；当前只有 `list` 一个只读子命令。

### 功能语义与状态权威

`clients list` 通过 SDK 请求 Server `GET /api/clients`，返回所有已注册 Client 的安全摘要：名称（全局唯一别名）、hostname、OS、在线状态、CPU/内存使用率、磁盘、版本和 capability 摘要。在线状态与心跳由 Server 维护，CLI 不做本地推断；输出反映的是查询时刻的快照。

默认输出人类可读表格（在线优先、按名称排序），并附总数/在线/离线汇总。**Agent 解析时必须加 `--json`**：该模式跳过环境摘要，stdout 为纯 JSON `ClientInfo[]`，可直接 `JSON.parse`。

### 认证与敏感信息

认证与环境选择遵循本 Skill「环境选择」章节；读操作也建议先 `env current` 核对目标 Server。列表结果中的 hostname、硬件信息和路径属于环境信息，可向操作者展示，但不得将 Token、Cookie 或凭据变量值写入命令或回复。

### 操作分级与确认门

当前 `clients list` 是只读 GET，幂等且无副作用，无需用户确认即可执行。后续若增加 rename 等写命令，必须在执行前展示目标对象并取得明确确认。

### 幂等性与失败处置

GET 天然幂等，失败可直接重试；网络错误或非 2xx 时 CLI 非零退出并输出安全错误摘要。空列表输出“没有已注册的 Client。”，这是正常结果而非错误。离线 Client 仍会出现在列表中（`online: false`），其 CPU/内存等运行时字段可能为 `null`。

### 成功判定与已知限制

成功判定：命令零退出且 JSON 数组可解析。已知限制：只有列表查询，没有单机详情过滤；机器上的命令执行用 `jobs run`，交互式终端与 Pi 子任务分别见 Terminal/Pi 功能章节。

### 与 Server 能力的对齐情况

已对齐：`GET /api/clients` 列表查询。未对齐：`PATCH /api/clients/:id/name` 重命名及一切远程操作能力，等待后续任务落地。

## 功能：Job 查询、执行与失败诊断

### 可用命令

```bash
node "<vcpdeck-cli>" jobs list [--client=<name|id>] [--status=<status>] [--page=<n>] [--env=<name>] [--json]
node "<vcpdeck-cli>" jobs get <jobId> [--env=<name>] [--json]
node "<vcpdeck-cli>" jobs run <client> [--cwd=<dir>] [--timeout=<seconds>] [--wait] [--wait-timeout=<seconds>] [--env=<name>] [--json] -- <command...>
node "<vcpdeck-cli>" jobs cancel <jobId> [--env=<name>] [--json]
```

`--status` 允许值：`pending/running/waiting_input/done/error/cancelled/disconnected/active`。以 CLI `--help` 为命令事实来源。

### 功能语义与状态权威

`jobs list` 通过 SDK 请求 Server `GET /api/jobs`，返回分页 Job 摘要（`PaginatedResult`）；`--client` 接受机器名称或 ID，CLI 先查机器列表解析为 `clientId`。`jobs get` 取详情与输出 spool。`jobs run` 创建 exec Job（command 模式，`--` 后的命令 token 以空格连接后交由目标机 shell 执行，Windows 下自动 chcp 65001）；复杂命令应作为 `--` 后的单一参数传入，例如 `-- 'sudo -n true; echo $?'`，避免多 token 重组丢失原参数边界。`--timeout` 是远端进程时限，`--wait-timeout` 是 CLI 等待终态时限，两者单位均为秒。目标机必须在线，否则 Server 拒绝。`jobs cancel` 提交取消：pending 立即 `cancelled`；running 返回 `cancelling`，终态需用 `jobs get` 核对。

Job 状态权威在 Server；输出 spool 由 Server 在 Client 实时上报 stdout/stderr 时旁路落盘（`<data>/job-outputs/<jobId>.log`），完整保留不封顶，只在详情路径读取。正常非零退出保存真实 exitCode；远端进程超时返回 `EXEC_TIMEOUT`，其他信号终止返回 `EXEC_SIGNALLED`，两者均保留已捕获输出。timeout/取消会按平台终止进程树，但不能回滚已提交给系统服务管理器的进程或外部副作用。`jobs get` 同时展示 Job 顶层远端进程 timeout。

### 确认门（写操作强制）

`jobs run` 与 `jobs cancel` 是写操作。**执行前必须向用户展示并取得明确确认**：

1. 目标环境（`env current` 的 Server 地址与环境名）；
2. 目标机器名称与在线状态；
3. 完整命令文本（含 cwd 与超时）；
4. 预期影响（远程命令继承 Client OS 账户权限，不是沙箱；破坏性命令必须单独强调）。

用户未明确同意前不得执行；用户只表达“看看/查询”类意图时绝不能升级为 run。`jobs cancel` 需展示目标 Job 的机器、命令与当前状态。批量执行多条命令时逐条确认，不得打包默认同意。

### 执行与失败诊断流程（闭环）

1. 推荐使用 `jobs run <client> --wait` 等待终态：成功输出 `result` 与全文；**失败时 CLI 非零退出并自动带出错误摘要与完整 stdout/stderr 现场**，Agent 直接定位根因；
2. 未加 `--wait` 时用 `jobs get <jobId>` 查询；
3. 事后排查：`jobs list --status=error` → `jobs get <jobId>`；
4. 需要机器上下文时用 `clients list` 核对状态。

全程不需要登录目标机器。若输出显示“（无落盘输出）”，说明该 Job 执行期间没有产生 stdout/stderr 或产生早于 spool 功能上线。

### 认证、敏感信息与操作分级

认证与环境选择遵循「环境选择」章节。**stdout/stderr 与命令文本都属于敏感正文**：可能包含路径、环境变量甚至密钥；向用户报告时先给安全摘要（错误码、退出码、关键错误行），原样输出前应说明内容可能敏感，不得写入日志或长期存储。

操作分级：`list/get` 只读 GET 无需确认；`run/cancel` 写操作必须确认门；`run --wait` 只是同步等待方式，不改变写操作性质。非幂等 POST 网络结果不明时先用 `jobs list`/`jobs get` 查权威状态，不盲目重试创建。使用 `--json` 时 stdout 只包含最终 JSON，等待状态、警告和暂时网络错误写入 stderr；Agent 应分别读取两条流，不用 `2>&1` 合并后再解析。

### 幂等性、成功判定与已知限制

`list/get` GET 幂等可直接重试；`run` 非幂等（重复执行会重复创建 Job），结果不明时先查询；`cancel` 幂等（重复取消已取消 Job 由 Server 权威态决定）。`run --wait` 仅重试安全 GET，容忍 Server 重启短暂不可达，超时非零退出。成功判定：零退出且 `--json` 输出可解析。已知限制：只支持 command 模式（script 模式未暴露）；输出 spool 无自动清理；没有按时间范围过滤。

### 与 Server 能力的对齐情况

已对齐：Job 列表/详情/输出/创建（exec command 模式）/取消。未对齐：script 模式、file.*/frp 等其他 Job 类型、SDK `jobs.wait` 的 CLI 暴露，等待后续任务落地。

## 功能：文件管理（浏览、读取与写入）

### 可用命令

```bash
node "<vcpdeck-cli>" files roots <client> [--env=<name>] [--json]
node "<vcpdeck-cli>" files list <client> <path> [--root=<dir>] [--env=<name>] [--json]
node "<vcpdeck-cli>" files stat <client> <path> [--root=<dir>] [--env=<name>] [--json]
node "<vcpdeck-cli>" files read <client> <path> [--root=<dir>] [--max-bytes=<n>] [--env=<name>] [--json]
node "<vcpdeck-cli>" files write <client> <path> [--root=<dir>] [--input=<file>] [--env=<name>] [--json]  # 覆盖写；缺省 --input 时读 stdin
node "<vcpdeck-cli>" files mkdir <client> <path> [--root=<dir>] [--env=<name>] [--json]  # 递归创建
node "<vcpdeck-cli>" files delete <client> <path> [--root=<dir>] [--recursive] [--env=<name>] [--json]  # 不可恢复
node "<vcpdeck-cli>" files move <client> <source> <destination> [--root=<dir>] [--overwrite] [--env=<name>] [--json]
node "<vcpdeck-cli>" files download <client> <remotePath> <localPath> [--root=<dir>] [--env=<name>] [--json]
node "<vcpdeck-cli>" files upload <client> <localPath> <remotePath> [--root=<dir>] [--overwrite] [--env=<name>] [--json]
```

以 CLI `--help` 为命令事实来源。

### 功能语义与授权根（rootDir）

文件操作通过创建 `file.*` Job 并等待终态实现，目标机必须在线。`rootDir` 是授权根（`resolveSafePath` 的基准目录）：显式 `--root=<dir>` 优先；缺省时自动探测（`file.roots`）——唯一根直接使用，多根时 fail closed 并要求显式指定，不猜测。`path` 相对授权根解析。

只读三件套：`list` 输出目录项（目录优先、按名称排序，含总数汇总）；`stat` 输出单个路径元信息；`read` 读取文本（默认上限 256KB，`--max-bytes` 可调）。失败时 CLI 非零退出并带 Server 稳定错误码（`PATH_NOT_FOUND`/`PATH_NOT_ALLOWED`/`PATH_CONFLICT`/`IO_ERROR` 等）。

写操作语义（由 Client 权威定义）：`write` 原子覆盖写（tmp+rename），内容来自 `--input` 本地文件或 stdin；`mkdir` 递归创建；`delete` 非递归遇非空目录报 `PATH_CONFLICT`，`--recursive` 解锁；`move` 目标存在默认拒绝，`--overwrite` 解锁。所有写操作执行前 CLI 会输出目标摘要（机器、授权根、路径、影响）。

### 确认门（写操作强制）

`write/mkdir/delete/move` 是改变目标机状态的写操作。**执行前必须向用户展示并取得明确确认**：

1. 目标环境（Server 地址与环境名）；
2. 目标机器、授权根和完整目标路径；
3. 操作影响：`write` 会覆盖已有文件；`delete` **不可恢复**，`--recursive` 会删除整个目录树，必须单独强调；`move --overwrite` 会覆盖目标；
4. 写入内容来源（不展示可能含秘密的完整内容，除非用户要求）。

用户未明确同意前不得执行；“看看/读取”类意图绝不能升级为写操作。批量操作逐条确认。远程文件操作继承 Client OS 账户权限，不是沙箱。

### 敏感内容规则

**文件内容属于敏感正文**：可能包含凭据、密钥或隐私数据；向用户报告时先给摘要（路径、大小、关键行），原样输出大段内容前应说明并征得同意，不得写入日志或长期存储。`read` 只针对文本文件，二进制文件结果不可靠；写入内容经 stdin 或本地文件传入，避免秘密出现在命令行参数中。

### 幂等性与成功判定

`roots/list/stat/read` 不改变目标机状态，失败可直接重试；`write/mkdir/delete/move` 非幂等（重复执行会重复变更），网络结果不明时先用只读命令核对权威状态。成功判定：零退出且 `--json` 输出可解析。

### 文件传输（download/upload，确认门 + 直传链路）

`download` 导出目标机文件：创建 `file.export` Job（Client 分片直传 Storage Provider）→ Server 签发短期下载令牌 → CLI 从签名 URL 拉取到 `<localPath>` 并校验 sha256，不一致时删除本地半成品并报错。`upload` 先分片直传本地文件到 Storage Provider（403 经 Server 仅刷新该分片 URL），完成后创建导入 Job 由 Client 从存储拉取落盘。

**直传约束**：字节流不经过 Server——阿里云后端为 Provider 预签名 URL 直传；Local 后端经 Server 中转是无外部存储时的固有行为。签名 URL 不输出、不落盘、不进日志。

确认门要求：展示源/目标路径、文件大小、是否覆盖（download 覆盖本地同名文件；upload 默认拒绝覆盖远端已存在文件，`--overwrite` 解锁），取得明确确认后执行。传输非幂等：网络结果不明时先用只读命令核对两侧状态，不盲目重传。大文件传输耗时较长，CLI 有进度输出，不要在未完成时重复触发。

## 功能：Pi 子任务（远端 Agent 驱动）

### 可用命令

```bash
node "<vcpdeck-cli>" pi models <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]
node "<vcpdeck-cli>" pi sessions <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]
node "<vcpdeck-cli>" pi new <client> --cwd=<path> [--root=<dir>] [--env=<name>] [--json]
node "<vcpdeck-cli>" pi run <client> "提示词" --cwd=<path> [--session=<id>] [--root=<dir>] [--timeout=<seconds>] [--env=<name>] [--json]
node "<vcpdeck-cli>" pi attach <client> [--cwd=<path>] [--session=<id>] [--root=<dir>] [--env=<name>]  # 交互式对话 REPL；/exit 或 Ctrl+D 退出
node "<vcpdeck-cli>" pi abort <client> --session=<id> [--env=<name>] [--json]
```

以 CLI `--help` 为命令事实来源。目标机必须具备 `pi` capability。

### 功能语义与运行循环

`run` 在目标机的 Pi Agent 上执行子任务：提交提示词 → 轮询 agent.state 至 `idle`（默认超时 600 秒，可调）→ 从会话上下文提取最后一条助手文本回复并输出。缺省自动创建新会话（子任务隔离）；`--session=<id>` 复用既有会话延续上下文（先 open 再 prompt）。`waiting_for_extension_input` 表示 Pi 在等待扩展输入，CLI 会明确报错——需在 Frontend 处理或 `pi abort` 中止。`complete` 是中断标记不是等待，Agent 不得用它等待任务完成。

授权根与文件域一致：显式 `--root` 优先，缺省探测唯一根，多根 fail closed；`--cwd` 为相对路径（缺省 `.`），是 Pi 在目标机上的工作目录。

`attach` 为交互式对话模式：readline 循环内每行作为提示词下发，等待 idle 后打印最后一条助手回复，循环继续；`/abort` 中止当前运行、`/state` 查看状态、`/exit` 或 Ctrl+D 退出。单轮超时或扩展输入等待只报告不退出，可继续输入。

### 确认门（最强级，强制）

**pi run 让 AI Agent 以工具能力在目标机上执行任务——它可以读写文件、执行命令、访问网络。**执行前必须向用户展示并取得明确确认：

1. 目标机器与工作目录（cwd）；
2. 完整提示词原文；
3. 超时与会话策略（新建/复用）；
4. 预期影响：Pi 的行为不可完全预测，生产机器上慎用。

用户未明确同意前不得执行；“查看模型/列出会话”类只读意图绝不能升级为 run。运行可持续数分钟，不要在未完成时重复触发。

### 敏感内容与结果处理

提示词与回复都可能含敏感信息：回复先给摘要，原样输出前征得同意；不得写入日志或长期存储。回复为空时用 `--json` 查看完整上下文排查。

### 幂等性与已知限制

`models/sessions` 只读幂等；`new/run/prompt` 非幂等（重复提交会重复执行子任务）。已知限制：未暴露 fork/clone/navigate/compact/setModel/thinkingLevel/附件；不支持图片输入；扩展输入需到 Frontend 处理。

### 与 Server 能力的对齐情况

已对齐：模型列表、会话列表、会话创建/打开、子任务下发与回复提取、中止。未对齐：会话高级操作与多模态输入。

## 功能：FRP 映射与 Storage 状态

### 可用命令

```bash
node "<vcpdeck-cli>" frp instances [--page=<n>] [--env=<name>] [--json]
node "<vcpdeck-cli>" frp mappings [--client=<name|id>] [--page=<n>] [--env=<name>] [--json]
node "<vcpdeck-cli>" frp mapping create <client> --local-port=<port> [--type=tcp|http|https] [--local-ip=<host>] [--remote-port=<port>] [--domain=<domain>] [--name=<name>] [--instance=<id>] [--timeout=<seconds>] [--env=<name>] [--json]
node "<vcpdeck-cli>" frp mapping delete <mappingId> [--timeout=<seconds>] [--env=<name>] [--json]
node "<vcpdeck-cli>" storage status [--env=<name>] [--json]
```

以 CLI `--help` 为命令事实来源。

### 功能语义与敏感字段红线

`frp instances` 列出 FRP 服务实例（名称、服务器地址端口、Dashboard 地址、是否默认）；`frp mappings` 列出映射（名称、机器、类型、本地地址、远程端口、状态、公网 URL），支持 `--client` 名称/ID 过滤。**实例信息中的 authToken 与 dashboard 密码属于凭据，CLI 输出已做安全投影，Agent 不得尝试从其他渠道获取或展示这些字段**。`storage status` 显示当前激活的存储后端类型（local/alibaba）与配置更新时间。

### 写操作语义与确认门

`mapping create` 支持 TCP/HTTP/HTTPS；name 可省略，缺省由 Server 生成唯一名称；HTTP/HTTPS 必须提供 domain，TCP 可选 remotePort。`mapping delete` 接受 mappingId。两者默认使用 30 秒 Dashboard 确认窗口，可用 `--timeout=1..300` 覆盖；只有 Client 已正确更新 frpc 且 FRPS Dashboard 确认 proxy 出现/消失时才零退出，不验证本地服务或公网可达。创建确认失败由 Server 自动回滚；回滚或删除失败保留 error 映射。若 Client 派发后完全不回报，当前 Server 无 FRP Job 后台超时监控，CLI 会继续等待；可由用户中止，随后先用 `frp mappings`/`jobs get` 核对，不能盲目重试 create。

create/delete 都是写操作，执行前必须先运行 `env current`/`env check`，并向用户展示环境与 Server、Client、类型、本地端点、公网端口或域名、实例/名称（若指定）和影响；取得明确确认后才能执行。delete 还要展示 mappingId/name/公网端点。用户说“查看”不能升级为写操作。

只读 `instances/mappings/storage status` 幂等无需确认。已对齐：实例/映射列表、映射 create/delete 和 Storage 状态；未对齐：FRP 实例创建/探活/设默认与 Storage 后端切换。

## 功能：Terminal 生命周期与终端直连

### 可用命令

```bash
node "<vcpdeck-cli>" terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>] [--env=<name>] [--json]  # 创建会话，返回 sessionId
node "<vcpdeck-cli>" terminal shells <client> [--env=<name>] [--json]
node "<vcpdeck-cli>" terminal list <client> [--status=<status>] [--env=<name>] [--json]
node "<vcpdeck-cli>" terminal close <client> <sessionId> [--env=<name>] [--json]  # 写操作需确认
node "<vcpdeck-cli>" terminal attach <client> <sessionId> [--env=<name>]  # 本地终端直连远端 PTY；Ctrl+Q 退出
```

以 CLI `--help` 为命令事实来源。

### 功能语义与边界

`shells` 探测目标机可用 Shell；`list` 列出会话（sessionId/shell/status/创建者，`--status` 为首页内本地过滤）；`close` 关闭会话（写操作需确认门，先取详情展示目标摘要再删除）。

**attach 是终端直连**：本地终端进入 raw mode 后经 `/app` 数据面（Bearer 握手认证）双向桥接远端 PTY——按键直传、输出直写、resize 同步，vim/htop 等 TUI 应用可用，体感与 SSH 一致。交互体感受操作者到 Server 的网络延迟影响。安全退出序列为 `Ctrl+Q`（直接断开本地连接不会通知 Server，应尽量使用退出序列或 `terminal close`）。

已知限制：仅支持 Bearer 环境（密码环境的登录态无法传给 socket 握手）；交互式内容经 Server 中继（审计与隐私预期见 docs/security.md）；不支持会话录制回放。

### 操作分级与确认门

`shells/list` 只读幂等无需确认；`close` 写操作需展示机器/会话/shell/创建者并取得明确确认；`attach` 本身不改变目标机状态（附着到既有 PTY），但接入后用户的键入即为真实操作——Skill 应提醒用户正在操作真实机器。

## 后续 CLI 能力扩展规则

每当 CLI 新增并验证一组 Server 能力时，同一变更应在本 Skill 中增加对应功能章节，至少包含：

1. 可用命令和真实 `--help` 用法；
2. 功能语义、状态权威和同步/异步完成边界；
3. 认证方式与敏感信息处理；
4. 读操作、写操作、危险操作及其确认门；
5. 幂等性、超时、取消、重试和断线语义；
6. 成功判定、失败处置和当前已知限制；
7. 与 Server 能力的已对齐项和仍未对齐项。

新增章节只描述已经落地并验证的 CLI 命令。候选命令和未来方向留在 Current 文档的“后续候选”或 Roadmap，不能提前写进“当前能力”。
