# ADR-0037：Server 集中管理共享 Git SSH 密钥并向 Client 分发

- 状态：Accepted
- 日期：2026-09-30
- 决策者：项目维护者
- 关联：[ADR-0009](./0009-trusted-operator-security-domain.md)、[ADR-0023](./0023-linux-system-client-and-root-equivalent-account.md)、[ADR-0027](./0027-system-level-client-installation-and-clean-migration.md)、[`docs/security.md`](../security.md)

## 背景

系统级 Client 不继承操作者个人的 Git/SSH 配置。若逐台生成密钥，11 台机器就要在 Git 服务逐一登记公钥；操作者更希望只登记一次，由 Git 服务人工决定该公钥可访问的仓库，并让 VCPDeck 的 Job、Terminal 和 Pi 中的普通 SSH Git 操作直接可用。

共享私钥换来较少的 Git 服务配置，却无法在私钥已被复制时仅靠清理某台 Client 实现可靠单机撤销。当前 Client 通道使用共享 PSK，也不具备强每机身份。

## 决策

1. Server 生成一组 Git SSH 密钥对，加密保存私钥及版本，向操作者展示公钥和安全元数据；操作者自行在 Git 服务登记公钥及配置权限。VCPDeck 不管理 Git 服务授权，不处理 HTTPS remote。加密根密钥与数据库分离；密钥缺失或解密失败时 fail closed，不存明文。
2. Server 持久化选定 Client 的期望分发状态；只向经认证、绑定且能力兼容的 Client 下发。Client 在自身专用、跨 Release 保留的受限目录原子安装私钥，重连后按 Server 期望状态对账。Shared 协议严格校验版本、字段和状态；安装确认不等于 Git 服务已授权。
3. Client 只让自己启动的 Job、Terminal、Pi 及其子进程在执行 SSH Git 时使用受管密钥；不修改整机或用户的 SSH 配置，不改写项目 remote，不限制 Git 服务主机。私钥正文不进入环境变量、argv、普通 REST 响应、日志、Job payload/result 或审计正文；进程可以使用非秘密的密钥路径及 SSH 选项。
4. 每台 Client 为 VCPDeck Git 操作使用独立的 host-key 记录。未知主机首次连接自动接受并记录（TOFU）；已记录主机的公钥变化时拒绝连接，须经人工核实后显式处理。不可用时不降级为永久关闭校验。TOFU 不保证首次连接免受冒充。
5. 取消某 Client 的绑定会阻止后续分发并要求清理受管副本；离线时显示待清理，收到清理确认仅表示本地受管副本已删除。可靠排除曾持有私钥的机器，必须人工在 Git 服务撤销旧公钥、生成并登记新公钥，再向保留机器分发新版本；不承诺零停机、追回已复制私钥或终止既有进程。
6. 本能力仍处于 ADR-0009 的少量可信操作者单信任域。实现前必须核验 `/client` 当前连接与 Client ID 的绑定、伪装和重复连接风险；共享 PSK 不构成强每机认证。若无法保证分发目标边界，则暂停分发，而非声称实现了每机隔离。Client 运行账户下的 Job、Terminal、Pi 具有读取可用密钥的潜在能力，不将文件权限宣传为同账户进程隔离。

## 候选方案

- **每 Client 一把密钥**：可以在 Git 服务独立撤销机器，但需要逐台登记公钥，不符合一次配置的主要目标。
- **仅 Server 代理 Git 操作**：不向 Client 分发私钥，但改变现有 Job/Terminal/Pi 直接调用 Git 的工作方式，并引入新的数据面与代理复杂度。
- **修改整机 SSH 配置或禁用 host-key 校验**：前者污染非 VCPDeck 程序，后者失去后续主机身份变化保护；均不采用。

## 后果

- 一次登记公钥可供多个 Client 使用，且系统级 Client 不依赖个人 SSH 配置；代价是所有受领机器共享同一授权面，泄露、可靠单机排除或权限变更需要 Git 服务侧撤销和人工换钥。
- Server 与 Client 都需要受保护的秘密持久化、备份/恢复、版本化下发和离线对账；Windows SYSTEM 与 Linux 专用账户的权限及 SSH 行为必须分别验证。管理面必须区分待同步、已安装、待清理与已清理，不把本地清理表述为安全撤销。
- 当前共享 PSK、受信操作者和高权限 Client 模型决定本方案不适合不可信机器或多租户隔离。若需每机可靠撤销，应重新评估每机独立 Git 凭据与 Client 独立身份认证。

## 验证与退出条件

验证批量分发、离线重连、重复/伪装 Client ID、旧版本拒绝、权限失效、密钥轮换与清理状态；分别在 Windows/Linux 的 Job、Terminal、Pi 中验证 SSH Git 可用、HTTPS remote 与非 VCPDeck 程序不受影响；验证首次 TOFU、后续指纹变化拒绝及私钥不泄漏至日志、协议投影或 Job 结果。引入不完全可信的操作者或 Client、按仓库/机器精细授权、强每机撤销或更高审计要求时，应以新 ADR 重新设计信任与密钥边界。
