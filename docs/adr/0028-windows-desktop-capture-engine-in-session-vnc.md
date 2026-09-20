# ADR-0028：Windows 桌面查看固定使用受控 UltraVNC，并在交互会话内捕获

- 状态：Accepted
- 日期：2026-09-19
- 决策者：项目维护者
- 关联：[`ADR-0009`](./0009-trusted-operator-security-domain.md)、[`ADR-0023`](./0023-linux-system-client-and-root-equivalent-account.md)、[`ADR-0026`](./0026-browser-client-webrtc-tcp-tunnel.md)、[`ADR-0027`](./0027-system-level-client-installation-and-clean-migration.md)、[`design/p2p-tunnel.md`](../design/p2p-tunnel.md)、[`design/windows-ultravnc-setup.md`](../design/windows-ultravnc-setup.md)

## 背景

浏览器经既有 P2P 隧道查看和操作 Windows 目标机桌面。该能力要求捕获目标机**交互会话**中正在显示的画面，抓屏组件所在会话是首要约束。

Windows Client 按 ADR-0027 以 `NT AUTHORITY\SYSTEM` 开机任务运行在 Session 0，没有交互桌面。2026-09-19 在 7 台生产 Windows Client 上实测：Client 进程 `SessionId=0`、`VirtualScreen` 恒为 `1024×768`，`Graphics.CopyFromScreen` 抛出 `The handle is invalid`。因此不能让现有 Client 进程直接抓取用户桌面。与此同时，Session 0 的 Client 可以通过回环连接交互会话内的 VNC Server，现有 Browser → P2P Tunnel → Client → `127.0.0.1:5900` 链路已经证明可行。

此前 VCPDeck 允许运维自行提供任意会话内 VNC Server，只在浏览器侧使用 noVNC。该边界不能稳定提供以下产品能力：

- 不同 VNC 实现的多显示器语义不同；
- noVNC 公共 API 不提供通用的显示器列表和精确选屏接口；
- 把合并 framebuffer 按 50% 裁成“左半/右半”不是真正的显示器切换，不适用于不同分辨率、上下排列或非双屏环境；
- 在 noVNC 外层用 CSS 放大和平移画面，会使 noVNC 的输入坐标模型无法感知显示变换，可能造成鼠标偏移；
- `resizeSession` 会发送 `SetDesktopSize`，其语义与“仅改善浏览器操作且不改变目标机显示设置”冲突。

UltraVNC 的 Windows Server 和官方 Viewer 提供显示源切换能力。其客户端消息 `SetSW`（消息类型 10，长度 6 字节）可以令 Server 切换当前显示器，并在显示器序列中进入全部显示器模式。该扩展尚未形成 noVNC 的稳定公共 API，完整互操作语义也必须针对固定 UltraVNC 版本验证。

本决策仅处理 Windows 10/11。Linux 桌面不在本期范围。

## 决策

1. **继续把抓屏引擎放在 Windows 交互会话内。** SYSTEM Client 只负责 P2P 隧道与回环 TCP 转发，不在 Session 0 自建抓屏、编码或输入注入组件。

2. **Windows 远程桌面固定使用 VCPDeck 验证过的 UltraVNC Server x64 版本和配置基线。** 不再承诺任意 VNC Server 都具备完整的多屏、输入和生命周期能力。具体版本必须经过真实机器兼容矩阵后锁定；未经重新验收不得自动漂移到“最新版”。

3. **VCPDeck 负责 UltraVNC 基线的可重复达成和检测。** 支持边界包括安装来源与校验、固定版本、配置模板、启动方式、回环监听、状态与版本检查、升级和卸载规则。实施可复用现有安装和远程 Job 能力，但不得把抓屏职责移回 Session 0。高风险安装、升级、删除操作继续遵守显式确认要求。

4. **UltraVNC 只能监听 `127.0.0.1`，默认端口为 5900。** 不向局域网或公网暴露 VNC。VNC 密码只能作为纵深保护，主要安全边界仍是 VCPDeck 身份、临时 Tunnel Session、WebRTC 加密和 Client 回环目标限制。

5. **真正的显示器切换使用 UltraVNC `SetSW`，不再使用“左半/右半”比例裁剪。** VCPDeck 在 noVNC 周围维护隔离的 UltraVNC 兼容层，负责消息编码、连接级状态、超时、有界循环和降级。React 页面不得拼接协议字节，也不得直接依赖 noVNC 的 `_sock` 等私有字段。

6. **精准标签以可验证状态为前提。** 只有固定版本的真实验证能够可靠确认初始状态、循环顺序、当前显示源和目标结果时，UI 才显示“全部 / 屏幕 1 / 屏幕 2”。如果只能可靠循环，UI 降级为“切换到下一屏”；若连循环语义也无法验证，则不提供切屏按钮。不得根据 framebuffer 宽度、黑边或固定 50% 比例猜测显示器。

7. **显示器切换是服务端全局状态；产品接受并必须向操作者明示。** 已实测确认 `SetSW` 改的是 winvnc 服务端共享的捕获源：在一条连接上切换会向所有已连客户端推送，且**新建连接直接看到切换后的状态**（不是每连接状态）。因此**同一目标机的并发会话共享所选显示源**。本产品是少量可信操作者的单信任域、以单操作者使用为主，接受该共享行为；但 UI 必须明示「会影响其他正在查看同一机器的会话」。若将来需要严格隔离，必须重新评估「每显示器一个 VNC 实例/端口」方案，**不得以已知串扰的实现冒充隔离**。

8. **浏览器查看只使用本地缩放。** `resizeSession` 默认且持续为 `false`，普通 UI 不提供“远端分辨率跟随”。适应窗口、100%、缩放、平移、页面内最大化和浏览器全屏都只改变本地 viewport，不发送 `SetDesktopSize`，不修改 Windows 分辨率、DPI、排列或主屏。

9. **画面与输入共享同一坐标模型。** 移除 noVNC 挂载点外层的 framebuffer 裁剪、放大和反向平移。优先使用 noVNC 的公开 viewport 能力；若连续缩放需要扩展，则显示变换和坐标逆变换必须封装在同一适配层并覆盖留黑边、平移、DPR、页面缩放、全屏和 framebuffer 尺寸变化。默认使用绝对坐标鼠标，不启用 Pointer Lock。

10. **工具栏位于远程画面之外。** 路径、只读、显示源、缩放、最大化和全屏控制不覆盖远端内容。浏览器 Fullscreen API 的目标是“工具栏 + 画面”的整个工作区；页面内最大化是独立的浏览器视口 overlay。

11. **不改变现有 P2P 数据面协议。** RFB 和 `SetSW` 继续作为原始字节经过 ADR-0026 的 WebRTC DataChannel ↔ 回环 TCP 隧道。若浏览器需要在连接前识别受支持的 UltraVNC 版本或健康状态，新增能力字段必须进入 `@vcpdeck/shared`，并同步 Server、Client、SDK、Frontend、兼容性文档和测试；不得由前端根据端口或画面猜测。

12. **无活动显示输出仍是运维前置条件，不是链路故障。** 真正没有活动显示输出时，需要 HDMI 假负载或受支持的虚拟显示器驱动；前端继续明确提示，不自动重试，也不在本期自建虚拟显示器。

## 后果

正面：

- 多显示器控制从不可靠的浏览器裁剪变为 VNC Server 真实切换捕获源；
- 固定版本和配置消除“任意 VNC 实现”带来的不可测试差异；
- 移除外层 CSS 画面变换后，noVNC 的 framebuffer 与输入坐标重新处于同一模型；
- 所有缩放留在浏览器，不改变目标机显示设置；
- 继续复用既有 P2P 隧道，不新增桌面图像协议或 Server 大流量转发；
- 工具栏不再遮挡远程画面。

负面与约束：

- VCPDeck 新增 UltraVNC 安装、版本锁定、配置、升级和健康检查责任；
- `SetSW` 是 UltraVNC 特定扩展，noVNC 尚无稳定公共 API，VCPDeck 需要维护小型兼容层或受控补丁；
- UltraVNC 升级必须重新执行真实多屏、输入、锁屏、UAC、direct/relay 和并发 Viewer 验收；
- 精准显示器编号可能因协议无法确认而降级成“下一屏”；产品必须接受诚实降级；
- 无活动显示输出仍需硬件假负载或虚拟显示器驱动；
- 本决策不提供 Linux 桌面支持。

## 替代方案

### 保持任意 VNC Server，并在网页裁剪完整 framebuffer

未选择。它无法可靠识别真实显示器边界，并会把 noVNC 不知道的 CSS 变换引入输入链路。即使额外上报 Windows 显示器几何，也仍需维护坐标逆变换，且不能解决不同 VNC Server 的行为差异。

### 为每个显示器运行独立 VNC 实例和端口

作为 `SetSW` 无法满足隔离要求时的候选回退，不作为默认方案。它需要多个 VNC 实例、端口和配置，可能争抢抓屏驱动或输入资源；切屏还需重建 Tunnel 与 RFB 会话，生命周期和诊断成本更高。

### 扩展标准 RFB/noVNC 的通用多屏布局支持

未作为本期主方案。即使解析 `ExtendedDesktopSize`，服务端也未必提供选择显示器的标准消息；实现范围会扩展到多个 VNC Server 的互操作。当前只为固定 UltraVNC 基线实现最小适配。

### 自建交互会话 helper 或按需会话投递

未选择。会新增 Windows 会话投递、常驻组件、自有捕获与编码协议，以及更大的安全和运维失败面。现有 UltraVNC 已在正确会话内提供成熟的捕获与输入能力。

### 从 Session 0 使用 DXGI Desktop Duplication 或 Windows.Graphics.Capture

不可行。Windows 会话隔离下，SYSTEM Client 的 Session 0 不能直接捕获其他用户交互会话的桌面。

## 已实测事实（2026-09-20）

下列值来自在 Windows 目标机上真实安装与验证的结果；它们是本决策落地时的具体锚点，完整可复现步骤与排查对照见 [`design/windows-ultravnc-setup.md`](../design/windows-ultravnc-setup.md)。

- 锁定版本：**UltraVNC 1.8.3.0 x64**（官方页面 `uvnc.com` → 直链 `uvnc.eu/download/1800/UltraVNC_1830_x64_Setup.exe`），SHA-256 `e9c22419…bd131e` 与官方公布值一致，Authenticode 为 `Valid`（签名主体为该项目维护者）。
- 安装目录：**`C:\Program Files\uvnc\UltraVNC`**（以卸载表 `InstallLocation` 为准，不能从安装器脚本推断）。
- 配置权威：**`C:\ProgramData\UltraVNC\ultravnc.ini`**；`setpasswd.exe` 也写该文件。仅回环由 `AllowLoopback=1` + `LoopbackOnly=1` 实现，另需 `AutoPortSelect=0` 锁死 5900（默认 `1` 会在被占用时静默顺延，使固定端口的隧道莫名失败）。
- **UltraVNC 强制要求口令**：未设口令时安全类型数量为 0 并拒绝连接（`This server does not have a valid password enabled...`）。因此“无口令”不可作为部署形态；且实测其 `passwd=` 存储格式不是经典 8 字节位反转，**只能经 `setpasswd.exe` 设置**，不得手工构造。
- 会话架构证据：服务模式下稳定出现**两个** `winvnc` 进程，分别为 Session 0（服务宿主）与 Session 1（交互会话内抓屏/注入），与本文决策 1 的会话边界要求一致。
- 服务名为 `uvnc_service`；配置变更后需杀净 `winvnc` 进程再起服务才会生效，且不得用 `Stop-Service -Force`（会卡在 `STOP_PENDING`）。
- **`SetSW` 实测（双 1920×1080 显示器，裸 RFB 客户端）**：6 字节消息 `0A 00 00 00 00 00`（类型 10，`status`/`x`/`y` 均置 0）即被接受并生效，无需构造坐标。效果为切换服务端**共享**捕获源：在一条连接上发送后，所有已连客户端均收到服务端推送；在另一条连接上发送后，**新建连接**的 ServerInit 尺寸由 `1920x1080` 变为 `3840x1080`（全部显示器）。
- **因此“精准显示源标签”实际不可得**：同尺寸多屏无法用尺寸区分哪一块在显示，且源码显示 `nr_monitors == 2` 时“全部显示器”的尺寸取自派生自当前所选屏的 `m_Cliprect.br`，两屏场景下报告尺寸本身可能不准。故 UI 只提供**循环式「切换到下一屏」**，不给屏幕编号（与决策 6 的降级一致）。
- 交付边界：**前端侧的 `SetSW` 显示器切换适配层尚未实现**；当前前端只保证完整桌面可看可操作，因此决策 6 的“精准显示源标签”仍未交付，不属当前能力。

## 验证与退出条件

固定 UltraVNC 版本前至少验证：

- Windows 10/11，单屏和双屏；
- 同分辨率、不同分辨率、左右排列和上下排列；
- Windows 缩放 100%/125%/150%，常见浏览器 DPR 与页面缩放；
- 每个显示源的四角、中心、双击和拖拽坐标准确性，误差不得随离中心距离线性放大；
- 适应、100% 和本地 50%–200% 缩放不改变远端分辨率；
- 普通登录、锁屏、UAC 和重新登录；
- direct 与强制 relay；
- 显示器热插拔后的状态失效与重新发现；
- 多 Viewer 并发时 `SetSW` 的隔离语义；
- 无活动显示输出时给出明确提示；
- UltraVNC 仅监听回环。

出现以下任一情况时停止精准选屏实施并回到架构评审：

- `SetSW` 会改变所有并发 Viewer 的全局状态且无法隔离；
- 当前显示源无法可靠确认，而产品不能接受 cycle-only；
- 接入 `SetSW` 必须大规模 fork noVNC 或破坏其 RFB parser；
- 固定 UltraVNC 无法稳定覆盖目标 Windows 版本、登录、锁屏或 UAC；
- 托管 UltraVNC 与现有 SYSTEM Client 安装模型产生不可接受的安全或生命周期冲突。

若退出条件触发，优先重新评估“每显示源独立 VNC 端口/会话”，不得恢复伪“左半/右半”裁剪。