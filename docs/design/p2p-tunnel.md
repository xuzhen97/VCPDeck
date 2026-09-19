# VCPDeck P2P 隧道设计

> 状态：Current｜维护责任：网络/Client 维护者｜最后核验：2026-09-17｜适用版本：当前 `main`
>
> 事实来源：`packages/shared/src/tunnel.ts`、`packages/server/src/tunnel/`、`packages/server/src/events/app.gateway.ts`、`packages/server/src/events/client.gateway.ts`、`packages/client/src/tunnel/`、`packages/frontend/src/tunnel/`、`scripts/install-coturn.sh`、`scripts/pack-release.ts`

本文描述当前已经实现的 Browser ↔ Client WebRTC DataChannel 回环 TCP 隧道。字段级事件与 parser 以 Shared 和 [`protocols.md`](../protocols.md) 为准；长期决策（DataChannel 承载 TCP 字节流、coturn TURN 兜底、secret 文件隔离、Client 仅连回环）见 [`ADR-0026`](../adr/0026-browser-client-webrtc-tcp-tunnel.md)。

## 1. 范围与非目标

当前提供：
- 机器工作区「隧道」Tab：对目标 Client 本机 `127.0.0.1:<port>` 上运行的 HTTP 服务发起一次 GET 探测，显示状态行、正文与 `direct`/`relay` 路径。
- 机器工作区「远程桌面」Tab：通过同一条 P2P 隧道回环到目标机 `127.0.0.1:5900`，用 noVNC 的 `RFB` 直接接收已打开的 `RTCDataChannel`，把目标机 VNC 画面渲染进浏览器（见第 3 节）。
- 设置「网络」页：配置 STUN/TURN URL 与 realm，显示 TURN 密钥就绪状态（不采集 secret）。
- coturn 一键安装脚本 `scripts/install-coturn.sh`（Debian/Ubuntu 与 CentOS/RHEL/Rocky/AlmaLinux）。
- 发布包内置 `node-datachannel` 与双平台预编译 native 包，随包分发 `install-coturn.sh`。

非目标（当前阶段）：
- 不安装、不启动、不托管 VNC 服务端生命周期。VNC 服务端由运维经既有 Job/exec 能力在目标机自行安装，且必须只监听 `127.0.0.1`（VNC 自身密码不作为安全边界）。
- 不提供面向任意远程主机或局域网扫描的通用 TCP 代理；Client 固定只连 `127.0.0.1`。
- 不自研压缩、分片或传输协议；数据面复用 WebRTC `RTCDataChannel` 与 `node-datachannel`。
- 不做多屏、剪贴板同步、文件传输、音频、录制。

## 2. 控制面与数据面

- **控制面（Server 权威）**：`TunnelConfigService` 持久化 coturn 配置（单行 `id=1`，`TunnelConfig` 表），`TunnelSessionService` 在内存登记活动 Session（绑定发起 Browser 的 `/app` socket 与目标 Client 的 `/client` socket 身份），签发 24h 短期 TURN 凭据。
- **数据面（Browser ↔ Client 直连）**：HTTP 字节流走 WebRTC `RTCDataChannel`，不经过 Server 转发大流量。Server 只做信令转发（offer/answer、trickle candidate）与状态/关闭广播。
- **角色固定**：Browser 是 offerer 且创建 DataChannel；Client 是 answerer 且通过 `ondatachannel` 接收该 channel。入站 Browser 信令用 `parseTunnelBrowserSignal`（只允许 offer/candidate）解析，Client 侧信令用 `parseTunnelClientSignal`，未知字段/错误 code 抛稳定错误。

## 3. 数据权威

- coturn 配置：Server SQLite `TunnelConfig`（`stunUrls`/`turnUrls`/`realm` JSON 数组 + 字符串，单例行）。
- TURN shared secret：**不落库、不进 REST、不进 Web 表单**。仅由 `VCPDECK_TURN_SECRET_FILE` 指向的 `root:serverUser`、mode `0640` 文件提供；缺失或不可读时 TURN 签发失败，STUN 仍可用。
- 活动 Session：Server 内存；`/app` 或 `/client` 断线、attach 超时、Client 上报 failed/closed 都幂等回收。
- 远程 TCP 连接：只存在于 Client 进程内，指向 `127.0.0.1:<targetPort>`。

## 4. ICE 服务器与短期凭据

- `issueIceServers(sessionId, now)`：STUN（无凭据）+ 每个 TURN URL 一份凭据。
- TURN 用 coturn TURN REST API：`username = <expiresEpochSeconds>:<sessionId>`，`credential = base64(HMAC-SHA1(secret, username))`，`expires = now + 24h`。
- 缺 TURN URL、realm 或 secret 时返回 `TUNNEL_TURN_NOT_CONFIGURED`；STUN-only 配置仍可直连。

## 5. 信令与 Session 生命周期

事件（`/app` ↔ Server ↔ `/client`，转发不持久化）：
- `tunnel.prepare`（→Client）、`tunnel.attach`（Browser→Server，ack 含 iceServers）、`tunnel.signal`（双向）、`tunnel.state`（→Browser）、`tunnel.close`（→Client）。

固定顺序（Browser 侧 `openBrowserTunnel`）：
1. 创建 `RTCPeerConnection` + 可靠有序 DataChannel；
2. `attach` 换回短期凭据（不阻塞 open，失败即清理）；
3. 发送 offer（answer 前先应用，排队 answer 前的 candidate）；
4. 等待 `channel.onopen`，超时 15s 拒绝并清理；
5. 对 `127.0.0.1:<port>` 做一次 GET 探测，`getStats()` 分类 `direct`/`relay`；
6. 无论成败 `close()`（移除 listener、关闭 channel/peer），`sdk.tunnels.remove(sessionId)` 回收 Server Session。

## 6. 回环 TCP 数据泵（Client）

`tunnel-bridge.ts` 把 DataChannel 桥到 `127.0.0.1:<targetPort>` 的 `node:net` socket：
- 入站 `onmessage` 写 TCP；`write` 返回 false 时累计回压，超 1 MiB 关闭（`TUNNEL_BACKPRESSURE_LIMIT`，不丢包、不静默吞）。
- 出站 `data` 切分为最多 16 KiB 二进制消息；`bufferedAmount ≥ 1 MiB` 暂停读取，`onbufferedamountlow`（阈值 256 KiB）恢复。
- 目标拒绝连接报 `TUNNEL_TARGET_REFUSED`；Client native 后端加载失败报 `P2P_NATIVE_BACKEND_UNAVAILABLE` 且不上报能力。
- **目标终止的拆除顺序**：目标 TCP 终止（被拒绝 / 报错 / 目标主动关闭 / 回压超限）只上报权威 `TUNNEL_STATE` 并拆目标 TCP，**WebRTC 通道保留**，由 Server 的 `TUNNEL_CLOSE` 统一关闭；仅当 WebRTC 通道自身出错或收到 `TUNNEL_CLOSE` / 进程关闭时才整体拆 `peer`+`channel`。这样 Browser 必先收到具体错误码（如 `TUNNEL_TARGET_REFUSED`）再感知通道拆除，避免快速失败端口时本地 `onerror` 抢先把错误降级成通用 `TUNNEL_CLOSED`（同机回环下最易复现）。

## 7. native 后端（node-datachannel）

- Client 用 `node-datachannel/polyfill` 的 `RTCPeerConnection`/`RTCDataChannel`（Web API 形状），**延迟加载** native binding；`probeP2pBackend` 在 register 前探测，加载失败才把能力标为 unavailable。
- `register.ts` 把 `p2pTunnel` 能力上报进 `MachineRegister`（`P2pTunnelCapabilityStatus`，`available:false` 附 `code`，旧 Client 缺省不出现该字段）。
- 发布包将 `node-datachannel` 与 `@node-datachannel/win32-x64-msvc`、`@node-datachannel/linux-x64-gnu` 外置保留（esbuild external `node-datachannel/*`），staging 用 `supportedArchitectures: [win32, linux]` 同时安装两平台包，win zip 排除 linux native、linux zip 排除 win native。

## 8. coturn 部署

`scripts/install-coturn.sh`（`sudo`，在 Server 主机执行）：
- 检测发行版家族（apt/dnf）；dnf 无 `coturn` 时先装 `epel-release` 再重试。
- 探测 external IP（优先 `--external-ip`，否则 `api.ipify.org`），internal/relay IP 用 `ip -4 route get 1.1.1.1`；校验失败要求显式参数，不猜测。
- 生成 32 字节 Base64 secret 到 `/etc/vcpdeck/turn-secret`（`root:serverUser`、`0640`），重跑保留既有 secret。
- 写带 `# managed-by: vcpdeck-coturn` marker 的 `/etc/turnserver.conf`；非本脚本管理的既有配置拒绝覆盖。
- 启用/重启 `coturn.service`（或 `turnserver.service`）并校验 active；结尾只打印端口、`VCPDECK_TURN_SECRET_FILE`、STUN/TURN URL 与 realm，不打印 secret。

端口：`3478` TCP/UDP、relay `49160–49200` UDP。Web「网络」页只填 URL 与 realm；`VCPDECK_TURN_SECRET_FILE` 指向 secret 文件。

## 9. 前端入口与错误映射

- 机器「隧道」Tab（`tunnel-panel.tsx`）：目标端口 + 路径 + 强制中继开关，一次点击只允许一个活动请求；结果只进文本/`<pre>`，不注入 DOM HTML。
- 机器「远程桌面」Tab（`desktop-panel.tsx`）：目标端口（默认 5900）+ 连接/断开；一次点击建立一条会话：`create` 会话 → `openBrowserTunnel`，并在其 `onChannel` 回调（DataChannel 创建后、open 之前）内立即 `createVncSession` 挂载 noVNC（否则通道 open 后服务端立即发送的 RFB banner 会被丢弃，握手停在等待版本串），断开 / 卸载 / 切 Tab 都按 `rfb.disconnect()` → `tunnel.close()` → `tunnels.remove()` 固定顺序清理（幂等）。凭据经 `credentialsrequired` 事件弹窗交互（密码只在内存，不落 localStorage）。
  - **默认只读**（`viewOnly=true`，不发送任何键鼠事件），工具栏可显式切换为可操作（切换后不再显示 `只读` 芯片）。
  - 画布高度**自适应容器**（不再固定 `60vh`），三种查看模式：**适配**（`scaleViewport`，完整显示、比例不符留黑边）/ **1:1**（`clipViewport` + `dragViewport`，可拖动）/ **滚动**（不缩放、滚动条）。**画质档位只影响清晰度与带宽，永不改变可见范围。**
  - 分辨率：默认 `resizeSession=true`（容器尺寸变化即发 `SetDesktopSize`），可关为“仅本地缩放”。**注意：在物理 Windows 桌面上该开关是空操作** —— ExtendedDesktopSize 在 Windows 上等同于改物理屏幕分辨率，而会话内 VNC 服务端抓的是真实控制台桌面，改不了（实测窗口从 1280 改到 900 后，远端帧仍为 3960×1920）；只有虚拟显示/X 会话（如 Xvfb）能真生效。**用户可见的“完整显示”目标由「适配」模式的本地等比缩放保证**，不依赖该开关；不生效时开关无副作用，也不做 UI 标注（noVNC 未公开支持标志）。
  - 画质：`qualityLevel`（低 3 / 中 6 / 高 9）+ `compressionLevel=2`，连接中可改，直接作用于服务端编码。
  - 剪贴板双向：`clipboard` 事件只**展示**在面板（不静默覆写系统剪贴板）；「发送剪贴板」经 `clipboardPasteFrom`（需浏览器授权，失败只提示不中断）；并提供 `sendCtrlAltDel`。
  - **按显示器查看 = 客户端区域裁剪**：服务端送整块虚拟桌面（本机实测 3960×1920），RFB 无“选择显示器”消息、noVNC 1.7 也未公开多屏几何，故本期提供「全部 / 左半 / 右半」比例区域（`screen-view.ts` 计算，CSS 变换裁剪，零每帧开销、**不重连、不重建会话**）；精确显示器边界见 ADR-0028 的后续项。
  - **断线语义**：连上之后断开不再静默 —— 按 `reconnect.ts` 的 `classifyDisconnect` 给出原因；可重试的按 1/2/4/8/15 秒退避自动重连（上限 5 次，页面重新可见时立即重试一次），确定性失败（目标端口拒绝、VNC 认证失败、Client 离线/不支持等）只报原因不重试；用户主动断开不报错也不重连。
  - **无活动显示输出**：每 2 秒把画布缩采样到 32×32 判定（`black-screen.ts`），连续 5 次近全黑则显示可关闭提示，不当作链路故障、不自动重试。
- 安全上下文前提（noVNC 1.7 硬性要求）：浏览器只在安全上下文（HTTPS 或 `localhost`）提供 `crypto.subtle` 与 WebCodecs。明文 HTTP + 非 localhost 入口下 RFB 构造时打印 `noVNC requires a secure context (TLS). Expect crashes!`，**未加密的 VNC 密码认证（DES，纯 JS）与常规 JPEG/Tight/ZRLE 解码仍可用**，但 VeNCrypt/RA2 加密认证、H.264（WebCodecs）与剪贴板 API 不可用。面板在该情况下显示黄条提示（`data-testid="desktop-insecure-context"`）但不阻断连接；根治方式是改用 HTTPS 入口（生产按 [`deployment.md`](../deployment.md) 的 `VCPDECK_COOKIE_SECURE` 要求本就应如此）。
- VNC 会话适配（`vnc-session.ts`）：把 `RTCDataChannel` 交给 noVNC `RFB`（默认动态 `import("@novnc/novnc")`，构造即开始 RFB 握手；可经 `preloadRfb()` 预热以移出连接关键路径）。该通道**可以尚未 open**：noVNC 的 `Websock.attach` 只挂 `binaryType/onmessage/onopen/onclose/onerror` 并等原生 `onopen`；noVNC 接管 channel 的 `send/on*` 事件，故本模块创建后不再持有这些 handler，隧道清理由面板按固定顺序完成。面板**不直接触碰 RFB 属性**：本模块暴露 `viewMode`（`applyViewMode` 映射三个视口属性）、`resizeSession`、`qualityLevel`、`compressionLevel`、运行时 `setViewOnly`，以及出站 `sendClipboard` / `sendCtrlAltDel` 与入站 `onClipboard`。
- 设置「网络」（`tunnel-settings-panel.tsx`）：URL/realm 表单 + secret 就绪状态芯片。
- 错误映射到稳定中文文案（`tunnel/errors.ts`：隧道通用文案 + VNC 认证失败 / 断开）；`openBrowserTunnel` 在打开后把 `TUNNEL_STATE` 的 `code` 暴露为只读 `failureCode`，供面板取具体原因（如 5900 无监听）。不回显 Server 错误 details、SDP、凭据或 secret。

## 10. 错误码与清理

`TUNNEL_CLIENT_UNAVAILABLE`、`TUNNEL_CLIENT_UNSUPPORTED`、`TUNNEL_TARGET_REFUSED`、`TUNNEL_BACKPRESSURE_LIMIT`、`TUNNEL_OPEN_TIMEOUT`、`TUNNEL_SESSION_EXPIRED`、`TUNNEL_TURN_NOT_CONFIGURED`、`P2P_NATIVE_BACKEND_UNAVAILABLE`、`TUNNEL_SIGNAL_FAILED`、`TUNNEL_DATA_ERROR`、`TUNNEL_ATTACH_FAILED`、`TUNNEL_CLOSED`。任一失败路径都幂等回收 Browser 资源、Client 数据面与 Server Session。

## 11. 兼容与变更

- 协议版本 `P2P_TUNNEL_PROTOCOL_VERSION = 1`；Client 上报能力版本，不一致或无能力时不执行数据面，UI 显示「该 Client 不支持 P2P 隧道协议 v1」。
- 旧 Client 不上报 `p2pTunnel` 能力即视为 unsupported；SDK `tunnels` 域为新增只读 API，不改变既有构造/请求行为。
- 远程桌面本期为**纯前端**能力，Shared / Server / Client / SDK 无协议改动：复用既有 `TunnelSessionCreateRequest`（`targetPort` 已是 1–65535，5900 即可用）。前端侧增量：`browser-tunnel.ts` 新增只读 `failureCode`、`relayOnly` 改可选；Frontend 新增 `@novnc/novnc` 依赖并因 noVNC 1.7 的顶层 await 把 Vite `build.target` 提到 `es2022`（与 ADR-0011 modern evergreen 基线一致）；noVNC 经动态 `import` 独立分包，仅打开远程桌面时加载。

## 12. 测试门禁

- Shared parser/DTO 单测、Server TunnelConfig/Session/Controller/Gateway 单测、Client register/bridge 单测、SDK 只读域单测、Frontend runtime/设置/机器面板/远程桌面单测（`desktop-panel.test.tsx` 含非安全上下文提示与「noVNC 在隧道 open 前挂载通道」、`vnc-session.test.ts`）、`browser-tunnel.test.ts`（含打开后失败原因码、`onChannel` 在 open 前同步回调）、`scripts/install-coturn.test.sh`（纯函数）、`scripts/pack-release-deps.test.ts`（native 平台裁剪）。
- 真实网络验收：普通模式 `direct`、强制中继 `relay`、停 coturn 后强制中继失败并恢复；日志与 SQLite 不得出现 secret、TURN password、SDP、candidate 或 HTTP 正文。
- 本地已验证：① 直连端到端（真实 Server + native Client + 本地 HTTP 目标，DataChannel 直连命中、目标关闭后 `TUNNEL_TARGET_REFUSED`）；② **真实 coturn（Vagrant/VirtualBox Ubuntu VM，`use-auth-secret` + `no-auth`）凭据 A/B** —— 空凭据被拒，Server 签发的 `expiry:sessionId` HMAC-SHA1 凭据被接受并分配 relay 端点，确认与 coturn `use-auth-secret` 完全兼容。③ **真实浏览器（Playwright 驱动的系统 Chrome 153，headful、无代理）矩阵测试**：
  - **P2P 直连**：两端 `iceConnectionState=connected`、DataChannel `PING→PONG` 往返成功——浏览器侧隧道数据通路可用。
  - **强制 relay（`iceTransportPolicy: relay`）**：ICE 进入 `gathering` 但无候选产生、连接停在 `new`；测试期间 **coturn 侧收不到来自浏览器（源 `192.168.56.1`）的任何 TURN 流量**（而 node 原生 UDP 直连 coturn 有响应、STUN 有回包）——即该 Chrome 在此 VirtualBox host-only 网络下未向 coturn 发出 TURN Allocate，属**浏览器↔VM 虚拟网络**的互操作限制，非 coturn/凭据/产品缺陷（凭据已被 coturn 自带 `turnutils_uclient` 实证可被接受并分配 relay 端点）。
  - **换网络复测**：把 coturn 同时绑到 host-only（`192.168.56.10`）与 Vagrant NAT（`10.0.2.15`）两张卡、并把浏览器 TURN URL 切到 NAT 卡后，强制 relay **仍 0 条 TURN 流量**、连接仍停 `new`——证明根因不是「够不到 coturn」，而是该 Windows 宿主 + VirtualBox 虚拟网络（host-only/NAT 的 3478/UDP）下 **Chrome WebRTC 的 TURN 客户端未触发 Allocate**（STUN 可达、P2P host 候选可达，唯 TURN 不出）。
  - 结论：产品侧仅需标准 `RTCPeerConnection` + `iceTransportPolicy: relay`（所有真实浏览器支持），配合已验证可用的 coturn 凭据即可走中继。**在本机单台 VM 环境无法端到端复现浏览器→coturn→Client 的字节流动**；要真实验证中继，需浏览器与 Client 分处两个不同网络（两台物理机/云 VM），且 Chrome 处于可正常出站 UDP 的环境。各组件均已独立验证可用，逻辑闭合。
- 远程桌面（noVNC）：已落地——浏览器隧道建立结果为原生 `RTCDataChannel`（具备 `send/close/binaryType/onerror/onmessage/onopen/protocol/readyState`，已验证 noVNC `Websock.attach` 可接受），直接作为 `new RFB(target, rtcDataChannel)` 通道。VNC 服务端由运维经既有 Job/exec 安装且仅监听 `127.0.0.1`。
- 远程桌面真实网络验收（手动，非自动化）：① P2P 直连能看画面能操作；② 强制 TURN 中继同样可用；③ 目标机未启动 VNC 时报「目标端口拒绝连接」并回收会话；④ VNC 配密码时弹窗、输错报认证失败、取消即清理；⑤ 断开后重连仍可成功（无 Session 泄漏）。**已知风险**：RFB 是长连接、双向、服务端主动推帧，与 HTTP 探测「发一次 GET 等关闭」不同，`tunnel-bridge.ts` 的 16 KiB 分片与 1 MiB 回压阈值首次被持续压力覆盖；若卡顿/断流优先怀疑该路径阈值。

## 13. 相关文档

[`protocols.md`](../protocols.md)、[`security.md`](../security.md)、[`deployment.md`](../deployment.md)、[`compatibility.md`](../compatibility.md)、[`ADR-0026`](../adr/0026-browser-client-webrtc-tcp-tunnel.md)、[`ADR-0012`](../adr/0012-bundled-release-artifacts.md)。
