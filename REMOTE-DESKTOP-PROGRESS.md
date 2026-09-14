# Remote Desktop 开发进度文档

> 目的:供维护者与新会话恢复上下文、继续开发。
> 本文档是**临时进度快照**,最终事实以代码、`packages/shared/src/`、Prisma schema、Accepted ADR 为准。
> 计划原文:`.tmp/plans/2026-09-11-webrtc-remote-desktop.md`;设计:`.tmp/specs/2026-09-11-webrtc-remote-desktop-design.md`。
> 最后更新:2026-09-13(会话内第 3 轮开发)。

---

## 1. 目标与架构(一句话版)

Browser 通过 WebRTC P2P 直连目标机器的特权 Rust Desktop Host,实现类似向日葵/UU 的远程桌面。
Server 只做认证、Session、租约、审计、信令转发;媒体/输入/剪贴板完全不经过 Server。

```text
Browser (React) ──/app Socket.IO 信令──> Server (NestJS) ──/client Socket.IO──> TypeScript Client
   │                                        │                                     │
   │ WebRTC P2P (视频/输入/剪贴板)           │ Prisma Session/Audit                 │ 本机 IPC
   ▼                                        ▼                                     ▼
   └────────────────► Rust Desktop Host ◄───┘(capability/state)◄── Named Pipe / Unix socket
```

- 协商方向固定:**Browser 是 offerer,Host 是 answerer**。
- Browser 必须在 `createOffer()` 前创建两条 DataChannel(`control-reliable`、`pointer-realtime`)并添加 recvonly 视频 transceiver,否则 offer 无 `m=application` 段,Host 侧通道永远协商不上(这是本轮修掉的关键缺陷)。
- 每个 Session 最多 1 operator + 3 viewer;operator 断线 30s 保护;全部离开 5min TTL。
- Server 不落盘:SDP、ICE、按键、剪贴板正文、TURN 凭据。

---

## 2. 当前验证状态(全部为最近一轮实测)

| 范围 | 结果 |
| --- | --- |
| Rust workspace 测试 | **126 passed**(0 个失败 suite) |
| `cargo fmt --all --check` | 干净 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 干净 |
| `@vcpdeck/shared` vitest | **154 passed**(10 文件) |
| `@vcpdeck/launcher` vitest | **102 passed**(12 文件) |
| Server remote-desktop + client.gateway | 78 passed(8 文件) |
| Frontend remote-desktop | **60 passed**(8 文件) |
| `scripts/install-coturn.test.cjs` | 11 passed |
| Frontend / Server / Client `tsc --noEmit` | 通过(需先 fresh build shared) |

**Rust 必须用 MSVC 环境**(`cargo` 不在裸 shell PATH):

```powershell
# 通过 .tmp/rust.cmd(内部先 call vcvars64.bat,再把 MSVC Hostx64\x64\link.exe 放 PATH 首位)
cmd /c ".tmp\rust.cmd test --manifest-path native\remote-desktop\Cargo.toml --workspace"
cmd /c ".tmp\rust.cmd clippy --manifest-path native\remote-desktop\Cargo.toml --workspace --all-targets -- -D warnings"
cmd /c ".tmp\rust.cmd fmt --manifest-path native\remote-desktop\Cargo.toml --all --check"
```

**TypeScript 顺序**(否则 stale dist 报"no exported member"):

```bash
pnpm exec tsc -b packages/shared/tsconfig.build.json --force
# 然后各包 tsc --noEmit / vitest
# 验证结束后:删除 packages/shared/dist/remote-desktop.* 等新增生成物,git restore -- packages/shared/dist
```

---

## 3. 已完成(代码 + 测试证据)

### Task 1 — Shared 协议 ✅

- `packages/shared/src/remote-desktop.ts`:严格 parser、错误码、Session/Attachment/Audit 状态、能力摘要、显示器、信令、限制常量、control/clipboard/host-control 消息。
- 能力摘要含 capability-driven 的 `secureAttention`(Ctrl+Alt+Del);控制消息含 `secure-attention`。两者都已在 Shared、Rust、Fixture、Browser 四层贯通。
- `packages/shared/protocol-fixtures/remote-desktop-v1.json`:**17 个用例**(signal/control/clipboard/capability,含正例、未知字段拒绝、snake_case 拒绝、unit 变体夹带字段拒绝);其中 control 类 8 个。
- Rust 通过 `parse_fixture()` 消费同一 fixture(`desktop-core/tests/protocol_fixture.rs`)。

### Task 2 — Prisma 持久化 ✅

- `schema.prisma`:`RemoteDesktopSession`、`RemoteDesktopAuditEvent`;migration `20260911000000_remote_desktop_sessions`。
- **生产 migration 未执行**(有约束,见 §7)。
- `remote-desktop-records.ts` 安全投影 + 测试(5 passed)。

### Task 3 — Server 域/REST/审计/broker ✅

- `remote-desktop.service.ts`(932 行):create→prepare→ready、单会话串行化、attachment 角色分配、保护期 reconnect、takeover、detach、5min TTL、`handleClientState` 收敛(含无 sessionId 的 idle/closed/error 对账、Host generation 同步、disconnect watchdog)。
- request broker、audit service、controller、module;**13+5+3+3 = service/controller/broker/audit 测试全过**。
- `ice-config.service.ts`(Task 17 部分,见下)已接入 module 并被 `attachBrowser` 使用(测试验证 iceConfig 注入)。

### Task 4 — 信令/角色/租约/收敛 ✅(基本)

- `app.gateway.ts` + `client.gateway.ts`:attach/detach/signal/takeover/response/state 路由,精确 socket 投递。
- `client.gateway.test.ts` **40 passed**,含 Remote Desktop 专项(binder、合法/非法 response、state 校验、disconnect 清理)。
- `remote-desktop-signaling.service.ts`:按 attachment 的字节/candidate/频率预算。

### Task 5 — SDK ✅

- `packages/sdk/src/remote-desktop.ts`:list/create/get/remove/audit,URLSearchParams、URL 编码、分页。

### Task 6 — Client IPC + bridge ✅

- `ipc-client.ts`:4 字节长度前缀、碎片重组、1 MiB 上限、严格 UTF-8/JSON/字段校验、requestId、超时、generation 校验、pending 全量失败。
- 默认端点选择(Windows Named Pipe / Linux `/run/vcpdeck/desktop-host.sock`,env 覆盖)。
- `protocol-bridge.ts`(verifyOnly 迁移模式)、`capability-probe.ts`(**finally 保证短生命周期 client 必然 close**)。
- 测试 9 passed。

### Task 7/8 — Rust 核心 + Host ✅(框架级)

- `desktop-core`:protocol(严格 camelCase serde)、session(SessionManager,MAX_ATTACHMENTS=4,LEASE 30s)、input(InputRouter)、clipboard、media、webrtc(control/pointer/clipboard 消息、challenge、PeerTransport、视频轨)。
- `desktop-core/src/host.rs`(本轮新增):`HostFrame`/`HostRequest`/`HostResponse`/`StateReport`、严格 action 路由(prepare/close/attach/detach/freeze/resume/signal/state)、challenge 发布、layout generation、`select_display`/`confirm_layout`、reap_expired。**17 tests**。
- `desktop-core/src/peer.rs`(本轮新增):Host 作为 answerer 的 `PeerManager`——接受 offer、挂视频轨、按 label 绑定通道、challenge 下发。**9 tests**。
- `desktop-host`:lib+bin,`transport.rs`(Unix socket 0600 + peer UID 校验 / Windows Named Pipe)、`runtime.rs`(HostRuntime 编排 service+peers)。**ipc_e2e 6 + signal_bridge 9 + lib 单测 5 = 20 tests**。
- 平台 mock:`platform-mock`(`MockBackend::new()` 测试用 / `unavailable()` 生产诚实上报)。**host_service 17 + lib 3**。
- 生产接线缺口:Host 默认 `MockBackend::unavailable("REMOTE_DESKTOP_UNSUPPORTED")`,能力诚实为 false;`session.prepare` 会被拒绝(`REMOTE_DESKTOP_CAPTURE_FAILED`/`NO_DISPLAY`)。这是**故意的**——没有真实平台后端就不得假装可用。

### Task 13 — Frontend ✅(基础)

- `remote-desktop-peer.ts`:**本轮修复——在 createOffer 前创建两条 DataChannel**(control: ordered;pointer: unordered+maxRetransmits 0),保留 ondatachannel 按 label 兜底;challenge-response(32 字节 nonce 校验、attachment 绑定、observer 异常隔离);ICE 缓存;可注入 connection factory。
- `remote-input.ts`:归一化坐标、keyCode、wheel 边界、freeze/resumeLayout(generation 匹配)、blur/visibility release-all;**Ctrl+Alt+Del 就地拦下并释放修饰键,暴露显式 `secureAttention()`**;鼠标按键跟踪 + 焦点驱动的保留组合键抢占。
- `remote-clipboard.ts`:off/browser-to-remote/bidirectional、严格解析、远端文本仅显式复制。
- `remote-desktop-peer.ts`:Browser offerer(offer 前建两条通道)、challenge-response、ICE 缓存;**五阶段恢复状态机 + `onStateChange` + `retry()` + `stats()`**。
- `remote-desktop-reconnect.ts`:恢复材料 sessionStorage 存取,严格校验 + 存取失败安全降级。
- `remote-desktop-stats.ts`(本轮新增):`summarizeConnectionStats` 纯函数,从 getStats 报告归纳直连/中继、RTT、码率、帧率。
- `remote-desktop-view.tsx`:video 绑定、显示器选择(freeze→select→layout-update→confirm→resume)、角色门禁、capability-gated Ctrl+Alt+Del 按钮;工厂 prop 只走 ref;恢复横幅 + 就地重试 + 路径标签 + 指针捕获(转发仍走 mouse 事件,捕获走 pointer 事件)。
- `remote-desktop-panel.tsx`:三档画质、剪贴板模式、capability gate;`supportsSecureAttention()` 纯函数校验能力并把结果传给 View。
- **60 tests**(peer 11、input 16、view 10、stats 6、reconnect 6、clipboard 4、panel 4、socket 3)。

### Task 17 — ICE/coturn ✅(代码部分)

- `packages/shared/src/ice-config.ts`:`parseRemoteDesktopIceDeployment`(p2p-only/relay-allowed、URL scheme/数量/长度、TTL 60–600s 钳制、p2p-only 禁 TURN)、`buildRemoteDesktopIceConfig`。**10 tests**。
- `packages/server/src/remote-desktop/ice-config.service.ts`:coturn REST HMAC-SHA1 短期凭据、TTL、username 三段化(冒号清洗)、凭据不落盘。**7 tests**。
- `deploy/coturn/turnserver.conf.template` + `docker-compose.yml`:STUN-only(`no-auth` 即拒绝全部 Allocate;不配 relay-ip/min-port/max-port;不映射 49152-65535)。
- `scripts/install-coturn.cjs`:模板/compose 静态护栏(剥离注释后校验中继指令与端口映射)、部署计划生成。**11 tests**。
- **未做**:真实 coturn 容器 STUN 绑定/中继不可用验证(`scripts/test-coturn.cjs` 需 Docker 主机)。

### 文档

- `docs/protocols.md`:Desktop Host IPC 帧格式/generation 回显/action 白名单、协商方向与通道创建规则、ICE 策略、角色 fail-closed。
- `docs/adr/0026–0030` 已写。
- `CHANGELOG.md` 未发布条目已更新。

---

## 4. 本轮发现并修复的真实缺陷(避免回归)

1. **Rust 协议字段名与 Shared 不一致**:`CapabilityStatus`/`DisplayInfo` 是 snake_case。原 fixture 只有负例,掩盖了问题(合法 camelCase 被拒、非法 payload 因字段名不匹配被误判为"非法")。→ 加正例,改 `#[serde(rename_all = "camelCase")]` + `virtual` 显式 rename,补 backend/codec/自洽校验。
2. **IPC 响应双重分帧**:`encode_frame` 已含长度前缀,`emit` 又调 `write_frame_async` 再加一层 → 客户端把前缀当 JSON 解析失败。→ 拆 `encode_framed`/`encode_body`。
3. **Browser 不创建 DataChannel** → offer 无 `m=application`,Host 侧通道永远协商不上。→ 前端在 `createOffer()` 前 `createDataChannel` 两条。
4. **通道绑定用数量判定** → 通道 LIFO 到达,只到 `pointer-realtime` 即"成功",Viewer 拿到指针通道而控制通道缺失。→ 改为"必需 label 集合是否齐全",且角色不允许的通道从不绑定。
5. **Host 可能默默提权** → 会话第一个 attachment 恒为 operator;Server 请求 `viewer` 时返回了 operator。→ 任何角色不一致都回滚 attachment 并返回 `REMOTE_DESKTOP_PERMISSION_DENIED`。
6. **capability probe 不关闭短生命周期 IPC client** → `finally` 保证 close。
7. **install-coturn 端口正则误匹配注释文本**、`--stun-public-ip <val>` 未消费参数值。
8. **coturn 配置错误**:`relay-ip=0.0.0.0` 实际会**启用**中继,与 STUN-only 目的相反 → 已移除,依赖 `no-auth`(TURN 强制鉴权,关闭即拒绝全部 Allocate)。
9. **unit 控制消息可以夹带未知字段**(安全相关):serde 的 `deny_unknown_fields` 对 internally-tagged enum 的 **unit 变体**不生效,`{"type":"release-all","extra":1}` 与 `{"type":"secure-attention","keyCode":46}` 会被接受。→ `decode_control_message` 改为先按 `type` 做键白名单校验再反序列化;新增 fixture 用例锁定。
10. **前端重渲染会重建整个远程桌面会话**:`RemoteDesktopView` 的 effect 依赖 `peerFactory`/`inputFactory`/`clipboardFactory` 等工厂 prop,父组件用行内函数重新渲染就会拆掉并重建 WebRTC 会话(丢帧、丢通道、重新握手)。→ 工厂只通过 ref 读取,effect 依赖收敛为 `[clipboardMode, sessionId]`。该 bug 是在写测试时发现的。
11. **Ctrl+Alt+Del 之前会被当作普通按键下发**:Windows 的 SAS 无法用按键注入送达,下发 Delete 既无效又可能在本机触发意外行为。→ 前端就地拦下组合、释放修饰键,改走显式 `secure-attention` 消息。
12. **输入永远到不了操作系统**(核心缺口):`ControlAction::InputAccepted` 只报告「已接受」而不携带事件,`next_pointer()` 从未被调用,也没有任何代码读取 DataChannel——控制消息被校验后即丢弃。→ `ControlAction` 改为携带事件本体,新增 `dispatch.rs` 映射平台调用,并在通道就绪后为每个 attachment 启动读取循环。
13. **授权状态存在两份**:`HostService.authorizations` 与 Host 运行态的 `control_sessions` 各自一份,导致通道上完成的认证永远不反映到 `is_authenticated` 与状态上报(测试里表现为“输入已到平台但 `is_authenticated` 仍为 false”)。→ 授权收敛为 `HostService` 单一权威,数据面任务共享同一 `ControlSession`;并补上通道绑定失败/数据面释放时的授权撤销(否则 Host 会保留没有可用数据面的 attachment)。
14. **重连不关闭旧 PeerConnection**:`teardownConnection()` 只丢弃引用而不调 `close()`,会留下仍在收集 ICE、持有编码器与连接的僵尸对象。→ 恢复与 `close()` 都真正关闭连接。
15. **并发重连会拿到两个 attachment**:socket `connect` 事件与重试定时器各自发起一次 attach(且 socket 断开时 `isConnected()` 可能仍为 true),其中一个 attachment 永远无人使用。→ 用在途标志串行化 attach,并把“立即重试”改成显式入参(socket 断等事件、ICE 失败立即)。
16. **显示器切换导致输入永久冻结**(功能性致命):Host 协议里没有 `layout-update` 消息,生产路径也从不调用 `HostService::select_display`/`confirm_layout`(无人调用的死代码)。Browser 与 Host 双双在 `display-select` 后冻结输入,等待一个永远不会来的布局广播——一次点击就把会话变成不可输入。→ 新增 `LayoutUpdate` 控制消息,Host 切换捕获目标后广播新布局;布局 generation 收敛为 `ControlSession` 单一权威。
17. **剪贴板消息会杀死整个控制循环**:剪贴板与控制消息共用 `control-reliable` 通道,而 Host 把入站帧全部当控制消息解析,一条 `browser-to-remote` 就解析失败并终止读取循环,连带输入全部失效。→ 新增 `decode_inbound_control_message` + `receive_control_raw`,先按 `type` 分流再各自严格解析。
18. **Viewer 可以切换显示器**(权限提权):`display-select` 只检查了是否认证,唯一的角色检查留在死代码 `HostService::select_display` 里;Viewer 能冻结整条会话输入并改操作者的显示目标。→ `ControlSession` 直接拒绝非 Operator 的 `display-select`。

**模式提醒**:缺陷 13、16、18 都是同一个模式——“带副作用的操作检查被写在无人调用的那份重复状态里”。发现生产路径与带测试的 API 不连通时,优先怀疑重复状态,而不是新增一份并行实现。

---

## 5. 剩余工作(按建议优先级)

> **关键更正(已修复)**:生产 Host 入口 `run()` → `serve_connection()` 曾直接使用裸
> `HostService`,**从不构造 `HostRuntime`**;`HostService::handle_signal()` 只返回
> `json!({})`。当时 `HostRuntime` 与 `PeerManager` 在生产路径上不可达,Browser 永远
> 收不到 answer。现已修复,并新增串联测试锁定。
>
> 教训:`ipc_e2e.rs` 测 `serve_connection`、`signal_bridge.rs` 测 `HostRuntime`,两边都绿,
> 却没有一条测试把两者连起来——分开验证不等于链路闭合。任何“新组件/新入口”都要有
> 一条**穿过真实入口**的测试。

### 0. 阻塞其余一切的断点(✅ 已修复)

- [x] `serve_connection` / `run()` 已改用 `HostRuntime<B>`（`build_runtime`/`build_runtime_with`）；`session.signal` 现在执行真实 SDP 协商，响应写出后后台 `pump()` 完成通道绑定与 challenge 下发
- [x] 新增串联测试 `production_entry_point_answers_a_real_offer`：走真实 `serve_connection` → prepare → attach → 真实 offer → 断言真实 answer（`m=video`/`a=sendonly`/`m=application`）;修复前此用例必失败
- [x] 已核实 Client bridge → Host IPC → 协商 的完整闭环（Client 侧已转发 `REMOTE_DESKTOP_REQUEST`）
- [ ] 连接关闭时释放数据面（当前 `serve_connection` 退出不会 `release_all`）
- [ ] 仍然缺真实平台后端：生产 Host 依旧诚实上报 `available=false`，因此**单机真实端到端仍需先做 Task 9**

### A. Frontend 生产交互收口 ✅ 完成

- [x] 键盘安全快捷键:Ctrl+Alt+Del 拦下 + capability-gated 显式 SAS 动作
- [x] 修复工厂 prop 导致的会话重建隐患
- [x] Panel → View 传递 `secureAttentionSupported`
- [x] **断线/重连/重新协商状态机**:`connecting/connected/reconnecting/failed/closed` + `onStateChange`;socket 断开与 ICE 失败走同一恢复流程;30s 窗口;恢复材料 sessionStorage
- [x] 再次协商提示与恢复:恢复横幅 + 失败后**就地重试**(`RemoteDesktopPeer.retry()`)
- [x] 浏览器保留组合键抢占:`isBrowserReservedShortcut` + 焦点驱动的 `setCaptureActive`;保留 Escape/Tab/F12 为退出通道
- [x] 鼠标拖拽状态:按键跟踪 + 指针捕获 + 丢失捕获时释放(转发走 mouse 事件,捕获走 pointer 事件)
- [x] connection stats + Direct/Relay 投影:`summarizeConnectionStats` 纯函数;解析不出就报 unknown,绝不编造
- [x] 完整 display topology 同步:不再伪造 `physical`/`virtual`/`primary`
- [x] 剪贴板两个方向与显式复制交互均接通

### B. Host 媒体数据面(真实视频)

- [x] **输入真正落到平台**:控制/指针通道读取循环 + `dispatch::apply_control_action` + `DesktopBackend::{inject_input,secure_attention,select_display,write_clipboard_text}`;授权收敛为 HostService 单一权威
- [x] **显示器切换广播 `layout-update`**:新增协议消息 + 平台切换 + generation 收敛为 ControlSession 单一权威(删掉死代码 `HostService::select_display`/`confirm_layout`/`LayoutState`)
- [x] **剪贴板入站分流与写入平台**:`decode_inbound_control_message` + `receive_control_raw`
- [x] **远端剪贴板反向推送**(`remote-to-browser`):`ControlSession::clipboard_to_browser`(去重 + 回声抑制 + 模式/角色/大小校验) + `DesktopBackend::read_clipboard_text` 轮询;前端接收侧已有显式复制交互
- [ ] 平台 capture → 编码器 → `send_encoded_sample` 的生产循环
- [ ] 关键帧请求(PLI)、码率/拥塞自适应(RTCP stats → QualityProfile)
- [ ] `runtime.pump()` 接入 IPC 服务循环(已完成信号响应后的 challenge 路径,但连接空闲时不会主动 pump)
- [ ] 剪贴板轮询接入平台变化通知(当前为有界轮询;真实后端可用平台序列号/监听降低开销)

### C. 平台后端(Task 9–12,需真实 API/硬件验收)

#### 库选型评估(已完成调研,建议作为后续方向)

目标:尽量复用成熟库而不是手写,并优先跨平台。实测可用版本(经代理拉取 crates.io index):

| 库 | 最新版 | 平台 | 评估 |
| --- | --- | --- | --- |
| `windows-capture` | **2.0.1** | 仅 Windows(WGC + DXGI) | **最成熟(2.x)**;自带文件向 VideoEncoder(不适用流式) |
| `scap` | 0.1.0-**beta.1** | Win/Linux(PipeWire)/macOS | **beta,不宜用于 Tier 1 生产** |
| `pinray` | 0.2.4 | Win(DXGI/WGC)/Linux(PipeWire/X11) | 很新;Wayland **窗口捕获尚不支持**(显示器捕获可用) |
| `xcap` | 0.9.8 | Win/Linux/macOS | **视频录制仍 WIP**(仅截图) |
| `openh264` | 0.9.8 | **跨平台**(Win MSVC/Linux/macOS) | 可用的**软件** H.264 编解码 |

**结论**：

- **捕获**：目前**没有成熟且涵盖 Tier 1 四后端的跨平台库**。跨平台候选均为 pre-1.0/beta 且有 Wayland 限制。建议：Windows 用 `windows-capture`(成熟)；Linux 优先评估 `pinray`/`scap` 但视为风险依赖，**必须藏在 `DesktopBackend` 抽象后以便替换**；纯 X11 需确认是否存在非 PipeWire 路径。
- **编码**：**不存在成熟的跨平台硬件 H.264 库**。硬件保持平台特有（Windows MF、Linux VAAPI）；软件路径可用 `openh264` 统一跨平台（替代手写 MF 软件路径）。
- **替代**：ffmpeg 跨平台且有硬编，但是外部进程 + **GPLv3** 分发贵任（详见上文 encoder 一节）。

#### 手写后端现状(已存在,建议逐步被库替代)

- [ ] Windows:Graphics Capture/Desktop Duplication、SendInput、Media Foundation 探测、Session Helper、IddCx 虚拟显示驱动、登录屏/锁屏/会话切换
- [ ] Linux X11:logind/XRandR/XTest、XAUTHORITY 校验、dummy headless 输出
- [ ] GNOME/GDM Wayland:Mutter RemoteDesktop/ScreenCast D-Bus、PipeWire、EIS/libei、虚拟显示器
- [ ] KDE/SDDM Wayland:KWin 接口、虚拟输出所有权
- [ ] 这些必须结合 Tier 1 真机验收,不能用 mock 伪报完成

### D. Supervisor / 签名 / 迁移(Task 14–16)

#### Task 15 签名基础(部分完成:纯逻辑与密码层已就绪,尚未接入生产路径)

- [x] Shared 纯逻辑 `release-signature.ts`:规范化字节(键排序、拒绝非有限数与 undefined)、严格解析(未知字段/平台/角色/digest/大小/重复路径全部拒绝)、`assertArtifactMatches`、`assertLauncherVersionSatisfies`(按数字段比较,字符串比较会把 1.9.0 误判大于 1.10.0)、`assertArchiveEntriesAllowed`(拒绝越界/绝对路径/盘符/反斜杠、大小写不敏感重复、未声明可执行文件、缺失构件、与声明矛盾的可执行位)
- [x] Launcher `release-signature.ts`:Ed25519 签名与验签(`node:crypto`);信任根由调用方内置传入,不从待验证 Release/Server 响应/同一下载位置取得;验签前先严格解析声明;信封 `keyId` 与声明 `keyId` 必须一致;签名固定 64 字节校验
- [ ] **接入生产路径(立即下一步)**:`pack-release.ts` 生成真实 `ReleaseDeclaration` + 签名信封;`UpdateRequest`/SDK/Server 携带声明;Launcher 在 `prepare`/`apply` 前调用验签 + 构件哈希 + archive allowlist
- [ ] **`launcherMinVersion` 实际生效**:目前 `scripts/pack-release.ts:517` 硬编码 `"0.0.0"`,即使接入门禁也不会触发;需改为由发布配置提供,并在 Launcher `startCurrent` 处强制执行(ADR-0028 决策 6)
- [ ] 内置受信公钥的配置面(环境变量/配置文件)与密钥轮换重叠期
- [ ] 平台代码签名(Windows Authenticode / Linux 包签名)作为附加门禁

#### Task 9 Windows 后端（第一切片已完成）

- [x] 新 crate `platform-windows`：真实 Win32 显示器枚举（`EnumDisplayMonitors` + `GetMonitorInfoW`，并与 `SM_CMONITORS` 对账）、输入注入（`SendInput`：指针/按键/滚轮/键盘 + 释放全部）、剪贴板读写（`CF_UNICODETEXT`）
- [x] 已接入生产：`desktop-host` 在 Windows 上使用 `build_runtime_windows()`（真实平台路径，不再走 mock）
- [x] 诚实能力：捕获/编码器未实现时 `capture=false` 且 `available=false`，诊断码 `REMOTE_DESKTOP_ENCODER_UNAVAILABLE`；`secure_attention` 仍返回 Unsupported（能力驱动）
- [x] 多显示器坐标映射抽成纯函数 `map_point(monitor, vscreen, x, y)` 并有确定性测试
- [x] 本机实测 7 个测试通过（显示器数量对账、映射、剪贴板往返、越界按键拒绝等）
- [x] **捕获（GDI BitBlt 有界回退）**：真实抓帧为 BGRA8，`capture` 能力**真实探测**（构造时真跑一次 BitBlt）；`CapturedFrame::to_i420()` 在 desktop-core 做 BT.601 limited range 转换（纯计算，有确定性数值测试）
- [x] 本机实测 10 个测试通过（含真实抓帧尺寸/非全黑、未知显示器失败、I420 数值、多显示器映射）
- [x] **编码器探测（Media Foundation MFT）**：新加 `windows` crate 依赖（`windows-sys` **没有** MF 模块），真实枚举 H.264 编码器；本机实测识别出 `NVIDIA H.264 Encoder MFT`（hardware=true, vendor=nvenc, **asynchronous=true**）与微软软件编码器（hardware=false, asynchronous=false）；`hardwareEncoders` 现为真实探测结果，且探测结果包含**是否异步**（决定编码循环形态）
- [ ] **实际编码循环**（`IMFTransform` 配置 + `ProcessInput`/`ProcessOutput` + 码流 → Annex-B）；缺它 `supportedCodecs` 保持为空、`available` 仍为 false
  - **关键发现（改变设计）**：硬件编码器 MFT 普遍是**异步**的。本机实测 NVIDIA H.264 MFT `asynchronous=true`，微软软件 MFT `asynchronous=false`；AMD AMF 与 Intel QSV 同样属异步类。因此编码器**必须支持事件驱动**（解锁 `MF_TRANSFORM_ASYNC_UNLOCK` + `IMFMediaEventGenerator` 的 `METransformNeedInput` / `METransformHaveOutput`），同步 `ProcessInput` 写法在任何有硬编的机器上都跑不通。
  - **厂商中立要求**：不得针对特定厂商硬编码。应按“硬件优先、软件回退”的顺序尝试候选编码器，并对同步/异步两类分别处理；候选集从 MFT 枚举获得（已按 `vendor_from_name` 归一化 nvenc/qsv/amf）。
  - **建议分两步**：先做**同步路径**（每台 Windows 都有的微软 H.264 软件 MFT，厂商中立且立即可验证），让 `available` 能诚实翻转为 true；再补异步硬件路径作为优化。
  - **进度（A1 部分完成）**：`encoder.rs` 已实现厂商中立的同步编码器配置（枚举候选 → 跳过异步 → 硬件优先/软件回退 → 设输出 H.264 类型 + 逐候选协商输入 NV12/I420 → 发送流式消息）。**配置已稳定验证通过**。但 `encode()` 仍不产出码流（连续嗂 8 帧 `ProcessOutput` 始终返回 `NEED_MORE_INPUT`），因此 `available` 仍为 false、模块**未接入生产路径**（以 `allow(dead_code)` + 注释标为待办）。
  - **已修的两个真 bug**：（1）输出样本所有权搞反（未按 `MFT_OUTPUT_STREAM_PROVIDES_SAMPLES` 分支）会 `STATUS_ACCESS_VIOLATION`；（2）MF 生命周期错序（`select_sync_encoder` 在 `ActivateObject` 之前就 `MFShutdown`）导致配置时好时坏——严重时单跑必失败。
  - **下一步待查**：输入样本应用 `MFSampleExtension_CleanPoint` 属性（而非现在无意义的 `SetSampleFlags(0)`）；或还需手动发 `MFT_MESSAGE_COMMAND_FLUSH` 等消息。
- [x] **媒体循环已接通（首次真实端到端数据面）**：
  - `desktop-core::encoder`：`VideoEncoder`（线程独享，不要求 Send）+ `EncoderFactory`（`Send + Sync`，只持配置）——因为平台编码器持有套间资源（COM），不能放进 `Send + Sync` 的 backend
  - `peer.rs`：**保存视频轨道**（之前 `add_video_track` 的返回值被丢弃，导致无从发送）+ `broadcast_sample`（**一次编码、多路扇出**）
  - `HostRuntime::pump_media` + `MediaOutcome`（`NoViewer`/`NoEncoder`/`Failed`/`WarmingUp`/`Sent(n)`）
  - `spawn_media_loop`：**独占线程 + `current_thread` 运行时**（多线程运行时会迁移任务线程，破坏 COM 套间归属）
  - `run()` 在 Windows 上以 33ms 间隔启动媒体循环
- [x] **能力现为真实且自洽**：本机实测 `available=true  capture=true  codecs=["H264"]  hardware=["nvenc"]`；真实捕获 1920×1080 → 真实 MF 编码 60 帧共 206116 字节
- [x] **低延迟配置（已完成，收益显著）**：按 Microsoft 官方文档在 `SetOutputType` 之前设置 `CODECAPI_AVLowLatencyMode` / `AVEncCommonLowLatency` / `AVEncCommonRealTime` / `AVEncMPVDefaultBPictureCount=0` / `MF_LOW_LATENCY`。实测 lookahead **16 帧 → 0 帧**（首帧即产出，0.53s 延迟消除）；代价是压缩率下降（60 帧 206116 → 342913 字节，与文档所述“可能降低质量”一致）。已加**延迟回归护栏**防止配置丢失后静默退回。
- [ ] 异步硬件编码路径（NVENC/QSV/AMF 都是异步 MFT）
- [ ] 关键帧请求（PLI）与码率/拥塞适配
- [ ] 浏览器侧真实端到端验收（单机）
- [ ] 库替换：`windows-capture` 换 GDI 捕获；`openh264` 统一跨平台软件编码

  **关键设计约束（试过并被编译器拦住，已确认）**：**编码器不能存在 `DesktopBackend` 里**。
  Media Foundation 的 `IMFTransform` 内含 `NonNull<c_void>`，**不是 `Send`/`Sync`**（COM 对象有套间归属），
  而 `DesktopBackend: Send + Sync`。尝试把 `Mutex<Option<H264Encoder>>` 放进 backend 会直接编译失败。

  因此正确形态是：**编码器由媒体循环线程独占**，通过一个 `Send + Sync` 的**工厂**在该线程上创建：

  ```rust
  // desktop-core（不要求 Send/Sync，归媒体循环线程所有）
  trait VideoEncoder { fn encode(&mut self, frame: &CapturedFrame, key_frame: bool) -> Result<Option<Vec<u8>>, DesktopError>; }
  // 工厂只持配置，不持 COM 对象，所以可以放进 backend/运行时
  trait EncoderFactory: Send + Sync { fn create(&self, w: u32, h: u32) -> Result<Box<dyn VideoEncoder>, DesktopError>; }
  ```

  已就绪的基础件：`platform_windows::encoder::annex_b_contains_idr()`（纯函数，从 NAL 类型准确判定关键帧，
  已用于 RTCP/PLI 与前端提示）；Windows 后端已实现并验证 `capture_frame`。
- [ ] 编码器优先选择策略（硬件优先、失败回退软件）
- [ ] 关键帧请求（PLI）与码率/拥塞适配
- [ ] GPU 捕获路径（WGC/Desktop Duplication）；当前 GDI 路径是计划里允许的回退
- [ ] DPI 缩放探测（现在如实报 100，不猜）
- [ ] Session Helper / 登录屏 / 锁屏 / 用户切换（需 Session 0 边界）
- [ ] IddCx 虚拟显示驱动（`OrayIddDriver`/`GameViewer` 已存在于本机，可用于先验证“无物理显示器”场景）

#### Task 14 Supervisor(核心已就绪,平台注册未开始)

- [x] `supervision-policy.ts`:从既有 `Daemon` 抽出退避语义(指数退避、封顶、稳定窗口后计数清零);纯逻辑,无计时器
- [x] `supervisor.ts`:多组件顺序启动、启动失败**逆序回滚**、健康检查与按策略重启、放弃阈值(放弃后不再重复检查)、稳定窗口后重置重试预算、逆序幂等停止、单组件失败不影响其它组件、空/重名组件拒绝、生命周期日志
- [x] `components.ts`:Daemon 适配器(`stopSupervised`/`healthCheck`)、子进程组件(只有 `spawn` 事件才视为启动成功;停止先 SIGTERM 后超时 SIGKILL)
- [x] `DaemonConfig.manageSignals`(默认 true,保持既有行为) + `main.ts` 的 `VCPDECK_LAUNCHER_MODE=supervisor`(Supervisor 独占信号)
- [ ] **平台注册**:Windows LocalSystem Service / Linux root systemd unit;不依赖 PM2、登录任务、linger、用户 Shell
- [ ] 真实组件接入:Desktop Host、Session Helper 需要 Task 9–12 的平台后端
- [ ] 能力级健康检查(现在只有进程存活 + Daemon 的探活):Host IPC 可达、注册成功、**WebRTC loopback**、捕获/输入/编码、物理/虚拟显示能力
- [ ] Windows Console Session / Linux logind Seat 发现
- [ ] 组件版本一致性检查与 Supervisor 自身可验证更新(verify→stage→replace→health→restore)
- [ ] `SupervisionPolicy` 与 `Daemon` 内部重启逻辑合并为单一实现(现在两处语义一致但是两份代码)

#### Task 16 事务迁移(未开始,依赖 Task 14 平台注册)

- [ ] `scripts/migrate-supervisor.cjs`:事务日志、restart-idempotent、保存旧现场→安装新体系→停旧不删→自检 + 携带 migration nonce 的 Server 回连验收→才能提交删除旧机制;任一步失败完整回滚并确认旧 Client 重新上线;迁移期间同一 Client ID 不得新旧同时在线

### E. 收尾

- [ ] `scripts/test-remote-desktop-e2e.cjs`、平台矩阵 runner、`scripts/test-coturn.cjs`(真实 Docker)
- [ ] Task 18 文档同步(Current docs)、`.github/workflows/remote-desktop.yml`
- [ ] 全量 `pnpm build`/`pnpm test`/`pnpm lint`(Biome)、`git diff --check`、GitNexus `detect_changes`
- [ ] 删除 `.tmp/specs`、`.tmp/plans`、`.tmp/run-rust-msvc.cmd`、`.tmp/rust.cmd`(验收后)

---

## 6. 关键文件地图

```text
packages/shared/src/remote-desktop.ts        协议事实来源(严格 parser)
packages/shared/src/ice-config.ts            ICE 部署解析/组装
packages/shared/protocol-fixtures/...json    跨语言 fixture(Rust parity 消费)
packages/server/src/remote-desktop/          service/controller/broker/audit/signaling/ice-config
packages/server/src/events/{app,client}.gateway.ts   /app 与 /client 路由
packages/sdk/src/remote-desktop.ts           REST 客户端
packages/client/src/remote-desktop/          ipc-client / protocol-bridge / capability-probe
packages/frontend/src/remote-desktop/        peer / input / clipboard / view / panel / socket
native/remote-desktop/desktop-core/src/      protocol session input clipboard media webrtc host peer
native/remote-desktop/desktop-host/src/      lib(main 实现体) transport runtime + bin main.rs
native/remote-desktop/platform-mock/         MockBackend(测试) + unavailable()(生产诚实上报)
deploy/coturn/                               STUN-only 模板 + compose
scripts/install-coturn.cjs                   部署前静态护栏
.tmp/rust.cmd                                MSVC cargo 包装器(勿提交)
```

### Rust 测试分布(97)

protocol_fixture 1 · session_lifecycle 2 · codec 2 · **clipboard 7** · input_gate 2 · adaptation 3 · webrtc_auth 12 · webrtc_loopback 3 · **host_service 17**(platform-mock)· **peer_negotiation 10** · **ipc_e2e 6** · **signal_bridge 16** · **input_dispatch 8**(platform-mock)· desktop-host lib 5 · platform-mock lib 3

### 控制协议速查(wire format)

```json
{"type":"input","event":{"kind":"key","keyCode":65,"pressed":true}}
{"type":"input","event":{"kind":"wheel","deltaX":4,"deltaY":-12}}
{"type":"release-all"}
{"type":"display-select","displayId":"display-2"}
{"type":"layout-confirm","layoutGeneration":8}
{"type":"challenge","nonce":[…32],"attachment_id":"rda_…"}      // Host→Browser,snake_case attachment_id
{"type":"challenge-response","nonce":[…32],"attachment_id":"…"} // Browser→Host
{"type":"browser-to-remote","text":"…"}                          // 剪贴板
```

IPC 信封:`{"protocolVersion":1,"generationId":"<client 生成,Host 原样回显>","kind":"request|response|state","payload":…}`
State report:`{"protocolVersion":1,"hostGeneration":…,"sessionId":…,"status":"idle|preparing|ready|connected|frozen|closed|error","capability":…,"displays":…,"safeErrorCode":…}`

---

## 7. 约束与环境备忘

- 不提交、不推送、不切分支;生产 DB migration 未执行;无真实驱动安装/发布/部署。
- 工作树约 220+ 既有修改(含历史 tracked dist 生成物),**不能**全量 reset/restore;`.gitignore` 已加 `packages/*/dist/`,但已跟踪的旧 dist 仍会显示 modified。
- `packages/shared/dist` 是 **已跟踪** 的构建产物,因此 `.gitignore` 对它无效。若在 fresh build 后 `git restore -- packages/shared/dist`,shared 的新导出(如 `secureAttention`)会从 dist 消失,而 frontend/server 通过 `node_modules/@vcpdeck/shared` 读的正是 dist,`tsc` 会直接报 “has no exported member”。**保持 dist 与 src 同步才是一致状态**;只有在确定要提交且不想带上生成物时才恢复。
- pi-lens 的 `rust-clippy` deferred runner 会报 unknown:环境问题(cargo 不在裸 shell PATH),用 `.tmp/rust.cmd` 验证。
- `git diff --check` 既有无关问题:`packages/server/src/events/client.gateway.ts:89: space before tab in indent.`(非本轮引入)。
- GitNexus 未建索引,impact/detect_changes 不可用(计划要求修改符号前跑,当前只能靠测试覆盖兜底)。
- Rust 测试中的 `.expect()` 会触发 pi-lens `rust-expect` 建议:标准 Rust 测试写法,忽略。
- 机器测试放最后:先完成上述 A–D 代码任务,再设计真实机器/平台矩阵验收(登录、锁屏、用户切换、物理/无显示器、热插拔、输入、剪贴板、重连、迁移回滚)。

---

## 8. 恢复开发的第一步(建议)

1. 读本文档 §2 跑一遍验证命令,确认基线全绿。
2. 从 §5-A(Frontend 生产交互,已开局)或 §5-B(Host 媒体循环)继续;两者互不阻塞。
3. 若做 Rust:改动前跑 `cmd /c ".tmp\rust.cmd fmt --all"`,提交前跑 test + clippy + fmt --check。
4. 若做 Server/前端:先 `pnpm exec tsc -b packages/shared/tsconfig.build.json --force`。
5. 行为变更遵循 TDD;新跨语言字段必须同时进 fixture 并让 Rust parity 测试消费。
6. 每完成一个可验证块,更新本文档 §3/§5,并让下个会话能从 §2 直接续跑。

### 下一步具体切入点(按价值排序)

1. **Host 媒体循环**:平台 capture → 编码器 → `send_encoded_sample`;当前仍无真实视频帧。没有它,重连后也没有画面可恢复。这是唯一必须依赖真实平台捕获 API 的一块。
2. **平台后端(Tasks 9–12)**:Windows/X11/GNOME/KDE + 虚拟显示;必须结合真实机器验收。
3. **Supervisor / 签名 / 迁移(Tasks 14–16)**。

**前端与协议侧的代码工作已全部完成**(§5-A 全部勾选;§5-B 除媒体捕获与平台通知外均已接通)。接下来剩余的均为平台工程,必须结合真实硬件验收。
