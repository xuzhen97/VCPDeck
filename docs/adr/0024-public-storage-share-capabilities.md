# ADR-0024：使用长期 opaque capability 提供公开 Storage 分享

- 状态：Accepted
- 日期：2026-09-04
- 决策者：项目维护者
- 关联：`docs/design/storage.md`、`docs/protocols.md`、`docs/security.md`

## 背景

VCPDeck 需要让 VCPToolBox 等外部消费者展示或下载已经进入 Storage 的文件。现有稳定下载入口要求 VCPDeck Cookie 或 Bearer 认证，不能可靠用于跨站图片加载或不具备请求头注入能力的消费者；Provider 签名 URL和外部下载 URL又是短期凭据，不应固化到对话历史、日志或长期记录中。

如果把文件复制到每个消费系统，会形成重复正文、分散生命周期和清理责任。VCPDeck 已经保存 File 元数据并管理 Local、Alibaba 等 Provider 的认证和临时下载能力，因此需要在现有 Storage 控制面上增加统一、可撤销的公开分享机制。

## 决策

1. VCPDeck Server 新增通用 Storage Share 子系统，作为分享记录、状态、审计和底层 File 保留关系的权威；该能力不绑定具体插件或前端。
2. 每次创建分享都生成独立的 256-bit 加密安全随机 Token，并通过长期公开 URL授予单个 File 的只读能力。URL 不包含 File ID、Storage key、用户身份或 Provider 签名。
3. Token 是 bearer capability。数据库只保存 Token 的 SHA-256 哈希；完整 URL仅在创建成功时返回一次，管理查询不能恢复它。Token 泄露后只能撤销旧分享并创建新分享。
4. 分享默认长期有效，不设置自动到期。撤销使用软撤销并保留创建者、撤销者和时间；不支持恢复。自动清理和更丰富的保留策略留给后续独立设计。
5. 任意已认证业务 Identity 均可创建、查询和撤销分享，延续可信操作者单信任域。公开读取仅校验分享 Token，不要求 VCPDeck Cookie、Bearer 或 Client PSK。
6. 有效分享是底层 File 的保留锁。显式删除和到期清理必须跳过或拒绝删除仍有有效分享的 File；操作者必须先撤销全部有效分享。不提供隐式 force 删除或删除时自动撤销。
7. Server 每次公开访问都重新校验分享、File 状态和当前 Provider。普通文件实时换取 Provider 短期下载能力并 302；受支持图片由 Server 流式代理，以强制受控 MIME、inline disposition 和安全响应头。Provider 主凭据和临时 URL不进入分享记录或业务响应正文。
8. 图片首版按文件扩展名白名单映射固定 MIME，不进行内容嗅探。PNG、JPEG、GIF、WebP、AVIF、BMP 和 SVG 可内联；SVG 必须附加 sandbox CSP，所有图片启用 `nosniff`。
9. Provider 明确确认对象永久不存在时，分享标记为 invalid 并返回 410。临时网络、授权或 Provider 故障不得永久失效分享。
10. 首版不建立历史 Provider 配置仓库。File 的 `storageKind` 与当前 Provider 不一致时公开访问返回暂时不可用，分享保持有效；切回原 Provider 后恢复。
11. 公开分享 URL不得出现在普通应用日志、审计参数或遥测中。公开访问首版不逐次持久化，避免无界增长；创建和撤销继续记录 ActorContext。

## 候选方案

### 将文件镜像到 VCPToolBox

可直接复用 VCPToolBox 的文件服务，但会复制正文、分散清理和撤销责任，并使其他消费者重复实现相同机制，因此不采用。

### 直接返回 Provider 临时 URL

数据路径最短，但 URL会过期且本身是短期 bearer 凭据；固化到对话历史后既不可靠也扩大泄露面，因此不采用。

### 直接复用 VCPDeck 认证下载入口

普通浏览器在已登录且 Cookie 可用时可以下载，但跨站 `SameSite`、图片标签和模型服务通常无法携带 Cookie，也不应把长期 Bearer Token放进 URL，因此不作为公开展示协议。

### 保存分享 Token 明文

可以从管理界面重新显示链接，但数据库泄露会直接暴露全部长期分享能力。一次性返回加哈希保存足以支持撤销和审计，因此不采用明文保存。

### 删除 File 时自动撤销分享

操作简单，但会让普通清理或误删静默破坏长期公开链接。显式保留锁更符合默认长期有效的承诺，因此不采用。

### 本次同时支持历史 Provider 并存访问

需要持久化多套 Provider 配置、凭据、路由和迁移语义，显著扩大安全及运维范围。本阶段保持单活动 Provider 边界，后续如有明确需求再单独决策。

## 后果

### 正面

- 外部系统获得不依赖 VCPDeck 用户会话的稳定展示和下载地址；
- 文件正文和 Provider 认证仍由 VCPDeck 统一管理，不产生消费方副本；
- 分享可独立撤销和审计，Provider 临时 URL可按请求刷新；
- File 保留锁为后续统一清理系统提供明确不变量；
- VCPToolBox、Frontend、CLI 和后续消费者可以复用同一分享协议。

### 负面

- 公开 Token 一旦泄露，在撤销前任何持有者都可读取文件；
- 默认长期有效会持续占用 Storage，需要后续设计清理、配额和管理界面；
- 图片代理消耗 Server 带宽，尤其是外部 Provider 图片；
- Server/数据库与 Provider 不能形成跨系统原子事务，对象丢失和删除失败需要安全收敛；
- Provider 切换后历史分享可能暂时不可用；
- Token 只返回一次，丢失后必须新建分享。

### 安全与运维影响

- 反向代理、访问日志和错误采集必须对公开分享路径中的 Token 脱敏；
- 备份包含 Token 哈希和分享审计，但不包含可直接使用的公开凭据；
- 公开接口必须统一隐藏 File ID、Storage key、Provider 原始错误和签名 URL；
- 任何未来 File 清理或迁移实现都必须检查有效分享，不能绕过 File 控制面直接删除对象；
- SVG 虽允许内联，但必须使用 sandbox CSP、固定 MIME 和 `nosniff`，不能信任上传 MIME。

## 验证与退出条件

实现必须覆盖 Token 熵与哈希保存、重复创建、软撤销、公开 404/410、管理权限、File 删除与到期清理保护、Provider 临时故障和永久缺失、Local/Alibaba 下载、图片 MIME、SVG 安全头、日志脱敏以及真实 VCPDeckBridge 调用。

出现以下情况时重新评估本决策：

- 需要分享自动到期、密码、访问次数、配额或逐次访问审计；
- 需要多个历史 Provider 同时在线读取或自动迁移；
- 图片代理带宽成为瓶颈，需要受控 CDN 或可约束响应头的直连能力；
- 信任域扩展到非可信租户，需要所有者权限、细粒度授权或租户隔离；
- 需要公开写入、目录分享或可恢复查看的分享链接。
