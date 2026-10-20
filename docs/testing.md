# VCPDeck 测试策略

> 状态：Current｜维护责任：各包维护者/发布维护者｜最后核验：2026-10-12｜适用版本：`0.19.2` / 当前 `main`

## 1. 目标

测试必须覆盖的不只是成功 API，还包括跨进程协议、断线对账、路径/凭据安全、状态机并发、真实 PTY/FRP 和发布回退。

## 2. 测试层次

| 层次 | 工具/位置 | 适用内容 |
| --- | --- | --- |
| Shared 单元测试 | Vitest，`packages/shared/src/*.test.ts` | parse 函数、错误码、状态和边界常量 |
| Server 单元测试 | Vitest，模块旁测试 | Service 状态机、Controller 映射、Prisma mock |
| Client 单元测试 | Vitest | dispatcher、executor、文件路径、PTY/终端 supervisor |
| SDK 单元测试 | Vitest | URL、认证头、分页、错误归一化 |
| CLI 单元/本地集成测试 | Vitest，`packages/cli/src/*.test.ts` | 多环境严格配置、选择优先级、项目查找、凭据引用、命令与 Release SDK 接线 |
| Frontend 组件测试 | Vitest + Testing Library + jsdom | 路由、状态、交互、敏感信息不渲染 |
| 包内集成测试 | `*.integration.test.ts` | Server Gateway/Broker、Client、Terminal |
| 脚本级离线回归 | [scripts/tests/unit/](../scripts/README.md#6-tests离线回归与公共-helper) | `pnpm test:scripts` 运行 Node/TSX；夹具、adapter、临时 SQLite/目录及 loopback；Shell 单列 |
| 项目 E2E | [scripts/tests/e2e/test.cjs](../scripts/tests/e2e/test.cjs) | 真实 Server + mock/真实 Client + REST/WS；隔离 DB，但强杀 3001 占用者 |
| CLI 能力 E2E | [scripts/tests/e2e/test-cli-capabilities.cjs](../scripts/tests/e2e/test-cli-capabilities.cjs) | 真实 Server + Client 驱动 CLI 构建产物；隔离 DB/假 HOME 与文件夹具，仍有端口终止和真实远端文件操作 |
| VCP 插件 E2E | [scripts/tests/e2e/test-vcp-plugin.cjs](../scripts/tests/e2e/test-vcp-plugin.cjs) | 真实外部 VCPToolBox、Server/Client/FRPS；隔离 DB/沙箱，需构建和外部环境，不是离线回归 |
| FRP E2E（手工） | [scripts/tests/manual/test-frp.cjs](../scripts/tests/manual/test-frp.cjs) | 真实 frps/frpc、TCP/HTTP；**使用开发库、删除全部 frpMappings、终止端口占用进程** |
| Launcher 冒烟 | [scripts/tests/e2e/smoke-launcher.cjs](../scripts/tests/e2e/smoke-launcher.cjs) | prepare/apply、探活、失败回退；PowerShell、3999 端口和临时进程 |
| 手工/环境验收 | `docs/verification/` | Windows PTY、外部存储、真实网络和发布演练 |

## 2.5 集成 / 真实环境测试方法论（跨网络 / 原生依赖 / 第三方服务）

> 适用于「特性依赖真实网络拓扑、原生绑定、或外部服务（FRP/存储后端/真实浏览器）」的场景。单元与包内集成测试只覆盖逻辑，**真实字节流动必须另起真机验证**。以下从跨网络链路实战提炼，可复用于 FRP、Storage、Release 等同类特性。

**（1）三层验证，逐层闭合**
- 逻辑层：Shared parser / Service 状态机 / 前端路径分类 —— 单测覆盖（见 §2）。
- 组件层：**每个真实依赖各验各的**，互不假设。例：frps 能跑、Client 的 frpc 能连上、映射端口可达、整条映射 E2E 通 —— 各自独立 PASS。
- 端到端层：字节真过网络（客户端→frps→目标端口）。**只有这一层能证明「转发真的生效」**，组件层全 PASS 也不等于它 PASS。

**（2）第三方服务用其「自带权威客户端」做 A/B 对照**
- 别自己手写 raw 协议客户端去验服务端——**用该服务官方/自带的客户端**最可靠。例：验 FRP 用 `frpc/frps` 自带探测与 Dashboard API，空凭据与有效凭据各跑一次做对照；存储后端用其 SDK 直连。
- 同理：PTY 用 `scripts/tests/e2e/terminal-smoke.cjs` 这类真实终端入口验证，而不是只断言 DTO。

**（3）浏览器行为必须用真实浏览器验证**
- headless 环境可能缺少真实浏览器的网络/渲染能力，**会误判**。需要判定浏览器侧行为时，用 Playwright 驱动**系统 Chrome**（headful、确认 `navigator.webdriver`、无 `--proxy-server`）。
- 测试页应能自驱（注入凭据、可选模式参数），并读取可观测证据（`getStats()`、DOM 状态、网络日志）而不是只看「没报错」。

**（4）网络隔离与定位技巧**
- 用隔离网络（Vagrant/VirtualBox、host-only 网段）复现跨网络问题；必要时**同一服务绑多张卡**以区分「够不到」vs「客户端没触发」。
- 判定「客户端是否真发包」：**在服务端看日志**，比看客户端状态更硬。
- 换网络复测仍复现 → 根因在客户端/环境，非服务端配置。

**（5）区分「组件可用」与「端到端连通」，诚实记录边界**
- 若某层在本机环境无法复现（如受限 VM 网络下中继路径不触发），**不要硬凑**：记录「各组件独立验证可用 + 该层待两台不同网络真机复测」，逻辑上已闭合；验收文档给出真机步骤即可。
- 验收文档必须含：**前置 / 步骤 / PASS-FAIL 判定 / 证据（看什么日志/状态）/ 常见 FAIL 排查**，让人能照做打勾。

**（6）收尾清理**：测试 VM `vagrant destroy -f`（或 `VBoxManage unregistervm --delete`）、`.tmp/` 脚手架、测试进程与端口。`.tmp/` 被 git 忽略，不留痕。

## 3. 标准命令

```bash
pnpm install
pnpm -r test
pnpm test:scripts
pnpm lint
pnpm build
pnpm test
```

`pnpm lint` 由根目录 `biome.json` 驱动（Biome，仅 linter 不含格式化；覆盖 `packages/*/src` 与 `scripts`）：错误级诊断阻塞门禁；降级为 warning 的规则（NestJS DI 未使用参数、noExplicitAny、非空断言等）为已知技术债，新增代码不应新增此类告警。

`pnpm test:scripts` 仅运行 Node/TSX 离线脚本回归，不包含 Shell、真实 FRP、云盘、PTY 或系统安装；可能启动临时子进程、SQLite、loopback 服务并写删夹具。Shell 回归需 Bash，单列运行：

```bash
bash scripts/tests/unit/install-client-bootstrap.test.sh
```

各文件用途、依赖、副作用及保留的公开安装根路径见 [脚本清单](../scripts/README.md)。


按包：

```bash
pnpm --filter @vcpdeck/shared test
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/cli test
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/launcher test
```

真实 FRP 全链路（**仅专用可丢弃环境**；当前会使用开发库、删除全部 `frpMappings`，并终止 `3001` 及测试 FRPS 相关端口占用进程；先备份，不能与开发/生产实例并行）：

```bash
pnpm download:frp
pnpm build
pnpm test:frp
```

Launcher：

```bash
pnpm --filter @vcpdeck/launcher build
node scripts/tests/e2e/smoke-launcher.cjs
```

`pnpm test` 使用隔离临时数据库，但会强制停止 3001 占用进程；`pnpm test:cli` 同样不能与开发 Server 并行。它们的 DB 隔离不能推广到手工 FRP 脚本。FRP 输出 `SKIP` 不算通过。Launcher smoke 当前依赖 PowerShell 构造 ZIP，部分失败出口可能绕过 finally，结束后需核对进程、3999 端口和临时目录。

只需为本地集成联调启动真实 frps 时，不必运行上述破坏性 FRP 脚本：

```bash
pnpm download:frp
node scripts/dev/start-test-frps.cjs --port=17000 --dashboard-port=17500 --token=<local-test-token> --clean
```

替换为专用本地测试 Token，并保持该终端运行，按 Ctrl+C 停止。该入口真实启动 frps；Dashboard 绑定全部接口、使用 `admin/admin`，配置/输出含明文测试 Token，只用于隔离可信本地网络。实际环境变量和 Server 接线见 [脚本清单](../scripts/README.md#保留启动真实本地-frps) 与 [README](../README.md#启动本地-frps-测试实例)。

CLI 能力端到端：

```bash
pnpm build          # 需先构建 server/client/cli
pnpm test:cli       # 即 node scripts/tests/e2e/test-cli-capabilities.cjs
```

隔离数据库 helper 在系统临时目录创建带随机 owner marker 的专用 DB，并在初始化/清理前校验归属、URL 与路径；当前使用 Prisma `db push`，不应笼统写成所有测试都执行 migrate/reset。若工具阻止数据库操作，应先核实命令、目标和操作者授权，不把 consent 环境变量当作通用绕过手段。

## 4. 变更对应测试

| 变更 | 最低测试 |
| --- | --- |
| Shared DTO/事件/错误码 | Shared 单测 + Server/Client 双端测试 + compatibility 更新 |
| Prisma schema/查询 | Service 测试 + migration/升级测试 + 备份恢复验证 |
| Job 状态机 | 并发、取消、断线、重连、终态幂等 |
| Exec command/script | 双端 parser、runtime capability、stdin、大小/输出截断、cwd root、timeout、进程树取消、最终输出留痕 |
| 远程文件/路径 | 双端 parser、Windows/Linux 认证 root、UNC/盘符、symlink/junction、不存在目标父链、文本上限、覆盖/临时文件、大小/SHA、取消、断流、失败后下一 Job 派发、重连和 Socket/Job 归属 |
| Terminal | 协议 parser、operator/viewer/token、snapshot/output 同序列、上游 gap/resync、UTF-8 上限、持续输入速率、generation、SQLite 状态、首次/重复 attach-detach TTL、expired 上报、真实 PTY 和进程树 |
| Storage Provider | 签名篡改/过期、上传下载、Provider 故障、对象永久缺失分类、公开分享和 File 保留锁 |
| Storage 阿里云盘真环境验收 | `node scripts/tests/manual/test-release-alibaba.cjs`（ADR-0019 一键端到端）：脚本自建同一临时 DB、Server/Client Launcher，按会话把两个 Release 分片直接 PUT Provider，验证 Server 本地无目标 zip、下载 302、更新与清理；仅首次输入 clientId、浏览器 OAuth code 或 3001 端口冲突时需人工介入 |
| FRP | 实例/default/迁移/parser/secret、端口、单 Client 多实例、真实 FRPS/frpc、退出/断线/重启/删除孤儿 E2E |
| Auth/Security | 密码/Cookie/Bearer、禁用/启用、撤销/过期、修改密码、既有 Socket、最后 admin、parser/限速、Actor、防泄漏 |
| Release/Launcher | Shared 严格 parser、Local SHA/raw、Alibaba 会话持久化/恢复/分片刷新/Provider 安全错误/URL 不落库、CLI 实际发送字节 SHA、Server 本地无正文、Windows/Linux 格式、drain、Server 恢复、Client 补更、数据库兼容和回退 |
| Client 一键安装 | 默认关闭、Actor 开关、同版本 done Release、平台拒绝、root/sudo 门禁、Node/Client archive SHA、其他 Server 冲突、A2 固定布局/账户/sudoers/systemd、幂等修复、Linux 冷重启无人登录恢复、M1 迁移校验/回滚，以及 Windows PM2 登录恢复和 Server 上线验收 |
| CLI 多环境与 Release | strict parser、明文秘密/未知字段拒绝、flag/env/project/global 优先级、Git 根、项目 fail closed、Token-first 注册、password/Bearer 缺失、`env check` 身份且不泄漏 Token、直连冲突、原子写入/权限、Local raw 与 Alibaba Provider 分片直传/403 刷新/URL 脱敏/旧 Server 引导兼容，以及 `status/wait` 的重启断线、成功、Release/Client 失败和超时 |
| Git 分发 | 在仓库外用 Node.js 24+/pnpm 10.26+ 从同一 Tag 安装 SDK/Shared，验证构建许可、JS/TS 导入、类型声明和单文件打包；从不同 cwd 调用同一 Skill CLI 验证项目环境隔离 |
| Frontend | loading/error/empty、刷新重连、无敏感原文渲染 |

## 5. 测试数据与安全

- 不执行真实破坏性命令；
- 使用临时目录和唯一 Client ID；
- 不在 fixture 中提交真实 Token、PSK、OAuth 凭据或签名 URL；
- 文件测试使用小型合成内容并验证清理；
- 日志断言不得输出 command/script/file content；
- 外部服务测试使用专用测试账户和最小权限目录；
- E2E 失败后必须清理子进程、端口、临时 DB 和 FRP 映射；脚本里的“自动清理”不是所有异常出口都能清理的保证；
- 真实云盘脚本会修改 OAuth/Storage 配置或上传、删除云对象；发布云盘脚本虽用临时 DB，仍会真实打包并注入版本，不能纳入离线门禁；
- 永久链接旧脚本没有实际重启 Server，早期失败可能退出 0 且输出签名链接；终端旧脚本创建真实 PTY，存在无界 ACK 等待/缺 finally 清理。这些手工入口不能单凭退出码当作正式验收，逐项见 [脚本清单](../scripts/README.md#7-跨进程与手工入口必须显式选择)。

## 6. CI 建议门禁

每个 PR：

1. 格式/lint；
2. 受影响包类型检查、单元测试和 `pnpm test:scripts`（Shell 回归按环境单列）；
3. 全量 `pnpm build`；
4. 核心 `pnpm test`；
5. secret scan、依赖漏洞和静态安全检查；
6. 文档链接及 Mermaid 基本校验。

主分支/发布候选：

- Windows 和 Linux 矩阵；
- Client 一键安装在 Windows x64 与 Linux x64/glibc/systemd 的真实空机、A2 固定布局和账户权限、既有 Linux PM2 M1 迁移、冷重启/无人登录恢复，以及 Windows 登录恢复矩阵；
- 真实 node-pty；
- FRP E2E；
- **导入专项门禁**：摘要响应不含正文与源文件完整绝对路径（canary）；预览文本 ≤ 80 字符且不进存储/Job/日志（canary）；源文件导入前后 hash 不变；二次导入幂等且目标内容不变；副本校验失败无半成品；`sourceName` 含路径逃逸字符时整请求被拒（400）。
manifest 严格解析（路径逃逸/未知键/摘要格式）、逐资源 sha256 校验（篡改/缺失/符号链接逃逸/SDK 版本不符 → 不上报能力且不加载）、Client 二次校验 `requiredBundle`（缺资源 → `PI_BUNDLE_UNAVAILABLE`）、v4 契约与「上报 < 4 不下发」（含 v3 Client）、SDK 内置工具名与工具目录一致性（SDK 新增工具时该测试失败，强制显式决定归属桶）、默认拒绝与三模式完整矩阵（`approval`/`auto`/`yolo` × `allow`/`confirm`/`deny`/未列出，含审批、拒绝、超时与 UI 调用次数）、执行模式损坏列与 bridge v2 非法输入的 fail closed、YOLO 不扩大资源加载面；
- RuntimeSpec 门控与换代：未 ready 时 WORKER_ACTIONS 返回 `PI_CONFIG_UNAVAILABLE` 且不 fork Worker；活跃 Run 期间配置变更只 drain、Run 结束换代；Server 侧同一门控；
- Launcher 更新/回退；
- 从上一支持版本数据库升级；
- 备份恢复 smoke；
- Frontend 浏览器 E2E（当前尚未建立，应补齐）。

## 7. 发布验收

Release 不得只凭构建成功发布。至少确认：

- health/status/login；
- Client 注册、心跳、别名和 capability；
- exec command/script、stdin、输出边界、timeout、进程树取消和断线对账；
- 文件浏览、文本留痕、写/移/删覆盖、导入/导出、Local/Alibaba 完整性差异、取消/断线和 Storage；
- Terminal attach/input/resync/close、snapshot/seq、控制权、Client/Server 重启、TTL/expired 和真实 PTY；
- Agent 会话与 Run 独立于 Job（ADR-0041）：归档/恢复、失败后继续、每轮自动结算、会话操作审计分页、普通 Job 列表不含 Agent、Server drain 同时等待 Agent Run、显式 Agent migration 在遗留活跃 Run/删除预约时 fail closed；
- FRPS probe、单实例映射、frpc 退出/重启、删除孤儿和凭据不泄漏；
- Windows/Linux 构件从上传到 Server 更新、Client 逐台更新、离线补更和失败回退的完整链路；Alibaba 后端必须证明上传/下载正文均不经过 Server；
- 同一 Git Tag 的 Skill 安装/升级与 SDK/Shared 仓库外安装；
- 数据库和 Storage 恢复；
- CHANGELOG/compatibility/deployment/operations 已更新。

## 8. 验证文档

`docs/verification/` 保存某次环境验收的证据，应记录：

- 日期、提交、应用版本和协议版本；
- OS/Node/FRP/数据库环境；
- 命令与结果摘要（脱敏）；
- 失败、跳过项和已知限制；
- 验收人。

- `scripts/tests/manual/test-release-alibaba.cjs`：ADR-0019 发布构件向阿里云盘上传/下载双向直连的唯一交互入口。直接运行后自动打包基线/目标版本、用 `install.cjs` 安装并启动隔离的 Server/Client Launcher、在同一临时 DB 中完成阿里云盘授权、按会话分片 PUT 两个平台构件、验证 `storage.mode=direct`、Server Local Release 目录无目标 zip与下载 302、等待 Server/Client 自更新、删除本测试云端对象并清理本测试进程/目录。仅在缺少 clientId、浏览器 OAuth code 或 3001 端口被其他进程占用时暂停请人处理。

验证文档是时间点证据，不是永久“已支持”声明。支持范围以 `compatibility.md` 和当前 CI 矩阵为准。

## 9. 当前缺口

- 缺完整浏览器 E2E；
- Server 重启窗口内 Job 结果不丢的真实环境验证未完成；
- Terminal snapshot/output seq、上游 gap、UTF-8 snapshot/backlog 上限、持续输入速率、generation、持久状态、首次/重复 attach-detach TTL 和本地 expired 收敛仍缺完整自动化和真实平台门禁；
- 尚未建立持续、可重复的 Windows/Linux 真实 PTY 验收矩阵；
- 远程文件 rootDir 认证、symlink/junction、不存在目标父链、import SHA-256、跨平台覆盖、running cancel、失败后下一 Job 派发和断线终局补报尚无满足长期安全要求的全链路验证；
- 全链路 Release（Server + 多 Client + 故障回退）未自动化；
- Client 一键安装已在 Ubuntu 22.04 与 Bazzite x64 完成 A2 安装、SELinux、冷重启和无人登录自动启动验收；Debian 12、Rocky Linux 9、AlmaLinux 9、Windows 真实安装以及同 Server 的 M1 正向迁移仍需发布候选环境验收；
- 缺数据库升级/回滚兼容测试；
- 认证缺 strict parser、登录限速、Cookie Origin/CSRF、Credential 生命周期、既有 Socket 撤销和最后 admin 防锁死测试；
- FRP 缺同 Client 多实例约束、secret 脱敏、默认实例原子性、Client 重启恢复、frpc 退出状态和删除孤儿的长期门禁；
- 缺稳定的安全 fuzz/速率限制测试；
- 旧集成测试清单存在过时能力描述，新增测试以代码和本文为准。
## 10. 远程 DSH 与 A2A 验收矩阵

- 自动门禁：`packages/shared/src/client-dsh-web.test.ts`（DSH 地址规范化、null/空串清除、拒绝非 http(s) 与内嵌凭据）、`packages/shared/src/dsh-web.test.ts`（受管命令/结果解析）、`packages/server/src/dsh-web/dsh-web.service.test.ts`（地址拼装、启动/停止、离线与能力缺失拒绝、建映射失败回滚、外部托管拒绝代起与解除登记）、`packages/server/src/client/client.service.test.ts`（登记即 external / 清除交还 managed）、`packages/server/src/task/task.service.test.ts`（appendAgentTurn 正文落库与 64KB 截断、listTurns 顺序、输入侧不存正文）、`packages/server/src/task/task-dispatch.service.test.ts`（流式增量累积后 settle flush、reply artifact）、`packages/server/src/a2a/a2a.service.test.ts`（GetTask 组装 history、user 回合 summary 回填、historyLength 取最近 N 条）、`packages/server/src/agent-registry/agent-registry.service.test.ts`（Agent Card 列出口 agentId 且不带敏感字段）、`packages/client/src/dsh-web/dsh-web-host.test.ts`（token 提取、netstat/lsof/`/proc` 端口解析与反查、命令行校验、端口延迟释放不误报、清理失败要报错）、`packages/frontend/src/pages/machine-dsh-web-panel.test.tsx`（打码、打开、保存、一键启动、外部托管、公网地址预填）、`packages/frontend/src/pages/develop-dsh-page.test.tsx`（跨机器启动/错误映射/空状态/外部托管）、`packages/frontend/src/app/navigation.test.ts`。
- 手工门禁（尚未在 CI）：两台真实机器，A 机 `vcpdeck tasks send --agent=<id> --intent=... --message=...` 到 B 机并 `tasks get` 取回 `history`；远程 DSH 一键启动 → 打开完整 WebUI → 停止并清理后无残留进程与映射。
- 安全断言：DSH 地址只经 API 按需下发、不写日志；`agent-reply` 正文入库按 64KB 截断、操作者 prompt 只存摘要 + hash；`external` 托管下 VCPDeck 不向 Client 发送任何起停命令。

