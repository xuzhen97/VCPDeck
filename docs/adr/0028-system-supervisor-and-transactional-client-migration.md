# ADR-0028：Launcher 演进为系统级 Supervisor 并事务迁移存量 Client

- 状态：Accepted
- 日期：2026-09-11
- 决策者：项目维护者
- 关联：[`ADR-0003`](./0003-separate-launcher-for-updates.md)、[`ADR-0015`](./0015-launcher-distributed-with-release.md)、[`ADR-0018`](./0018-public-client-installer-and-pm2-supervision.md)、[`ADR-0023`](./0023-linux-system-client-and-root-equivalent-account.md)、[`ADR-0025`](./0025-windows-client-highest-privilege-logon-task.md)、[`ADR-0027`](./0027-privileged-rust-remote-desktop-host.md)
- 取代范围：取代 ADR-0003 与 ADR-0015 中 Launcher 冻结、已有 Launcher 不自动更新的决策；取代 ADR-0018 与 ADR-0025 的 Windows PM2/登录计划任务模型；取代 ADR-0023 中 Linux Client 的现有 systemd 单进程守护、root 等价业务账户和显式 transient Launcher updater 模型。上述 ADR 的历史背景及未冲突决策继续有效

## 背景

Remote Desktop 必须在用户登录前运行，管理系统登录界面、活动图形 Session、特权 Desktop Host、用户 Session Helper 和虚拟显示组件。现有 Windows PM2 + 登录计划任务只有用户登录后才运行；现有 Linux systemd 只守护稳定 Launcher，业务 Client 仍拥有 root 等价 sudo-all；现有 Launcher 被设计为冻结且不能随业务 Release 自动升级。

长期并行保留 PM2、计划任务、旧 systemd unit、新系统服务和多个更新器会造成启动竞争、相同 Client ID 重复上线、权限漂移与不可判定回滚。维护者要求在可行时一次切换到最终进程模型，不留下长期双轨。

## 决策

1. 保留 `launcher` 作为产品组件和稳定生命周期边界，但将其职责演进为系统级 VCPDeck Launcher/Supervisor。
2. Windows Supervisor 注册为自动启动的 LocalSystem Windows Service；Linux Supervisor 注册为 root systemd daemon。Supervisor 在无人登录时运行，不依赖 PM2、登录计划任务、linger 或用户 Shell 环境。
3. Supervisor 统一启动、停止、监控和版本协调 TypeScript Client、Rust Desktop Host 与活动用户 Session Helper，并负责发现 Windows Console Session 或 Linux logind Seat/Session。
4. TypeScript Client 使用受限业务身份运行；系统桌面特权集中在 Desktop Host/Supervisor。Linux 不再以业务 Client 持有 `NOPASSWD: ALL` 作为最终模型；需要系统动作通过有限、版本化的本机协议执行，而不是通用 sudo-all。
5. Supervisor 继续管理版本目录、current、下载、校验、切换、探活和失败回退，并新增自身可验证更新、组件版本一致性、Desktop Host/Helper 健康和虚拟显示安装回滚。
6. `launcherMinVersion` 必须成为强制兼容门。依赖新 Supervisor 能力的 Release 在版本不满足时不得启动业务构件或宽松降级。
7. 新安装直接创建最终 Supervisor 结构，不经过 PM2、Windows 登录计划任务或旧 Linux Client unit。
8. 存量 Client 通过发布包中的一次性 Supervisor Migration Bootstrap 事务迁移。Bootstrap 先保存旧现场并安装新 Supervisor、Desktop Host、Helper、IPC 凭据和虚拟显示组件；停止但暂不删除旧守护；启动新体系并等待本机自检及携带 migration nonce 的 Server 回连验收。
9. 只有 Client 版本、Server 回连、Supervisor、Desktop Host IPC、捕获、输入、编码、WebRTC loopback 以及物理/虚拟显示能力全部通过，迁移才提交。提交后删除 PM2、Windows 登录计划任务、重复旧 unit 和迁移临时入口。
10. 提交前任一步失败必须停止和卸载新组件、回滚驱动/系统配置、恢复旧启动入口并确认旧 Client 重新上线。迁移期间不得允许相同 Client ID 的新旧进程同时在线。
11. 迁移提交后不自动恢复旧进程模型。后续更新只由 Supervisor 执行，最终稳定状态只保留一套进程监管和更新机制。
12. Supervisor 控制接口只存在于受保护本机边界，不开放公网；Supervisor 不解析普通 Job、不执行调用方任意 Shell、不处理桌面媒体或输入正文。
13. 存量机器迁移成功后 Remote Desktop 默认启用；未升级旧二进制可以继续使用既有能力，但明确报告 Remote Desktop 不支持。

## 候选方案

### 长期并行运行旧 Launcher 与新 Supervisor

可以降低初期迁移压力，但会留下两个更新权威、启动竞争和清理尾巴，不符合最终单一模型，因此拒绝。

### 保留 Windows PM2/计划任务，仅增加 Desktop Host Service

改动较小，但 Client 登录前不在线，系统服务与用户进程之间的控制、版本和凭据生命周期分裂，无法可靠实现统一登录界面会话，因此不采用。

### 整个 Client 作为 LocalSystem/root Service

进程更少，但会将 Job、Terminal、Pi、Files 和第三方扩展全部提升为系统权限，扩大漏洞影响，因此拒绝。

### 只支持新安装，不迁移旧机器

实现简单，但已有机器无法获得目标能力，与存量 Client 自动升级要求冲突，因此拒绝。

### 分多次发布逐步迁移

可以降低单次变更风险，但会把双轨状态变成跨版本产品状态。采用实现阶段内逐项验证、单次正式发布事务切换，而不是长期分阶段部署。

## 后果

### 正面

- Windows/Linux 使用统一的系统启动和生命周期模型；
- Remote Desktop 可在无人登录时工作；
- 业务 Client 与系统桌面特权分离；
- Supervisor、Desktop Host、Helper 和业务版本能统一探活、更新和回滚；
- 存量机器自动迁移，成功后没有 PM2/计划任务等旧机制尾巴。

### 负面与风险

- Launcher 从冻结组件变为可更新信任根，迁移和回滚复杂度显著增加；
- Windows Service、Linux systemd、用户 Session Helper 和驱动安装都需要真实平台验证；
- 提交后回退到旧进程模型不再自动可用，必须确保提交门足够严格；
- 业务 Client 降权会改变当前 Linux root 等价 Job/Pi 使用方式，所有依赖需纳入迁移验收。

### 安全与运维影响

- Supervisor 和 Migration Bootstrap 属于最高信任构件，必须经过发布者签名验证；
- 本机 IPC 和配置权限必须阻止普通进程伪造 Supervisor/Desktop Host；
- 迁移失败必须保留可诊断现场，但日志不得包含 PSK、IPC capability 或桌面正文；
- 卸载必须清理 Service/unit、Desktop Host、Helper、虚拟显示组件和受保护配置，并为身份数据提供明确保留或 purge 语义。

## 验证与退出条件

必须覆盖 Windows/Linux 新安装、当前所有受支持存量模式迁移、迁移中断、驱动失败、Service/unit 启动失败、新 Client 未回连、Desktop Host 自检失败、旧现场恢复、相同 Client ID 排他、提交后旧入口已删除、机器冷启动无人登录上线、业务能力回归以及后续 Supervisor 自更新和失败回退。

若未来采用容器、操作系统包管理器或外部设备管理平台作为唯一生命周期权威，应新建 ADR supersede 本决策，不得再次引入并行守护者。
