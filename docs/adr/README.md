# 架构决策记录（ADR）

> 维护责任：架构维护者｜最后核验：2026-08-15

ADR 记录会长期影响系统结构、数据、协议、安全或运维的决策。ADR 一经 Accepted 不修改结论；后续变化用新 ADR supersede。

## 编号与状态

文件名：`NNNN-short-title.md`，编号四位递增。

状态：

- Proposed
- Accepted
- Deprecated
- Superseded by ADR-NNNN
- Rejected

## 模板

```markdown
# ADR-NNNN：标题

- 状态：Proposed
- 日期：YYYY-MM-DD
- 决策者：
- 关联：Issue/PR/文档

## 背景

问题、约束和驱动因素。

## 决策

明确、可执行的结论。

## 候选方案

各方案及未选择原因。

## 后果

正面、负面、风险、运维和迁移影响。

## 验证与退出条件

如何验证；何时应重新评估。
```

## 何时必须写 ADR

- 新运行组件、数据库、消息队列、存储或部署模型；
- 协议版本和破坏性兼容变化；
- 身份、授权、密钥或信任边界变化；
- 数据权威或状态机变化；
- Launcher/Release/备份恢复策略变化；
- 对长期成本有明显影响的第三方依赖。

小型实现细节和可轻易撤销的局部选择不需要 ADR。

## 当前决策索引

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](./0001-control-plane-and-outbound-clients.md) | Accepted | Server 中心控制面，Client 主动出站连接 |
| [0002](./0002-sqlite-prisma-control-plane.md) | Accepted | 当前控制面使用 SQLite + Prisma |
| [0003](./0003-separate-launcher-for-updates.md) | Accepted | 使用独立 Launcher 守护和回退业务进程 |
| [0004](./0004-typed-job-kernel.md) | Accepted | Typed Job 作为可持久化远程操作内核 |
| [0005](./0005-shared-contracts-and-communication-channels.md) | Accepted | Shared 统一治理协议并按职责划分通信通道 |
| [0006](./0006-file-control-and-data-plane-separation.md) | Accepted | 文件传输的控制面与数据面分离 |
| [0007](./0007-client-owned-interactive-runtime.md) | Accepted | 远程交互运行态驻留 Client，Server 最小持久化 |
| [0008](./0008-pi-session-job-and-run-lifecycle.md) | Accepted | Pi Session 使用稳定 Session Job 与独立 Run 身份 |
| [0009](./0009-trusted-operator-security-domain.md) | Accepted | 当前采用可信操作者单信任域 |
| [0010](./0010-client-owned-script-runtime-registry.md) | Accepted | 脚本执行迁移到 Client 持有的受控运行时注册表 |
| [0011](./0011-server-side-opaque-authentication-and-actor-context.md) | Accepted | 使用服务端 opaque Session/Credential 与可信 ActorContext |
| [0015](./0015-launcher-distributed-with-release.md) | Accepted | Launcher 随发布包分发，安装到 app-dir 外部稳定路径，不随业务版本覆盖 |
| [0016](./0016-release-archive-storage-provider.md) | Superseded by ADR-0019 | 历史方案：外部存储下载直连，但上传由 Server 转存 |
| [0017](./0017-cli-multi-environment-configuration.md) | Accepted | CLI 使用用户级环境注册表，项目配置只选择环境；严格优先级与 fail-closed 解析 |
| [0018](./0018-public-client-installer-and-pm2-supervision.md) | Accepted（Linux 部分由 ADR-0023 取代） | 提供公开可控的 Client 一键安装入口；Windows 继续由 PM2 只守护 Launcher |
| [0019](./0019-direct-release-upload-to-external-storage.md) | Accepted | 外部 Storage Provider 的 Release 上传与下载数据面均直连，Server 只控制权限、会话、元数据和编排 |
| [0020](./0020-cli-dataplane-namespace.md) | Accepted | CLI 复用 `/app` 数据面命名空间接入终端与 Pi 交互 |
| [0021](./0021-frp-dashboard-confirmed-mapping-lifecycle.md) | Accepted | FRP 映射以 Client 动作和 FRPS Dashboard 双重确认收敛 |
| [0022](./0022-release-artifact-and-launcher-retention.md) | Accepted | Release 审计与归档正文分离生命周期，Server 与 Launcher 按各自权威独立清理 |
| [0023](./0023-linux-system-client-and-root-equivalent-account.md) | Accepted | Linux Client 使用 systemd 系统部署与 root 等价专用账户，存量 PM2 安装通过 M1 迁移 |
