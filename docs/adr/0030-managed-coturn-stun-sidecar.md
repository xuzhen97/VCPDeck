# ADR-0030：使用受管 coturn sidecar 提供 WebRTC STUN

- 状态：Accepted
- 日期：2026-09-11
- 决策者：项目维护者
- 关联：[`ADR-0001`](./0001-control-plane-and-outbound-clients.md)、[`ADR-0005`](./0005-shared-contracts-and-communication-channels.md)、[`ADR-0026`](./0026-browser-client-webrtc-remote-desktop-dataplane.md)

## 背景

Remote Desktop 使用 Browser 与 Desktop Host 的 WebRTC P2P 连接。只使用 host candidate 通常只能覆盖局域网或已有可路由网络；跨 NAT 需要 STUN 帮助双方发现映射地址。STUN 只参与候选发现，基本不承载会话视频，适合与低带宽 VCPDeck Server 同机部署。

STUN/TURN 是独立 UDP/TCP 协议和公网基础设施。把它直接实现进 NestJS 会混合控制面与网络穿透职责，增加协议、安全、限速和故障隔离成本。TURN 则会持续中继媒体，不适合默认落在当前低带宽 Server 主机。

## 决策

1. VCPDeck 使用成熟的独立 coturn 进程或容器提供 ICE 基础设施，不在 NestJS/Node.js Server 中自行实现 STUN 或 TURN。
2. VCPDeck 部署和进程管理体系可以一体安装、配置、探活和维护同机 coturn sidecar；“内置 STUN”指受管 sidecar，而不是同一业务进程。
3. bundled coturn 默认只启用 STUN，不提供 TURN relay。正常 Remote Desktop 媒体路径仍是 Browser 与 Desktop Host 直连，不占用 VCPDeck Server 应用带宽。
4. Server 为 Remote Desktop Attachment 下发经过安全投影的 ICE 配置。部署可选择 `p2p-only` 或 `relay-allowed`；默认使用 `p2p-only`。
5. 协议从第一版起允许配置外部 TURN。需要中继时使用独立高带宽节点或第三方服务，不自动将当前 VCPDeck Server 主机启用为媒体中继。
6. TURN 凭据必须为短时会话凭据。固定长期密码不得打包进 Frontend、写入普通日志或作为公开配置返回 Browser。
7. 未配置 TURN 且 host/STUN 打洞失败时，Session 明确返回稳定 ICE 失败状态，不通过 Server WebSocket、REST 或 Storage 偷偷中继视频。
8. Frontend 显示当前连接使用 Direct 还是 Relay。Relay 只表示配置的 TURN 路径，不改变 Server 对 Remote Desktop Session 的控制权和租约职责。
9. bundled coturn 使用明确端口、防火墙和公网地址配置，实施速率限制、探活和安全日志；coturn 故障不得拖垮 Server 控制面。
10. ICE URL、临时 TURN 凭据和 candidate 地址按敏感网络数据处理。普通审计不持久化对端 IP、完整 candidate 或凭据。

## 候选方案

### 不使用 STUN

部署最少，但跨 NAT 成功率显著降低，只适合局域网、VPN 或天然可路由地址，不满足公网远控目标，因此拒绝。

### 在 NestJS 内实现 STUN

可以减少一个进程，但会让业务 Server 承担 UDP 协议、安全、限速、IPv4/IPv6 和 NAT 地址声明，且未来无法自然扩展高性能 TURN，因此不采用。

### 默认在 Server 主机启用 TURN

连接成功率更高，但持续占用当前低带宽主机并扩大媒体处理和滥用风险，与 Server 不承载视频的目标冲突，因此不采用。

### 只使用第三方公共 STUN

实现简单，但形成不可控外部依赖。允许部署者配置外部 STUN，同时提供受管 coturn 作为默认可控选项。

## 后果

### 正面

- 提高 NAT 环境的 P2P 成功率而不承担视频带宽；
- 复用成熟 ICE 服务并保持 NestJS 职责清晰；
- 为以后独立 TURN 提供兼容路径；
- coturn 故障与 Server 控制面隔离。

### 负面与风险

- 部署需要额外进程/容器、端口、防火墙和公网地址配置；
- STUN 无法穿透所有对称 NAT、CGNAT 或企业防火墙；
- 公网 STUN 需要限速和监控，避免扫描或放大滥用；
- 外部 TURN 会产生独立带宽成本和凭据管理责任。

### 安全与运维影响

- 默认配置必须确认 TURN relay 未启用；
- Server 位于 NAT 后时必须提供正确的可达地址；
- 云安全组和主机防火墙需显式开放配置的 STUN 端口；
- TURN 临时凭据签发密钥只在 Server/coturn 受保护配置中存在；
- 诊断应显示失败阶段，但不泄露候选地址和凭据。

## 验证与退出条件

必须验证局域网直连、跨 NAT 的 STUN 直连、STUN 不可达、P2P 不可达时明确失败、默认无 relay candidate、外部 TURN 短期凭据、Direct/Relay 状态、凭据过期、coturn 重启、端口限速和 Server 不出现媒体流量。

若未来决定提供官方托管 TURN、同机 TURN 或 SFU，应新建 ADR 明确带宽、滥用防护、凭据、容量、隐私和故障边界。
