# ADR-0025：Windows Client 使用最高权限登录计划任务

- 状态：Accepted
- 日期：2026-09-09
- 决策者：项目维护者
- 关联：[ADR-0018](./0018-public-client-installer-and-pm2-supervision.md)、[`deployment.md`](../deployment.md)、[`security.md`](../security.md)

## 背景

ADR-0018 规定 Windows Client 由当前用户的 PM2 守护 Launcher，并通过用户登录计划任务执行 `pm2 resurrect`。现有安装器使用 `/RL LIMITED`，因此即使安装者属于本机 Administrators，恢复后的 Launcher、Client、Job、Terminal、Files 和 Pi 也只继承未提升令牌，无法完成需要管理员权限的机器管理操作。

当前需求只要求管理员用户运行的 Client 获得该用户的最高可用权限，不要求改为 LocalSystem、Windows Service、无人登录运行或专用服务账户。保留现有用户 HOME 和 Pi、SSH、Git 等配置，比引入新的服务身份更符合当前 Windows 使用模型。

## 决策

1. Windows 一键安装继续使用当前用户、PM2 和 `ONLOGON` 计划任务，PM2 仍只托管稳定 Launcher。
2. Windows 安装账户必须属于本机 Administrators。安装器不授予组成员资格；条件不满足时 fail closed，不得降级为普通权限安装。
3. `VCPDeck PM2 Startup` 使用该账户 SID 的登录触发器与 `InteractiveToken + RunLevel=Highest`。安装或修复时允许通过一次 UAC 注册任务；后续登录恢复不再逐次弹出 UAC，也不得保存或要求用户密码。
4. 任务 Action 直接执行安装器选定的 Node.js 绝对路径，以参数调用 PM2 CLI `resurrect`，并设置 Launcher 目录为工作目录；不得把带引号的 `.cmd` 路径直接保存为 Task Scheduler `Command`。恢复脚本继续保留，仅供人工处置。
5. 任务必须允许电池供电时启动和继续运行，启用 `StartWhenAvailable`，并在当前用户登录后短暂延迟执行；笔记本电源状态不得导致 Client 静默离线。
6. 重跑安装器必须读取并收敛完整任务定义。旧的 Limited、异常引号 Action、错误账户/触发器、错误路径和电池限制均须修复；同名任务指向其他安装目录时继续 fail closed。
7. 修复旧任务时必须处理已存在的低完整性 PM2 daemon：保存进程快照，在确认无不安全冲突后停止旧 daemon，再由最高权限任务恢复。无法安全切换时安装失败并保留现场。
8. 安装成功前必须验证任务定义、按需执行结果、PM2 Launcher 在线、Client 向 Server 注册，以及 Launcher/Client 使用高完整性令牌。任一权限或自启动验收失败都不得记录为 `windows-logon-task` 成功。
9. Client、Launcher、PM2 的账户身份不变；该模式不是 LocalSystem、不是 Windows Service，也不保证用户未登录时在线。
10. 本变更不新增 `installation.mode`。Windows 在协议中继续保持安装模式未报告，直到未来形成可区分且需要控制面展示的 Windows 部署模式。

## 候选方案

### Windows Service / LocalSystem

可以无人登录运行并获得系统级权限，但会改变进程监管模型和 HOME，默认无法继承安装用户的 Pi、SSH、Git 等配置；当前需求不需要，因此不采用。

### 保持 Limited，按 Job 临时提权

Windows 非交互进程无法可靠地为每个远程操作完成 UAC 同意，且会把提权逻辑散落到各执行器，因此不采用。

### 保存用户密码创建批处理登录任务

会增加凭据存储和轮换成本；当前 `ONLOGON + InteractiveToken` 可以在不保存密码的前提下使用最高权限，因此不采用。

## 后果

### 正面

- 管理员账户安装的 Windows Client 可直接执行需要提升令牌的机器管理操作；
- 登录恢复经过真实验收，重复安装可收敛旧任务和低权限 PM2 daemon；
- 笔记本使用电池时仍可自动启动并保持运行；
- 保留现有 PM2、Launcher、自更新和用户配置目录；
- 计划任务无需保存 Windows 密码。

### 负面与风险

- 任何经该 Client 执行的 Job、Terminal、Files 和 Pi 操作都继承管理员令牌；
- 标准用户即使选择 Highest 也不会成为管理员；
- 修复存量 Limited 安装会重启该账户的 PM2 daemon；安装器必须避免误伤其他 PM2 应用，并在无法安全切换时停止；
- 安装和修复需要一次 UAC 授权，取消授权即安装失败；
- 仍依赖用户登录，不提供无人值守 Windows 服务语义。

## 验证与退出条件

- 自动化测试验证任务使用当前管理员 SID、`InteractiveToken + Highest`、绝对 Node/PM2 Action、正确工作目录和不受电池限制的设置；
- 重跑安装器能够修复 Limited、异常引号 Action、错误账户/触发器和电池限制，且拒绝指向其他安装目录的同名任务；
- 安装器按需运行任务，并验证执行结果、PM2 Launcher、Server 注册和 Launcher/Client 的 High Mandatory Level；
- Windows 真机完成首次安装、重复安装、注销后登录、重启后登录及电池供电场景验收；
- Client 版本更新和 Launcher 回退行为保持不变。

当需要无人登录运行、LocalSystem、专用服务账户或控制面区分 Windows 部署模式时，应创建新 ADR 重新评估 Windows Service 模型。
