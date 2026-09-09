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
2. `VCPDeck PM2 Startup` 计划任务改为以当前用户的最高可用运行级别启动，即 `RunLevel=Highest`；当前用户必须已属于本机 Administrators，安装器不负责授予组成员资格。
3. 创建任务需要提升时，安装器继续通过 UAC 仅提升任务注册步骤；任务本身使用交互式登录令牌，不保存或要求用户密码。
4. 重跑安装器时必须校验既有任务同时指向当前安装目录的恢复脚本且运行级别为 Highest；指向相同脚本但仍为 Limited 时原位修复，指向其他命令时继续 fail closed。
5. Client、Launcher、PM2 的账户身份不变；该模式不是 LocalSystem、不是 Windows Service，也不保证用户未登录时在线。
6. 本变更不新增 `installation.mode`。Windows 在协议中继续保持安装模式未报告，直到未来形成可区分且需要控制面展示的 Windows 部署模式。

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
- 保留现有 PM2、Launcher、自更新和用户配置目录；
- 计划任务无需保存 Windows 密码。

### 负面与风险

- 任何经该 Client 执行的 Job、Terminal、Files 和 Pi 操作都继承管理员令牌；
- 标准用户即使选择 Highest 也不会成为管理员；
- 已运行的 Limited PM2 daemon 不会自动提权，存量安装需要结束旧 daemon，并由修复后的计划任务重新启动；
- 仍依赖用户登录，不提供无人值守 Windows 服务语义。

## 验证与退出条件

- 自动化测试验证直接创建与 UAC 重试命令均使用 Highest；
- 重跑安装器能够修复指向正确恢复脚本的 Limited 任务，并拒绝指向其他命令的同名任务；
- Windows 真机验证任务为 `RunLevel=Highest`、不要求账户密码，结束旧 PM2 daemon 后由任务恢复的 Client 拥有 High Mandatory Level；
- Client 版本更新、Launcher 回退和用户重新登录恢复行为保持不变。

当需要无人登录运行、LocalSystem、专用服务账户或控制面区分 Windows 部署模式时，应创建新 ADR 重新评估 Windows Service 模型。
