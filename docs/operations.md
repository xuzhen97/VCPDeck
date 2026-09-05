# VCPDeck 运维手册

> 状态：Current｜维护责任：运维/发布维护者｜最后核验：2026-09-05｜适用版本：`0.6.26` / 当前 `main`

## 1. 运行基线

运维对象包括：Frontend 静态站点、Server、SQLite、Storage、Client、Launcher、frpc/FRPS，以及远程 Pi/PTY 运行环境。

当前仅使用 stdout/stderr 日志，没有统一结构化日志、指标或 tracing。生产环境必须由 Launcher/服务管理器和日志采集器接管进程输出。

## 2. 启停

开发环境：

```bash
pnpm dev       # Server + Frontend
pnpm dev:all   # Server + Frontend + Client
```

构建后直接运行：

```bash
pnpm --filter @vcpdeck/server start
pnpm --filter @vcpdeck/client start
```

长期环境优先由 Launcher 启动 Server/Client；也可用 PM2 等外部进程管理器守护 Launcher 本身（只托管 Launcher，不托管业务进程，见 [`deployment.md`](./deployment.md) §4.6）；停止 Launcher 前应确认没有进行中的 Release、Job、Terminal 或 Pi run。

### Windows Client 重启

Windows 一键安装器可能把 PM2 安装到当前用户的私有目录，因此新开的 PowerShell 中直接执行 `pm2` 可能提示“找不到命令”。必须使用**安装 Client 的同一个 Windows 用户**，并只重启 PM2 管理的 Launcher：

```powershell
# 若 pm2.cmd 已在 PATH 中，直接执行：
pm2 restart vcpdeck-client-launcher
```

如果 `pm2` 不在 PATH，使用安装器默认的私有 PM2 和 Node.js：

```powershell
$Pm2Cli = "$HOME\.vcpdeck\tools\pm2\node_modules\pm2\bin\pm2"

# 优先使用安装器可能下载的用户私有 Node.js；没有时再使用 PATH 中的 Node.js
$Node = (Get-ChildItem "$HOME\.vcpdeck\runtime\node\node-*\node.exe" `
  -File -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1).FullName
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $Node -or -not (Test-Path $Node)) { throw "找不到 Node.js" }
if (-not (Test-Path $Pm2Cli)) { throw "找不到私有 PM2：$Pm2Cli" }

& $Node $Pm2Cli restart vcpdeck-client-launcher
& $Node $Pm2Cli status
```

电脑重启后若 PM2 进程列表没有恢复，可执行安装器生成的恢复脚本；它内含安装时使用的 Node.js 和 PM2 的绝对路径，不依赖 PATH：

```powershell
& "$HOME\.vcpdeck\launcher-client\pm2-resurrect.cmd"
```

然后再次执行上面的 `restart` 命令。排查日志时：

```powershell
& $Node $Pm2Cli logs vcpdeck-client-launcher --lines 100
```

若 `pm2-resurrect.cmd` 和私有 PM2 路径都不存在，说明安装未完整保留 PM2 现场；不要删除 `~/.vcpdeck/client-id`，应重跑 `/releases` 页面生成的同一条 Client 安装命令。

### Linux A2 Client 运维（systemd）

- **无人值守开机自启**：`vcpdeck-client.service` 为 `enabled` + `Restart=always`，开机由 systemd 拉起，无需用户登录/linger。验证链：`systemctl status vcpdeck-client.service`（active）→ Server 控制面 `online=true` 且版本/能力齐备。
- **迁移（M1）**：存量 PM2 安装用 `--migrate` 迁到 A2（保留 `client-id`、无关 PM2 应用）。两阶段：verify-only 验证身份/版本/特权 → 原子切稳态；稳态全能力注册为回滚边界，之前失败自动恢复旧 PM2，之后记 `manual-recovery-required`。迁移前若源指向不同 Server、`client-id` 非法、PM2 未 online 或有进行中 Release，安装器直接拒绝。
- **卸载**：`uninstall-client-linux.cjs` 停服务 → 删单元/sudoers/env/opt/var（含身份）→ `daemon-reload` → 删账户 → 校验消失；`--purge` 额外删 Release 缓存与迁移状态。非 systemd 单元会被拒绝（走 PM2 卸载）。
- **root 等价风险**：该 Client 可执行任意 root 命令；Job/Terminal/Pi 操作前确认在可信运维域内（Server 仅记录控制面/Job/Session 审计，见 [`security.md`](./security.md) §4.5）。

## 3. 健康与就绪检查

| 检查 | 命令/位置 | 说明 |
| --- | --- | --- |
| HTTP 存活 | `GET /api/health` | 只证明 Nest HTTP 可响应 |
| 版本/更新状态 | `GET /api/status` | 返回 `serverVersion` 和 activeRelease |
| 登录与 DB | 登录 + `GET /api/auth/me` | 间接验证认证表和 Cookie |
| Client 在线 | `GET /api/clients` | 只列在线 Client |
| Storage | 配置页/签名上传下载小文件、公开分享抽查 | 验证 Provider、正文路径和公开分享状态 |
| FRPS | 实例 probe + Dashboard | 验证 Dashboard/连接配置 |
| Launcher | `control.json`、进程和日志 | 检查守护与本机控制通道 |
| Terminal/Pi | capability + 小型真实操作 | 浅健康不会验证这些能力 |

建议每 1–5 分钟外部探测 `/api/health`，每 5–15 分钟执行带认证的深检查；不要频繁创建真实远程 Job 作为存活探针。

## 4. 日志与敏感信息

收集：

- Server stdout/stderr；
- Client stdout/stderr；
- Launcher stdout/stderr；
- frpc/frps 日志；
- 反向代理访问/错误日志。

不得采集或输出：密码、Cookie、Bearer Token、PSK、FRP Token、Launcher Token、签名 URL、阿里云 Token、完整 command/script、敏感路径、终端正文和文件内容。

当前日志中仍有较自由的 `console.*`，接入集中日志前应进行一次脱敏审查。对外提供日志时先二次清洗。

## 5. 日常巡检

### 每日

- Server/Launcher 进程是否稳定，是否反复重启；
- `/api/status` 是否存在长时间 activeRelease；
- Client 在线率、最后心跳、版本和 capability；
- 磁盘空间：数据库、Storage、Release、Launcher apps；
- FRP 映射是否异常 inactive 或长期 `reconciling`（正常应在 Client 重连后数分钟内收敛为 active/inactive）；
- 最近 Job error/disconnected 是否增加；
- 是否有长期 `waiting_input/disconnected` 文件 Job、pending File 或目标目录中的 `.vcpdeck-tmp-*` 残留；
- Storage/阿里云授权是否过期或不可达。

### 每周

- 验证备份成功并抽查可读性；
- 在预发布环境查看 Release 清理预览，确认候选、Provider 状态和预计回收空间；
- 不直接手工删除 Release archive 或 Launcher 版本目录；按固定保留策略执行清理，异常时先保留现场；
- 检查长期 disconnected Job、interrupted Terminal 和 failed Client update；
- 复核 Credential、禁用身份、不再使用的 Token、过期/撤销 Session，以及是否仍有可用 admin；
- 在非生产目标机执行最小 Job、文件、终端和 Pi 回归。

### 每月或每次发布前

- 恢复演练；
- Launcher 正常更新与失败回退冒烟；
- 生产发布前完成 SQLite、Storage、Release archive 和 Launcher `apps/` 备份；先在预发布环境执行 cleanup preview，确认无误后再允许生产启动/发布触发自动清理；
- 依赖和 CVE 检查；
- PSK/Token/外部存储凭据轮换评估；
- 文档与当前环境变量、端口、目录核对。

## 6. 备份

备份集至少包括：

1. SQLite 数据库文件；
2. Local Storage 目录（若启用）；
3. Release 目录；
4. Server 配置与反向代理配置（秘密应使用受控秘密备份）；
5. Launcher state/current/apps（至少保留当前和上一版本）；
6. FRPS 独立配置；
7. 远程 Pi Session 如需业务恢复，应由各目标机器单独备份。

推荐一致性顺序：

1. 暂停写操作或停止 Server；
2. 复制 SQLite 及必要 sidecar 文件；
3. 同一备份批次复制 Storage 和 Release；SQLite 中的 Job 还可能包含 command/script、`file.writeText` 输入和 `file.readText` 结果，按文件正文同等级保护；
4. 记录应用版本、schema/migration 版本和校验和；
5. 加密并发送到独立故障域；
6. 重启并检查健康。

项目当前没有在线备份命令。不要在高写入期间直接复制 SQLite 后声称得到一致备份。

## 7. 恢复

1. 停止 Server 与 Launcher 自动拉起；
2. 保留当前故障数据副本；
3. 恢复与应用版本匹配的 SQLite、Storage、Release；
4. 恢复配置和文件权限；
5. 启动对应 Server 版本；
6. 检查 health/status、登录、Client 列表和 Storage；
7. 启动 Client，观察重连对账；
8. 处理恢复点之后形成的重复/失联 Job；
9. 记录恢复点目标、恢复时间目标和数据差异。

恢复演练必须验证文件正文与 File 元数据一致，不能只验证数据库能打开。

## 8. 常见故障

### Server 无法首次启动或无法管理身份

- 首次启动检查 `VCPDECK_ADMIN_PASSWORD`；
- Bootstrap 只在数据库没有任何 `isAdmin=true` 记录时运行，disabled admin 也会阻止新 admin 自动创建；
- 当前最后 admin 可自禁用且没有业务 API 创建另一个 admin；锁死时先保全数据库并通过受控维护流程恢复，不删除历史 Identity 或重置整个库；
- 修改密码不撤销现有 Session/Token，Credential 泄漏需另行 revoke，必要时断开 `/app` Socket；
- 检查 `DATABASE_URL` 相对于当前工作目录的解析；
- 检查数据库目录写权限和 Prisma generate；
- 检查 3001 端口占用。

### CLI 环境错误或目标环境不符

- 先运行 `vcpdeck env current` 核对环境名、Server 和来源，再运行 `vcpdeck env check` 验证 Server、凭据和实际身份；
- 检查选择优先级：`--env`、`VCPDECK_ENVIRONMENT`、最近项目 `.vcpdeck.json`、全局默认；
- 项目配置损坏或引用已删除环境时 CLI 会 fail closed，不会回退；修正项目文件或重新注册同名环境；
- 凭据变量缺失时只补设对应环境变量，不把 Token/密码写入用户级或项目配置；
- `env remove` 不遍历项目选择器，删除前应自行确认哪些项目引用该名称；
- 高风险操作前若环境/Server 与预期不符，立即停止，不使用 `--server` 绕过后继续执行。

### Release 上传失败或未登记

- 先运行 `vcpdeck release status <version>` 查询权威状态；非幂等 legacy raw POST 网络结果不明时不要盲目重复；
- Alibaba 后端正常流程会先创建 `/api/releases/uploads` 会话，再由 CLI 直接 PUT Provider 分片；Server 日志和入站流量不应出现完整 zip；
- `RELEASE_DIRECT_UPLOAD_REQUIRED` 表示当前 Alibaba 后端拒绝 legacy raw 上传，必须使用 `0.2.1+` CLI，不能通过延长 Server 超时或代理中转绕过；
- `RELEASE_UPLOAD_PROVIDER_FAILED`：检查阿里云 OAuth、配额、文件夹权限和网络；响应只给安全摘要，详细外部响应不得进入普通日志；
- 403 分片 URL 由 CLI 自动经 Server 刷新；重跑相同版本/平台/SHA/大小会恢复持久化会话并换取全部新 URL；
- `RELEASE_UPLOAD_SESSION_EXPIRED`：重新运行同一命令创建新 Provider 会话；过期对象删除是尽力而为，应检查阿里云中转目录孤儿；
- `RELEASE_UPLOAD_SESSION_CONFLICT` 或 `RELEASE_ARCHIVE_EXISTS`：核对本地构件 SHA/大小，不覆盖同版本不同构件，修复后使用新版本号；
- 从旧 Server 首次升级且公网 legacy 上传超时：将构件和 CLI 用 `rsync/scp` 复制到 Server 主机，从回环地址执行一次引导；升级后恢复 Alibaba 直传。

### Client 一键安装失败

- `CLIENT_INSTALLER_DISABLED`：回 `/releases` 启用入口；不会影响已有 Client；
- `CLIENT_INSTALLER_RELEASE_NOT_READY`：确认当前 Server 版本存在状态为 `done` 的同版本 Release；
- `CLIENT_INSTALLER_ARCHIVE_MISSING`：补齐目标平台 Release archive；
- 平台检查失败：核对 x64、受支持发行版、glibc/systemd，WSL/容器/ARM64/musl 不在范围；当前仅额外支持 Bazzite x64，不自动支持其他 Fedora Atomic 发行版；
- Bazzite 基础依赖失败：安装器只对缺失的 `curl`、`unzip`、`tar`、`xz` 或 CA 证书调用 `sudo rpm-ostree`，不应改用 `dnf install`；先执行 `rpm-ostree status` 检查 pending deployment、网络和 sudo 权限。若提示依赖将在重启后生效，手工重启 Bazzite 后重跑同一条安装命令；安装器不会自动重启。A2 安装完成后运行时位于 `/opt/vcpdeck/client/node`，由 `vcpdeck-client.service` 管理；
- Node/PM2 下载失败：Windows 或旧 Linux PM2 安装时检查目标机公网、DNS、TLS 和代理；安装器先尝试国内源再回退官方源。Linux A2 不使用 PM2，Node 运行时直接安装到 `/opt/vcpdeck/client/node`。若旧 PM2 安装错误包含 `env: “node”: 没有那个文件或目录`，说明 Server 仍在提供未把私有 Node `bin` 注入 npm 子进程 `PATH` 的旧安装器，应先更新 Server 后重跑同一固定命令。若 Node 输出的探测表达式丢失 `"x64"` 或 `"."` 引号，则是旧版 Windows PowerShell 5.1 引导脚本，同样先更新 Server；
- 旧 PM2 Launcher 显示 `online`，但 120 秒后仍报 `registered:false`：检查 Launcher error log；若反复出现 `The operation was aborted due to timeout` 且系统没有 Node，说明旧 ecosystem 没有把私有 Node `bin` 注入 Launcher `PATH`，Launcher 正在尝试下载第二份运行时。更新 Server 后重跑同一固定命令；紧急恢复可将私有 Node `bin` 前置到 ecosystem 的 `env.PATH`，以 `--update-env` 重启 Launcher 并 `pm2 save`。A2 systemd 部署则检查 `systemctl status vcpdeck-client.service`、`journalctl -u vcpdeck-client.service` 和 `/etc/vcpdeck/client.env` 权限；
- Linux 安装末尾出现 `TMP_DIR: 未绑定的变量`：这是旧 bootstrap 的 EXIT trap 在函数返回后展开局部变量所致，不会删除已安装文件；更新 Server 后重跑同一固定命令完成幂等修复；
- PM2 同名路径冲突：运行 `pm2 describe vcpdeck-client-launcher`，不要自动覆盖指向其他 app-dir 的进程；
- Launcher online 但验收超时：运行 `pm2 logs vcpdeck-client-launcher --lines 100`，核对 `launcher.env`、Server 可达性、PSK 和 `/client` WebSocket；
- 若修改 `launcher.env` 后仍连接旧 Server，运行 `pm2 env <id>` 核对 PM2 是否缓存了旧 `VCPDECK_SERVER`。Node `--env-file` 不覆盖已存在的同名进程环境；新版一键安装器会生成 `launcher-env.cjs` preload（先清除继承的 `VCPDECK_*`，再主动读取 `launcher.env`）并在 ecosystem 中设置 `filter_env: ["VCPDECK_"]`。旧安装应更新这些文件后，以 `pm2 delete vcpdeck-client-launcher`、`pm2 start <app-dir>/ecosystem.config.cjs --only vcpdeck-client-launcher`、`pm2 save` 重建进程，确保 `launcher.env` 是 Launcher 配置权威；
- 失败会保留 `~/.vcpdeck/client-install.json`、缓存、版本目录与 PM2 现场，修复后重跑同一固定命令；
- `/releases` 的 Client 一键卸载命令只读取该安装状态，删除对应 `vcpdeck-client-launcher`、Client 目录和约定的自启配置，不删除 `~/.vcpdeck/client-id`、通用缓存、其他 PM2 应用或 Server 数据；找不到安装状态或同名 PM2 进程指向其他目录时会拒绝操作。

### Client PM2 进程丢失

- 现象：`pm2 list` 为空且 `pm2 describe vcpdeck-client-launcher` 不存在，但 `~/.pm2/dump.pm2` 存在——PM2 守护被清空而恢复快照仍在；
- 恢复：`pm2 resurrect` 后 `pm2 list` 确认进程回 online，再到驾驶台或 `vcpdeck clients list` 核对在线；
- 起不来时 `pm2 logs vcpdeck-client-launcher --lines 100` 核对 `launcher.env`、Server 可达性与 PSK；
- 自启单元/计划任务也被删时，Linux 重跑 `pm2 startup` 按提示注册 systemd；Windows 重跑一键安装固定命令重建登录触发任务；
- 全程不得动 `~/.vcpdeck/client-id`，否则会以新身份注册成新机器。

### Client 无法连接

- 核对 `VCPDECK_SERVER` 和网络/DNS/TLS；
- 核对双方实际使用的 `VCPDECK_PSK`；
- 注意示例中的 `VCPDECK_CLIENT_PSK` 当前不生效；
- 查看 `/client` handshake 和 CORS/反向代理 WebSocket；
- 保留 `~/.vcpdeck/client-id`，避免误注册成新机器。

### Job 长期 pending

- Client 是否在线且支持 capability；
- 同 Client 是否已有 3 个通用 running Job；
- Server 是否处于 Release drain；
- 前序 Job 终局是否触发下一次调度；
- 不要直接改 DB 状态，先保留现场并查明调度链路。

### Job 显示 disconnected

- 这是非终态；检查 Client 是否仍运行并等待自动重连；
- 重连后观察 status report 对账；
- 若 Client 进程已丢失本地任务，按安全错误结束，不伪造成功；
- 取消请求可能需要重连后才能应用。

### 远程文件 Job 结果不明

- 先区分轻量文件 Job、Browser 上传阶段、Client import 和 Client export；
- running 文件 Job 的取消/timeout 当前不会可靠中止 fs、HTTP 或分片操作，Socket 断线后操作也可能继续；
- Client 重连 status report 当前不保证包含文件 handler/transfer，`disconnected` 可能无法自动收敛；
- 若文件 Job 显示 running 但 Client 没有活动证据，检查其前一个 Job 是否刚进入 error；当前 error 分支可能已推进 scheduler 状态却没有真正发送下一条 dispatch；
- write/move/delete/import 不要盲目重试，先核对目标路径、`.vcpdeck-tmp-*`、Job、File 和 Provider 对象；
- import 当前只验证字节数，不验证 SHA-256；Alibaba export 也没有 Local 同等级的 SHA-256；
- `rootDir` 当前未绑定认证 root，处理疑似越界时先隔离 Client 并保全路径和 Job 元数据，不继续执行破坏性操作；
- Alibaba export 分片 URL 过期返回 403 时，Client 通过 `client-export-sessions/:jobId/part-urls` 续期指定分片；连续失败则导出失败并重新创建会话；
- 详细实现偏移和恢复边界见 [`design/remote-files.md`](./design/remote-files.md)。

### Terminal 无输出、长期 starting 或要求重同步

- 检查 `terminal.pty` capability、node-pty、Client 在线状态和 `/app` WebSocket 认证/代理；
- 不要只看 SQLite `active/detached/expiresAt` 判断 PTY；当前这些字段不是完整实时镜像；
- 重新 attach 获取 snapshot；慢消费者会触发 resync，但持续 resync 也可能来自 snapshot/output seq 偏移或 Server 上游 gap；
- Browser 在线但 Client 断线时，Server 当前不一定立即广播 Terminal 断线，input/snapshot 可能经超时才暴露失败；
- 长期 `starting` 可能是创建 request timeout；同时核对 Client 是否实际存在孤儿 PTY，不要直接重复创建；
- 创建后从未 attach 的 Session 当前可能没有启动 Client 30 分钟 TTL；重新 attach 后再次最后离开也可能因 Server detach 标记未复位而不重启 TTL；核对目标机 Shell 进程；
- Client 本地 expired 不会主动上报 Server，DB 可能保持非终态并在后续对账时变为 interrupted；
- Server 重启后旧 reconnect token 不保证恢复 operator，重新 attach 并确认控制权；
- Client 重启后 PTY 应标记 interrupted，不能由 Server 恢复或伪造进程；
- 关闭/过期后的进程树清理是尽力而为，检查 daemonized/脱离 PTY 的残留进程；
- 详细恢复边界见 [`design/remote-terminal.md`](./design/remote-terminal.md)。

### Pi 不可用

- 检查 `agent.pi` capabilityDetails；
- Node 是否至少 22.19.0，Bash、Pi agentDir、锁定 SDK、模型和认证是否满足探测；
- `PI_SESSION_JOB_PROTOCOL_VERSION` 是否匹配；
- 检查目标项目路径是否在允许的 file roots，realpath 后是否仍在 root 内；
- `PI_STATE_PENDING` 表示新 Socket generation 尚未完成权威对账，应等待而不是新建 Run；
- `PI_CLIENT_RESTARTED` 表示原活动 Run 不可恢复，不能伪造成功；Session JSONL 仍存在时可处理 error 后重新打开；
- Browser/SSE 断线后重新读取 Session detail/context 和 Agent state，不等待事件补传；
- Server 重启后等待 Client PI_STATE 重建项目锁和活动 Run；
- Session 正文不在 SQLite，恢复历史需要目标机器 Pi Session 备份。

### Storage 分享与下载失效

- 公开分享地址是长期 bearer capability，丢失或泄露时不能从列表恢复 Token；泄露后立即撤销对应分享并按需创建新分享；
- `GET /api/public/storage-shares/<token>` 不需要 Cookie/Bearer；未知 Token 应为 404，撤销/底层确认失效应为 410，Provider 切换或临时故障应为 503/502 且不自动失效；
- active 分享会阻止 File 显式删除和到期清理；先调用认证的 `DELETE /api/storage/shares/:id` 撤销，再删除 File；File 删除后分享审计保留但状态为 invalid；
- 反向代理访问日志必须脱敏公开路径 Token，不记录 Provider URL、Storage key 或原始外部错误；
- 图片和普通文件都应先返回 302：Alibaba 等外部 Provider 的 Location 指向外部存储，正文不经过 Server；Local 的 Location 指向 Server 签名下载端点。图片能否内联及其 MIME、安全头由 Provider 响应决定。

- 签名或外部临时 URL 是否过期，过期时重新签发；
- `StorageBackendConfig.config` 中的 Local signSecret 是否丢失、被覆盖或轮换；
- Provider 是否已切换，旧对象是否仍在原后端；
- File 元数据和正文是否一致；
- 检查磁盘空间、权限和外部存储授权；公开分享若仅因 Provider 切换暂时不可用，不要撤销，切回原 Provider 后重试。

- `file.export` 以 `Export session failed: HTTP 401` 立即失败时，核对 Server/Client 的 `VCPDECK_PSK` 是否一致，并确认两端均已升级到包含 `client-export-sessions*` 认证的版本；不得把 PSK 写入日志或工单。

### Release 卡住或失败

- 查看 Release status/clientStates；
- 检查活跃 Job 是否阻塞 10 分钟 drain；
- 检查 Launcher `control.json`、Token、下载和解压权限；
- 核对构件 SHA-256、Node 约束和 `/api/status` 版本；
- Launcher 回退后确认数据库仍兼容旧 Server；
- Server drain 超时会令 Release 失败，但当前派发闸门不会自动解除；核对活跃 Job 后通常需要重启 Server 恢复派发；
- Launcher 仅在目标版本的 manifest、版本号和当前 artifact 业务入口均完整时跳过 prepare；仅含 Launcher payload 或其他不完整目录会先清理，再重新下载、校验和解压；
- Windows x64 与 Linux x64 zip 已完成 Server→多 Client 生产发布验收；其他平台或 archive 格式仍不得在唯一生产环境首次尝试。

### FRP 映射不可达或状态不一致

- probe FRPS 实例和 Dashboard；probe ok 不检查目标 local service 和完整代理链；
- 核对 serverAddr/port/token，确认未使用 `test-frp-token` 或 admin/admin；
- 检查 Client frpc 进程、stderr、`frpc-combined.toml` 权限和本地服务；
- 同一 Client 当前只有单个 frpc/lastFrpsInfo，不要跨多个 FrpsInstance 创建活动映射；
- 核对 remotePort/customDomain、防火墙和 DNS；不同实例的端口当前也按全局 DB 集合占用；
- `active` 表示 Client 本地 frpc 动作完成且 FRPS Dashboard 已确认 proxy 注册；它仍不证明本地服务、公网、DNS 或 TLS 可达；
- frpc 进程崩溃由 Client 侧有限自愈（立即/5s/30s 三次）覆盖，Client 重启后进程 PID 不变；重试耗尽会置 `failed` 且 mapping 回 `inactive + FRP_RECONCILE_FAILED`，需要人工检查 frpc/frps 后触发恢复（重启 Client 或删除重建）；
- Client 断线会令映射状态 inactive，但控制连接和 FRP 是独立链路，frpc 可能仍工作；Client 重连后 Server 自动 reconcile 把期望集合恢复回 active（需 FRPS Dashboard 可达且确认通过）；
- mapping 长期 `reconciling`：确认 Client 在线（在线应在下一次上报或 5s/30s 槽位内收敛）；Client 离线则等重连；Server 刚重启时遗留 reconciling 已由启动恢复归位 inactive；
- FRPS/Dashboard 不可达时重试耗尽统一表现为 `inactive + FRP_RECONCILE_FAILED`，不能仅凭该状态区分 frps 故障与凭据故障；恢复 FRPS 后重启 Client 或等待重连触发 reconcile；
- 删除后仍可达时在 FRPS Dashboard 查孤儿 proxy；Server 当前先删 DB 再清理 Client；Client 快照中的孤儿映射（Server 已删除但 FRPS 仍注册）会保留并上报，不自动导入/删除；
- 自动恢复只覆盖控制通道在线的场景；Client 的 PM2/Launcher 进程丢失或机器离线仍需按本节“Client PM2 进程丢失/无法连接”独立恢复，不依赖 FRP reconcile；
- 详细边界见 [`design/frp.md`](./design/frp.md)。

## 9. Release 与容量清理

### 9.1 固定策略和入口

Server 会在启动时、每次 Release 完成后以及每日 24 小时兜底扫描时，按固定策略清理 Release archive 正文和上传会话。策略不可配置、不能指定版本、不能强制删除：

- 最近 3 个成功 Release 始终保留；成功 Release 至少保留 30 天；
- `failed` 和不完整 `uploaded` Release 至少保留 30 天；
- 未完成直传会话在 `expiresAt` 后再宽限 24 小时；`provider_completed` 不按 pending 会话过期规则删除；
- 当前 Server、活动 Release 和最新有效安装/补更目标受保护；Release 行、SHA-256、文件名、大小和 `clientStates` 长期保留；
- Launcher 在每台机器独立保留 current、最近 2 个成功历史版本、previous 及 prepare/apply 目标，不由 Server 远程清理。

Frontend `/releases` 的“存储清理”卡片只提供固定策略 preview 和确认后的 run。等价认证 REST 接口为：

```text
GET  /api/releases/cleanup/preview
POST /api/releases/cleanup/run
```

Preview 只读，不会 claim 或删除对象；run 会重新计算候选并执行，不能使用旧预览强行删除。清理进行中再次 run 返回 `RELEASE_CLEANUP_BUSY`（HTTP 409），等待当前任务结束后重新 preview。

### 9.2 archive 状态、Provider 和恢复

Release archive 状态为：

- `available`：正文可下载，可参与编排、安装和补更；
- `deleting`：已被清理任务 claim，停止新的下载/目标选择；Server 重启后会继续处理；
- `cleaned`：正文已删除或确认不存在，只能查看审计字段，不能下载、编排或安装。

清理先以 CAS 将 archive 置为 `deleting`，再删除 Local 文件或当前 Provider 对象，最后写入 `cleaned`。删除失败恢复为 `available`，结果中的 `retryable` 和安全 issue code 用于后续重试。遗留 `deleting` 会在下一次启动/定时/手动 run 中恢复；不要直接修改数据库 JSON。Provider 后端不匹配、授权失效或不可达时标记 `provider_unavailable`，不会猜测 key、切换后端删除或伪造 `cleaned`；恢复原 Provider 配置后重新 run。

上传会话清理严格先删 Provider 临时对象，再删数据库会话。Provider 删除失败时保留会话和可重试现场；已完成会话只有对应 archive 已 `cleaned` 后才删除元数据。清理结果、日志和工单不得包含 Provider key、签名 URL、Token 或外部原始响应。

Launcher 的 `apps/retention.json` 损坏时会停用本机自动删除；保留所有版本目录并人工恢复可信状态，不按目录时间或猜测顺序批量删除。Launcher 清理失败只影响空间回收，不影响已健康运行的 current 或自动回退。

### 9.3 其他容量对象

File 到期对象仍由现有每 10 分钟任务处理。Release 清理不负责：

- Job 历史；
- Terminal 审计和长期 `starting/interrupted` 会话记录；
- Launcher Node 缓存；
- 日志；
- 目标机器上的 `.vcpdeck-tmp-*` 残留；
- Storage Share 默认长期有效，需定期检查 active 分享；撤销后再删除对应 File，不能绕过 FileService 删除受保护对象。

删除前先做元数据/正文一致性检查和备份；清理目标机器临时文件前还要确认没有仍在运行但 Server 已失联的 import/write Job。

## 10. 事件响应

发生安全或数据事件时：

1. 隔离网络或停止相关 Client/Server；
2. 保留日志、数据库和 Launcher 状态副本；
3. 撤销 Session/Credential，轮换 PSK、FRP、Storage/OAuth 凭据；
4. 检查 Job、TerminalAudit、Release 和代理日志；
5. 从可信构件恢复；
6. 验证所有 Client 版本和身份；
7. 编写事后报告和 ADR/修复计划。

不要在证据保全前执行大规模清理或覆盖式重装。
