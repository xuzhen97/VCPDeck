# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本采用[语义化版本](https://semver.org/lang/zh-CN/)。日期 `YYYY-MM-DD`。

## [Unreleased]

## [0.8.17] - 2026-09-17

### Fixed

- **Linux 迁移未完成后永久保留双 Client 身份**：一旦早期尝试创建了合法 A2 `client-id`，安装器就优先按 fresh 修复，即使旧 PM2 Client 仍在线也不会再迁移，导致同一主机同时出现旧记录（如 `my7900xtx`）和新 hostname 记录（如 `xuzhen97-bazzite`）。现在默认模式检测到有效旧 PM2 候选时优先恢复清理式迁移，覆盖误生成的 A2 身份；仅在无旧候选时才幂等修复现有 A2。迁移源系统扫描失败也改为 fail closed，不再静默降级为 fresh 新身份。

## [0.8.16] - 2026-09-17

### Fixed

- **Windows 旧 PM2 Client 迁移误用不存在的私有 PM2 CLI**：SYSTEM 安装器此前固定调用 `~/.vcpdeck/tools/pm2/...`，但旧安装可能使用 NVM/全局 `pm2.cmd`；`jlist/delete/save` 的非零退出又未校验，导致安装器误以为已停旧 Client，随后删除仍被占用的 `~/.vcpdeck/launcher-client` 并报 `EPERM`。现在复用已验证的全局 PM2 JS 入口，PM2 查询/删除/保存任一失败均 fail closed，旧目录删除等待 Windows 进程句柄释放；保留无关 PM2 应用，仅在无其他应用时删除旧启动任务。

## [0.8.15] - 2026-09-16

### Fixed

- **Windows 同版本重装覆盖正在运行的 Client 目录时报 `EPERM`**：现有 SYSTEM Client 的工作目录位于 `apps/<当前版本>/client`，安装器此前未停止 `\VCPDeck\Client` 任务就递归删除当前版本目录；Windows 会拒绝删除被运行进程占用的目录。现在铺设发布物前先结束既有 SYSTEM 任务，删除目录使用 Node 原生 10 秒有界重试，随后重新注册并启动任务；同时确保恢复后的 `client-id` 与 `launcher.env` 不会被 `MultipleInstances=IgnoreNew` 的旧实例继续占用。

## [0.8.14] - 2026-09-16

### Fixed

- **SYSTEM 安装永远复用旧的缓存 `~/.vcpdeck/cache/install.cjs`**：该构件文件名固定且只判断“文件存在”，首次下载后再也不更新；旧版本 `parseArgs` 会静默丢弃裸标志，于是 `--force`、`--no-env` 失效并报“目标版本目录已存在”（同版本重装时必现）。现在 Release zip 与低层安装器都按 SHA-256 校验缓存内容，不一致即重新下载（与用户级安装路径语义一致）。

## [0.8.13] - 2026-09-16

### Fixed

- **别名被旧记录占用时安装等到 120 秒超时并误报失败**：Windows 安装已在任务注册后真实上线，但最后的 `PUT .../name` 因旧离线记录仍占用同名而返回 409；该错误被验收循环当作瞬时失败重试，直到超时。现在别名冲突只输出可操作警告（当前显示名 + 重命名旧记录或复用其 client-id 的处理方式），不再阻断安装。
- **重装忽略 ADR-0027 保留的机器身份**：系统级卸载会把 `client-id` 保留到 `C:\ProgramData\VCPDeck\client-id`，但重装只读旧 PM2 安装的 id，旧 PM2 现场已被清理时会重新生成 UUID，产生重复身份并与旧别名冲突。现在安装根 `client-id` 缺失时先复用保留路径中的合法 id（非法值不采用，仍生成新 id）。

## [0.8.12] - 2026-09-16

### Fixed

- **Windows SYSTEM 安装缺少“铺设发布物”步骤**：`runWindowsInstall` 只下载了低层 `install.cjs` 却从未执行，导致 `C:\ProgramData\VCPDeck\Client` 下没有 `dist/main.js` 与 `apps/<版本>/client`；任务启动即失败，最终只表现为“Client 未在超时内上线”。现在布局阶段先调用低层安装器铺设发布物（`--artifact=client --no-env --force`），并在注册任务前 fail closed 校验 `dist/main.js` 与 `apps/<版本>/client/dist/index.js` 存在。
- **SYSTEM 任务不注入环境变量，而 Launcher 只读 `process.env`**：任务无 `EnvironmentFile` 等价物，Launcher 启动时因 `VCPDECK_ARTIFACT` 缺失直接退出。现在 Launcher 在加载配置前自行读取安装根（`VCPDECK_APP_DIR` 或工作目录）下的 `launcher.env`，仅补齐缺失键，已有的同名环境变量优先（PM2/手动启动不受影响），并随 `process.env` 传给被守护的 Client 子进程。

## [0.8.11] - 2026-09-16

### Fixed

- **Windows 续装把既有 `client-id` 的 `EPERM` 归因于 ACL，实际缺少只读属性处理**：Node 在 Windows 上写入带只读属性的文件会直接报 `EPERM`（与空 DACL 同为 `EPERM`，难以区分）。现在安装器在读取/写入 `client-id`、`launcher.env`、`install-state.json` 前先清除只读属性，并逐对象重建这两个文件的访问权，不再依赖现场是否健康；已在本地分别复现“只读文件”与“空 DACL”两条 `EPERM` 路径并验证修复。

## [0.8.10] - 2026-09-16

### Fixed

- **Windows 安装器在读取 `client-id` 之后才重建安装根 ACL**：0.8.7 之前写入的不可继承 ACE 会让既有子对象（`client-id`、`launcher.env` 等）失去全部 ACE，导致续装时报 `EPERM: operation not permitted, open 'C:\ProgramData\VCPDeck\Client\client-id'`，且永远走不到修复。现在先对安装根写入可继承的 `(OI)(CI)F`，由内核将权限传播到既有子对象，再执行身份读取；已用本地现场验证被清空的 `client-id` 能立即恢复继承读写权限。

## [0.8.9] - 2026-09-16

### Fixed

- **Windows bootstrap 依赖 `Get-FileHash`，在 PSModulePath 被 PowerShell 7 模块覆盖的机器上无法识别**：这些机器上 Windows PowerShell 5.1 会加载到不含该 cmdlet 的 `Microsoft.PowerShell.Utility`，导致 Node.js 与安装器校验失败，而错误被 `catch` 吞掉后只报“无法准备 Node.js 24+ x64”。现在改为直接用 .NET 计算 SHA-256，并在两个源都失败时输出真实的最后一次异常。
- **Windows bootstrap 的 Node 下载改为直接解压到 `runtime\node`**：移除“解压到临时目录再 `Move-Item`”的步骤，避免失效目录或目标目录已存在导致的失败；解压后立即验证 `node.exe` 可执行。
- **ACL 自愈阶段的 `takeown`/`icacls` 原生 stderr 会中断安装**：在 `Stop` 偏好下原生命令 stderr 会变成终止错误，现在修复阶段改用 `Continue`，仅以最终可写性判定成败。

## [0.8.8] - 2026-09-16

### Fixed

- **Windows 安装根对目录使用了不可继承的 ACL**：`icacls` 的 `/grant:r *S-1-5-18:F` 不带 `(OI)(CI)`，设置后子目录（如 `runtime\node`）会丢失全部 ACE 变成空 DACL，导致即使提升的管理员也被拒绝访问，后续安装报 `Access to the path ... is denied`。现在目录使用可继承的 `(OI)(CI)F`，并在 bootstrap 复用/下载 Node 前探测可写性，必要时按 `takeown` + `icacls /T /C` 自愈已损坏现场。

## [0.8.7] - 2026-09-16

### Fixed

- **Windows SYSTEM 计划任务 XML 不符合 Task Scheduler schema**：修复 BootTrigger 中非法的 `StartWhenAvailable`、非法的 `TimeTrigger` 延迟写法、`RestartOnFailure` 的 `Attempts` 字段、缺失的 `version="1.2"` 和错误的 UTF-16 声明；并删除 XML 中不被 schema 接受的 `LogonType=ServiceAccount`，改为注册时显式传 `/RU SYSTEM`，保持开机前登录、最高权限运行。

## [0.8.6] - 2026-09-16

### Fixed

- **Windows SYSTEM 安装器使用了错误的 `icacls` 参数格式**：原实现把 SDDL ACE 直接传给 `/grant`，导致 `launcher.env` ACL 设置失败并阻止计划任务注册。现改用 `*S-1-5-18:F` 与 `*S-1-5-32-544:F` 的 `icacls` SID:权限格式；安装器和系统级卸载器同步修复，并增加回归测试。

## [0.8.5] - 2026-09-16

### Fixed

- **Windows bootstrap 仍把机器 PATH 的 Node 传给 SYSTEM 安装器**：即使私有 Node 尚未就绪，bootstrap 原先也会回退到 `Get-Command node`，把 `C:\Program Files\nodejs\node.exe` 传给只允许 ProgramData 私有 runtime 的低层安装器，随后被正确拒绝为“路径无效”。现已删除 PATH fallback；Windows SYSTEM 安装只复用或下载 `C:\ProgramData\VCPDeck\Client\runtime\node` 下的 Node。

## [0.8.4] - 2026-09-16

### Fixed

- **Windows SYSTEM 安装器错误假设私有 Node 路径为固定 `node.exe`**：bootstrap 实际准备的 Node 位于 `C:\ProgramData\VCPDeck\Client\runtime\node\node-<version>\node.exe`，低层安装器却只检查根目录路径，导致管理员安装在 Node 下载完成后仍报“ProgramData 私有 Node.js 未就绪”。现改用 bootstrap 传入的真实私有 Node 路径，并限制该路径必须位于 ProgramData runtime 目录内；失败诊断改为提示 SYSTEM 任务和安装现场。

## [0.8.3] - 2026-09-16

### Fixed

- **已提升的管理员 PowerShell 被 Windows 一键安装/卸载脚本误判为未提升**：bootstrap 原先错误地从 `WindowsIdentity.Groups` 查找 Mandatory Label SID；该集合不包含令牌完整性 SID，导致窗口已显示“管理员”仍被拒绝。现改用 `WindowsPrincipal.IsInRole(Administrator)` 区分 UAC 过滤令牌，低层 Node 安装器继续通过 `whoami /groups` 独立复核 Administrators 成员与 high-integrity 令牌。

## [0.8.2] - 2026-09-16

### Fixed

- **A2 fresh install 在 configuration 阶段崩溃**：Linux A2 安装器 `configuration` 阶段的 `writeAtomic` 调用漏传 `ENV_FILE` 参数，导致 `fs.writeFileSync` 收到 options 对象并抛出 `ERR_INVALID_ARG_TYPE`，fresh install 在所有依赖/构件准备完成后崩溃。该问题由 Vagrant Ubuntu 22.04 VM 端到端验证抓取，并新增针对性回归测试。

## [0.8.1] - 2026-09-16

### Fixed

- **Windows 一键安装命令兼容 PowerShell 5.1 UTF-8 BOM**：动态执行 `/api/client-installer/scripts/win-x64` 和卸载脚本前移除脚本首个 BOM，避免 `param` 被解析为 `﻿param` 导致 `-ServerOrigin` 参数未绑定。

## [0.8.0] - 2026-09-16

### Added

- **Windows Client 系统级安装（ADR-0027）**：一键安装改为 `NT AUTHORITY\SYSTEM` 下的 `\VCPDeck\Client` 开机任务，固定安装到 `C:\ProgramData\VCPDeck\Client` 并使用机器级私有 Node，**无需用户登录**即保持在线，不再安装或运行 PM2。安装必须在已提升的管理员 PowerShell 中执行，脚本不申请 UAC；Git 为可选工具（缺失时尝试机器级 `winget`，失败只警告）。
- **部署合规提示与人工升级汇总**：机器卡片按 Shared `getClientInstallationCompliance` 显示「系统级部署」或「需要人工升级：<稳定原因>」；发版页新增合规摘要与待升级机器列表（含离线 Client）。该判定独立于业务版本，`clientVersion` 已是最新仍可能提示迁移。
- **Linux 清理式迁移与幂等续装**：存量 PM2 安装无需额外参数，安装器自动探测并改走清理式迁移（与 Windows 一致，页面固定命令即可），保留 `client-id`、Server Origin 与显示名称；迁移在全部材料校验成功后只删除可证明属于 VCPDeck 的 entry、旧自启与旧运行目录，启动 A2 稳态服务并全能力验收。失败只记录阶段状态并保留 A2 现场，可用同一命令重跑；需要强制重装时传 `--migrate=false`。

### Changed

- **迁移失败语义变更**：Windows 与 Linux 迁移不再回滚或 `resurrect` 旧 PM2；身份（`client-id`）、Server Origin 与显示名称保留。Windows 卸载会把 `client-id` 原子保留到 `C:\ProgramData\VCPDeck\client-id` 后再删除运行目录。
- **Client 上报**：新增 `installation.mode=windows-system-task` 与 `capabilityDetails.privileged.mode=windows-system`；旧 Client 缺字段仍按「未报告」处理。

### Migration

- 存量 Windows PM2/登录任务与 Linux PM2 安装需**在每台目标机重跑一次**对应平台的一键安装命令完成迁移（直接复制 `/releases` 页面命令即可，无需额外参数）；Server 不批量下发。迁移会中断该机 Client 一段时间，建议在维护窗口执行。
- Linux 迁移仍需 root 或可完成 `sudo -v` 的普通用户（ADR-0023/ADR-0027，无用户态回退）；无 sudo 时安装器会在安装依赖与下载构件前以 `LINUX_SUDO_AUTH_FAILED` 失败关闭，并明确提示需要 root/可交互 sudo、本机既有安装未被改动、不会回退到用户态安装。
- **发布门禁**：真实 Windows（含无人登录开机）与 Linux 冷启动验收尚未在发布环境执行，完成前不得在 CHANGELOG 中标记为已验收。

## [0.7.1] - 2026-09-15

### Fixed
- 修复 Server 在 Client REST 能力投影中遗漏 `p2pTunnel`，导致 Web 将已上报 `tunnel.p2p` v1 的 Client 误判为不支持 P2P 隧道的问题。

## [0.7.0] - 2026-09-15

### Added
- **P2P 回环隧道（ADR-0026）**：机器工作区新增「隧道」Tab，对目标 Client 本机 `127.0.0.1:<port>` 的 HTTP 服务发起浏览器直连探测，展示状态行、正文与 `direct`/`relay` 路径；设置页新增「网络」页配置 STUN/TURN URL 与 realm（TURN 密钥仅由 `VCPDECK_TURN_SECRET_FILE` 提供，不在 Web 采集）。
- **coturn 一键安装脚本** `scripts/install-coturn.sh`：支持 Debian/Ubuntu 与 CentOS/RHEL/Rocky/AlmaLinux，自动探测公网/内网 IP、生成权限受控 secret 文件并启用 systemd coturn；随发布包分发。
- **node-datachannel 离线装配**：发布包内置 `node-datachannel` 与 Windows/Linux x64 预编译 native 包（win/linux zip 各自平台裁剪），目标机无需 node-gyp 或联网。

## [0.6.30] - 2026-09-11

### Fixed

- **Windows 自启动任务 UAC 提权使用绝对路径 PowerShell 并捕获真实错误日志**：`registerStartupTask` 改用绝对路径 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` 调用 `Start-Process -FilePath`，避免环境变量缺少 `WindowsPowerShell` 目录导致启动失败；提权子进程错误直接落盘并在失败时原样透出，杜绝黑盒。

## [0.6.29] - 2026-09-11

### Fixed

- **Windows 重复安装不再误报“任务已存在但指向其他安装目录”**：`schtasks /XML` 会在 XML 声明 `encoding="UTF-16"` 的同时按控制台代码页输出单字节文本，安装器与卸载器却按 `utf16le` 解码，导致任务路径全是乱码、任何已存在的 `VCPDeck PM2 Startup` 任务都被判为冲突，无法修复历史 Limited / 异常引号 / 电池限制任务。现改为 PowerShell `Export-ScheduledTask` 并以 base64 回传 UTF-8，彻底脱离代码页依赖；卸载器读不到任务定义时先探存在性，任务仍在则拒绝静默跳过。

## [0.6.28] - 2026-09-11

### Fixed

- **Windows Client 登录自启动与最高权限闭环（ADR-0025）**：
  - Windows 一键安装改为由本机 Administrators 成员执行，通过一次 UAC 注册以该用户 SID 登录触发、`RunLevel=Highest`、`InteractiveToken` 的计划任务，后续登录恢复不再弹 UAC。
  - 自启动 Action 直接执行安装器 Node.js 绝对路径调用 PM2 `resurrect`（附带高完整性启动探针），移除 Task Scheduler 对 `.cmd` 路径的引号歧义。
  - 任务设置显式启用电池供电允许启动/继续运行、`StartWhenAvailable` 与 10 秒登录延迟，消除笔记本电池模式与启动期未就绪导致的自启丢失。
  - 重复安装与卸载全面收敛：自动检测并修复历史 Limited、异常引号、错误账户/目录与电池限制任务；安全停止未提升的单应用 PM2 daemon 并由最高权限任务恢复；安装结束必须真实执行任务并验收高完整性令牌，失败 fail closed，不再误报假成功。

## [0.6.27] - 2026-09-05

### Fixed

- VCPDeckBridge 插件移除 `DownloadFile` 工具回执中的非标准 `image_url` Content Block 注入，统一返回纯文本 Markdown 下载链接，避免因非 Base64 HTTP 链接触发上游 LLM 网关 Schema 校验失败报错。

## [0.6.26] - 2026-09-05

### Changed

- 公开 Storage Share 对图片和普通文件统一 302 到当前 Provider 的短期下载 URL；Alibaba 等外部存储由调用方直连，避免图片正文占用 VCPDeck Server 带宽，Local 仍使用 Server 本地 Storage 数据面。

## [0.6.25] - 2026-09-05

### Changed

- 发布流程同步 VCPDeckBridge 版本并重新生成 `dist/VCPDeckBridge.zip`；该商店构件必须与源码和 manifest 一起提交，避免 VCPToolBox 继续下载旧命令清单。

## [0.6.24] - 2026-09-04

### Added

- 新增通用公开 Storage Share：认证操作者可创建、查询和撤销长期下载链接；公开读取不需要登录，Token 仅保存哈希且只在创建时返回。
- VCPDeckBridge 新增 `DownloadFile`：导出远程文件并返回公开 Markdown 下载链接；白名单图片额外返回 `image_url` 预览。
- 有效公开分享为 File 保留锁，显式删除和到期清理会阻止删除；Provider 明确确认对象永久缺失时分享返回 410 并失效。
- 对齐 VCPToolBox 平铺 stdin 参数和 `invocationCommands[].command` manifest 契约，VCPDeckBridge 提供 22 个命令。

### Changed

- 统一 Server、Client、Shared、SDK、CLI 与 VCPDeckBridge 发布版本为 `0.6.24`；VCPDeckBridge stdio timeout 为 300000ms。

### Security

- 公开图片由 Server 代理并固定 MIME；SVG 使用 sandbox CSP。公开链接是 bearer capability，泄露后需撤销分享；反向代理和访问日志必须脱敏分享 Token。

## [0.6.22] - 2026-09-04

### Fixed

- 对齐 VCPToolBox 平铺 stdin 参数：`dispatchCommand` 同时支持 `{ command, params }` 和 `{ command, ...flat }`；`RunShellJob` 改用 `shellCommand` 字段，避免重复 `command` 覆盖动作名。
- VCPToolBox manifest 改用 `invocationCommands[].command` 和完整 `<<<[TOOL_REQUEST]>>>` 示例，防止模型将 Shell 内容写入动作字段。

### Added

- 新增 `pnpm test:vcp-plugin`：真实 VCPToolBox `ToolCallParser` 解析 + 隔离 Server/Client/FRPS 全量 21 动作 E2E。

## [0.6.21] - 2026-09-03

### Fixed

- 修复 `VCPDeckBridge` 插件标准输出未嵌套 `result: { content: [...] }` 导致 VCPToolBox 框架解包后丢失响应正文（仅剩 `MaidName` 与 `timestamp` 元数据）的问题。

## [0.6.20] - 2026-09-03

### Fixed

- 修复 `VCPDeckBridge` 插件清单中 `entryPoint.command` 定义缺失目标执行脚本导致 Node.js 触发 REPL 语法解析异常的问题（规范为 `node index.cjs`）。

## [0.6.19] - 2026-09-03

### Added

- 新增 VCP 插件生态桥接包 `@vcpdeck/vcp-plugin` 与 `plugins/vcpdeck/`：基于 `synchronous` + `stdio` 协议，提供 21 项远程运维管理工具（机器巡检、Shell Job 与日志诊断、全量文件操作、FRP 穿透状态与版本查询）。
- 支持单文件自包含分发（`plugins/vcpdeck/index.cjs`），支持机器名与 ID 智能解析、文件授权根自动探测，供 VCP 插件商店通过 GitHub URL 直接拉取即装即用。

## [0.6.18] - 2026-09-03

### Added

- Linux Client 全新安装改为 A2 系统级部署（systemd，ADR-0023）：`/opt/vcpdeck/client` 系统应用 + `/var/lib/vcpdeck-client` 身份/状态 + `/etc/vcpdeck/client.env`（0640）+ `vcpdeck` 专用账户 + `vcpdeck-client.service`；安装要求 root/可用 sudo，否则 `LINUX_SUDO_AUTH_FAILED` 失败关闭，无 PM2/用户服务回退。
- Linux A2 专用账户为 root 等价 Client（`sudo -n` 可执行任意 root 命令）；Client 注册上报 `capabilityDetails.privileged` 与顶层 `installation` 摘要（旧 Client 缺省表示“未报告”，不推断）。
- Frontend 机器卡片与 CLI `clients list` 展示 root 等价特权（root 等价 / 不可用 / 未报告）与安装模式（系统级部署 / 旧版 PM2 / 未报告）；CLI `jobs run` 与 `pi run` 对 root 等价目标机在执行前打印风险提示（Server 仅记录控制面/Job/Session 审计）。
- Linux A2 存量 PM2 迁移（`--migrate`，保留 `client-id` 与无关 PM2 应用）：verify-only 两阶段验证 → 原子切稳态；稳态全能力注册为回滚边界，之前失败自动恢复旧 PM2，之后记 `manual-recovery-required`；卸载 `uninstall-client-linux.cjs` 支持 `--purge`。

### Changed

- Linux 全新安装不再依赖用户私有 PM2/linger/登录自启；systemd 只守护稳定 Launcher，Launcher 自升级改用受限 transient `systemd-run`（脱 Client cgroup）。Windows 安装行为保持不变。

## [0.6.17] - 2026-09-02

### Fixed

- 兼容阿里云盘 `dl1-v6.aliyundrive.cloud` 下载域名证书过期：改用 `cn-beijing-data.aliyundrive.net`，保留签名参数并继续执行 TLS 校验。

## [0.6.15] - 2026-09-01

### Added

- FRP 映射恢复对账：Client 重连（或首次连接）后 Server 按 SQLite 期望集合做三方比较（SQLite × Client 快照 × FRPS Dashboard），自动派发内部 `frp.reconcile` Job 重建 frpc 并恢复映射；通过 capability `frp.reconcileProtocolVersion=1` 协商，新 Server + 旧 Client 不自动恢复、新 Client + 旧 Server 不读取残留配置，标准组合仍为同版本发布。
- FRP 映射新增 `reconciling` 状态与 5s/30s 有限重试槽位：Client 在线时重连即收敛；重试耗尽回 `inactive + FRP_RECONCILE_FAILED`；Server 重启后遗留 `reconciling` 由启动恢复归位 `inactive`。
- frpc 进程崩溃 Client 侧有限自愈：立即/5s/30s 三次重启，耗尽置 `failed` 并回报安全状态；Client PID 保持不变，无需 PM2 重启。

### Changed

- FRP 恢复周期进行中的 create/delete 返回 409 `FRP_RECONCILE_BUSY`（可有限重试）；映射断线置 inactive 的语义保持不变。
- FRP Job 与 `frp:state` 上报采用 Shared 严格 parser 与安全投影：Job 结果、ack 与事件不携带 FRPS Token、TOML 或 frpc stdout/stderr；FRPS Dashboard 二次确认只认 online 状态，offline 残留条目不再误判为已恢复。

## [0.6.14] - 2026-08-30

### Added

- Release archive 与 Launcher 本地版本清理：Server 按最近 3 个成功 Release + 30 天保底策略清理 Local/Provider 正文和过期上传会话，`/releases` 页面支持预览与确认执行；Release 审计行和 `clientStates` 保留不删。
- Release archive 新增 `available`、`deleting`、`cleaned` 生命周期展示与安全分流；清理失败可恢复，Provider 不可用时不会猜测删除。
- 新安装 Launcher 记录 `retention.json`，保留 current、最近 2 个成功历史版本、previous 和 prepare/apply 目标；新增一次性升级脚本的 `--app-dir`、`--source`、`--pm2-name` 参数，支持迁移同机 Server Launcher。

### Changed

- Launcher 启动后在稳定窗口执行本地版本补扫；保留状态损坏时暂停自动删除，存量 Launcher 不通过业务 Release 自动升级。

### Fixed

- 修复无系统 Node.js 的 Linux Client 上 PM2 虽能启动 Launcher，但 Launcher 环境仍找不到私有 `node`、继而尝试从官方源下载第二份运行时并循环超时的问题；生成的 ecosystem 现在只持久化前置私有 Node `bin` 的安全 `PATH`，不写入其他安装器环境变量；Launcher 自身也会优先复用满足 manifest 约束的 `process.execPath`，不再依赖 `PATH` 重新发现当前运行时。

## [0.6.13] - 2026-08-29

### Fixed

- 修复 Linux Client 首次安装在系统没有 Node.js 时，私有 npm 安装 PM2 的子进程无法通过 `PATH` 找到私有 `node`、最终误报所有 registry 失败的问题。
- 修复 Linux bootstrap 的退出清理 trap 在 `main` 返回后引用已离开作用域的临时目录变量，导致 `set -u` 报 `TMP_DIR: 未绑定的变量` 的问题。

## [0.6.12] - 2026-08-29

### Added

- Client 一键安装器新增 Bazzite x86_64 支持：缺少基础命令时自动使用 `rpm-ostree` 补齐固定系统依赖，并支持实时应用或重启后续装。

### Fixed

- 发布打包链路统一将 Linux Shell 安装资产规范化为 LF，修复 Windows CRLF 导致 Bash 将 `pipefail` 识别为无效选项的问题。

### Changed

- Bazzite 的系统依赖只在实际缺失时分层安装；无法实时应用时安装器提示重启但不会自动重启，Node.js 与 PM2 仍使用用户私有目录。

## [0.6.11] - 2026-08-28

### Fixed

- 修复 Alibaba 导出直传完成时上报错误 fileId 的问题：Client 直接上传分支此前把 Provider 对象 ID 当作 `fileId` 上报，Server 以该值更新 File 记录时找不到记录（P2025）导致确认中断；现与本地路径一致，上报 File 记录 ID，真实对象 ID 由 `key` 字段承载。

## [0.6.10] - 2026-08-28

### Fixed

- 修复 Alibaba 导出直传不提供 SHA-256 的问题：Client 在上传完成后顺序读源文件计算摘要并随 Job 结果上报，Server 回填 `File.sha256`，`files download` 的完整性校验恢复正常（此前 Alibaba 导出文件下载在 SHA-256 校验阶段报“期望 undefined”失败）。

## [0.6.9] - 2026-08-28

### Fixed

- 修复 Alibaba 导出分片直传在认证修复后暴露的缺陷：分片 PUT 使用流式 body 但未声明 `duplex: "half"`，导致 Node fetch 在 Provider 上传阶段拒绝请求（`RequestInit: duplex option is required`）。

## [0.6.8] - 2026-08-28

### Added

- `/releases` 新增 Client 一键卸载命令：Windows PowerShell 和 Linux Bash 均可复制执行；仅清理本机 Client、PM2 Launcher、自启配置和安装目录，保留 Client ID、缓存、其他 PM2 应用及 Server 数据。

### Fixed

- 修复 Alibaba Storage 模式下 Client 文件导出会话缺少共享 PSK导致 `files download` 在 `file.export` 阶段返回 HTTP 401的问题；新增 Client 专用 export 控制路径并接通分片 URL 403续期，PSK仅发送到 Server 控制端点。

## [0.6.7] - 2026-08-28

### Fixed

- 修复 Launcher 将仅含 `launcher/dist/main.js` 的预升级目录误判为完整版本的问题：现在必须验证 manifest、版本号和当前业务入口，不完整目录会在重新下载前清理；失败的 `0.6.6` 不复用。

## [0.6.6] - 2026-08-27

### Fixed

- Release 更新下载对 Alibaba 直链换取和 Server 更新入口的瞬时网络失败增加最多三次有界重试，降低 Client 因临时直链失败而更新失败的概率；确定性错误和失败 Client 仍不会自动无限重试。

## [0.6.5] - 2026-08-27

### Changed

- Frontend 更新 VCPDeck 品牌标志，并将同一 SVG 用作浏览器 favicon。

### Fixed

- Server 新增 Client 心跳超时扫描：超过 30 秒未收到心跳的机器会自动标记离线，并执行与 Socket 断线相同的 Job、FRP、Pi 和 Terminal 清理，避免机器失联后长期显示在线。
- 修复 Release 更新期间重新上线的旧版本 Client 被遗漏的问题：Server 现在会在当前 Client 更新循环结束前补偿扫描并继续补更，已失败 Client 不会无限自动重试。
- Client 一键安装生成的 PM2 ecosystem 现在过滤安装器进程继承的 `VCPDECK_*`，并通过 `launcher-env.cjs` preload 在启动时清除缓存值、主动加载 `launcher.env`，避免 PM2 缓存旧 `VCPDECK_SERVER` 后覆盖文件配置。

## [0.6.4] - 2026-08-26

### Changed

- Exec Job 现在明确区分正常非零退出、`EXEC_TIMEOUT` 与 `EXEC_SIGNALLED`；timeout/取消会终止完整进程树并保留已捕获输出，不再把无退出码的信号终止伪造成 `exitCode: 1`。
- Job 详情、CLI 与 Frontend 统一展示 Job 顶层远端 timeout；exec 基础设施错误完成后继续派发队列中的下一项。
- 远程命令执行文档、协议说明和 CLI Skill 同步更新 timeout、信号终止与进程树清理语义。

## [0.6.3] - 2026-08-25

### Added

- Windows 一键安装器（install-client.cjs）：开机自启注册在非管理员权限被拒时自动弹 UAC 提权补注册（自包含 EncodedCommand payload，任务名/参数不变；取消或失败降级并打印可直接执行的 schtasks 命令），普通权限安装不再需要二次操作。

### Changed

- CLI `jobs run --json --wait` 的 stdout 现在只包含最终 JSON，等待状态、命令边界警告和暂时网络错误统一写入 stderr；复杂 shell 命令推荐作为 `--` 后的单一参数，安全单 token 不再产生误报警告。
- CLI 的 Git Bash/MSYS shell 垫片默认禁用参数路径转换，避免 `/root/...` 等远端路径在启动 Windows `node.exe` 前被改写。

### Fixed

- 修复 `jobs run --timeout=<seconds>` 未转换单位、把秒数直接作为 Node.js 毫秒 timeout 下发，导致远端命令可能在几十毫秒后被提前终止的问题。

## [0.6.2] - 2026-08-24

### Added

- 新增 `scripts/upgrade-launcher.cjs` 一键升级 Launcher：材料取自本机已解压版本的 launcher payload，停守护→备份覆盖→重启→验证在线，失败自动还原、sha256 一致幂等跳过；随发版 zip 分发于 `client/installer/`，可经 `vcpdeck jobs run` 远程执行（deployment.md §9.8）。

### Changed

- Launcher 在 Windows 解压 zip 优先使用系统 bsdtar（`System32 ar.exe` 流式解压，较 PowerShell Expand-Archive 快数倍），失败自动兜底 Expand-Archive 并输出实际使用的解压器；Launcher prepare 新增下载（含体积）/校验/解压分项与总耗时日志。

## [0.6.1] - 2026-08-24

### Added

- CLI 新增 `vcpdeck frp mapping create/delete`：覆盖 TCP/HTTP/HTTPS、可选自动名称、实例/端口/域名与 1–300 秒确认时限；命令等待 Client frpc 动作和 FRPS Dashboard 双重确认后才成功，`--json` 输出稳定结果。
- FRP 映射新增 `provisioning/deleting/error` 收敛状态、同实例 proxy name 唯一约束和 `operationJobId`；创建确认失败自动回滚，删除确认成功后才移除控制面记录。

### Fixed

- 修复 FRP 创建在 `spawn(frpc)` 后立即误报 active、删除先删数据库导致孤儿 proxy 和内部 Job 无法终结的问题；Client 启动/重启失败会恢复内存 registry 与旧 frpc 配置，Dashboard 故障按未确认收敛而不让 Job 永久卡住。
- CLI 修复 `terminal attach` 重连后沦为只读的问题：Server 对 operator 断开设计有 30 秒重连保护期，期间须携带 reconnectToken 才能恢复可输入模式——CLI 此前未保存也未回传该令牌，导致退出后 30 秒内重连只能拿到 viewer（画面正常但键盘无效）。现令牌持久化于配置目录并在 attach 时自动回传。

## [0.5.0] - 2026-08-23

### Added

- CLI 新增 `vcpdeck terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>]`：创建终端会话（缺省选默认 Shell），输出 sessionId 与 attach 连接命令——纯命令行完成建会话到 TUI 直连全流程，无需经 Frontend。
- CLI 新增 `vcpdeck completions bash|powershell`：生成 Shell 补全脚本——覆盖顶层命令、各域子命令、常用 flag 与生成时嵌入的已配置环境名（`--env=` 候选，零网络请求）；环境增删后重新生成。
- 新增 `pnpm vcpdeck:link`（scripts/link-cli.cjs）：将 CLI 安装为全局 `vcpdeck` 命令——向 Node 可执行目录写入 CMD/PowerShell 与 Git Bash 两个垫片，不经 npm/pnpm link、不触碰 pnpm store；支持 `--target=`/`--dir=` 定制。
- 新增远程一键安装脚本 `scripts/install-cli.cjs`：仅有 Node 18+ 的联网机器可用单条 `node -e 'fetch(…).then(eval)' -- --tag=<版本>` 从 GitHub raw 下载随 tag 提交的单文件 CLI 包并生成垫片、自动配置 PATH、自验收；Windows/POSIX 双端。

### Fixed

- 安装器内建三次重试与 jsDelivr 镜像回退，网络错误与 404 分类提示（此前单次失败即中止且提示误导）。

### Documentation

- README「从 GitHub 安装」补充 CLI 全局命令安装与 Tab 补全；design/cli.md 新增 §16 全局安装与 Shell 补全、修正 §10 终端边界与 §15 过时清单；operations.md 新增「Client PM2 进程丢失」处置。

## [0.4.0] - 2026-08-23

### Fixed

- CLI 修复 `terminal` 命令组未接入分发入口的问题：shells/list/close/attach 已实现并有单测，但入口未路由导致实际二进制报“未知命令”，现已在 `vcpdeck --help` 与分发中接入。
- CLI 修复 `files download` 在本地存储后端下的签名下载地址为相对路径导致请求失败的问题：现按环境 Server 地址拼接（外部 Provider 绝对直链不受影响）。

### Added

- CLI 新增 `vcpdeck terminal attach`：本地终端 raw mode 直连远端 PTY（经 /app 数据面与 Bearer 握手认证），TUI 体感与 SSH 一致，Ctrl+Q 退出；决策见 ADR-0020。
- CLI 新增 `vcpdeck pi attach`：交互式对话 REPL 驱动远端 Pi 子任务——每行提示词下发、等待完成后取回助手回复、循环继续；支持 /abort、/state 内建命令与 /exit 退出。
- CLI 新增 `vcpdeck terminal shells/list/close`：Shell 探测与会话生命周期管理（关闭为写操作需确认门）；交互式 PTY 输入输出保留在 Frontend（Socket.IO），CLI 仅管理生命周期。
- CLI 新增 `vcpdeck pi models/sessions/new/run/abort`：在目标机驱动 Pi Agent 执行子任务——prompt 提交后轮询 agent.state 至 idle，从会话上下文提取最后一条助手文本回复；缺省自动创建新会话，`--session` 复用既有会话；扩展输入等待时明确报错（需到 Frontend 处理）。写操作需最强确认门。
- CLI 新增 `vcpdeck frp instances/mappings` 与 `vcpdeck storage status`（只读）：FRP 服务实例/映射状态查询（凭据字段安全投影，token/密码绝不进入输出）与存储后端状态；映射支持 `--client` 名称/ID 过滤。
- 新增 CLI 能力端到端测试脚本 `scripts/test-cli-capabilities.cjs`（`pnpm test:cli`）：真实 Server + Client 上驱动 CLI 构建产物逐域验证（clients/jobs 失败闭环/files 全周期与直传往返/frp/storage/terminal/pi/错误路径），临时物全部隔离在 `.tmp/cli-e2e/`；AI Agent 会话运行需以操作者同意文本设置 `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`。

## [0.3.0] - 2026-08-22

### Fixed

- 修复 Launcher 自动下载 Node 运行时后 spawn ENOENT 的死循环：官方压缩包解压后的顶层目录（`node-v<version>-<plat>-<arch>`）未归一化为缓存标准布局 `node-<version>`，导致返回的路径永远不存在，目标机在系统无合格 Node 时反复崩溃重启、无法上线；现解压后归一化目录并校验二进制存在，缓存扫描跳过二进制缺失的损坏条目。

### Added

- 引入 Biome 作为仓库 lint 门禁：`pnpm lint` 覆盖 `packages/*/src` 与 `scripts`（仅 linter，不含格式化）；错误级诊断阻塞，存量风格/测试类噪音规则降级为 warning 并记录为技术债。修复全部存量错误（可选链不安全用法、void 返回、pi-panel hook 顺序缺陷、a11y 基础项）。
- CLI 新增 `vcpdeck files download/upload`（写操作，需确认门）：文件传输走 Storage Provider 直传链路——download 导出后经短期签名 URL 拉取并校验 sha256（不一致删除本地半成品）；upload 经 upload-sessions 协商后分片直传 Provider（403 仅刷新该分片 URL），由 Client 从存储拉取导入；字节流不经过 Server。
- CLI 新增 `vcpdeck files write/mkdir/delete/move`（写操作，需确认门）：覆盖写（原子 tmp+rename，内容来自 `--input` 或 stdin 不进 argv）、递归建目录、删除（不可恢复，非空目录需 `--recursive`）、移动重命名（目标存在默认拒绝，`--overwrite` 解锁）；失败带稳定错误码。Skill 确认门扩展到文件域（删除/覆盖影响单独强调）。
- CLI 新增 `vcpdeck files roots/list/stat/read`（只读）：授权根探测（多根 fail closed）、目录列表、元信息与文本读取（默认上限 256KB），失败带稳定错误码；`--json` 输出纯 JSON 供 Agent 解析。文件传输后续必须复用 Storage Provider 直传链路，不经 Server 中转。
- CLI 新增 `vcpdeck jobs run/cancel`（写操作）：在指定机器上执行 shell 命令（exec command 模式，`--` 分隔符保护命令 token），`--wait` 轮询终态且失败时自动带出错误摘要与完整 stdout/stderr 现场（非零退出）；取消请求返回 Server 权威状态。同步在 vcpdeck Skill 中确立写操作确认门（展示环境/机器/命令/影响并取得用户明确确认）。参数解析器支持 `--` 分隔符。
- Job 失败根因闭环：Server 在 Client 实时上报 stdout/stderr 时旁路落盘到 `data/job-outputs/<jobId>.log`（完整保留不封顶、无自动清理），新增只读端点 `GET /api/jobs/:id/output`；SDK 新增 `jobs.output()`。
- CLI 新增 `vcpdeck jobs list/get`（只读）：分页查询 Job、按机器名/ID 与状态过滤，`get` 展示错误摘要与完整失败现场输出；`--json` 输出纯 JSON 供 Agent 解析。同步更新 vcpdeck Skill（含失败诊断流程）与 CLI/部署文档。

## [0.2.5] - 2026-08-21

### Fixed

- 修复 Client 一键安装在 Windows 上无法安装 PM2 的问题：安装器此前优先直接 spawn `npm.cmd`，Node 18.20+ 因 CVE-2024-27980 防护返回 EINVAL 且无任何输出，导致四个 registry 尝试全部静默失败；现改为用 `node + npm-cli.js` 执行 npm，全局 `pm2.cmd` 也解析为 `node + bin/pm2` 执行，并把进程启动错误纳入失败摘要。

## [0.2.4] - 2026-08-21

### Fixed

- 修复 Client 一键安装的 Windows 引导脚本通过 `node -e` 传递探测表达式时，Windows PowerShell 5.1 删除 JavaScript 内嵌引号，导致已满足要求的 Node.js 24+ x64 被误判为不可用并反复下载的问题。

## [0.2.3] - 2026-08-21

### Fixed

- Launcher 在 Windows 上拉起 Client 时未设置 `windowsHide`，导致 Client 控制台以可见黑窗出现（用户关闭窗口会杀死 Client 并被再次拉起、再弹新窗）；现已隐藏，并同步覆盖更新解压（powershell/tar/unzip）、frpc 守护与 Job 命令执行等子进程。
- Client 一键安装生成的 PM2 ecosystem 增加 `windowsHide`，Launcher 自身不再可能弹出控制台。

## [0.2.2] - 2026-08-21

### Fixed

- Client 一键安装：PM2 安装失败时每个 registry 尝试一次重试，并把真实 npm/网络错误透出到错误摘要，不再只报“国内与官方 registry 均无法安装 PM2”。
- Client 一键安装：先等待 Client 上线验收，再配置开机自启；非管理员无法创建根目录计划任务时，安装不再整体失败，而只降级为“未配置自启”的明确警告（安装仍成功），以管理员身份重跑可补齐自启。

## [0.2.1] - 2026-08-21

### Fixed

- 修复启用阿里云存储后 Release 构件仍先完整上传到 Server、再由 Server 转存，导致大构件受 Node.js HTTP 请求接收时限影响且占用 Server 带宽与临时磁盘的问题。
- CLI 现在先创建持久化 Release 上传会话，再把 zip 分片直接 PUT 到阿里云盘；分片 URL 失效时经 Server 刷新，完成后由 Server 合并、登记 Release 并触发既有自更新编排。

### Security

- 阿里云后端强制使用 Release 直传会话，旧 raw 上传入口在读取构件正文前拒绝；预签名 URL 仅通过 `no-store` 响应返回，不写入数据库、日志或错误。
- Provider 原始错误归一化为稳定安全摘要；CLI 日志只显示平台、SHA-256 前缀和百分比，不输出预签名 URL 或凭据。

### Migration

- 新增持久化 `ReleaseUploadSession`，保存版本、平台、声明 SHA-256/大小、Provider file/upload id、分片大小、操作者与有效期，不保存预签名 URL。
- Local Storage 继续使用 Server raw stream 上传；从不支持直传协议的旧 Server 首次升级仍可使用 legacy 引导，升级后 Alibaba Release 上传必须直连。

## [0.2.0] - 2026-08-21

### Added

- `/releases` 新增默认关闭、持久化的 Client 一键安装入口，为 Windows x64 和 Linux x64/glibc/systemd 提供固定命令；自动准备 Node.js、Client、Launcher、PM2、自启并等待 Server 验收。
- SDK 新增 `clientInstaller` API；发布构件的 Server 目录携带 PowerShell/Bash 引导和统一 Node.js 安装器。

### Security

- 一键安装命令与公开脚本不包含 PSK；启用入口后 bootstrap 会向任何可访问 Server 的机器返回现有共享 PSK，禁用只关闭后续安装，不撤销已有 Client 或已泄露凭据。

### Migration

- 新增默认 `enabled=false` 的 `ClientInstallerConfig` 单例配置。升级后需在 `/releases` 显式启用；已有 Client 和自更新不受影响。

## [0.1.2] - 2026-08-20

### Added

- CLI 新增 `release status <version>`、`release wait <version>` 和 `release upload ... --wait`，同时核对 Server 版本、Release 状态与逐台 Client 明细。

### Fixed

- 修复发布上传后只能依赖 `/api/status.activeRelease` 或浏览器人工核对、无法区分 Client 失败的问题；Release failed、Client failed、终态不一致和超时现在均返回非零退出。
- 等待 Server 重启时只重试安全 GET，并使用显式 `AbortController` 清理请求超时，避免临时轮询脚本在 Windows 退出时触发 libuv 句柄断言。

## [0.1.1] - 2026-08-20

### Added

- CLI 新增只读 `env check`：复用 SDK 请求 `/api/auth/me`，验证 Server、凭据和 Token 对应身份，输出不包含 Token。

### Changed

- 新命名环境改为 Token-first：在 Frontend `/settings/tokens` 创建专用 Token 后，`env add --token-env=<VAR>` 自动使用 Bearer；CLI 与 SDK 可共用该 Token，个人资料修改用户名不影响身份。`--auth=bearer` 和既有 password 环境保持兼容。
- Pi Skill、CLI Help 与运维文档不再把 bootstrap 管理员密码作为生产 CLI 首选凭据。

### Fixed

- 修复 CLI 默认引导使用用户名/密码，导致 `/settings/profile` 修改用户名后环境持续返回 401 的问题。

## [0.1.0] - 2026-08-20

首个对外版本：Server 控制中心 + Client 出站代理的远程驾驶台闭环，含命令/脚本、文件、FRP、终端、Pi 会话、身份认证、自更新、React 驾驶台与 SDK。

### Added

- 支持从同一 Git Tag 以 pnpm 10.26+ 安装 `@vcpdeck/sdk` / `@vcpdeck/shared` 子目录，安装期生成未提交的 `dist` 与类型声明。
- Pi Skill 可通过 `pi install git:github.com/xuzhen97/VCPDeck@vX.Y.Z` 用户级安装；`vcpdeck.cjs` 随 Tag 提交并支持不同项目 cwd 的 `.vcpdeck.json` 环境选择。
- CLI 多环境配置（ADR-0017）：`env add/list/show/current/use/remove` 管理 `~/.vcpdeck/cli/config.json`，按 `--env` → `VCPDECK_ENVIRONMENT` → 项目配置 → 全局默认解析，凭据只保存环境变量名。
- SDK 新增 Cookie 登录会话与 Release 流式上传；`release upload` 校验两平台构件版本一致且互补。
- 发布构件接入 Storage Provider 直连分发（ADR-0016）：zip 转存外部存储（阿里云盘等），下载统一走 `GET /api/releases/:version/file` 并 302 到临时直链，目标机直连存储不占 Server 带宽；Local 后端行为不变。
- Server 端口可用 `VCPDECK_PORT` 覆盖（默认 3001，非法值启动即退出）；`install.cjs --port` 安装时写入。
- 新增 `scripts/install.cjs` / `uninstall.cjs` 一键安装卸载：TTY 引导或 `--psk` / `--admin-password` / `--server-url` / `--client-id` 显式传参，写入 `<app-dir>/launcher.env`（权限 600）；支持 `--db-url` 建库、多版本卸载与 current 重定向。
- 新增 `docs/quickstart.md` 端到端快速开始手册及长期文档体系（架构/协议/部署/运维/安全/ADR 等）。
- 阿里云盘真环境一键集成测试 `scripts/test-release-alibaba.cjs`：打包、安装、上传、自更新全链路自动验收。

### Changed

- `pnpm release --version=x.y.z` 同步 SDK、Shared、CLI 和运行时版本，冻结校验 lockfile，构建并冒烟验证 Skill CLI；Git commit/Tag/push 仍由维护者确认。
- 发布包改为 esbuild 单文件打包，按平台产出 win-x64 / linux-x64 两份 zip，体积约 513MB → 120–130MB；根 `package.json` 新增 `pnpm release --version=<x.y.z>` 一键打包。
- 发布 zip 内嵌 launcher/server/client 三构件，install/uninstall 脚本与 zip 平级提供，安装时自动放置 Launcher。
- Frontend 打进 server 构件由 Server 同源托管，访问 `http://<host>:3001/` 即驾驶台，无需单独静态托管。
- 更新协议按平台归档（archives JSON），两平台上传齐备才触发更新，客户端按目标机平台选包。
- Client 终端依赖 `node-pty` → `@lydell/node-pty`（预编译随包分发；已知限制：无 musl/Alpine 预编译）。
- Server preStart 改为显式路径调用随包 prisma CLI；Launcher 解压支持 Linux zip 与 Windows bsdtar。

### Fixed

- 修复自更新误判：`/prepare` 改为立即受理后台下载，`/apply` 后以新进程重启对账为准；下载超时 5 → 15 分钟；Server 重启窗口内旧版本重连自动重发更新。
- 修复 `--app-dir` 安装时自更新控制通道连错路径，以及 Local Storage 相对路径随版本目录漂移（改为锚定 `VCPDECK_APP_DIR`）。
- 修复 Windows 发布打包：bsdtar `--force-local` 不兼容、安全软件误删 frp 裸 ELF（改从 `.gz` 内存注入 zip）、发布包混入测试产物与多余平台绑定。

### Security

- 明确 Client PSK 实际配置变量为 `VCPDECK_PSK`（`VCPDECK_CLIENT_PSK` 尚未被代码读取）。

### Migration

0.1.0 是首个版本，无既有部署升级路径。首装凭据与 `DATABASE_URL` 由 `install.cjs` 引导写入 `launcher.env`；`VCPDECK_APP_DIR` 决定控制通道与存储锚点；改端口用 `VCPDECK_PORT`。当前生产路径仍含 `db push --accept-data-loss`，仅适用个人/测试环境。卸载用 `uninstall.cjs`；自更新失败可手动回切 `current` 指针。
