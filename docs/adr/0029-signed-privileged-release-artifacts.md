# ADR-0029：使用发布者签名保护特权组件和 Supervisor 更新

- 状态：Accepted
- 日期：2026-09-11
- 决策者：项目维护者
- 关联：[`ADR-0003`](./0003-separate-launcher-for-updates.md)、[`ADR-0012`](./0012-bundled-release-artifacts.md)、[`ADR-0015`](./0015-launcher-distributed-with-release.md)、[`ADR-0028`](./0028-system-supervisor-and-transactional-client-migration.md)
- 取代范围：取代 ADR-0012 中“不引入发布者数字签名”的决策；SHA-256 完整性校验、平台构件拆分与其余打包决策继续有效

## 背景

当前 VCPDeck Release 使用上传认证和 SHA-256 检测构件内容不一致，但 SHA-256 本身不能证明发布者身份。Remote Desktop 与新 Supervisor 会自动安装或更新 LocalSystem/root 服务、Desktop Host、Session Helper 和 Windows 虚拟显示驱动；一旦构件来源被替换，攻击者可直接获得目标机器系统权限。

Launcher 将从冻结组件演进为可更新的生命周期信任根。继续仅依赖 Server 数据库中声明的哈希，无法在 Server、Storage 或发布链路受损时提供独立来源认证。

## 决策

1. VCPDeck 平台 Release 和独立 Supervisor/迁移构件必须使用 Ed25519 发布者签名。SHA-256 继续用于字节完整性和寻址，但不再单独构成特权更新的来源信任。
2. Launcher/Supervisor 内置一个或多个受信发布公钥，不从待验证 Release、普通 Server 响应或同一下载位置取得新的信任根。
3. 签名覆盖规范化、版本化的发布声明。声明至少绑定版本、平台、构件 SHA-256、大小、manifest 版本、最低 Supervisor 版本和构件角色，避免跨平台、降级或替换混用。
4. Supervisor、Migration Bootstrap、Desktop Host、Session Helper、驱动和业务构件在 prepare/apply 前必须同时通过声明解析、签名验证、SHA-256、大小、平台和版本约束。任何失败均在切换前 fail closed。
5. `launcherMinVersion` 必须强制执行；旧 Launcher 无法验证新签名或执行 Supervisor 迁移时，只能进入明确、受控的一次性引导升级，不能直接运行新特权构件。
6. 私钥只存在于受保护发布环境，不进入仓库、Server、Release archive、CI 普通日志或目标机器。Server 只保存并分发签名声明和构件，不拥有签名能力。
7. 密钥轮换采用新旧公钥有界重叠：由仍受旧信任根验证的发布版本引入新公钥；后续版本再移除旧公钥。普通配置和远程 API 不得即时替换信任根。
8. 密钥泄露时停止发布，吊销受影响构件并通过仍可信的离线恢复或预先建立的轮换路径更新信任根；不得用 Server 数据库开关绕过签名。
9. Windows Service、Desktop Host 与虚拟显示驱动还应满足平台代码签名要求；平台签名不能替代 VCPDeck 发布声明签名，二者分别保护系统加载信任和产品发布来源。
10. 构件解析必须在执行 `preStart`、加载驱动或启动二进制之前完成，并严格拒绝 archive 路径穿越、异常 manifest、重复条目和未声明可执行文件。

## 候选方案

### 继续只使用 SHA-256

能检测下载损坏，但哈希和值都由控制面下发，不能独立证明来源，不足以保护自动安装的系统级组件，因此拒绝。

### 仅依赖 HTTPS 与 Server 认证

可保护传输和上传入口，但无法覆盖 Server/Storage 被入侵、构件被替换或离线分发场景，因此不足。

### RSA 或 ECDSA 签名

同样可以提供来源认证，但 Ed25519 实现简单、签名短、跨平台库成熟，适合固定声明签名，因此选择 Ed25519。

### 只使用 Windows Authenticode/Linux 包签名

平台签名覆盖范围和部署方式不同，无法统一验证完整 Release manifest、Node 业务构件和跨平台 archive，因此作为附加门禁而非唯一机制。

## 后果

### 正面

- 目标机器可独立验证特权更新的发布来源；
- Server 与 Storage 不再是唯一软件供应链信任根；
- 平台、版本、大小、哈希和最低 Supervisor 版本被同一签名声明绑定；
- 为 Supervisor 自更新和存量事务迁移提供必要的信任基础。

### 负面与风险

- 发布流程需要受保护的离线或 CI 签名密钥；
- 密钥轮换、泄露响应和历史构件验证需要明确运维流程；
- 旧 Launcher 无签名能力，首次迁移必须设计可信引导路径；
- 签名不能解决有漏洞但由合法发布者签出的构件，也不能自动回滚数据库副作用。

### 安全与运维影响

- 签名私钥必须具备最小访问、审计、备份和恢复策略；
- 验证失败的详细内容不能泄漏路径或密钥，但应保留稳定错误码和声明摘要用于诊断；
- Release 清理必须保留足以审计签名声明、key ID、SHA-256 和版本的信息；
- 回滚目标同样必须是已验证签名且仍被当前信任根接受的构件。

## 验证与退出条件

必须测试合法签名、字节篡改、错误平台、错误版本、错误大小、未知 key ID、旧/新密钥轮换、重复/穿越 archive、最低 Supervisor 版本、签名后 manifest 修改、离线回滚和迁移 Bootstrap 验证。发布门禁必须证明私钥不进入构件、仓库和日志。

若未来采用硬件签名服务、TUF、Sigstore 或操作系统包仓库作为统一更新信任框架，应新建 ADR supersede 本决策并提供现有固定公钥的迁移路径。
