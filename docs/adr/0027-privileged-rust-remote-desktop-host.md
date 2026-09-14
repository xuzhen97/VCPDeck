# ADR-0027：使用独立特权 Rust Desktop Host 承载系统远程桌面

- 状态：Accepted
- 日期：2026-09-11
- 决策者：项目维护者
- 关联：[`ADR-0007`](./0007-client-owned-interactive-runtime.md)、[`ADR-0009`](./0009-trusted-operator-security-domain.md)、[`ADR-0026`](./0026-browser-client-webrtc-remote-desktop-dataplane.md)

## 背景

VCPDeck 的 Remote Desktop 需要捕获和控制 Windows 与 Linux 的登录界面、锁屏、活动用户桌面和无物理显示器环境。普通用户 Node.js Client 无法可靠跨越 Windows Session 0、Winlogon、安全桌面、Linux logind Seat、GDM/SDDM 和 Wayland compositor 边界，也不适合承担实时捕获、硬件编码、WebRTC 和虚拟显示驱动集成。

将现有 Client 整体提升到 LocalSystem/root 会把 Job、Files、Terminal、Pi、第三方扩展和公网 `/client` 协议同时置于最高权限，扩大远程代码执行和凭据泄露的影响范围。因此必须分离业务控制进程与系统桌面能力。

## 决策

1. 新增原生 Rust Remote Desktop 子系统。Rust Desktop Host 负责真实桌面 Session、屏幕捕获、缩放、视频编码、WebRTC PeerConnection、输入注入、纯文本剪贴板、显示拓扑和虚拟显示。
2. Desktop Host 运行在满足平台桌面操作所需的受控系统权限下，但不持有 Browser 用户凭据、Bearer/Cookie、Client 共享 PSK、Storage 凭据或任意 Job 执行能力，也不直接访问 VCPDeck Server。
3. 现有 TypeScript Client 保持 Server `/client` 连接、协议协商和业务状态职责，通过受保护本机 IPC 与 Desktop Host 协作。Client Bridge 只转发会话控制、租约、严格信令和安全状态，不读取或转发视频、键鼠或剪贴板正文。
4. Windows 使用带 ACL 的 Named Pipe 并验证对端身份；Linux 使用受权限保护的 Unix domain socket 并验证 peer credentials。本机 IPC 不监听网络端口，采用独立数字版本、严格判别联合、大小限制、超时、generation 和短期 capability。
5. Desktop Host 不提供任意 Shell、任意文件、任意设备 IO 或通用 LocalSystem/root RPC。所有可调用动作必须是 Remote Desktop 协议中的有限 allowlist。
6. 需要活动用户图形会话资源时，由 Supervisor 以正确用户身份启动 Session Helper。Helper 只连接 PipeWire、Portal、EIS/libei 或对应平台用户会话资源，不持有 Server 凭据。
7. 平台后端至少分为 Windows、Linux X11、GNOME/GDM Wayland 和 KDE/SDDM Wayland。统一核心接口不意味着猜测兼容；每项 capture、pointer、keyboard、loginScreen、lockScreen、virtualDisplay、headless 和 encoder capability 必须来自运行时探测及端到端自检。
8. 有物理显示器时优先控制当前 Console/Seat；无物理显示器时创建一个稳定虚拟显示输出，仍控制同一系统登录/桌面会话，不创建独立 RDP 式用户 Session。
9. Remote Desktop 运行态和画面权威位于 Desktop Host。Server 只保存 Session 元数据和最小审计；Desktop Host generation 变化后旧 Session 必须收敛为 `interrupted`，不得从数据库伪造恢复。
10. Rust 子系统按目标平台条件编译和打包。第一版不建立第三方动态插件机制；平台内部可以复用成熟库和系统 API，但不得把实现差异泄漏成 Browser/Server 的平台专用协议。

## 候选方案

### Node.js Client 加截图、输入和 WebRTC 原生插件

原型较快，但登录界面、Wayland、硬件编码、驱动、ABI 和跨平台发布会形成脆弱的原生依赖组合，且业务 Client 权限过大，因此不采用为最终架构。

### 整个 TypeScript Client 以 LocalSystem/root 运行

实现进程更少，但任何 Job、Pi、文件或网络协议漏洞都直接获得系统权限，违背特权最小化，因此拒绝。

### C++ Desktop Host

能直接使用 libwebrtc 和平台原生 API，但跨平台构建、ABI、内存安全和依赖维护成本更高。Rust 可以在需要处调用系统 API，同时提供更好的内存安全和单二进制分发，因此选择 Rust。

### 独立 RDP/虚拟用户会话

更容易支持无显示器，但远程看到的可能不是本地控制台和已打开应用，不符合控制当前机器 UI 的目标，因此不采用。

## 后果

### 正面

- 公网业务协议与最高权限桌面能力隔离；
- 原生媒体和平台 API 可以在合适语言与运行时中实现；
- Server 不积累桌面正文，Client 不承担实时媒体复制；
- 平台 capability 和故障边界清晰；
- 支持登录界面、锁屏、多显示器和无头虚拟显示的最终演进路径。

### 负面与风险

- 新增 Rust 工具链、原生构件和跨平台测试矩阵；
- Windows 虚拟显示驱动、GNOME/GDM 与 KDE/SDDM 需要专项维护；
- 用户会话 Helper 和系统 Host 的生命周期、权限和版本必须一致；
- Wayland 能力受 compositor 和发行版版本影响，不能只靠统一接口保证可用。

### 安全与运维影响

- Desktop Host 和虚拟显示驱动属于高信任构件，必须签名、固定版本并纳入 Supervisor 探活与回滚；
- IPC 权限或 capability 校验失败必须 fail closed；
- 本地受保护诊断仍不得记录系统密码、按键、剪贴板正文和画面；
- 默认静默运行不改变其高权限性质，管理界面和系统服务清单必须如实显示状态。

## 验证与退出条件

必须在 Windows 10/11、Ubuntu GNOME/GDM、Fedora GNOME/GDM、KDE Plasma/SDDM 和标准 X11 真实环境验证登录界面、锁屏、登录/注销/切换用户、有/无显示器、多显示器、输入、剪贴板、编码、Helper 重启和 Host generation 对账。Mock 或“进程存活”不能替代真实桌面验收。

若未来平台提供统一、可靠且权限更小的系统远控 API，或决定采用独立虚拟用户会话，应新建 ADR 重新评估 Host、Helper 和显示权威边界。
