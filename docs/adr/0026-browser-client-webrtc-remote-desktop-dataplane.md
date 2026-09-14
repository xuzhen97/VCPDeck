# ADR-0026：浏览器与 Desktop Host 建立受控 WebRTC 远程桌面数据面

- 状态：Accepted
- 日期：2026-09-11
- 决策者：项目维护者
- 关联：[`ADR-0001`](./0001-control-plane-and-outbound-clients.md)、[`ADR-0005`](./0005-shared-contracts-and-communication-channels.md)、[`ADR-0007`](./0007-client-owned-interactive-runtime.md)、[`ADR-0009`](./0009-trusted-operator-security-domain.md)

## 背景

VCPDeck 需要在 Browser 中观看和控制目标机器桌面。现有 Server 带宽较低，不适合中转持续视频；同时 Browser 不能绕过 Server 的身份认证、会话协调和审计，直接把任意 Client 暴露为可控制端点。

远程桌面与 Terminal 一样是长生命周期交互资源，但具有视频编码、NAT 穿透、高频输入、多观看者和登录界面控制等独立语义，不适合建模为普通 Job 或复用 Terminal Session。

## 决策

1. Remote Desktop 使用独立、版本化的 Session 与 Attachment 协议，不复用普通 Job 或 Terminal Session。
2. Server 继续是唯一控制面。Browser 必须先通过 Server 认证，由 Server 验证目标 Client、创建 Session、分配 operator/viewer、维护控制租约、协调接管并记录最小审计。
3. Server 通过现有 `/app` 与 `/client` Socket.IO 通道转发经过严格校验的 SDP/ICE 信令。信令契约、状态、事件、限制和运行时 parser 统一维护在 `@vcpdeck/shared`。
4. 授权和 WebRTC 二次认证完成后，Browser 与目标机器 Desktop Host 直接建立 WebRTC 连接：Desktop Host 通过视频轨道发送单显示器画面，通过 DataChannel 接收键鼠、显示器、画质和纯文本剪贴板控制。Server 不接收或转发媒体正文。
5. WebRTC DTLS 不替代 VCPDeck 授权。每个 Attachment 使用短时、单次认证材料在 DataChannel 上完成 challenge-response；验证前 Desktop Host 不发送画面、不接受输入。
6. 同一 Client 最多一个活动 Remote Desktop Session；每个 Session 最多一个 operator 和三个 viewer。每个 Attachment 使用独立 PeerConnection，第一版不引入 SFU。
7. Server 控制通道或租约失效时 Desktop Host 立即冻结输入；在有界恢复窗口后关闭 PeerConnection、捕获和编码。Browser 刷新或 Server 短暂重启通过新 Attachment 和重新协商恢复，不复用旧 DTLS 状态。
8. Server、SQLite、普通日志和审计不得保存视频帧、按键、鼠标轨迹、系统密码、剪贴板正文、SDP、ICE candidate、对端 IP 或 WebRTC 密钥。
9. 授权继续遵循 ADR-0009：任意有效业务 Identity 可访问所有 Client；operator/viewer 只用于输入协调，不是资源级保密边界。
10. 该数据面是“Server 授权后的受控直连”，扩展但不取消 ADR-0001 的中心控制面原则。Browser、SDK 和 CLI 仍不得绕过 Server 自行发现或授权 Client。

## 候选方案

### Server 中转视频和输入

可简化 NAT 穿透和对端发现，但持续占用低带宽 Server，扩大敏感正文与媒体处理责任，并形成控制面瓶颈，因此不采用。

### DataChannel 按需传输 JPEG

实现较简单，适合偶尔截图，但缺少成熟视频轨道的拥塞控制、编码协商和连续交互体验，无法满足桌面软件操作目标，因此不作为正式画面协议。

### Browser 直接连接未受控 Client 端口

减少 Server 协调，但会绕过统一认证、会话、控制权和审计，并要求目标网络暴露入口，因此拒绝。

### 使用普通 Job 或 Terminal Session

二者无法准确表达 PeerConnection、多个 Attachment、显示器、视频质量和输入租约，复用会污染既有状态机，因此新增独立资源。

## 后果

### 正面

- 正常媒体不占用 Server 带宽；
- 保留统一身份、控制权和审计；
- WebRTC 提供标准加密、拥塞控制和浏览器原生视频渲染；
- Remote Desktop 可独立演进而不破坏 Terminal/Job 语义。

### 负面与风险

- NAT、CGNAT 和企业防火墙可能使 P2P 失败；
- 多 viewer 会线性增加目标机器上行和编码压力；
- 需要复杂的租约、信令限制、重连、二次认证和本地 fail-closed；
- Browser 与 Client/Desktop Host 协议必须协调发布。

### 安全与运维影响

- SDP/ICE 虽由 Server 转发，仍按敏感网络元数据处理；
- Frontend 隐藏输入控件不能代替 Desktop Host 的 operator 校验；
- Session 关闭、接管或租约过期必须在 Desktop Host 本地立即生效；
- 远程桌面等价于目标机器物理显示器和键盘，部署继续限于可信操作者域。

## 验证与退出条件

至少验证：严格 parser、信令大小/数量/速率限制、Session/Attachment/Actor/socket 归属、一个 operator/三个 viewer、并发接管、二次认证重放拒绝、viewer 输入拒绝、租约失效冻结与关闭、Browser/Server 重连、P2P 失败收敛，以及数据库和日志无媒体/输入/信令正文。

若未来需要 Server 媒体中继、SFU、持久录屏、匿名分享、不可信 viewer 或资源级授权，必须新建 ADR 重新定义数据面和信任边界。
