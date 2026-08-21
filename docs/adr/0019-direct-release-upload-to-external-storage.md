# ADR-0019：Release 构件向外部 Storage Provider 直传

- 状态：Accepted
- 日期：2026-08-21
- 决策者：项目维护者
- 关联：[ADR-0006](./0006-file-control-and-data-plane-separation.md)、[ADR-0016](./0016-release-archive-storage-provider.md)、[`design/release-and-update.md`](../design/release-and-update.md)
- 替代：ADR-0016

## 背景

ADR-0016 已将外部存储上的 Release 下载数据面移出 Server，但上传仍采用“CLI 把完整构件传给 Server，Server 校验后再转存 Provider”。这使启用阿里云存储后，大构件仍占用 Server 公网上行入口、临时磁盘和 Node.js HTTP 请求时限；实际发布 `0.2.0` 时，约 111 MiB 构件在 Server 完整接收前超时，未能登记 Release。

项目维护者确认：启用支持直传的外部 Storage Provider 时，Release 上传字节也必须直连 Provider；Server 只承担身份、权限、会话、元数据与 Release 状态控制，不中转构件正文。

## 决策

1. 外部 Provider 的 Release 上传采用控制面/数据面分离：
   - CLI 向 Server 创建持久化 Release 上传会话，提交版本、平台、大小与 SHA-256；
   - Server 验证身份、重复版本、平台和当前后端后，向 Provider 创建分片上传，并把短期预签名 URL 返回 CLI；
   - CLI 按分片把构件直接 `PUT` 到 Provider；构件字节不经过 Server；
   - URL 失效时 CLI 经 Server 刷新指定分片 URL；
   - CLI 通知 Server 完成，Server 校验完成上报字节数与会话固定大小一致、调用 Provider 合并并登记 Release；两个平台齐备后沿用既有自更新编排。
2. 上传会话持久化版本、平台、声明 SHA-256/大小、Provider key/upload id、分片大小、操作者和有效期；预签名 URL 不持久化、不记录日志，并在 REST 响应上设置 `Cache-Control: no-store`。
3. Local Provider 不具备外部直传数据面，继续使用既有 Server raw stream 上传；启用阿里云后端时，旧 raw Release 上传入口必须拒绝请求，不能静默回退为 Server 中转。
4. 完整性仍以可信发布者 + 双端 SHA-256 为基础：CLI 上传前计算并声明 SHA-256，Provider 创建上传任务时固定总大小，完成上报字节数必须与会话大小一致；Launcher 下载后重新计算 SHA-256 并与 Release 权威值比较。Server 不读取外部直传正文，也不声称独立复核 Provider 内容哈希。
5. CLI 对不支持会话 API 的旧 Server 保留 legacy raw 上传兼容，只用于从旧版本引导升级；新 Server + 外部 Provider 不允许走 legacy raw 数据面。
6. 下载继续沿用统一 Server 入口：Local `sendFile`，外部 Provider 由 Server 换取临时 URL 后 302，目标机直接下载。

## 候选方案

- **仅延长 Node.js `requestTimeout`**：拒绝。只能缓解 Server 中转超时，仍违反外部存储数据面必须直连的要求，并继续占用 Server 带宽与磁盘。
- **CLI 直接持有阿里云 OAuth 凭据**：拒绝。凭据和权限应保留在 Server，CLI 只接收短期、单文件、单分片 URL。
- **把预签名 URL持久化到数据库或 Release**：拒绝。URL 短期有效且包含敏感能力，应按需刷新并只驻留内存。
- **所有 Provider 强制同一上传协议**：拒绝。Local 没有独立外部数据面，保留流式 Server 上传更直接；能力由会话响应显式协商。

## 后果

### 正面

- 阿里云后端的上传和下载构件字节均不经过 Server；
- 公网慢上传不再受 Server HTTP 请求接收时限影响；
- 分片可以独立重试和刷新 URL；
- Server 继续掌握发布权限、审计、状态与编排。

### 代价与风险

- 新增持久化上传会话及创建、刷新、完成协议；
- CLI 需要实现范围读取、分片 PUT、进度和安全重试；
- Provider 完成成功但 Server 登记失败时可能留下孤儿文件，需要保留会话并允许幂等修复；
- Server 不读取直传正文，完整性依赖 Provider 固定大小会话、CLI 声明值与 Launcher 下载后复核；若 Provider 后续提供可靠内容哈希，应增加第三方元数据核对；
- 从不支持直传协议的旧 Server 首次升级，仍需在 Server 本机/近端使用 legacy 入口完成一次引导。

## 验证与退出条件

- 测试证明 Alibaba 模式下 CLI 只把构件分片发送到预签名 Provider URL，Release API 只接收小型 JSON；
- 测试证明 Alibaba 模式下 raw Release 上传被拒绝，Local 模式仍兼容；
- 测试覆盖会话持久化、Server 重启后刷新、大小不匹配、URL 失效、重复完成和双平台触发；
- 真实 Alibaba 后端完成一次双平台上传，并通过流量/日志确认 Server 未接收构件正文；
- Launcher 下载后 SHA-256 不匹配必须拒绝更新；
- 若目标 Provider 无法提供稳定分片直传或权限粒度不足，重新评估该 Provider，而不是回退 Server 中转而不告知操作者。
