# CLI 与多环境配置设计

> 状态：Current｜维护责任：CLI/SDK 维护者｜最后核验：2026-09-04｜适用版本：`0.6.24` / 当前 `main`

本文描述当前 VCPDeck CLI 的职责、环境配置、安全边界和已落地命令。长期取舍见 [ADR-0017](../adr/0017-cli-multi-environment-configuration.md)；REST 与认证语义见 [`protocols.md`](../protocols.md) 和 [`design/identity-and-authentication.md`](./identity-and-authentication.md)。

## 1. 定位与边界

CLI 是操作员和 Pi Skill 使用的命令入口，复用 `@vcpdeck/sdk` 访问 Server。当前已落地：

- 多环境注册、查看、选择与项目默认环境；
- `clients list` 已注册 Client 只读列表查询；
- `jobs list/get` Job 只读查询与失败现场（含 stdout/stderr spool 全文）；
- `jobs run/cancel` Job 执行与取消；
- `files roots/list/stat/read` 文件只读浏览（授权根探测、目录列表、元信息、文本读取）；
- `files write/mkdir/delete/move` 文件写操作（覆盖写、递归建目录、删除、移动，确认门由调用方负责）；
- `files download/upload` 文件传输（Storage Provider 直传链路，Server 只签名；download 校验 sha256）；
- `pi models/sessions/new/run/abort` Pi 子任务（在目标机驱动 Pi Agent 并取回回复）；
- `frp instances/mappings` FRP 状态查询与 `frp mapping create/delete` 完整映射写操作；
- `storage status` 存储后端状态只读查询；
- `terminal shells/list/close` Terminal 生命周期管理；
- `release upload/status/wait` 双平台发布上传、权威状态查询和 Server/Client 终态等待。

CLI 不直接控制目标机器，不持有 Server 业务状态机，也不在 Skill 中复制 HTTP。SDK 不读取 HOME、当前目录或 CLI 配置，只接受解析后的 `baseUrl` 和认证。

## 2. 配置模型

### 2.1 用户级注册表

固定路径：

```text
~/.vcpdeck/cli/config.json
```

结构版本为 `1`。示例：

```json
{
  "version": 1,
  "defaultEnvironment": "dev",
  "environments": {
    "dev": {
      "server": "http://127.0.0.1:3001",
      "auth": {
        "type": "bearer",
        "tokenEnv": "VCPDECK_DEV_TOKEN"
      }
    },
    "prod": {
      "server": "https://deck.example.com",
      "auth": {
        "type": "bearer",
        "tokenEnv": "VCPDECK_PROD_TOKEN"
      }
    }
  }
}
```

配置只保存凭据环境变量名，不保存密码、Token 或 Cookie。非 Windows 下 CLI 将目录和文件权限收紧为 `0700` / `0600`，写入使用同目录临时文件加 rename。

### 2.2 项目级选择器

固定文件名：

```text
.vcpdeck.json
```

唯一有效结构：

```json
{
  "version": 1,
  "environment": "dev"
}
```

项目文件是否提交 Git 由目标仓库自行决定；CLI 对已提交和未提交文件处理相同。它只能选择用户级已注册环境，不能定义 Server、认证或凭据变量。不同操作者需要在本机注册同名环境。

## 3. 环境选择与查找

业务命令按以下顺序选择环境：

1. `--env=<name>` 或 `--environment=<name>`；
2. `VCPDECK_ENVIRONMENT`；
3. 从 cwd 向上找到的最近 `.vcpdeck.json`；
4. 用户级 `defaultEnvironment`；
5. 都不存在时失败。

在 Git 仓库内查找最多到仓库根，不继承仓库外选择器。`env use --local` 优先更新最近已有选择器，否则写到 Git 根；非 Git 目录写到当前目录。

项目配置损坏、字段未知、版本不支持或引用不存在环境时立即失败，不回退到全局默认。`env current` 不要求凭据变量已经设置，只输出安全摘要；真正业务命令缺少凭据时失败。

## 4. 环境命令

推荐在 Frontend `/settings/tokens` 为 CLI 创建独立 Token，保存到本机环境变量后注册环境：

```text
vcpdeck env list
vcpdeck env show <name>
vcpdeck env current [--env=<name>]
vcpdeck env check [--env=<name>]
vcpdeck env add <name> --server=<url> --token-env=<VAR>
vcpdeck env add <name> --server=<url> --auth=password --username=<name> --password-env=<VAR>  # 兼容
vcpdeck env remove <name>
vcpdeck env use <name> --global|--local
```

提供 `--token-env` 时默认推断为 Bearer；显式 `--auth=bearer` 保持兼容。Token 是服务端 Credential，与 Identity 关联，CLI 与 SDK 可共用；个人资料修改用户名不会改变现有 Token 所代表的身份。Token 明文只在创建时显示一次，不进入 CLI 配置。

行为：

- `list`：列出环境安全摘要，`*` 标记全局默认；
- `show`：显示单个环境的 Server、认证引用和默认状态；
- `current`：按完整优先级输出最终环境、Server、来源和凭据变量名，不访问 Server；
- `check`：按相同优先级解析凭据，通过 SDK 调用 `/api/auth/me`，显示 Token/兼容密码对应的真实用户名、显示名和 admin 状态；
- `add`：严格校验并新增环境，不覆盖同名环境；`--token-env` 是新环境推荐入口；
- `remove`：删除环境；若它是全局默认，同时清除默认；不遍历项目文件；
- `use --global`：设置用户级默认；
- `use --local`：写入项目选择器。

Server 必须是 HTTP/HTTPS origin，不允许内嵌用户名密码、query、fragment 或业务路径。环境名最长 64，只允许字母、数字、点、下划线和连字符，且以字母或数字开头。

## 5. Release 命令

推荐使用当前环境并等待完整终态：

```bash
vcpdeck release upload \
  vcpdeck-x.y.z-win-x64.zip \
  vcpdeck-x.y.z-linux-x64.zip \
  --wait --timeout=1800
```

已有发布可独立查询或等待；临时环境覆盖继续使用 `--env=prod`：

```bash
vcpdeck release status x.y.z --env=prod
vcpdeck release wait x.y.z --env=prod --timeout=1800
```

保留的直连兼容模式：

```bash
vcpdeck release upload ... \
  --server=https://deck.example.com \
  --username=admin
```

直连密码优先来自 `VCPDECK_ADMIN_PASSWORD`；`--password` 仍兼容但会暴露在 Shell history/进程参数中，不推荐。`--server` 不能与 `--env` 同时使用，命名环境模式也不能混入 `--username` / `--password`。

Bearer 环境直接通过 SDK Authorization 上传，是命名环境的推荐认证；Password 环境先通过 SDK 登录取得进程内 Cookie，仅为已有配置兼容。CLI 上传前显示最终环境安全摘要，并校验两个 archive 版本一致、平台互补、计算声明 SHA-256。

每个平台先向 Server 协商上传模式：Alibaba 返回持久化会话与短期分片 URL，CLI 从本地范围读取并逐片直接 PUT Provider，403 时只经 Server 刷新该分片 URL；全部发送后再次核对实际发送字节 SHA，再通知 Server 完成登记。URL 不输出、不落盘；相同已登记构件跳过，相同未完成会话刷新后继续。Local 返回 `mode=server` 并使用 legacy raw stream；旧 Server 会话端点 404 时也回退 legacy raw，仅用于引导升级。

`status` 输出 Server、Release 和 Client 状态汇总；`wait`/`upload --wait` 仅重试安全 GET，容忍 Server 重启短暂断线，并要求 Server 版本匹配、Release `done`、所有已记录 Client 均 `done`；Release/Client 失败或超时均非零退出。离线 Client 不属于本次在线明细，后续注册补更；Client 阶段期间上线的旧版本 Client 也会在阶段末尾补偿扫描处理。

## 6. Clients 命令

当前只读：

```text
vcpdeck clients list [--env=<name>] [--json]
```

`list` 通过 SDK 请求 `/api/clients`，输出所有已注册 Client 的安全摘要（名称、hostname、OS、在线状态、CPU/内存使用率、版本）。在线状态与心跳由 Server 维护，CLI 不做本地推断，输出是查询时刻快照。

默认输出人类可读表格（在线优先、按名称稳定排序）并附总数/在线/离线汇总；`--json` 跳过环境摘要，stdout 为纯 JSON `ClientInfo[]`，供 Agent 和脚本解析。空列表输出明确提示而非报错。

本命令只支持命名环境（含 `--env` 临时覆盖），不提供 Release 那样的 `--server` 直连兼容模式。GET 幂等且无副作用，失败可直接重试。Server 端 `PATCH /api/clients/:id/name` 重命名尚未暴露为 CLI 命令。

## 7. Jobs 命令

```text
vcpdeck jobs list [--client=<name|id>] [--status=<status>] [--page=<n>] [--env=<name>] [--json]
vcpdeck jobs get <jobId> [--env=<name>] [--json]
vcpdeck jobs run <client> [--cwd=<dir>] [--timeout=<seconds>] [--wait] [--wait-timeout=<seconds>] [--env=<name>] [--json] -- <command...>
vcpdeck jobs cancel <jobId> [--env=<name>] [--json]
```

`list` 请求 `/api/jobs` 返回分页摘要；`--client` 接受机器名称或 ID，CLI 先查机器列表解析为 `clientId`；`--status` 校验合法值（JobStatus 全集加 `active` 聚合）。人类可读表格进行中优先，其余按创建时间倒序。

`get` 输出单条详情：错误码/消息、`result`（如 exec 的 `exitCode`）、时间线与操作者，并附输出 spool 全文（无则显示“无落盘输出”）。stdout/stderr 由 Server 在 Client 实时上报时旁路落盘到 `data/job-outputs/<jobId>.log`（锚定 `VCPDECK_APP_DIR`），完整保留不封顶、无自动清理；只在详情路径读取，不进入列表。输出正文视为敏感数据，仅在显式查询时返回。

`run` 创建 exec Job（写操作）：`--` 后的命令 token 以空格连接为 command 模式 payload 交由目标机 shell 执行（Windows 下 Client 自动 chcp 65001）；复杂命令应作为 `--` 后的单一参数传入，只有多个 token 中存在空白 token、原参数边界确实会丢失时 CLI 才警告。`--timeout` 是远端进程时限，CLI 接受秒并转换为 Job 顶层毫秒值；Client executor 自主管理计时、进程树清理和 `EXEC_TIMEOUT`/`EXEC_SIGNALLED` 终态。`--wait-timeout` 是 CLI 本地等待终态时限，默认 1800 秒。目标机必须在线。`--wait` 仅重试安全 GET 并容忍 Server 重启短暂不可达；失败终态非零退出并自动带出错误摘要与输出全文。`--json` 时 stdout 只包含最终 JSON，状态、警告和暂时网络错误写入 stderr。`cancel` 提交取消：pending 立即 `cancelled`，running 返回 `cancelling`，终态用 `get` 核对。`run` 非幂等，网络结果不明时先查询权威状态。script 模式与其他 Job 类型（file.*/frp 等）未暴露。

## 8. Files 命令

```text
vcpdeck files roots <client> [--env=<name>] [--json]
vcpdeck files list <client> <path> [--root=<dir>] [--env=<name>] [--json]
vcpdeck files stat <client> <path> [--root=<dir>] [--env=<name>] [--json]
vcpdeck files read <client> <path> [--root=<dir>] [--max-bytes=<n>] [--env=<name>] [--json]
vcpdeck files write <client> <path> [--root=<dir>] [--input=<file>] [--env=<name>] [--json]  # 覆盖写；缺省 --input 时读 stdin
vcpdeck files mkdir <client> <path> [--root=<dir>] [--env=<name>] [--json]  # 递归创建
vcpdeck files delete <client> <path> [--root=<dir>] [--recursive] [--env=<name>] [--json]  # 不可恢复
vcpdeck files move <client> <source> <destination> [--root=<dir>] [--overwrite] [--env=<name>] [--json]
vcpdeck files download <client> <remotePath> <localPath> [--root=<dir>] [--env=<name>] [--json]
vcpdeck files upload <client> <localPath> <remotePath> [--root=<dir>] [--overwrite] [--env=<name>] [--json]
```

文件操作通过创建 `file.*` Job 并等待终态实现。`rootDir` 是授权根：显式 `--root` 优先；缺省时经 `file.roots` 探测——唯一根直接使用，多根 fail closed 要求显式指定。`list` 目录优先按名称排序并附汇总；`read` 默认上限 256KB（`--max-bytes` 可调）；失败非零退出并带稳定错误码（`PATH_NOT_FOUND`/`PATH_CONFLICT` 等）。文件内容属敏感正文，仅在显式查询时返回。

写操作语义（由 Client 权威定义）：`write` 原子覆盖写（tmp+rename），内容来自 `--input` 或 stdin，不进命令行参数；`mkdir` 递归创建；`delete` 非递归遇非空目录报 `PATH_CONFLICT`，`--recursive` 解锁；`move` 目标存在默认拒绝，`--overwrite` 解锁。所有写操作执行前输出目标摘要（机器、授权根、路径、影响）；确认门由调用方负责，删除不可恢复且 `--recursive` 删除整个目录树必须单独强调。写操作非幂等，网络结果不明时先用只读命令核对权威状态。

已知非能力：无（本节能力已对齐 Server 文件域；Terminal/Pi 等其他域见对应章节）。传输链路：`download` 导出后经 Server 签发的短期下载令牌从 Storage 拉取并校验 sha256；`upload` 经 upload-sessions 协商后分片直传 Provider（403 仅刷新该分片 URL），完成后由 Client 从存储拉取导入。字节流不经过 Server——阿里云为 Provider 预签名 URL 直传，Local 后端经 Server 中转是无外部存储时的固有行为；签名 URL 不输出、不落盘、不进日志。传输非幂等，网络结果不明时先用只读命令核对两侧状态。

## 9. Pi 命令

```text
vcpdeck pi models <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]
vcpdeck pi sessions <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]
vcpdeck pi new <client> --cwd=<path> [--root=<dir>] [--env=<name>] [--json]
vcpdeck pi run <client> "提示词" --cwd=<path> [--session=<id>] [--root=<dir>] [--timeout=<seconds>] [--env=<name>] [--json]
vcpdeck pi attach <client> [--cwd=<path>] [--session=<id>] [--root=<dir>] [--env=<name>]
vcpdeck pi abort <client> --session=<id> [--env=<name>] [--json]
```

Pi 子任务通过 Server Pi 命名空间驱动目标机上的 Pi Agent（要求 `pi` capability）。运行循环：`prompt` 提交即返回 → 轮询 `agent.state` 至 `idle`（默认超时 600 秒）→ `context` 提取最后一条 assistant 消息的文本回复。注意 Server 的 `complete` 是中断标记而非等待，CLI 不使用它等待任务。授权根与文件域同规则。`waiting_for_extension_input` 时明确报错，需到 Frontend 处理扩展输入。

会话策略：`run` 缺省自动创建新会话（子任务隔离）；`--session` 复用既有会话（先 open 再 prompt）。`run/prompt/new` 非幂等——重复提交会重复执行子任务。已知限制：未暴露 fork/clone/navigate/compact/setModel/附件与图片输入。

`attach` 为交互式 REPL：readline 循环内每行作为提示词下发，等待 idle 后打印最后一条助手回复；`/abort`、`/state` 内建命令与 `/exit`/Ctrl+D 退出；单轮超时不退出 REPL，报告后可继续。

Windows Git Bash 会话注意：MSYS 会把 `/etc` 这类绝对路径参数改写为宿主安装路径（如 `C:/Program Files/Git/etc`），传 POSIX 风格路径时用 `MSYS_NO_PATHCONV=1` 或改用 Windows 形式。盘符根路径统一写正斜杠形式（`--root=D:/`）：`--root="D:\\"` 的尾反斜杠会转义闭引号，命令未执行即报 shell 引号错误；两种形式与授权根匹配等价，显式根由 Client 侧授权校验 fail closed。

## 10. Terminal 命令

```text
vcpdeck terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>] [--env=<name>] [--json]
vcpdeck terminal shells <client> [--env=<name>] [--json]
vcpdeck terminal list <client> [--status=<status>] [--env=<name>] [--json]
vcpdeck terminal close <client> <sessionId> [--env=<name>] [--json]
vcpdeck terminal attach <client> <sessionId> [--env=<name>]
```

终端全生命周期：`new` 创建会话（缺省选 isDefault shell，返回 sessionId 供 attach；写操作需确认门）；`shells` 探测目标机可用 Shell（pwsh/cmd/bash 等）；`list` 列出会话（sessionId/shell/status/创建者等，`--status` 为首页内本地过滤——SDK 列表为分页 API，无服务端 status 参数）；`close` 关闭会话（写操作需确认门，先取详情展示目标摘要再删除）。

重连操作权：operator 断开后 Server 保留 30 秒保护期，期间须携带 reconnectToken 重连才能恢复可输入模式，否则降级 viewer 只读。CLI 将令牌持久化在配置目录 `terminal-reconnect.json` 并于 attach 时自动回传，跨进程退出重进仍能恢复操作权；会话结束（远端 EXIT）后自动清除对应条目。

**边界**：交互式 PTY 的 TUI 直连由 `attach` 提供（/app 数据面，Bearer 握手认证，Ctrl+Q 退出，见 ADR-0020）；Frontend 浏览器终端仍走同数据面。已知非能力：CLI 不做会话审计查询。

## 11. FRP 与 Storage 命令

```text
vcpdeck frp instances [--page=<n>] [--env=<name>] [--json]
vcpdeck frp mappings [--client=<name|id>] [--page=<n>] [--env=<name>] [--json]
vcpdeck frp mapping create <client> --local-port=<port> [--type=tcp|http|https] [--local-ip=<host>] [--remote-port=<port>] [--domain=<domain>] [--name=<name>] [--instance=<id>] [--timeout=<seconds>] [--env=<name>] [--json]
vcpdeck frp mapping delete <mappingId> [--timeout=<seconds>] [--env=<name>] [--json]
vcpdeck storage status [--env=<name>] [--json]
```

只读查询：FRP 服务实例与映射状态（mappings 支持 `--client` 名称/ID 过滤）、当前激活的存储后端。分页遵循 PaginatedResult 惯例。

写操作：create 支持 TCP/HTTP/HTTPS，name 可省略；HTTP/HTTPS 要求 domain，TCP 可选 remotePort。create/delete 默认使用 30 秒 Dashboard 确认窗口，可用 `--timeout=1..300` 覆盖。CLI 只在 Client frpc 动作完成且 FRPS Dashboard 确认 proxy 出现/消失后零退出；不验证本地服务或公网可达。创建确认失败由 Server 自动回滚；回滚/删除失败保留 error 记录供查询和重试。当前若 Client 派发后完全不回报，Server 尚无 FRP Job 后台超时监控，CLI 会继续等待直到进程被用户中止；此时先用 mappings/jobs 核对，不盲目重试 create。

**确认门**：create 会把目标服务暴露到 FRPS，delete 会停止映射；调用方执行前必须展示环境/Server、Client、类型、本地端点、公网端口或域名、目标实例/名称（若指定）并取得明确确认。delete 还需展示 mappingId/name 与当前公网端点。

**安全红线**：实例信息含 authToken/dashboard 密码，CLI 输出仅做安全投影（名称/服务器/Dashboard 地址/是否默认），凭据绝不进入 stdout/stderr/日志。已知非能力仅剩实例创建/探活/设默认和 Storage 后端切换等写操作。

## 12. 安全与故障边界

- 用户级配置、项目配置和所有 CLI 参数都视为不可信输入并严格解析；
- 项目选择器不能改变 Server 或凭据引用，降低不可信仓库诱导泄密风险；
- 项目仍可选择本机已注册生产环境，因此副作用命令必须展示最终 Server 并取得确认；
- 输出不得包含密码、Token、Cookie、PSK、签名 URL 或原始敏感响应；
- 非幂等 POST 网络结果不明时先查询 Server 权威状态；Release 直传可按持久化会话恢复同 SHA/大小构件，但不同构件绝不覆盖；
- `env current` 的成功只表示配置可解析，不表示 Server 可达或凭据有效；`env check` 才验证 Server、凭据和实际身份；
- 环境删除不会修复项目引用，被删除环境的项目后续明确失败。

## 13. Skill 安装与当前项目 cwd

正式版本通过 Pi 用户级 Git package 安装：

```bash
pi install git:github.com/xuzhen97/VCPDeck@v0.6.24
```

Pi 克隆整个仓库，从 `skills/vcpdeck/SKILL.md` 发现 Skill；同目录 `vcpdeck.cjs` 是随 Tag 提交的 CLI 单文件构件。所有项目共享这一份安装。升级到新 Tag 时再次执行 `pi install ...@vX.Y.Z`，固定 Tag 不会由 `pi update --extensions` 自动推进。

Skill 调用 CLI 时从 `SKILL.md` 解析 `vcpdeck.cjs` 的绝对路径，但必须保留 Pi 当前项目为 cwd，不得切换到 Skill 安装目录。这样 `D:/a` 与 `D:/b` 可以分别命中各自最近的 `.vcpdeck.json`；用户级 `~/.vcpdeck/cli/config.json`、项目选择器和 Git package 安装互不覆盖。

`skills/vcpdeck/SKILL.md` 通过 CLI `env current` 取得环境权威摘要，不直接读取 JSON。后续每个 CLI 业务命令都复用同一环境解析结果，并在 Skill 中新增对应功能章节。Server/SDK 已有 API 不等于 CLI 命令已落地。

## 14. SDK/Shared Git 安装

SDK 不读取 CLI 的 HOME/cwd 配置，只接受调用方提供的 `baseUrl` 与认证。Node.js 24+、pnpm 10.26+ 的目标项目可从同一个稳定 Tag 直接安装 SDK 与 Shared：

```bash
pnpm \
  --allow-build="@vcpdeck/sdk" \
  --allow-build="@vcpdeck/shared" \
  add \
  "github:xuzhen97/VCPDeck#v0.6.24&path:/packages/sdk" \
  "github:xuzhen97/VCPDeck#v0.6.24&path:/packages/shared"
```

两个包必须锁定相同 Tag；pnpm 会把 Git commit 和构建许可记录到目标项目。Git 获取阶段运行包的 `prepare` 构建 `dist`，VCPDeck 仓库不提交 SDK/Shared `dist`。目标项目可分别导入 `@vcpdeck/sdk` 与 `@vcpdeck/shared`，再自行用 esbuild 等工具打成只依赖 Node.js 的 `.mjs`。

## 15. 测试与验收

当前单元/集成测试覆盖：

- 严格配置 parser 与未知字段/明文秘密拒绝；
- flag、环境变量、项目、全局默认优先级；
- 最近父目录、Git 根和 `--local` 写入位置；
- 项目损坏/未知环境 fail closed；
- 缺失凭据和直连冲突；
- 配置原子写入及 POSIX `0600`；
- `env add/list/show/current/check/use/remove`；
- `env check` 使用 Bearer 调用真实本地 HTTP Server 并显示 Token 身份，且不输出 Token；
- 命名 Bearer 环境通过真实本地 HTTP Server 上传两个平台构件；
- `release status/wait` 覆盖 Server 重启暂时不可达、成功终态、Release failed、Client failed 和超时；
- `clients list` 覆盖未知子命令/选项拒绝、别名冲突、Bearer 环境请求 `/api/clients` 且不泄露 Token、人类可读表格排序与汇总、`--json` 纯 JSON 输出和空列表提示；
- Server 端 output spool 覆盖流式追加、未知 Job 忽略、spool 读取 null 语义和 `jobs/:id/output` 端点；
- `jobs list/get` 覆盖用法/非法参数拒绝、名称解析为 clientId、分页表格排序、失败现场展示（错误摘要 + 输出全文）、`--json` 输出和未匹配机器报错；
- `jobs run/cancel` 覆盖 `--` 分隔符解析、payload 形状（command 模式/cwd/timeout）、创建摘要、`--wait` 成功与失败（失败自动带出现场）、取消状态展示和 `--json` 输出；
- `files roots/list/stat/read` 覆盖四子命令、授权根探测与多根 fail closed、稳定错误码转译、排序汇总和 `--json` 输出；
- `files write/mkdir/delete/move` 覆盖 payload 形状（content 来自 --input/递归/覆盖语义）、成功摘要、失败错误码转译和用法校验；
- `files download/upload` 覆盖导出+签名 URL 拉取+sha256 校验、sha 不一致删除半成品、分片直传与导入终态等待。
- `pi models/sessions/new/run/abort` 覆盖 cwdRef 推导、多根 fail closed、运行循环（prompt→轮询→回复提取）、既有会话 open 复用、扩展输入报错和中止；
- `frp/storage` 覆盖实例/映射表格与过滤、凭据字段脱敏、TCP/HTTP/HTTPS create、完整 Job 等待、delete、timeout、JSON 和后端状态输出；
- `terminal shells/list/close` 覆盖 shell 探测、会话列表 `--status` 本地过滤和关闭流程（先取详情再删除）；
- `completions bash/powershell` 覆盖命令树与环境名嵌入、配置缺失降级、未知类型拒绝和用法输出。

当前已知非能力：系统凭据存储、共享环境目录、交互式密码输入、Job 输出自动清理、exec script 模式，以及 FRP 实例写操作、Storage 后端切换、Client rename 与 Pi 高级会话操作（fork/clone/navigate/compact/setModel/附件）。

## 16. 全局安装与 Shell 补全

```bash
pnpm vcpdeck:link                              # 默认指向仓库构建产物 packages/cli/dist/index.js
node scripts/link-cli.cjs --target=<file>     # 改指其他入口（如 Skill 内 vcpdeck.cjs 单文件包）
```

向 Node 可执行文件所在目录写入两个垫片：`vcpdeck.cmd`（CMD/PowerShell）与无扩展名 `vcpdeck`（Git Bash/MSYS）；不经 npm/pnpm link，不触碰 pnpm store，入口文件更新即时生效。Git Bash/MSYS 垫片在启动 Windows `node.exe` 前设置 `MSYS2_ARG_CONV_EXCL='*'` 和 `MSYS_NO_PATHCONV=1`，防止 `/root/...` 等远端 POSIX 路径被宿主转换。直接执行 `node <vcpdeck.cjs>` 不经过该垫片，调用方仍需显式设置 `MSYS_NO_PATHCONV=1`。卸载即删除两个垫片。

环境切换用既有命令：`vcpdeck env use <name> --global|--local`，`vcpdeck env current` 核对。

Tab 补全：`vcpdeck completions bash` 输出追加到 `~/.bashrc` 后 source（或开新终端）；`vcpdeck completions powershell` 追加到 `$PROFILE`。补全覆盖顶层命令、各域子命令、常用 flag 与生成时嵌入的已配置环境名（`--env=` 候选，零网络请求）；环境增删后需重新生成。

其它机器远程一键安装（目标机器只需 Node 18+ 与外网）。**Linux / Git Bash**（单命令，含三次重试与正确退出码）：

```bash
node -e 'const u="https://raw.githubusercontent.com/xuzhen97/VCPDeck/main/scripts/install-cli.cjs";const g=()=>fetch(u).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.text()});(async()=>{let t;for(let i=0;i<3;i++){try{t=await g();break}catch(e){if(i===2)throw e;await new Promise(r=>setTimeout(r,1500))}}eval(t)})().catch(e=>{console.error("安装失败:",String(e));process.exit(1)})' -- --tag=v0.6.24
```

**Windows PowerShell** 单行形式（JS 全单引号 + 外层双引号，避开 PS 5.1 吞内嵌双引号的问题；两种 shell 的命令均含三次重试与正确退出码，勿混用/改写引号形式）：

```powershell
node -e "const u='https://raw.githubusercontent.com/xuzhen97/VCPDeck/main/scripts/install-cli.cjs';const g=()=>fetch(u).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text()});(async()=>{let t;for(let i=0;i<3;i++){try{t=await g();break}catch(e){if(i===2)throw e;await new Promise(r=>setTimeout(r,1500))}}eval(t)})().catch(e=>{console.error('安装失败:',String(e));process.exit(1)})" -- --tag=v0.6.24
```

脚本从 GitHub raw 下载随 tag 提交的单文件 CLI 包（skills/vcpdeck/vcpdeck.cjs，esbuild 打包零 npm 依赖）到 `~/.vcpdeck/bin`，生成双垫片并自动配置 PATH（Windows 写用户 PATH；POSIX 追加 ~/.bashrc），最后自验收 `--version`。推荐固定 `--tag=<版本>`；私有仓库 raw 需凭据，可改用 git clone 后 `node scripts/link-cli.cjs --target=skills/vcpdeck/vcpdeck.cjs`。
