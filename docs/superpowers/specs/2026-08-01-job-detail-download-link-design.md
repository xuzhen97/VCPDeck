# Job 详情页展示导出下载链接 — 设计文档

日期：2026-08-01
状态：已确认

## 背景

"导出下载"（`file.export`）当前只在文件面板内闭环：点击后前端用 job 结果里的 `key` 现场签一个 **1 小时有效期** 的下载令牌并立即触发浏览器下载。令牌没有地方可回看，导致：

1. 大文件下载中途失败/被浏览器拦截后，无法从历史记录里重新下载
2. 想复制链接给其他工具（如 `curl`）拉取时没有入口

用户需求：在 **Job 详情页**展示下载 URL 本身（可复制、可点击下载），且**不设有效期**；存储空间的回收靠后续的定时清理任务兜底（本期不做清理）。

## 方案选型

- **采用 A：复用现有 `POST /api/storage/download-token`，`ttlSeconds: 0` 语义扩展为"永久链接"**。签名/校验链路现成且已验证，改动最小。
- 否决 B：job 完成时把 URL 存入 result。URL 是派生数据，不应进审计记录；重复签发语义混乱。
- 否决 C：新增 `/api/jobs/:id/download-url` 专用接口。现有接口已覆盖，YAGNI。

## 设计

### 1. 后端：下载签名支持"永久"

`StorageProvider.signDownloadUrl(key, expiresInSeconds)` 与 `verifyDownloadSignature(key, expiresAt, sig)` 在两个 provider（`local-storage.provider.ts`、`alibaba-storage.provider.ts`）对称修改：

- `signDownloadUrl`：`expiresInSeconds <= 0` 时 `expiresAt = 0`（永久标记），签名串不变（`download:{key}:0`）
- `verifyDownloadSignature`：`expiresAt > 0` 时才校验时间；`expiresAt = 0` 直接跳过时间检查

不需要改动：

- `storage.service.createDownloadToken`：`parseInt(expires)` 已兼容 `0`
- `storage.controller`：`body.ttlSeconds ?? DEFAULT_TTL` 中 `0 ?? 3600 = 0`，天然透传
- 上传签名（`signUploadUrl`）：保持有时效，本期只放行下载

### 2. 前端：Job 详情页新增"下载文件"卡片

文件：`packages/frontend/src/pages/job-detail-page.tsx`

展示条件（同时满足）：

- `job.type === "file.export"`
- `job.status === "done"`
- `job.result?.key` 存在

交互：

1. 进入详情页自动调 `sdk.storage.createDownloadToken({ key: result.key, ttlSeconds: 0 })`
2. 展示完整 URL：`location.origin + token.url`（`<code>` 样式，可选中复制）
3. URL 包装为 `<a href={url} download={filename}>` 点击直接下载；`filename` 从 `job.payload.path` 取最后一段解析（payload 仅用于取文件名，不展示原文，保持详情页"不泄露 payload"的既有承诺）
4. 签发失败（如 `file.export` 修复前遗留的假 key job）→ 展示"下载链接不可用"，不报错堆栈

### 3. 不做的事（本期边界）

- 文件面板的即时"导出下载"保持默认 1 小时有效期不变（当场使用，用后即弃）
- 不动 `FileCleanupService`：`expiresAt` 为 null 的 File 永不清理，与永久链接配套；后续清理策略（按保留期批量置 `expiresAt`）另行设计
- 不引入鉴权改造

## 安全取舍

- 永久链接无鉴权（REST 当前为内部使用），**链接泄露 = 文件可被任何人下载**
- 已完成的导出文件将持续占用存储（本地磁盘 / 阿里云盘），回收依赖未来的清理任务
- 缓解方向（本期不做）：接口接入鉴权、清理任务、链接可撤销（吊销 key）

## 验证

- 单元测试：`transfer-handler`/存储 provider 的签名校验——`expiresAt = 0` 永不过期、`expiresAt > 0` 过期拒绝（两个 provider）
- 手动验证：执行一次 `file.export` → 打开对应 job 详情页 → 看到完整 URL → 点击下载成功 → 复制 URL 用 `curl` 下载成功 → 断网/重启 server 后 URL 依然有效
- 回归：文件面板"导出下载"仍正常工作（1 小时令牌不受影响）
