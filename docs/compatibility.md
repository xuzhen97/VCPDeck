# VCPDeck 兼容性与升级策略

> 状态：Current｜维护责任：发布维护者｜最后核验：2026-09-01｜适用版本：`0.6.15` / 当前 `main`

## 1. 当前结论

VCPDeck 尚未发布稳定兼容承诺。Server、Client、Shared、SDK、CLI 与 Skill 在正式发布中使用同一个 `x.y.z` 版本，推荐始终整套升级。`pnpm release --version=x.y.z` 会保留该版本到 Shared 源码、三个 package manifest 和 Skill CLI 构件，提交后再创建同版本 Git Tag；普通开发构建可能仍显示最近准备的发布版本，不能据此判断工作区提交是否已经正式发布。

## 2. 兼容维度

| 维度 | 当前机制 | 保证 |
| --- | --- | --- |
| Server ↔ Client 通用协议 | Shared 事件与 DTO；Client 上报版本/capability | 没有独立通用协议版本；同版本最安全 |
| Server ↔ Client Pi | `PI_SESSION_JOB_PROTOCOL_VERSION=1`；capabilityDetails 含 SDK/Node/shell 安全摘要 | 必须精确匹配，不匹配明确拒绝 Pi |
| Server ↔ Client Terminal | `terminal.pty` capabilityDetails + Shared 严格运行时解析 | 无独立数字版本；缺能力时拒绝，seq/generation/state 变化需整套同版本发布 |
| Server ↔ Frontend | REST/Socket.IO/SSE | Frontend 应与 Server 同一发布版本部署 |
| SDK ↔ Server | REST DTO 和错误 | SDK/Shared 可从同一 Git Tag 子目录安装；只支持与 Server 同版本的标准组合 |
| CLI/Skill | 同 Tag 的 `SKILL.md` + `vcpdeck.cjs` | Pi 用户级 Git package 安装；升级必须显式切换 Tag；`0.2.1+` CLI 支持 Alibaba Release 分片直传 |
| CLI 配置 | 用户级/项目级 JSON `version=1`（ADR-0017） | `--token-env` 成为推荐入口但仍写入既有 Bearer 结构；0.1.0 password/Bearer 配置与 `--auth=bearer` 保持兼容；`--server` 直连保持兼容 |
| Launcher ↔ 构件 | manifest `nodeVersion`、artifact entry、`apps/retention.json` | 新安装使用带本地版本保留能力的 Launcher；旧 Launcher 不会因业务 Release 自动升级，存量机器需执行一次性迁移脚本；`launcherMinVersion` 字段仍未执行校验 |
| 数据库 ↔ Server | Prisma schema/migrations | 向前升级前必须备份；不承诺自动降级 |
| Node.js | release manifest 默认 `>=24` | Launcher 可选择系统或缓存 Node；Client 一键安装优先复用合格 x64 Node，否则安装用户私有 Node；开发环境也应使用 Node 24+ |
| FRP | 打包的 frpc/frps + Shared FRP DTO；capability `frp.reconcileProtocolVersion=1` 协商恢复对账 | 构件应成对验证；Dashboard 确认状态机、operationJobId、稳定错误码和单 Client 单 FrpsInstance 约束要求 Shared/Server/Client/SDK/CLI/Frontend 同步发布；恢复对账只在新 Client + 新 Server 组合生效，混合版本降级为“不自动恢复”而不是错误执行 |

## 3. 支持矩阵

当前维护策略：

| Server | Client | Frontend/SDK | 结论 |
| --- | --- | --- | --- |
| 同一 `x.y.z` | 同一 `x.y.z` | 同一 `x.y.z` | 支持的标准组合 |
| 新 Server | 上一版本 Client | 同版本 Frontend | 仅更新窗口临时存在；依赖 capability，必须完成补更 |
| 旧 Server | 新 Client | 任意 | 不支持主动部署；Server 更新顺序必须在 Client 之前 |
| 任意发布版本 | 未打 Tag 的工作区构建 | 任意 | 不支持 |
| Pi 协议版本不同 | 任意 | 任意 | Pi 功能明确不可用，其他 capability 可继续评估 |

“支持”表示进入发布验收矩阵，不表示所有历史版本永久兼容。

Client 一键安装第一版仅支持 Windows 10/11 x64、Windows Server 2019+ x64，以及 Ubuntu 22.04+、Debian 12+、Rocky/AlmaLinux 9+ 的 x64 + glibc + systemd 组合。ARM64、Alpine/musl、CentOS 7、WSL、容器和无 systemd Linux 会在下载大构件前明确拒绝；Node.js 自身支持某架构不代表 FRP、PTY 和 Release 原生依赖已支持。

## 4. 升级顺序

标准自动升级顺序：

1. 上传完整 Release；
2. Server 停止新 Job 派发并等待活跃 Job 收敛；
3. Server Launcher 更新 Server，探活失败自动回退；
4. 新 Server 从 Release 状态恢复；
5. 在线 Client 逐台更新；
6. 离线 Client 后续注册，或在当前 Client 阶段期间上线时补更；
7. Frontend 随 server 构件同版本分发（`server/public/` 同源托管，[ADR-0013](./adr/0013-frontend-bundled-with-server.md)）；跨源单独托管时需与目标 Server 版本同步发布并刷新缓存。

Release 下载的瞬时网络失败只做有界恢复：Server 换取 Alibaba 直链遇到网络错误或 HTTP `500/502/503/504` 最多尝试 3 次；Launcher 从 Server 更新入口下载遇到网络错误或 HTTP `502/503/504` 最多尝试 3 次，并在每次尝试重新请求入口。确定性 `4xx`、URL 校验、SHA-256、解压、切换和探活失败不重试，也不改变失败 Client 不自动无限重试的语义。

不要先手工部署新 Client 再保留旧 Server。

## 5. 兼容变更分类

### 5.1 通常兼容

- REST 响应新增可选字段；
- Release `archives[platform]` 的可选 `storage` 字段（外部存储直连信息；缺失即 Local，新旧记录互读）；
- Release archive 的可选 `availability` 字段（旧记录缺失时按 `available` 读取）；新记录可为 `available`、`deleting` 或 `cleaned`，下载/编排/安装消费者会对清理态 fail closed；
- `0.2.1+` 新增独立 Release 上传会话 API；新 CLI 对旧 Server 的 404 会回退 legacy raw，引导升级兼容；
- Client 新增 capability；
- Socket payload 新增接收方明确忽略的可选字段；
- 新增独立 API、Job 类型或事件且旧端不会收到；
- 新增数据库表或 nullable/default 字段。

### 5.2 需要迁移和双端发布

- 改变字段语义、默认值或状态转换；
- 修改认证方式、Cookie、opaque token/摘要、ActorContext、公开端点、签名算法、文件 root ID 或路径规则；
- 改变 Job dispatcher、文件 payload/result、Pi/Terminal 对账语义；
- 改变 Terminal snapshot/output seq、generation、Session 状态、attachment/token 或限制常量；
- 升级 Pi SDK、Session JSONL 版本、Worker Runtime API 或事件投影；
- 将 exec script 从 `executable + args` 迁移到 runtime ID；
- 数据库字段改名、非空约束或数据回填；
- Release manifest、上传会话或 Launcher 控制协议变化；
- 改变 FrpsInstance secret DTO、默认实例、端口池、mapping 状态/删除语义或 Client 单/多 frpc runtime。

### 5.3 破坏性变化

- 删除或重命名事件/字段/错误码；
- 更改 Job type 对应 payload；
- 更改终态含义；
- 更换数据库 provider 或不可逆 schema；
- 要求新 Launcher 才能启动构件。

破坏性变化必须：新增 ADR、提升相应协议版本、提供升级路径、更新 CHANGELOG，并验证旧版本得到明确拒绝而不是错误执行。

ADR-0010 已决定 exec script 迁移到 Client runtime registry。当前 Shared/Frontend/Server/Client 仍使用 `executable + args`；实施时必须先部署能声明 `exec.script.<runtime>` 的 Client，再切换调用方，并为旧 payload 设置有限兼容窗口。不得只凭应用版本猜测支持情况。

远程文件当前仍由调用方提交 `rootDir`，且 Shared `FileTransferResult.sha256` 与 Alibaba/当前 import 的实际结果存在偏移。迁移到 Client 认证 root ID、严格文件 parser、统一取消/对账或调整摘要字段时，必须作为 Server/Client/SDK/Frontend 双端协议变更发布；旧 Client 应按 capability/协议明确拒绝，不能把新 root ID 当作普通路径传给旧 handler。

Terminal 当前没有独立协议版本，且 snapshotSeq/网络 output seq、generation 对账和持久状态同步存在实现偏移。修复这些语义、升级 node-pty/xterm 或改变 strict parser 时，必须同步发布 Shared、Client、Server、Frontend 和 SDK；不能让新 Server 用新的 seq/generation 假设解释旧 Client。

认证当前使用服务端 opaque Session/Credential。Cookie/token/Actor 变化必须同时评估现有 Session 和 Credential 的失效/迁移、Frontend/SDK/CLI、`/app` handshake 和回滚；不能在无明确迁移时改为 JWT 或新摘要语义。

FRP 当前 Server 可保存多实例，但 Client 只有单 frpc runtime，Server 已强制同一 Client 的映射使用同一 FrpsInstance。改为每实例独立 frpc、取消 Dashboard 完成门或更改 mapping 状态/删除收敛仍属于需要新 ADR、数据迁移、整套发布和真实 FRPS E2E 的破坏性变更。

FRP 恢复对账通过 capability `frp.reconcileProtocolVersion=1` 协商：新 Server + 旧 Client（不声明该 capability）不会触发自动恢复，行为保持“断线置 inactive、人工处理”；新 Client + 旧 Server 的 `frp:state` 上报被忽略，旧 Server 不读取 Client 残留 frpc TOML、不派发 `frp.reconcile` Job。标准组合仍是整套同版本发布；单独升级 Client 或 Server 不改变 FRP 操作语义，只改变是否有自动恢复。

### 5.4 Release 上传兼容窗口

- `0.2.1+` Server + Alibaba：必须走创建/刷新/完成会话，旧 raw 入口在读取正文前返回 `RELEASE_DIRECT_UPLOAD_REQUIRED`；旧 CLI 不能向该组合发布；
- `0.2.1+` CLI + 旧 Server：创建会话端点返回 404 时回退 legacy raw，仅用于从旧版本引导升级；
- Local 后端：新旧 CLI 均可使用 raw stream，新 CLI 会先协商得到 `mode=server`；
- 首次引导若公网 raw 上传受旧 Server 请求时限影响，应从 Server 本机/近端执行，不修改已发布 Tag、不复用失败版本号。

## 6. 数据库兼容

- 升级前备份 SQLite 及 Storage/Release 数据；
- 生产升级应审查 Prisma migration 或 preStart 行为；
- 当前启动脚本包含 `prisma db push --accept-data-loss`，只适合受控开发环境，不应作为生产兼容保证；
- Launcher 回退应用版本不自动回退数据库 schema；涉及不可向后兼容迁移时，必须采用 expand/migrate/contract 多阶段方案；
- 回滚前确认旧 Server 能读取已升级 schema，否则应从备份恢复整个数据集。

## 7. Launcher 兼容缺口

manifest 已声明 `launcherMinVersion`，但当前代码没有 Launcher 自身版本比较和拒绝逻辑，打包脚本写入 `0.0.0`。Launcher 随发布 zip 提供，首次安装后位于 `<app-dir>/dist/main.js`；已有 Launcher 默认保留，不随业务版本自动覆盖。新安装的 Launcher 会在稳定启动后维护 `apps/retention.json` 并清理不受保护的本地旧版本；旧 Launcher 没有该能力。在最低版本校验缺口修复前：

- Launcher 协议或目录结构不得做隐式破坏性变更；
- 如必须升级 Launcher，应先使用明确的 Launcher 升级流程替换 `<app-dir>/dist/main.js`，再发布依赖它的业务构件；存量迁移可使用随 Client Release 分发的 `upgrade-launcher.cjs`，通过 `--app-dir`、`--source` 和 `--pm2-name` 显式指定目标，不建立长期自动升级状态机；
- 发布说明必须写明最低 Launcher 要求和人工步骤；
- 不得声称系统已自动强制最低 Launcher 版本；
- 发布脚本当前统一生成 `.zip`；Server/Launcher 按 `.zip` 保存和解压，Linux 目标机需要 `unzip`；Launcher 本地清理状态损坏时必须停用自动删除并人工恢复，不能按目录时间猜测历史。

## 8. 发布兼容门禁

每次 Release 至少验证：

- Shared、Server、Client、Frontend、SDK、CLI 全量构建，Skill `vcpdeck.cjs --help` 冒烟；
- 在仓库外用 pnpm 10.26+ 从同一 Git Tag 安装 SDK/Shared，验证 JavaScript 导入、TypeScript 类型和目标项目单文件打包；
- Server 与同版本真实 Client 的注册、Job、文件 parser/root/导入导出/取消和重连；
- Pi 协议版本、锁定 SDK 版本、Session 打开/迁移和 Worker 重连；Terminal capability、真实 PTY、snapshot/seq、控制权和重连；
- 数据库从上一支持版本升级；
- Launcher 正常更新和失败回退（含瞬时下载失败的最多三次有界重试）；
- Release archive `available/deleting/cleaned` 消费分流、Server 清理 CAS/Provider 恢复、上传会话宽限和 Launcher `retention.json` 损坏保护；
- Frontend 与新 Server 的 REST/Socket.IO/SSE；
- 离线 Client 补更；
- CHANGELOG 包含兼容性、迁移和回滚限制；
- 预发布环境先执行 cleanup preview，确认候选和 Provider 状态后再在生产启动/发布。

## 9. 建议的后续增强

在首次稳定发布前，应增加统一 `CONTROL_PROTOCOL_VERSION`，实现 Launcher 版本校验，并明确至少支持 N-1 Client 的窗口或明确只支持同版本。完成前维持“整套同版本部署”的保守策略。
