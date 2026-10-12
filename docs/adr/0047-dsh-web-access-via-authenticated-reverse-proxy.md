# ADR-0047：DSH 原生 Web 经宿主机内受认证反向代理接入

- 状态：Superseded by ADR-0049
- 日期：2026-10-10
- 决策者：项目维护者
- 实施状态：尚未实施；Accepted 表示接入形态已批准，不表示代理、双层认证或浏览器实测已完成。
- 关联：[ADR-0045](./0045-central-pi-and-native-agent-environments.md)、[ADR-0046](./0046-independent-session-host-and-client-restart-survival.md)、[ADR-0026](./0026-browser-client-webrtc-tcp-tunnel.md)、[ADR-0001](./0001-control-plane-and-outbound-clients.md)、[`p2p-tunnel.md`](../design/p2p-tunnel.md)、[`security.md`](../security.md)

## 背景

ADR-0045 要求人工与 Agent 使用 **DSH 原生 Web**，而不是由 VCPDeck 重做统一聊天界面。ADR-0046 要求该环境跨 Client 重启保活。平台范围为 Windows 与 Linux。

固定复核点（commit `d743267388641bc76f17c45ce8b4c231aed1d32c` 只读核验，非发行承诺）确认了四件与接入形态直接相关的事实：

1. **DSH 自带认证**：每次进程生成随机 launch token，`GET /` 接受该 token 后写入 **authority-bound 签名 Cookie** 并重定向到干净路径；缺失/过期/畸形/错 authority 的 Cookie 在 RPC 分发前返回 401。静态资源保持公开。
2. **DSH 自带请求信任检查**：每个请求先校验 `Host`（必须 loopback、等于监听地址字面量，或命中 `trustedHosts`）与 `Origin`（须为同一 authority），并拒绝 `sec-fetch-site: cross-site`。Host/Origin 失败 403，可信但未认证 401。官方明确 `dsh web --host 0.0.0.0` **不支持**。
3. **HTTP 载体形态**：`packages/host/webserver` 是单一 `node:http`（配 TLS 则 `node:https`）监听器，提供命名路由（`exact`/`prefix`）与**按精确 pathname 注册的 upgrade 路由**，外加一个 fallback seat（由 `packages/host/frontend-static` 持有）。TLS 不重定向、不开第二监听、PEM 在激活时读取、**无证书生命周期**。载体本身**没有服务端级认证或 origin 策略**，由各路由拥有者自行执行。
4. 本项目现有的 P2P 隧道只提供**字节流运输**（浏览器 ↔ Client 回环 TCP），不提供浏览器对完整 Web 应用的导航、Cookie 作用域或 upgrade 路由语义。

因此需要一个明确的接入形态决策：既不关闭 DSH 自身的安全机制，也不把 DSH 端口裸露出去。

## 决策

### 1. DSH 保持 loopback-only，由宿主内代理统一对外

DSH 服务继续只监听本机回环地址，**不使用 `--host 0.0.0.0`**。在同一机器上由**会话宿主**（ADR-0046）运行受认证反向代理，作为 DSH Web 的唯一对外入口。远程访问仍经 VCPDeck Server，不引入 Client 到 Client 直连，也不新增公网控制端口。

### 2. 代理必须同时支持 HTTP 与 WebSocket upgrade

代理需按 DSH 路由语义转发：命名路由（`exact`/`prefix`）与 **`registerUpgrade` 的精确 pathname**。仅做路径前缀重写、或只处理普通 HTTP 而不转发 upgrade，均视为未实现（WebSocket 不通即等于功能不可用）。fallback seat（SPA 静态资源）必须可用，否则页面能认证但加载不出界面。

### 3. 不关闭、不绕过 DSH 自身任何校验

保留 DSH 的 launch token → 签名 Cookie 流程、`Host`/`Origin` 检查、`sec-fetch-site` 拒绝、`trustedHosts` 语义。禁止以下做法：关闭或放宽 Host/Origin 校验、把校验失败改判为放行、用转发头或 `publicUrl` 伪造 authority、把 token 写入日志/审计/错误/遥测、把 token 拼进长期共享链接。

### 4. 双层认证相互独立

VCPDeck 身份与 DSH 会话身份是两层，**不得互相替代**：通过 VCPDeck 认证不构成 DSH 会话授权，DSH 的有效 Cookie 也不构成 VCPDeck 业务身份。代理必须保持 DSH 所见 authority 一致（hostname、端口、scheme），因为 Cookie 的确定性名称与签名载荷都绑定它；`Secure` 只在接收索引请求的监听器本身为 TLS 时成立，不得由转发头决定。两层各自的失效、登出与吊销语义需在实现中分别说明（DSH 当前**没有 logout 操作**，需在界面与文档中如实标注）。

### 5. TLS 由部署提供，代理不宣称证书生命周期

对外监听与 DSH 内部监听分离；TLS 材料由部署提供并被读取，代理不负责签发、续期或监控，也不声称已具备证书生命周期。不因配置了 TLS 就放宽前两条校验。

### 6. 不静默改变请求体语义

沿用 DSH 的 `maxRequestBodyBytes` 语义；代理不得静默截断、丢弃或改写请求体。超限必须明确拒绝并返回稳定错误，不得表现为认证失败或空响应。

### 7. 代理是通用接入组件，不解释 DSH 业务语义

代理不理解会话、消息或模型调用，不做 UI 改造、不做 iframe 嵌入要求、不替代 DSH 前端。它与 ADR-0046 的宿主同源部署，但不因此获得 Agent 配置、凭据或对话内容的解释权。

## 候选方案

1. **直接暴露 DSH 监听端口**：改动最小，但依赖 `trustedHosts` 放宽或 Host 校验失败，且把服务置于不受控网络面；不采用。
2. **关闭 DSH 的 Host/Origin 与认证校验，由 VCPDeck 单独把关**：等于把两层认证降为一层，并引入 DNS 重绑定与 CSRF 风险；不采用。
3. **用现有 P2P TCP 隧道充当网页代理**：隧道只运输字节流，不处理 upgrade 路由、Cookie authority 与相对路径导航，浏览器无法作为完整 Web 应用使用；不采用（隧道仍可用于其原本的一次性探测与远程桌面用途）。
4. **路径前缀重写代理（把 DSH 挂到某个子路径）**：会改变 authority 与资源解析基准，破坏 Cookie 绑定与升级路由匹配；不采用。
5. **受认证反向代理 + 保留 DSH 原生校验**：采用。代价是多一个运行组件与一套双层认证说明，收益是保留原生界面完整可用。

## 后果

正面：人工与 Agent 使用同一套原生 DSH Web；DSH 自身安全机制不被削弱；DSH 保持 loopback，不新增公网端口；与 ADR-0046 的宿主生命周期天然一致（Client 更新不影响该入口）。

成本与限制：新增需独立认证、配置与运维的代理组件；双层认证对使用者是额外一次登录/失效来源，必须在界面中解释清楚，不能让人以为「登录了 VCPDeck 就等于进了 DSH」。WebSocket 与长连接路径需要与 ADR-0046 的有界输出、慢消费者隔离协同，不能因代理而引入无界缓冲。

风险：代理实现不当可能把 DSH 的 authority 语义改坏（Cookie 失效、跨站请求被误放行）；TLS 与 Cookie `Secure` 的不一致可能导致「能打开页面但登录立即失效」这类难查故障。因此必须以固定 DSH 版本做真实浏览器验收，不能只做单元测试。

## 验证与退出条件

- 固定 DSH commit/发行版本，在 Windows 与 Linux 上分别以真实浏览器验证：静态资源加载、launch token 换取 Cookie、干净路径重定向、会话选择、消息交互、**WebSocket 建立（含 upgrade 路由）**、断线重连。
- 负向验证：错/过期/畸形/错 authority 的 Cookie 返回 401；跨 authority 的 `Origin` 与 `sec-fetch-site: cross-site` 被拒；非 loopback 且不在 `trustedHosts` 的 `Host` 被拒。代理不得把上述任一情况改判为放行。
- 日志、错误、审计、遥测与证据文件中**不得出现** launch token、Cookie 内容、请求正文或原始外部错误。
- 通过 VCPDeck 认证但无有效 DSH 凭据时，必须得到 DSH 自己的认证要求，而不是被代理静默放行。
- Client 重启/更新后代理与 DSH 会话按 ADR-0046 恢复，不重复启动 DSH、不新建会话。

若未来要求嵌入 VCPDeck 自研界面、在 Server 侧终止 DSH 会话、或让 VCPDeck 成为 DSH 身份权威，应另立 ADR，不得以完善接入为名隐式扩大本决策。
