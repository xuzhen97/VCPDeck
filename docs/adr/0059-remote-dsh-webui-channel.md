# ADR-0059：远程 DSH WebUI 通道（远程开发台）

- 状态：Accepted（2026-10-19；同日修订：主路径由"VCPDeck 反代"改为"FRP 直连 + DSH 插件目录"）
- 决策者：维护者
- 关联：[ADR-0058](./0058-remote-dev-session.md)（RDS）、[ADR-0037](./0037-git-ssh-managed-keys.md)（受控下发思路）

## 背景

RDS（ADR-0058）用 ACP 驱动目标机 agent，并自建了会话 UI（对话流、工具、权限、用量、transcript 回放）。两件事已经查清：

1. **ACP 与 DSH WebUI 不是同一层级。** `@deepseek-ai/dsh-acp` 自述「automation-only」；DSH 的界面能力分布在四十多个 `dsh-client-ui-*` 包与 Slots 体系里。用 ACP 复刻 WebUI 等于重写前端生态，且永远落后一个版本。
2. **两个进程写两套会话。** RDS 的 ACP 会话与 `dsh web` 会话在同一 `$DSH_HOME/sessions` 下，但内置 WebUI **不列出** ACP 创建的会话（实测：同 workspace 35 个会话目录只列 2 条带标题的；把会话复制成 `session-<id>`、补 `agentPreset` 后重启仍不列出）。"嵌 WebUI 看 RDS 会话"在当前版本不可达。

真实需求是：**操作者想用自己的浏览器，用完整的 DSH 开发体验去操作另一台机器。** 正确原语不是"在 ACP 里补 UI"，而是"让目标机的 `dsh web` 被安全访问到"，并让 VCPDeck 在其中提供**目录与入口**。

## 决策

1. **主路径：FRP 直连 + DSH 插件目录。**
   - 目标机运行 `dsh --profile web`，由 VCPDeck 已管理的 **FRP** 把其 loopback 端口映射到可访问地址；
   - VCPDeck 做成 **DSH UI 插件**（host 半 + client 半），在 DSH 页面里提供机器列表、通道状态与"打开"入口；
   - 新增极小登记表 `Client.dshWebUrl`，由 FRP 映射建立时写入，插件据此给出链接。
2. **启动契约（硬约束，零代码但不可省）**：目标机必须以 `--host 127.0.0.1 --port <p> --public-url <frpUrl> --trusted-host <frpAuthority> --no-open` 启动。缺少 `--trusted-host` 时页面的 `/api` 会被 browser-trust 门禁拒绝（403）。反代/隧道层 **固定 Host**，不透传客户端 Host——[社区已发生因用 Host 判断"来自本机"的认证绕过](https://github.com/JJDonald/dsh-public-origin)。
3. **网络约束（硬约束）**：`dsh web` 暴露的是一台开发机的完整 shell 能力，鉴权仅为 URL token。**只允许私网访问**（内网、Tailscale、已加密的 FRP 隧道）；确需公网时，必须在 FRP 前置 basic auth 或 mTLS。token 不得写入 VCPDeck 日志、DB 或文档；URL 只经插件按需下发。
4. **插件分工**：host 半（运行在 DSH 的 Node 进程内）代理 `GET /api/vcpdeck/*` 到 VCPDeck Server（携带 API token），**避免浏览器跨站 Cookie/CORS 问题**；client 半只做 UI，挂 `sidebar.panellist` 或机器页 tab，不直接访问 VCPDeck。
5. **RDS 收敛**：`/remote-dev` 保留为**自动化控制台**（端口转发、批量、脚本、远程冒烟、审计、transcript 回放），主开发入口改为"远程 DSH"。二者不共用会话，不得对同一会话双写。
6. **v2 升级路径**：当出现"机器数 > 5 / 第二操作者 / 需要访问审计 / token 泄露过一次"任一情况，改为 VCPDeck 反代 `/dsh/<clientId>/`（统一登录、单入口、可回收），形态见本 ADR 候选方案 B。届时插件只需把链接从 `dshWebUrl` 换成 `/dsh/<clientId>/`。
7. **非目标**：不改 DSH 源码；不做 ACP 与 WebUI 会话互通；不做多租户。

9. **受管生命周期（同日二次修订）**：操作者不再手写启动命令。`POST /api/clients/:clientId/dsh-web/start` 由 Server 分配 loopback 端口 → 命令 Client 代起 `dsh web` → 为该端口自动建 **FRP TCP 映射** → 用「映射地址 + 一次性 token」拼出 `dshWebUrl` 落库；`POST .../stop` 反向收尾：停进程、删映射、清地址。任何一步失败都不留半开状态（建映射失败即回滚进程）。
10. **状态与可观测**：`Client.dshWebState ∈ {stopped, starting, running, failed}`、`dshWebPort`、`dshWebFrpMappingId`。Client 离线时把运行中的通道标 `failed` 并清空地址，但**保留端口与映射引用**：`dsh web` 是独立进程，Client 重启不会杀掉它，句柄失效后端口是唯一还能定位残留的线索；停止时先杀句柄、再按端口兜底（Windows `netstat -ano` + `taskkill /T /F`），并轮询确认端口释放，仍占用则报 `DSH_WEB_STOP_INCOMPLETE` 而不是假装成功。离线时也不调 `deleteMapping`（需要 Client 在线确认，否则留下永远 `deleting` 的记录），留给重连后的停止流程。FRP 映射建/删后必须把 `dispatch` 下发到 Client——只落库不生效，表现是"映射存在但端口不可达"。
11. **前提**：一键启动要求目标 Client 声明 `dsh-web` 能力，且 Server 侧存在可用的 `FrpsInstance`；缺少时返回 `DSH_WEB_FRP_UNAVAILABLE` 并提示先去配置 frps，而不是静默降级成"起了个没人能访问的进程"。
## 候选方案

- **A. FRP 直连 + DSH 插件目录**（采纳）：复用已有 FRP；不引入 HTTP/WS 代理面；产出一个可长期复用的插件包。代价是每台机的 DSH 直接暴露（受决策 3 约束）与逐机安装插件。
- **B. VCPDeck 反代 `/dsh/<clientId>/`**（保留为 v2）：统一登录与审计、单入口；但需实现 HTTP/WS 桥，并先验证两个未知（DSH 登录 Cookie 能否服务端注入、`--public-url` 前缀剥离后资源与 WS 路径是否相对化），当前不值得先付这个成本。
- **C. 继续扩展 ACP 复刻 WebUI**（否决）：结构性落后，且 ACP parser 是严格白名单，每加一项都要改两端契约。
- **D. 操作者自建 SSH 隧道**（否决为主路径，保留为应急）：可用但不可审计、不可发现。

## 后果

- 正面：完整 DSH 体验无需重写；代码量最小；插件包成为后续所有 DSH 侧集成的落点；RDS 定位因此清晰。
- 负面：每台目标机需安装一次插件，DSH 预览版 slot 契约变化会带来逐机适配；token 暴露面由"私网约束"兜底而非技术手段。
- 风险：`--public-url`/`--trusted-host` 语义随 DSH 预览版演进；FRP 映射变更后需同步登记表。

## 验证与退出条件

- 经 FRP 地址打开目标机 DSH，登录、建会话、prompt、工具审批、WebSocket 流式输出、刷新续用全部可用（即 P1 生效）；
- DSH 插件面板能列出 VCPDeck 机器、显示通道状态、点开对应 DSH，且不出现跨站错误（即 P2 生效）;
- 未登记 `dshWebUrl` 的机器不显示入口（即 P3 生效）；
- 仅私网可达：从公网直连该端口不可用；token 不出现在 VCPDeck 日志与 DB；
- RDS 与远程 DSH 不对同一会话双写。

出现以下情况应创建新 ADR supersede：

- 触发决策 6 的任一条件（切换到反代形态）；
- 需要把 VCPDeck 能力嵌入 DSH 之外的另一宿主；
- 需要多租户或按身份的资源级授权；
- DSH 提供原生"ACP 会话在 WebUI 可见/可续接"，届时单写者约束可放宽。
