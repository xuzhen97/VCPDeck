# ADR-0006：文件传输的控制面与数据面分离

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：`docs/design/remote-files.md`、`docs/design/storage.md`、`docs/protocols.md`

## 背景

VCPDeck 需要在 Browser、Server、Client 和 Storage Provider 之间传输可能很大的文件。若所有字节都通过 NestJS JSON/API 进程中转，外部存储场景会重复消耗 Server 带宽并增加内存、超时和故障压力；若 Browser 或 Client 直接持有长期 Storage 主凭据，又会绕过 Server 的身份、传输会话、Job 状态和审计边界。

Local Storage 位于 Server 主机，必须由 Server 提供数据端点；阿里云等外部 Provider 可以签发短期上传或下载能力。因此控制状态必须统一，而数据路径可以随 Provider 变化。

## 决策

1. Server 是文件传输控制面的权威，负责身份认证、File 元数据、传输会话、关联 Job、临时能力签发、进度和完成确认。
2. import/export 的文件对象正文由当前 Storage Provider 保存，不进入 SQLite 或 Job JSON；轻量 `file.readText/writeText` 仍通过 Job 传输文本，不属于本 ADR 的大文件数据面。
3. Local Storage 通过绑定动作、对象和过期时间的 Server 签名 URL 上传或下载，文件字节经过 Server 数据端点。
4. 支持直传的外部 Storage 可以向 Browser 或 Client 下发最小权限、短时有效的上传/下载 URL，使文件正文绕过 Server 进程。
5. 外部直传不改变 Server 的控制面责任：调用方仍需创建传输会话、报告进度并执行完成确认。
6. 创建 File/Job 或取得上传能力不等于传输完成。只有完成阶段按 Provider 能力校验会话状态、实际大小及可用的完整性信息后，资源才能进入完成状态。
7. Browser 和 Client 不持有长期外部 Storage 主凭据；短期 URL、Token 和签名不得进入普通日志、Job 文本或 Agent 回复。
8. Storage Provider 切换只影响新操作，不自动迁移、复制或删除旧 Provider 中的对象。
9. 数据面失败必须收敛到 File/Job/传输会话状态，不能通过直接写远程路径绕过控制面。

## 候选方案

### 所有文件都由 Server 代理

对 Local Storage 简单且便于统一校验，但外部 Provider 会造成不必要的双向带宽、超时和扩容压力，因此只保留为不支持直传 Provider 的路径。

### Browser/Client 直接配置 Storage 主凭据

数据路径最短，但会扩大凭据泄露面，绕过 Server 的身份和会话约束，难以撤销单次能力，因此不采用。

### import/export 文件对象正文存入数据库

可以将元数据和内容放在同一事务中，但不适合大对象、备份和流式传输，也会放大 SQLite 写入压力，因此不采用。小文本 `readText/writeText` 当前仍会进入 Job result/payload；其大小和保留风险由远程文件协议单独治理。

### Provider 切换时自动迁移全部对象

表面上简化调用方，但会产生高成本、长时间和不可逆的数据操作，并增加失控副本风险，因此当前不采用。

## 后果

### 正面

- 外部存储场景减少 Server 带宽和内存压力；
- 文件控制状态、权限和审计仍然集中；
- Local 与外部 Provider 可以共享上层 File/Job 生命周期；
- 短期能力比下发长期主凭据更易限制和撤销。

### 负面

- 上传/下载形成多阶段状态机，网络超时后的结果需要查询和对账；
- 不同 Provider 的完整性能力并不完全一致；
- Provider 切换后，历史对象仍依赖原 Provider；
- Local Provider 的签名 secret 属于持久化敏感配置；密钥丢失或被替换会使尚未过期的旧签名 URL 失效。

### 安全与运维影响

- 签名 URL 是临时凭据，必须限制日志、错误和可观测性采集；
- 远程导入最终仍由 Client 执行目标路径与覆盖检查；当前 rootDir 认证和 symlink 校验存在实现偏移，应按 `docs/design/remote-files.md` 修复，不能由 Storage complete 替代；
- 备份必须同时覆盖 SQLite 元数据和当前 Provider 中的实际对象；
- 清理孤儿对象时不能仅根据单一请求结果删除数据。

## 验证与退出条件

通过 Local 签名篡改/过期、外部直传分片、大小与完整性校验、进度与完成状态、断流、Provider 故障、远程路径越界和孤儿清理测试验证。

引入新 Provider、跨 Provider 自动迁移、内容寻址/去重、长期公共下载或更强供应链完整性要求时，应创建新 ADR 重新评估数据面和校验模型。
