# ADR-0026：浏览器与 Client 使用 WebRTC 通用 TCP 隧道

- 状态：Accepted
- 日期：2026-09-11
- 决策者：项目维护者
- 关联：`docs/architecture.md`、`docs/protocols.md`、`docs/security.md`、ADR-0001、ADR-0005、ADR-0012、ADR-0020

## 背景

VCPDeck 需要让浏览器访问目标 Client 本机服务，并为后续 noVNC/VNC 远程桌面建立低 Server 带宽的数据通道。现有 FRP 可以暴露远程端口，但业务流量固定经过 FRPS，不能提供浏览器与 Client 的 P2P 数据面。浏览器也不能直接创建普通 TCP 或 UDP socket。

该能力必须继续遵守 Server 中心控制面、Client 主动出站连接、Shared 严格协议治理和可信操作者单信任域，同时限制新隧道成为目标局域网访问或扫描入口。

## 决策

- Server 继续作为唯一控制面，负责操作者鉴权、临时 Tunnel Session、Client capability 校验、SDP/ICE 信令转发和短期 TURN 凭据签发；Server 不转发或持久化隧道业务字节。
- Browser 使用原生 `RTCPeerConnection`，Client 使用开源 `node-datachannel`。双方建立可靠、有序的 WebRTC DataChannel；ICE 优先直连，失败时使用开源 coturn TURN relay，业务层不切换协议。
- Client 将每条 DataChannel 只桥接到固定 `127.0.0.1:<targetPort>`。公共协议不接受 host，不能访问 Client 所在局域网的其他地址。
- Tunnel Session 是 Server 内存中的短期运行状态，绑定创建者、Browser socket、Client 当前连接和目标端口；任一侧断开、超时、Server 重启或显式关闭即释放，不持久恢复。
- coturn 与 Server 可同机部署，但作为独立 systemd 服务运行，不由 VCPDeck Launcher 守护。仓库提供基于发行版包管理器的一键配置脚本，支持 Debian/Ubuntu 与 CentOS Stream/RHEL/Rocky/AlmaLinux，并允许显式指定 NAT 外部地址。
- coturn shared secret 保存在 Server 主机权限受控文件中，由 `VCPDECK_TURN_SECRET_FILE` 指向；Web 配置和 API 不接收、不返回长期 secret。Server 按 coturn TURN REST 标准使用 Node.js `crypto` 签发短期 HMAC 凭据。
- `node-datachannel` 及对应 Windows x64、Linux x64 glibc 预编译包作为 Client 外部原生依赖随平台 release 离线交付；目标机不现场编译或下载。
- 隧道只传输原始双向字节，不实现自定义压缩、封包或上层协议。HTTP 仅作为首期验收；后续 noVNC 直接把已连接的 `RTCDataChannel` 传给其 `RFB` 构造器，并使用 VNC/noVNC 既有开源编码控制带宽。
- Shared 定义协议版本、事件、DTO、稳定错误和严格 parser；只有精确声明支持该协议版本的 Client 才能创建 Tunnel Session。

## 候选方案

- **FRP 作为默认数据面**：实现成熟，但全部流量经过 FRPS，增加带宽成本，也不能验证后续 noVNC 需要的浏览器 P2P 通道。
- **Server WebSocket/TCP relay**：接入简单，但 Server 承担全部桌面或文件流量，违背控制面与高带宽数据面分离目标。
- **自研 UDP 打洞、QUIC 或 NAT 穿透**：浏览器能力受限，协议、安全和跨平台成本高；WebRTC 已提供 ICE、STUN、TURN、DTLS 和 DataChannel。
- **纯 TypeScript WebRTC Client**：部署较简单，但本期优先采用性能和预编译平台支持更适合持续二进制流的 `node-datachannel`。
- **通用 TunnelManager/Provider 框架**：当前只有一条已确认路径，提前抽象会增加没有验收价值的复杂度；需要第二种真实数据面时再评估。
- **隧道层通用压缩**：上层 HTTP/VNC 等协议可能已压缩，二次压缩增加 CPU、延迟和安全风险；压缩应由上层开源协议实现。

## 后果

正面：

- Server 只承担低带宽控制与信令，P2P 成功时不承担业务流量；
- TURN fallback 与直连共用 WebRTC 协议，避免维护第二套数据通道；
- 通用字节流可复用到 HTTP、VNC 和其他本机 TCP 服务；
- noVNC 官方直接接受 RTCDataChannel，后续无需 WebSocket 代理；
- 固定回环目标与临时凭据限制新增网络和密钥暴露范围。

负面与约束：

- TURN fallback 仍会消耗 Server 所在公网主机带宽，必须配置 relay 端口范围、云安全组、监控和容量；
- `node-datachannel` 是原生依赖，升级 Node.js 或该依赖时必须验证预编译 ABI、双平台 release 与真实数据通道；
- coturn 是新增独立运行组件，需要额外安装、systemd 运维、密钥文件和公网端口；
- 活动 Session 不持久化，Server 重启或控制 socket 断开会终止隧道；
- 本期仅支持 `127.0.0.1` TCP，不支持 UDP、IPv6 回环、局域网目标或透明浏览器代理；
- Frontend/Server 生产部署必须使用 HTTPS/WSS，以满足浏览器安全上下文和凭据保护要求。

## 验证与退出条件

最低验证包括：

- Shared 严格 parser、Session 归属、信令方向、非法端口和未知字段拒绝；
- Browser 与 Client 通过 direct DataChannel 双向访问 Client 的 `127.0.0.1` HTTP 服务；
- 浏览器强制 `iceTransportPolicy=relay` 后仍能访问同一服务，并通过 stats 确认 relay candidate；
- Client 只连接回环地址，TCP 拒绝、超时、断线和背压均安全清理且不丢弃已接收字节；
- coturn 长期 secret 不出现在 API、SQLite、日志或 Frontend 持久存储；
- Windows x64 与 Linux x64 release 在无构建工具、无 npm 下载条件下加载 `node-datachannel`；
- 已连接的 RTCDataChannel 满足 noVNC `new RFB(element, channel)` 接口。

若未来需要多 Server 会话漫游、访问 Client 局域网、UDP、多路复用、Peer Relay、FRP 自动切换、长期可恢复隧道或非浏览器 Peer，应以新 ADR 重新评估数据权威、授权、协议和故障边界。
