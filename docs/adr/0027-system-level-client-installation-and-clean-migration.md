# ADR-0027：Client 统一采用系统级守护与保留身份的清理式迁移

- 状态：Accepted
- 日期：2026-09-15
- 决策者：项目维护者
- 关联：[`ADR-0003`](./0003-separate-launcher-for-updates.md)、[`ADR-0009`](./0009-trusted-operator-security-domain.md)、[`ADR-0018`](./0018-public-client-installer-and-pm2-supervision.md)、[`ADR-0023`](./0023-linux-system-client-and-root-equivalent-account.md)、[`ADR-0025`](./0025-windows-client-highest-privilege-logon-task.md)
- 取代范围：取代 ADR-0018 与 ADR-0025 的 Windows 用户环境、PM2 和登录任务模型；取代 ADR-0023 的旧 PM2 两阶段回退迁移策略。ADR-0018 的公开安装入口与共享 PSK、ADR-0023 的 Linux systemd、sudo 前提、专用账户和 root 等价模型继续有效

## 背景

Windows Client 当前依赖用户级 PM2 daemon、dump/resurrect 和登录触发计划任务。该模型必须等待指定用户登录，任务成功也不能证明 Launcher 与 Client 已上线，并且 PM2、任务、用户 Node/PATH 与安装状态可能分别漂移。生产机器已出现 PM2 daemon 恢复后 Launcher 延迟启动的故障，不满足无人登录开机自启要求。

Linux A2 已使用 systemd 守护 Launcher，并允许 root 或可认证 sudo 的普通用户完成安装；运行时专用 `vcpdeck` 账户通过 `NOPASSWD: ALL` 获得 root 等价能力。两个平台需要统一为系统级生命周期模型，同时让控制面明确指出仍使用旧安装方式或特权状态不合规的机器。

旧安装包含历史 PM2、用户环境和任务状态。继续迁移这些运行材料会把已知漂移带入新模型；直接先删除又会在下载或校验失败时造成不必要的离线。因此需要规定保留机器身份但重建运行环境的清理式迁移边界。

## 决策

1. Windows 一键安装必须从用户主动打开的、已提升的本机管理员 PowerShell 运行。脚本只校验提升状态，不申请 UAC；未提升时立即失败。
2. Windows 不再安装或使用 PM2。原生 Windows Task Scheduler 以 `NT AUTHORITY\SYSTEM`、注册时指定 `SYSTEM`、`Highest` 注册开机任务，直接使用 VCPDeck 私有 Node 的绝对路径运行稳定 Launcher；任务无需用户登录，配置失败重启、无限运行、电池可用和禁止重复实例。
3. Windows 使用 `C:\ProgramData\VCPDeck\Client` 下的机器级应用、运行时、状态、身份、配置和日志。敏感配置仅允许 SYSTEM 与 Administrators 读取或修改。Client 使用独立 SYSTEM 环境，不继承安装用户的 Profile、用户 PATH、Pi、Git、SSH 或 Shell 配置。
4. Windows 软件发现只使用机器级 PATH、App Paths、VCPDeck 管理目录和明确的标准机器级路径。Node 是随安装准备的必需私有运行时；Git 是可选工具，机器级缺失时可尝试用 winget 静默安装 `Git.Git --scope machine`，失败只降低相应能力，不阻断 Client 核心安装。
5. Linux 继续采用 ADR-0023：安装命令可由 root 或能通过 `sudo -v` 的普通用户执行；无可用 sudo 时 fail closed。systemd 以专用 `vcpdeck` 账户守护 Launcher，该账户通过经校验的 sudoers 获得 `NOPASSWD: ALL`，无需用户登录即可开机启动。
6. systemd 或 Windows 开机任务只守护稳定 Launcher；Launcher 继续负责业务 Client 的启动、崩溃恢复、版本切换、探活和回退。不得由系统守护直接管理版本目录中的业务 Client。
7. Windows 与 Linux 旧 PM2 安装统一采用保留身份的清理式迁移。清理前必须完成平台、权限、Release、Node、安装器、SHA-256、archive 结构、旧来源唯一性、迁移源 Server 可达性以及目标目录可创建性校验。Server 就一致性以旧配置为准：迁移不得把身份换到另一个 Server，因此 Server Origin 取旧配置值（同一 Server 的 loopback 与公网入口视为等价，不能用字串相等判定归属），并从该 Origin 取得 PSK 与完成验收；旧 Origin 不可达时 fail closed 且不动旧安装。迁移由目标机上的同一条安装命令发起：Windows 自动发现旧用户安装，Linux 同样在未显式指定时自动探测存量 PM2 源，页面固定命令即可完成迁移，不需要额外参数；需要强制重装时传 `--migrate=false`，多用户机器源不唯一时传 `--migrate-from-user=<name>`。目标机已有系统级身份时一律按幂等修复处理，不清理、不变更身份。探测到候选但校验不通过时必须 fail closed，不得静默退化为全新安装。
8. 迁移只保留原 `client-id`、Server Origin 和 Client 显示名称。确认来源后停止旧 Launcher，只删除 VCPDeck 自己的 PM2 应用、自启入口、旧 Launcher、业务版本和专用安装状态；不得删除其他 PM2 应用、通用 PM2、用户 Node/Git 或个人文件。
9. 清理后在固定系统目录全新安装并以同一 Client ID 上线。清理开始后的失败保留新现场和阶段状态，由同一安装命令幂等续装；不自动恢复已删除的旧 PM2 环境，也不允许同一 Client ID 的新旧进程并发在线。
10. Client 注册契约新增 Windows 系统安装模式 `windows-system-task`，并继续支持 `systemd-root-equivalent` 与 `legacy-pm2`。Client 必须本地真实探测 Windows SYSTEM 身份或 Linux 非交互 sudo-all；Server 不根据 OS、版本、用户名或环境变量猜测权限。
11. 旧 Client 缺失安装或特权字段时兼容为“未报告”，但控制面将其视为需要人工核验和升级，不推断具体安装方式或权限。Shared 对已出现的安装模式和特权字段严格解析，未知值 fail closed。
12. Frontend 机器页逐台展示系统级部署或人工升级原因；发版页汇总待升级数量、机器、平台、在线状态与原因。旧 PM2、未报告、平台与模式冲突或特权探测不合规都必须提示人工升级。
13. 安装合规独立于业务版本。即使 Client 业务版本与 Server 一致，只要系统部署或特权状态不合规，人工升级提示仍保留；只有重新注册并通过安装模式与特权验收后才自动消失。
14. 本阶段只提示并提供对应平台安装命令，不从 Server 自动批量执行迁移。系统守护清理属于可能导致机器失联的人工操作。
15. 安装成功必须由完整验证链证明：守护定义正确、Launcher/Client 以预期系统身份运行、原或新 Client ID 正确、Server 在线、版本一致、核心 capability 已上报、安装模式和特权状态合规。守护注册命令返回成功本身不构成安装成功。

## 候选方案

### 继续修复 Windows PM2 登录任务

改动较小，但仍依赖用户登录，并保留 PM2 daemon、dump、用户 SID、Node/PATH 和任务之间的多份状态，不能满足无人登录启动和确定性验收，因此不采用。

### 使用 WinSW 或 NSSM 包装 Windows Service

能获得标准 SCM 服务语义，但引入额外第三方二进制、配置、升级和供应链校验。原生 SYSTEM 开机任务已覆盖无人登录、最高权限和失败重启，当前没有足够收益引入包装器。

### 自研 Windows Service 包装器

控制力最强，但需要长期维护 SCM 生命周期、原生构建、签名、日志和自升级，超出单个 Launcher 守护的实际需要，因此不采用。

### 迁移时复制旧 PM2 与用户环境

可降低部分能力变化，但会继承已知漂移，并使 SYSTEM/专用 Linux 账户继续依赖个人环境，违背系统级部署边界，因此只保留机器身份、Server 和显示名称。

### 删除旧安装后再下载新材料

流程简单，但网络、校验或 archive 错误会无谓地让可工作的 Client 离线。决定先准备和校验全部材料，再进入不可逆清理窗口。

### 清理失败时自动恢复旧 PM2

可尝试缩短离线时间，但已部分清理的 PM2、任务和用户环境不再是可信权威，恢复会扩大双实例和身份冲突风险。决定保留可续装的新现场，由相同命令修复。

### Server 自动远程批量迁移

操作方便，但守护切换和清理一旦失败会使目标 Client 失联，且失联后 Server 无法继续修复。因此当前仅做显式提示和目标机人工执行。

## 后果

### 正面

- Windows 与 Linux 均可在无人登录时开机恢复 Client；
- Windows 移除 PM2、登录任务和用户环境的多重漂移点；
- 两个平台仍保持“系统守护 Launcher、Launcher 守护业务进程”的统一边界；
- 迁移不生成新机器记录，并避免把旧运行环境带入系统级安装；
- 控制面能持续识别业务版本已更新但系统部署尚未迁移的 Client；
- 不新增 Windows 服务包装依赖，安装供应链保持最小。

### 负面与风险

- Windows SYSTEM 与 Linux sudo-all Client 均近似目标机最高权限；任意有效业务 Identity、PSK 泄漏、命令注入或提示词注入都可能升级为整机接管；
- SYSTEM/专用账户不继承个人软件和凭据，原有 Pi、Git、SSH 或工具能力可能在迁移后消失；
- 清理开始后的失败可能让 Client 保持离线，必须在目标机重跑安装命令；
- Task Scheduler 的失败重启是有界配置，耗尽后需要通过任务状态和日志人工诊断；
- 离线 Client 的提示依赖 Server 最后保存的有效摘要，不能证明目标机当前真实状态；
- 旧 Client 缺字段会被保守标记为待升级，可能包含少量已人工系统化但尚未上报的机器；
- 机器级 winget/Git 可用性因 Windows 版本和源状态而异，因此只能作为可选增强。

### 安全与运维约束

- Windows 配置、Client ID、Launcher 控制材料和日志目录必须限制为 SYSTEM/Administrators；Linux 继续遵循 ADR-0023 的 env、sudoers 和目录权限。
- Server 审计只记录控制面、Job 输出和 Session 生命周期，不是完整主机级最高权限审计；需要完整审计时应另行部署 Windows 审计策略、auditd/sudo I/O logging 和集中防篡改日志。
- 安装器只删除能证明由 VCPDeck 管理且指向确认 app-dir 的资源；来源冲突、身份损坏或其他 Server 配置必须 fail closed。
- 业务 Release 自动更新不能修改或掩盖安装合规状态；系统部署迁移保持独立人工流程。

## 验证与退出条件

发布前必须验证：

- Windows 10/11 x64、Windows Server 2019+ x64 的管理员安装、未提升拒绝、SYSTEM 身份、无人登录冷启动、Launcher 崩溃恢复、任务漂移修复和旧 PM2 清理式迁移；
- Windows 迁移保留 Client ID 与其他 PM2 应用，不删除用户 Node/Git/个人文件；覆盖机器级 Git 已有、winget 成功和 winget 失败三条路径；
- Ubuntu、Debian、Rocky、AlmaLinux 与 Bazzite 支持范围内的 root/普通 sudo 安装、无 sudo 拒绝、无人登录冷启动、sudo-all 探测和旧 PM2 清理式迁移；
- 两个平台在多旧来源、不同 Server、身份损坏和未知守护所有权时 fail closed；
- Shared 严格解析新安装模式，旧 Client 缺字段兼容为未报告；
- Server 保存和投影最后有效安装/特权摘要；
- 机器页和发版页正确展示合规、旧 PM2、未报告、特权漂移和平台冲突；业务版本最新但安装不合规时仍提示；
- 系统级安装重新注册并通过验收后提示自动消失；
- Current 部署、运维、安全、兼容性、Release 设计文档与 CHANGELOG 同步更新。

当 Windows 必须使用正式 SCM 服务控制、需要继承特定用户桌面/Profile、引入有限权限隔离、自动远程迁移、非 systemd Linux、ARM64，或取消 Windows SYSTEM/Linux sudo-all 权限时，应创建新 ADR 重新评估本决策。
