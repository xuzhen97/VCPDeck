# ADR-0016：发布构件经 Storage Provider 分发，统一 Server 入口 + 临时直链重定向

- 状态：Superseded by ADR-0019
- 日期：2026-08-18
- 决策者：项目维护者
- 关联：[ADR-0006](./0006-file-control-and-data-plane-separation.md)、[ADR-0012](./0012-bundled-release-artifacts.md)、[`design/release-and-update.md`](../design/release-and-update.md)、[`architecture.md`](../architecture.md)

## 背景

- 现状：Release 归档只存 Server 本地（`VCPDECK_RELEASES_DIR`），Server 自身更新与每台 Client 更新都从 `GET /api/releases/:version/file` 经 Server HTTP 下载（`sendFile`），**下载流量与磁盘压力全部压在 Server**；
- [`architecture.md`](../architecture.md) §8 数据归属已把"发布构件"列为 Storage Provider（本地或外部存储、签名能力访问），**实现落后于设计**；
- 文件传输子系统已落地"Server 换链接、客户端直传外部存储"的模式（`AlibabaStorageProvider.createDirectUpload` 分片直传、`getExternalDownloadUrl` 临时下载直链、签名 URL），发布构件可以复用同一模式；
- 外部链接会过期（网盘临时直链约 15 分钟；OSS 预签名 TTL 自定），不能作为持久下发给目标机的 URL，也不宜暴露给协议层。

## 决策

1. **下载对目标机统一暴露 Server 入口** `GET /api/releases/:version/file?platform=`（保持现有协议、公开端点与 Launcher 零改动）：
   - **Local**：Server `sendFile` 直发（默认，无外部存储时保持现状）；
   - **外部后端（OSS/S3 兼容、网盘）**：Server 持凭证换取**临时直链**，对入口请求响应 **302 临时重定向**（不用 301：301 会被客户端/代理缓存，直链过期后换新链接会踩旧缓存）；目标机 `fetch` 默认跟随重定向，**字节流在目标机 ↔ 外部存储之间直传，不占 Server 带宽**。
2. **直链"用的时候现取、短时缓存"**：Server 在编排下发、离线补更（`triggerCatchUp`）、客户端重试时按需换取直链；内存缓存至 `expiresAt − 安全余量`，过期重新换取；短 TTL 永不暴露给目标机或协议。
3. **上传保持现状入口，Server 转存 Provider**：CLI/curl 照旧上传到 Server（流式接收 + sha256 校验）→ Server 经 provider 转存（复用 `uploadToKey` 或 `createDirectUpload` 分片上传）；`Release.archives[platform]` 扩展 `{ provider, key, mode }`，无该字段的旧记录视为 Local（向后兼容）。后续可选项：CLI 拿分片预签名 URL 直传存储（复用现有 upload-session 协议），字节不经 Server。
4. **能力位**：Provider 声明 `directDownload: boolean`（Local=false；OSS/网盘=true）；下载端点按能力位选择 `sendFile` 或 302。需要"自己处理认证"的云盘，其凭证只存 Server（OAuth/refresh token，现有 `StorageBackendConfig` 已有实现），由 Server 代为换取直链。
5. **完整性模型不变**：上传与下载两侧继续双端 sha256；直链过期/失效时重新走统一入口获取，不改变对完整性的兑底。

## 候选方案

- **把外部直链直接写进 UpdateRequest.url**：拒绝——URL 过期与续签复杂、协议需要感知后端差异、失败定位困难；
- **Server 拉流再转发（代理）**：拒绝——字节仍占 Server 带宽，与目标冲突（仅作为外部后端不可用时的临时兜底可接受）；
- **每个后端单独下载端点**：拒绝——目标机/协议感知后端，兼容性与扩展性差。

## 后果

**正面**

- 下载流量与磁盘压力移出 Server，符合 architecture.md 数据归属的既定意图；
- 一套协议同时兼容 Local / OSS / 网盘，切换后端只改配置与 Provider 实现；
- 目标机与协议不感知"后端需要认证"的差异，认证复杂度收敛在 Server。

**代价与风险**

- 网盘免费版限速/配额是后端自身限制（实测第三方应用 ~0.5–2.8MB/s），需在运维文档标注"可用但不承诺速度"；OSS 等对象存储不受此限；
- 302 依赖目标机 HTTP 客户端跟随重定向（Node `fetch` 默认跟随，Launcher 满足）；
- 临时直链含敏感 token：只允许内存缓存，**不得写入日志、Release 记录或持久化**；
- 直链换取失败时需要可靠降级（回到 Server 中转/标记更新失败），需在实现与故障文档中明确。

## 验证与退出条件

- Local / OSS / 网盘三后端各完成一次"上传 → Server 自更新 → 多 Client 更新"真实演练，并用流量统计证明外部后端下载字节不经过 Server；
- 直链过期后（等待超过 TTL）客户端补更/重试自动重新换取成功；
- 旧版本 Release 记录（无 storage 字段）继续走 Local 路径；
- 出现"目标机无法跟随重定向"或"网盘后端频繁不可用"的证据时，重新评估代理兜底或协议级直链方案。
