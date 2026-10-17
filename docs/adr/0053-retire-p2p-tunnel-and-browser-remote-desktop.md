# ADR-0053：退役 P2P 隧道与浏览器远程桌面，网络暴露统一走 FRP

- 状态：Accepted
- 日期：2026-10-17
- 决策者：项目维护者
- 替代：[ADR-0026](./0026-browser-client-webrtc-tcp-tunnel.md)、[ADR-0028](./0028-windows-desktop-capture-engine-in-session-vnc.md)
- 关联：[ADR-0001](./0001-control-plane-and-outbound-clients.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)、[ADR-0021](./0021-frp-dashboard-confirmed-mapping-lifecycle.md)、[ADR-0049](./0049-retire-pi-dsh-integrations-and-focus-on-core-capabilities.md)、[`design/frp.md`](../design/frp.md)、[`compatibility.md`](../compatibility.md)

## 背景

ADR-0026 引入 Browser ↔ Client 的 WebRTC DataChannel 回环 TCP 隧道，ADR-0028 在其上接入 noVNC 与受控 UltraVNC 构成浏览器远程桌面。该体系需要额外维护：

- Shared 隧道协议（14 个 parser、协议版本、ICE/Config DTO）；
- Server 的隧道 Session 控制面、TURN 短期凭据签发与 `TunnelConfig` 存储；
- Client 的 `node-datachannel` 原生依赖（双平台预编译包随 Release 分发）；
- coturn 独立 systemd 服务与一键安装脚本；
- Frontend 的 WebRTC 数据面、noVNC 集成、UltraVNC `SetSW` 扩展、缩放/黑屏/重连等整套桌面交互；
- 以及 STUN/TURN 的「网络」设置页。

实际使用中，远程桌面只在少量 Windows 目标机上验证，多显示器切屏至今未接入；而目标机网络暴露的既有需求由 FRP 映射覆盖，且 FRP 已是稳定、受审计、Typed Job 化的能力。维持两条并行的远程通道会长期分摊运维、发布与安全注意力。

维护者决定保持系统精简：**移除 P2P 隧道与浏览器远程桌面整条链路，网络暴露统一由 FRP 承担。**

## 决策

1. **删除 P2P 隧道能力**：Shared 的隧道协议、`Events.TUNNEL_*`、`capabilityDetails.p2pTunnel`，Server 的 `TunnelModule`（Session/Config/Controller）与两个 Gateway 的隧道信令，Client 的 `tunnel-bridge` 与 `node-datachannel` 依赖，SDK 的 `tunnels` 域，全部移除。
2. **删除浏览器远程桌面**：Frontend 的 `tunnel`／`desktop` 机器详情 Tab、隧道面板、桌面面板、noVNC 集成、UltraVNC 扩展与相关工具库同步移除；`@novnc/novnc` 依赖退出。
3. **删除「网络」设置与 TURN 部署面**：`/settings/network` 与 `TunnelSettingsPanel` 移除；`install-coturn.sh` 及其测试、Release 分发、`VCPDECK_TURN_SECRET_FILE` 读取全部退出。coturn 不再作为 VCPDeck 的部署组件。
4. **删除 `TunnelConfig` 存储**：Prisma 模型移除并新增 `DROP TABLE` 迁移。该表只保存 STUN/TURN URL 与 realm，不含可复用业务数据；删除是本次退役的一部分，不做保留。
5. **网络暴露统一走 FRP**：目标机端口的对外暴露、临时调试与凭据管理继续由 `FrpMapping`／`FrpsInstance` 与既有 Typed Job 承担，本次不新增替代隧道或通用代理层。
6. **入站退役字段必须容忍**：`capabilityDetails.p2pTunnel` 进入 `RETIRED_DETAIL_KEYS`（接受并丢弃，不持久化、不投影），使仍在旧版本的 Client 不被整条注册拒绝。旧 Client 发来的 `tunnel:*` socket 事件在新 Server 无 handler，静默忽略。旧调用方对已删除的 `/api/tunnels/*` 得到 404，属明确拒绝。
7. **不保留空壳**：不保留隐藏开关、占位页面、伪成功接口或「已停用」提示页；不恢复 WebRTC、VNC 或通用 TCP 隧道作为后续方向。

## 候选方案

- **保留隧道但隐藏 UI**：协议、原生依赖、coturn 与安全边界仍在，维护成本不降，不采用。
- **仅删除远程桌面、保留通用 TCP 隧道**：可保留浏览器访问目标机本机服务的能力，但与 FRP 职责重叠，且仍需 coturn 与原生依赖，收益不足，不采用。
- **把 coturn 改为可选项默认关闭**：仍需维护配置、凭据与文档分支，且没有已知使用方，不采用。

## 后果

正面：

- Client 少一个跨平台原生依赖与双平台预编译包，Release 构件、离线装配与平台裁剪规则同步简化；
- Server 少一个可写配置面、一个内存态 Session 状态机与 TURN 凭据签发路径，安全面收窄；
- 部署不再需要独立 coturn 服务与 secret 文件；
- 机器详情与设置页减少两个 Tab、一个设置分区与整套桌面交互代码。

负面与风险：

- **不再能从浏览器直接查看或操作目标机桌面**。需要图形界面时，须由操作者另行部署 VNC/RDP，并通过 FRP 映射暴露，且该链路不在 VCPDeck 的界面与审计范围内。
- 已存在的 `TunnelConfig` 数据随迁移丢失；本 ADR 认定其无业务价值。
- 存量旧 Client 仍会声明 `tunnel.p2p` 并发送 `tunnel:*` 事件；需按第 6 条容忍，至少保留一个发布周期后再评估是否收紧白名单。

## 验证与退出条件

实施验证：

- Shared 不再导出隧道 parser／常量，`Events` 不含 `tunnel:` 前缀；
- 旧载荷回归：携带 `capabilityDetails.p2pTunnel` 的注册载荷仍得到 ack 且该摘要不被投影；
- SDK 无 `tunnels` 域，Frontend 无 tunnel/desktop 路由与 Tab，`/settings/network` 落到个人资料；
- `pnpm -r build`、`pnpm -r test`、`pnpm lint` 通过；Prisma 迁移可执行。

重新评估条件：

- 若出现「必须从浏览器直接操作目标机桌面」的确定需求，应新写 ADR 重新评估通道方案（可考虑 FRP + 外部 VNC/RDP 客户端），而不是复活本 ADR 退役的 WebRTC 体系。
