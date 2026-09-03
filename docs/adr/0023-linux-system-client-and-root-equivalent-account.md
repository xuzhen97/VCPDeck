# ADR-0023：Linux Client 采用 systemd 系统部署与 root 等价专用账户

- 状态：Accepted
- 日期：2026-09-01
- 决策者：项目维护者
- 关联：[`ADR-0003`](./0003-separate-launcher-for-updates.md)、[`ADR-0009`](./0009-trusted-operator-security-domain.md)、[`ADR-0015`](./0015-launcher-distributed-with-release.md)、[`ADR-0018`](./0018-public-client-installer-and-pm2-supervision.md)、[`docs/design/release-and-update.md`](../design/release-and-update.md)、[`docs/deployment.md`](../deployment.md)
- 取代范围：取代 ADR-0018 中 Linux Client 使用用户私有 Node/PM2、PM2 systemd startup 和自启失败可降级的决策；ADR-0018 的公开安装入口、共享 PSK、Windows 安装模型及其余决策继续有效

## 背景

Linux Client 一键安装当前把 Node.js、PM2、Launcher、业务版本和状态放在安装用户 Home，并由 PM2 生成 systemd startup unit。Bazzite 在 SELinux enforcing 下出现 PM2 unit 对用户 Home 中 `#!/usr/bin/env node` 入口执行失败，机器重启且用户未登录时 Client 无法恢复。继续为发行版维护 PM2 system service、user service 或登录后启动等多套路径，会扩大兼容矩阵且不能提供一致的无人登录冷启动保证。

VCPDeck 当前面向少量可信操作者，远程 Job、Terminal、Pi 和文件能力继承 Client OS 权限。维护者要求受控 Linux 节点能够执行任意高权限操作，并接受由 Server 承担控制面、Job 和 Session 级审计，而不是把 Client 限制为最低权限节点。这改变了 ADR-0009 的一般最低权限建议，必须明确记录 root 等价风险和审计边界。

## 决策

1. Linux 新安装只支持当前已确认的 Ubuntu 22.04+、Debian 12+、Rocky Linux 9+、AlmaLinux 9+ 与 Bazzite x64/glibc/systemd 范围。ARM64、musl、WSL、容器、无 systemd 和其他未经验证的平台继续 fail closed。
2. Linux 安装必须由 root 执行，或由能够完成 sudo 认证的普通用户执行。缺少 root/sudo 时安装失败，不提供 PM2、user service、linger、cron、桌面自启动或登录后启动等降级方式。
3. Linux 使用固定系统布局：应用与私有 Node 位于 `/opt/vcpdeck/client`，持久身份和运行状态位于 `/var/lib/vcpdeck-client`，敏感配置位于 `/etc/vcpdeck/client.env`。系统 Node/npm 不是运行前置条件。
4. 安装器创建或严格核对专用 `vcpdeck` 账户。该账户使用独立 HOME `/var/lib/vcpdeck-client/home` 和 `/bin/bash`，密码锁定，安装器不配置密码、authorized keys 或其他直接登录凭据。未知同名账户或属性冲突必须拒绝，不自动接管。
5. Linux 使用 `/etc/systemd/system/vcpdeck-client.service` 直接守护稳定 Launcher，不再为新安装引入 PM2。服务由 multi-user target 启动，不依赖用户登录或 linger；Launcher 继续独立守护、更新和回退业务 Client，systemd 不直接托管业务版本入口。
6. `vcpdeck` 账户通过经 `visudo -cf` 校验并原子写入的 sudoers 获得 `(ALL:ALL) NOPASSWD: ALL`，且不要求 TTY。Job、Terminal、Pi 及其派生进程均可自行调用 `sudo -n`。该节点必须被产品、协议和运维明确标记为 root 等价节点，而不是安全沙箱或最低权限账户。
7. Client 每次启动真实探测非交互 sudo，并通过 Shared 契约报告权限与安装模式摘要。老 Client 缺失字段表示“未报告”，Server 不根据 OS、用户名或命令结果猜测权限。探测漂移时 Client 可以连接用于诊断，但不得继续展示为可用的 root 等价节点。
8. Server 的现有审计只承诺记录控制面操作者、目标 Client、Job、输出现场以及 Terminal/Pi Session 生命周期；不承诺完整记录 root shell 内部命令、Pi 全部副作用或带外持久化行为，也不替代 auditd、sudo I/O logging 和集中式防篡改日志。
9. 存量 Linux 使用 M1 自动原位迁移：保留原 Client ID、Server 关联、必要配置、可启动业务版本和 FRP 必需状态；准备新现场后短暂停止旧 Launcher，只有新 systemd 服务以相同身份完成在线、版本和 capability 验收后才禁用旧 PM2/自启。失败必须恢复旧守护并保留两侧现场，不允许同一 Client ID 新旧进程同时在线。
10. M1 不自动复制原用户的 Pi、Git、SSH、Shell 配置或个人凭据。专用账户的工具和凭据后续由明确的 Server 管理能力配置；该能力不属于本决策的当前实现范围。
11. Launcher 自身显式升级改用脱离 Client service cgroup 的受限 transient systemd updater，固定目标服务和安装路径，执行备份、替换、重启、验证与失败还原；不建立长期 Launcher 自动升级状态机。
12. Linux 卸载改为 systemd 和系统目录语义。默认移除服务、sudoers 和应用目录，但保留 Client ID、迁移状态、专用账户和 HOME；删除身份与账户必须使用独立高风险 purge 流程。Windows 继续使用 ADR-0018 的 PM2 与登录计划任务模型。

## 候选方案

### 用户目录 + systemd user service + linger

可以保留用户私有布局，并在启用 linger 后实现无人登录启动。但仍需管理员授权，运行路径受 Home、SELinux 和用户环境差异影响，且同时维护用户服务和系统服务没有足够收益，因此不采用。

### 普通发行版继续 PM2，仅 Bazzite 使用 systemd user service

改动较小，但私有 Node、shebang、PATH、Home 执行策略并非 Bazzite 独有问题；双路径会扩大安装、迁移、卸载和重启测试矩阵，因此不采用。

### systemd 直接以 root 运行 Client

实现最简单，但会使普通读取和所有子进程隐式获得 root。专用账户加显式 `sudo -n` 虽不构成强隔离，仍能保留普通身份、sudo 日志和未来收紧权限的迁移点，因此不直接以 root 运行。

### 专用账户只获得有限 sudo allowlist

安全性更高，但不能满足当前要求的任意高权限 Job、Terminal 和 Pi 能力。维护者明确接受 root 等价风险和当前可信操作者模型，因此本阶段采用 sudo-all。

### 无 sudo 时降级为登录后启动

会导致安装器报告成功但机器重启且无人登录时离线，与严格无人值守启动目标冲突，因此拒绝。

## 后果

### 正面

- 所有受支持 Linux 使用统一系统目录、专用账户和 systemd 运维方式；
- 机器重启后无需用户登录即可恢复 Client；
- 不依赖系统 Node/npm、PM2、Shell profile 或 `/home` 路径形态；
- Launcher 的业务更新、探活和回退边界保持不变；
- M1 保留机器身份并为迁移失败提供确定性旧现场恢复；
- 权限模式由协议显式投影，不再依赖运维猜测。

### 负面与风险

- Client 凭据、任意有效业务 Identity、命令注入或 Pi 提示词注入均可能升级为目标机 root 接管；
- `vcpdeck` 账户的 sudo-all 与直接 root 在最终权限上近似，不能声称存在强隔离；
- Server 当前审计不足以重建所有 root 行为，严格合规仍需主机审计和集中日志；
- Linux 安装、迁移、卸载和 Launcher 升级必须执行系统级写入，失败面和真实 VM 测试成本增加；
- 专用账户不继承原操作者的 Pi、Git、SSH 和 Shell 环境，迁移后相关 capability 可能暂时不可用；
- `/opt`、SELinux、systemd、sudoers 和账户冲突需要按发行版实机验证；
- 本决策与 ADR-0009 的最低权限建议形成明确例外，只适用于维护者接受 root 等价风险的 Linux Client。

### 兼容与迁移

- 升级 Server 不立即强制迁移旧 Linux Client；旧 PM2 Client 可继续连接和接收业务 Release；
- 重跑 `/releases` Linux 安装命令时触发 M1；迁移完成前不得把旧节点展示为 root 等价系统安装；
- Shared 新增权限和安装模式兼容字段，旧 Client 缺失时展示为“未报告”；
- Windows 安装、守护和自启行为保持不变；
- 正式切换 Linux 安装入口前必须完成新空机和 M1 真实验证。

## 验证与退出条件

- Ubuntu、Debian、Rocky Linux、AlmaLinux、Bazzite 五个发行版分别验证无系统 Node/npm 的 root 与 sudo 安装入口；
- 每个平台完成机器重启、无人登录、相同 Client ID 自动上线、版本一致和 capability 上报；
- Bazzite 必须在 SELinux enforcing 下验证 `/opt` 持久性和 systemd 执行，不得关闭 SELinux或使用临时 `chcon` 冒充完成；
- 验证专用账户锁定、sudoers 权限与 `visudo` 校验，并以该账户执行 `sudo -n id -u` 得到 `0`；
- 回归 Files、Job、Terminal、Pi、FRP、业务 Release 更新和失败回退；
- M1 覆盖私有/系统 Node、私有/全局 PM2、其他 PM2 应用、多个迁移来源拒绝、成功切换和失败恢复；
- Launcher transient updater 覆盖升级成功、启动失败、备份还原和重新上线；
- 卸载和 purge 验证固定路径、账户、身份及原用户环境边界；
- 安全文档明确 root 等价与 Server 审计非能力，不把未来统一环境管理写成当前能力。

若未来引入不完全可信操作者、资源级 RBAC、完整主机审计、有限特权 helper、容器隔离、非 systemd Linux、ARM64，或要求取消 root 等价 sudo-all，应创建新 ADR 重新评估并取代本决策。
