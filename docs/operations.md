# VCPDeck 运维手册

> 状态：Current｜维护责任：运维/发布维护者｜最后核验：2026-08-15

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

## 3. 健康与就绪检查

| 检查 | 命令/位置 | 说明 |
| --- | --- | --- |
| HTTP 存活 | `GET /api/health` | 只证明 Nest HTTP 可响应 |
| 版本/更新状态 | `GET /api/status` | 返回 `serverVersion` 和 activeRelease |
| 登录与 DB | 登录 + `GET /api/auth/me` | 间接验证认证表和 Cookie |
| Client 在线 | `GET /api/clients` | 只列在线 Client |
| Storage | 配置页/签名上传下载小文件 | 验证 Provider 和正文路径 |
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
- FRP 映射是否异常 inactive；
- 最近 Job error/disconnected 是否增加；
- 是否有长期 `waiting_input/disconnected` 文件 Job、pending File 或目标目录中的 `.vcpdeck-tmp-*` 残留；
- Storage/阿里云授权是否过期或不可达。

### 每周

- 验证备份成功并抽查可读性；
- 清理过期 Release、旧 Launcher 版本和日志前确认保留策略；
- 检查长期 disconnected Job、interrupted Terminal 和 failed Client update；
- 复核 Credential、禁用身份、不再使用的 Token、过期/撤销 Session，以及是否仍有可用 admin；
- 在非生产目标机执行最小 Job、文件、终端和 Pi 回归。

### 每月或每次发布前

- 恢复演练；
- Launcher 正常更新与失败回退冒烟；
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
- 平台检查失败：核对 x64、受支持发行版、glibc/systemd，WSL/容器/ARM64/musl 不在范围；
- Node/PM2 下载失败：检查目标机公网、DNS、TLS 和代理；安装器先尝试国内源再回退官方源。若 Node 输出的探测表达式丢失 `"x64"` 或 `"."` 引号，说明 Server 仍在提供不兼容 Windows PowerShell 5.1 的旧引导脚本，应先更新 Server 后重跑固定命令；
- PM2 同名路径冲突：运行 `pm2 describe vcpdeck-client-launcher`，不要自动覆盖指向其他 app-dir 的进程；
- Launcher online 但验收超时：运行 `pm2 logs vcpdeck-client-launcher --lines 100`，核对 `launcher.env`、Server 可达性、PSK 和 `/client` WebSocket；
- 若修改 `launcher.env` 后仍连接旧 Server，运行 `pm2 env <id>` 核对 PM2 是否缓存了旧 `VCPDECK_SERVER`。Node `--env-file` 不覆盖已存在的同名进程环境；新版一键安装器会生成 `launcher-env.cjs` preload（先清除继承的 `VCPDECK_*`，再主动读取 `launcher.env`）并在 ecosystem 中设置 `filter_env: ["VCPDECK_"]`。旧安装应更新这些文件后，以 `pm2 delete vcpdeck-client-launcher`、`pm2 start <app-dir>/ecosystem.config.cjs --only vcpdeck-client-launcher`、`pm2 save` 重建进程，确保 `launcher.env` 是 Launcher 配置权威；
- 失败会保留 `~/.vcpdeck/client-install.json`、缓存、版本目录与 PM2 现场，修复后重跑同一固定命令。

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
- Alibaba export 分片 URL 过期时当前重新执行导出，不依赖尚未接通的续期路由；
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

### Storage 下载失效

- 签名或外部临时 URL 是否过期，过期时重新签发；
- `StorageBackendConfig.config` 中的 Local signSecret 是否丢失、被覆盖或轮换；
- Provider 是否已切换，旧对象是否仍在原后端；
- File 元数据和正文是否一致；
- 检查磁盘空间、权限和外部存储授权。

### Release 卡住或失败

- 查看 Release status/clientStates；
- 检查活跃 Job 是否阻塞 10 分钟 drain；
- 检查 Launcher `control.json`、Token、下载和解压权限；
- 核对构件 SHA-256、Node 约束和 `/api/status` 版本；
- Launcher 回退后确认数据库仍兼容旧 Server；
- Server drain 超时会令 Release 失败，但当前派发闸门不会自动解除；核对活跃 Job 后通常需要重启 Server 恢复派发；
- 已存在的目标版本目录会令 Launcher 跳过重新下载和 SHA 校验，异常时先删除不完整目录再 prepare；
- Windows zip 以外的 archive 全链路尚未验证，不得在唯一生产环境首次尝试。

### FRP 映射不可达或状态不一致

- probe FRPS 实例和 Dashboard；probe ok 不检查目标 local service 和完整代理链；
- 核对 serverAddr/port/token，确认未使用 `test-frp-token` 或 admin/admin；
- 检查 Client frpc 进程、stderr、`frpc-combined.toml` 权限和本地服务；
- 同一 Client 当前只有单个 frpc/lastFrpsInfo，不要跨多个 FrpsInstance 创建活动映射；
- 核对 remotePort/customDomain、防火墙和 DNS；不同实例的端口当前也按全局 DB 集合占用；
- `active` 表示 Client 本地 frpc 动作完成且 FRPS Dashboard 已确认 proxy 注册；它仍不证明本地服务、公网、DNS 或 TLS 可达，frpc 后续退出也不会立即更新 Server；
- Client 断线会令映射状态 inactive，但控制连接和 FRP 是独立链路，frpc 可能仍工作；
- Client 重启后 proxy 内存不会从 SQLite 自动恢复；
- 删除后仍可达时在 FRPS Dashboard 查孤儿 proxy；Server 当前先删 DB 再清理 Client；
- 详细边界见 [`design/frp.md`](./design/frp.md)。

## 9. 容量与清理

当前自动清理只每 10 分钟删除 `expiresAt` 已到期的 File。它不负责：

- Release 历史；
- Job 历史；
- Terminal 审计和长期 `starting/interrupted` 会话记录；
- Launcher 版本和 Node 缓存；
- 日志；
- 外部 Provider 孤儿对象；
- 目标机器上的 `.vcpdeck-tmp-*` 残留。

上线前应定义各类数据保留周期，并以可审计脚本清理。删除前先做元数据/正文一致性检查和备份；清理目标机器临时文件前还要确认没有仍在运行但 Server 已失联的 import/write Job。

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
