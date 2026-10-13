# 架构决策记录（ADR）

> 维护责任：架构维护者｜最后核验：2026-10-12

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

状态为 Rejected 或 Superseded 的行，其摘要仅描述历史决策，不代表当前实施目标。ADR-0049 批准退役方向，不表示当前代码已退出专用能力。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](./0001-control-plane-and-outbound-clients.md) | Accepted | Server 中心控制面，Client 主动出站连接 |
| [0002](./0002-sqlite-prisma-control-plane.md) | Accepted | 当前控制面使用 SQLite + Prisma |
| [0003](./0003-separate-launcher-for-updates.md) | Accepted | 使用独立 Launcher 守护和回退业务进程 |
| [0004](./0004-typed-job-kernel.md) | Accepted（Pi Session 复用 Job 条款由 ADR-0041 替代） | Typed Job 作为可持久化远程操作内核 |
| [0005](./0005-shared-contracts-and-communication-channels.md) | Accepted | Shared 统一治理协议并按职责划分通信通道 |
| [0006](./0006-file-control-and-data-plane-separation.md) | Accepted | 文件传输的控制面与数据面分离 |
| [0007](./0007-client-owned-interactive-runtime.md) | Accepted（Pi 条款由 ADR-0049 退役；Terminal 保留） | 远程交互运行态驻留 Client，Server 最小持久化 |
| [0008](./0008-pi-session-job-and-run-lifecycle.md) | Superseded by ADR-0041 | 历史方案：Pi Session 使用稳定 Session Job 与独立 Run 身份 |
| [0009](./0009-trusted-operator-security-domain.md) | Accepted | 当前采用可信操作者单信任域 |
| [0010](./0010-client-owned-script-runtime-registry.md) | Accepted | 脚本执行迁移到 Client 持有的受控运行时注册表 |
| [0011](./0011-server-side-opaque-authentication-and-actor-context.md) | Accepted | 使用服务端 opaque Session/Credential 与可信 ActorContext |
| [0015](./0015-launcher-distributed-with-release.md) | Accepted | Launcher 随发布包分发，安装到 app-dir 外部稳定路径，不随业务版本覆盖 |
| [0016](./0016-release-archive-storage-provider.md) | Superseded by ADR-0019 | 历史方案：外部存储下载直连，但上传由 Server 转存 |
| [0017](./0017-cli-multi-environment-configuration.md) | Accepted | CLI 使用用户级环境注册表，项目配置只选择环境；严格优先级与 fail-closed 解析 |
| [0018](./0018-public-client-installer-and-pm2-supervision.md) | Accepted（Linux 部分由 ADR-0023、Windows PM2 部分由 ADR-0027 取代） | 提供公开可控的 Client 一键安装入口；系统级部署见后续决策 |
| [0019](./0019-direct-release-upload-to-external-storage.md) | Accepted | 外部 Storage Provider 的 Release 上传与下载数据面均直连，Server 只控制权限、会话、元数据和编排 |
| [0020](./0020-cli-dataplane-namespace.md) | Accepted（Pi 调用范围由 ADR-0049 退役；Terminal 保留） | CLI 复用 `/app` 数据面命名空间接入终端与 Pi 交互 |
| [0021](./0021-frp-dashboard-confirmed-mapping-lifecycle.md) | Accepted | FRP 映射以 Client 动作和 FRPS Dashboard 双重确认收敛 |
| [0022](./0022-release-artifact-and-launcher-retention.md) | Accepted | Release 审计与归档正文分离生命周期，Server 与 Launcher 按各自权威独立清理 |
| [0023](./0023-linux-system-client-and-root-equivalent-account.md) | Accepted（旧 PM2 回退迁移策略由 ADR-0027 取代） | Linux Client 使用 systemd 系统部署与 root 等价专用账户 |
| [0024](./0024-public-storage-share-capabilities.md) | Accepted | 使用长期 opaque capability 提供公开 Storage 分享，并以有效分享保护底层 File |
| [0025](./0025-windows-client-highest-privilege-logon-task.md) | Superseded by ADR-0027 | 历史方案：Windows Client 使用当前用户、PM2 与最高权限登录任务 |
| [0026](./0026-browser-client-webrtc-tcp-tunnel.md) | Accepted | 浏览器与 Client 使用 WebRTC 通用 TCP 隧道，ICE 直连优先并以 coturn 中继兜底 |
| [0027](./0027-system-level-client-installation-and-clean-migration.md) | Accepted | Windows 使用 SYSTEM 开机任务、Linux 保持 systemd/sudo-all；旧 PM2 保留身份后清理式迁移，并提示不合规 Client 人工升级 |
| [0028](./0028-windows-desktop-capture-engine-in-session-vnc.md) | Accepted | Windows 桌面查看复用交互会话内的 VNC 服务端作为抓屏引擎，不自建会话内捕获组件 |
| [0029](./0029-server-managed-isolated-pi-runtime.md) | Rejected（方向由 ADR-0048 否决） | Server 统一管理 Pi 配置/凭据/策略，Client 使用与用户原生 Pi 隔离的 VCPDeck Runtime，受信资源随 Client Release 发布 |
| [0030](./0030-pi-resource-bundle-and-tool-policy.md) | Rejected（方向由 ADR-0048 否决） | Pi Bundle 位于版本目录并由 Client 逐资源校验；工具策略默认拒绝、审批超时即拒绝；策略经进程内桥接传递，不落盘不进环境变量 |
| [0031](./0031-native-pi-session-explicit-import.md) | Rejected（ADR-0049） | 用户原生 Pi Session 的显式导入是唯一允许接触用户 Pi 的路径：只读、单向、只操作副本，源根不可覆盖，预览正文受限不落盘 |
| [0032](./0032-pi-web-renderer-vendoring.md) | Rejected（ADR-0049） | Pi Web 消息渲染层原样拷入 `packages/frontend/src/pi-web/`（vendored，MIT 随行）；Shared DTO 与渲染模型只经 Pi UI Adapter 翻译，移植子树零协议 import，上游手动 cherry-pick |
| [0033](./0033-pi-tool-approval-mode.md) | Superseded by ADR-0034 | Tool Policy 与 Execution Mode 分层：Approval 逐次审批、Auto 受策略自动执行、YOLO 跳过 Tool Policy 但只信任当前 Runtime 已加载工具；RuntimeSpec v4 / bridge v2 |
| [0034](./0034-pi-session-execution-mode-override.md) | Superseded by ADR-0049 | Server 保存 Session 覆盖，未覆盖跟随 Profile；Owner 空闲修改、每个 Run 固化模式且 Client fail closed；原三模式语义见历史正文 |
| [0035](./0035-pi-image-only-prompt.md) | Superseded by ADR-0049 | Pi Prompt 允许空文本仅当携带有效图片；Server 在接纳 Run 前校验，Client 再验证；不自动补词 |
| [0036](./0036-pi-sdk-single-file-and-shell-capability.md) | Superseded by ADR-0049（基础 shell 实现保留） | Pi SDK 以单文件产物发布（依赖 SDK 嵌入模块分支，扩展/插件运行时导入不依赖 node_modules）；Bash 不再作整机门禁，shell 由 VCPDeck 绝对路径解析并注入；探测失败不缓存且保留真实原因码 |
| [0037](./0037-server-managed-git-ssh-key-distribution.md) | Accepted（Pi 消费路径由 ADR-0049 退役；Job／Terminal 保留；分发身份门槛仍由 ADR-0038 取代） | Server 加密保存共享 Git SSH 私钥并向选定 Client 分发；Job/Terminal/Pi 使用受管密钥，TOFU 校验主机；可靠单机排除须 Git 服务撤钥及轮换 |
| [0038](./0038-git-ssh-distribution-under-shared-psk.md) | Accepted | 共享 PSK 下选定 Client ID 仅为运维分发范围，不构成每机身份认证；泄漏按整套 Git 密钥失陷处置 |
| [0039](./0039-pi-two-mode-execution.md) | Superseded by ADR-0049 | 删除逐工具三桶，采用 supervised/automatic；保留 Session 覆盖与 Run 固化，旧受限配置显式确认迁移 |
| [0040](./0040-pi-extension-web-interaction.md) | Superseded by ADR-0049 | 受信扩展命令复用 Owner/Run 控制；网页提供有限 UI 与 Client 内存状态恢复，不支持任意 TUI、Session 替换或 Runtime reload |
| [0041](./0041-agent-session-run-and-audit-separation.md) | Superseded by ADR-0049（不恢复 Pi Session Job） | Agent Session、Run 摘要与会话操作审计独立于 Job；移除会话完成语义，保留最小审计与精确 Run 对账 |
| [0042](./0042-standard-pi-community-extensions.md) | Superseded by ADR-0048 | 以官方 Pi 扩展 API 与包声明为标准，社区扩展及依赖锁定版本随 Client Release 统一交付；dev/release 共用构建输入，保留资源门控与有限网页兼容边界 |
| [0043](./0043-project-local-pi-resources-unconditional-trust.md) | Superseded by ADR-0049 | 项目本地 Pi 资源（`.pi/`、`.mcp.json`、skills、prompts、context 文件）无条件生效，不引入 policy/审批；全局 `~/.pi` 仍零占用；允许读机器全局 MCP 配置作为显式例外 |
| [0044](./0044-pi-bundle-tree-delivery-and-verification.md) | Superseded by ADR-0048 | Bundle 资源升级为单文件/目录树判别联合，以确定性 `treeSha256`（含 mode、不跟随符号链接）覆盖目录全部内容；协议升 v2；构建期剔除宿主模块并按平台裁剪原生 |
| [0045](./0045-central-pi-and-native-agent-environments.md) | Superseded by ADR-0049 | 中央 Pi 为可选操作者，目标机 Pi/DSH 使用自身原生环境（非用户个人配置）；Client 退出 SDK/Bundle 管理，人和 Agent 共用原生 TUI/Web，替代路径验收后退役旧体系并保留历史 |
| [0046](./0046-independent-session-host-and-client-restart-survival.md) | Superseded by ADR-0049 | 通用会话宿主独立持有工作进程与 PTY，**接入层断开不中断工作**（页面关闭/Server 断线/Socket 重连）；Client 重启或更新中断工作可以接受，但必须如实上报中断并提供会话接续路径，不得伪装仍在运行 |
| [0047](./0047-dsh-web-access-via-authenticated-reverse-proxy.md) | Superseded by ADR-0049 | DSH 保持 loopback-only，由宿主内受认证反向代理（含 WebSocket upgrade）统一对外；不关闭 DSH 自身 Host/Origin 与 Cookie 校验，双层认证互不替代 |
| [0048](./0048-client-slimming-and-pi-feature-surface-on-server.md) | Superseded by ADR-0049 | **Client 瘦身**：Pi 功能面的权威在 Server；Client 退为通用能力底座（不内嵌 Pi SDK、不交付 Bundle）；目标机 Pi/DSH 由环境自带，Client 只按 Server 下发的明确命令启动/接入/停止；交互进程与 DSH 反代仍驻目标机；Server 通用能力对外开放给外置 Agent（沿用 CLI/插件面）；先可用、再切换、最后删除 Client 侧实现 |
| [0049](./0049-retire-pi-dsh-integrations-and-focus-on-core-capabilities.md) | Accepted（2026-10-12，尚未实施） | 退出 Pi／DSH 专用集成与新增 session-host；同步精简页面，保留基础能力与通用 CLI／SDK；不迁移或重建 Agent 体系，不默认销毁历史数据或卸载外部程序 |
| [0050](./0050-dsh-skill-cli-consumption.md) | Accepted（2026-10-13，尚未实施） | DSH 通过同仓库、同 Tag 的轻量 bundle 注册共用 Skill，复用预构建 CLI 消费基础能力；不恢复 Agent 托管体系 |
| [0051](./0051-release-client-catch-up-retry.md) | Accepted（2026-10-14，尚未实施） | 客户端补更失败分级（瞬时／永久），Server 为唯一重试所有者并按递增退避有限重试；新增周期对账作为第二驱动力，与注册钩子共用互斥入口；人工重试兜底并补齐 CLI 可见性 |
