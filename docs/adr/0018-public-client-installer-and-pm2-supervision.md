# ADR-0018：公开可控的 Client 一键安装入口与 PM2 守护

- 状态：Accepted
- 日期：2026-08-20
- 决策者：项目维护者
- 关联：[`ADR-0003`](./0003-separate-launcher-for-updates.md)、[`ADR-0009`](./0009-trusted-operator-security-domain.md)、[`ADR-0012`](./0012-bundled-release-artifacts.md)、[`ADR-0015`](./0015-launcher-distributed-with-release.md)、[`release-and-update.md`](../design/release-and-update.md)

## 背景

现有 Release 已为 Windows x64 和 Linux x64 产出包含 Launcher、Server、Client 的平台 zip，`install.cjs` 也能把 Client 与 Launcher 安装到版本目录，但首次接入仍要求操作者自行准备 Node.js、下载包、填写 Server 与共享 PSK、启动 Launcher，并另外配置进程守护与开机自启。这使“已有自更新构件”尚不能直接解决新机器的首次安装。

目标是在 `/releases` 提供可复制的 Windows PowerShell 和 Linux Bash 命令。命令长期固定、按执行时的当前 Server 版本选择 Release，并自动完成 Node.js、Client、Launcher、PM2、自启和 Server 侧上线验收。当前产品仍采用 ADR-0009 的少量可信操作者单信任域，不在本阶段引入每 Client 独立凭据。

该能力同时改变公开信任边界和部署模型：启用安装入口后，能访问 Server 的目标机可以取得共享 Client PSK；PM2 成为首次安装的强制外部进程管理器。因此需要明确长期边界和退出条件。

## 决策

1. Server 提供一个持久化的 Client 一键安装开关，默认关闭。任意有效业务 Identity 都可以启用或禁用，符合 ADR-0009；开关不使用 admin-only 权限。
2. `/releases` 基于当前页面 `window.location.origin` 展示两条长期固定命令。命令不包含 Cookie、Bearer、PSK 或一次性令牌；每次执行时向该 Origin 获取当前安装信息。
3. 只有版本与运行中 Server 完全一致、状态为 `done` 且包含目标平台 archive 的 Release 才可首次安装。历史版本、活动 Release 和缺包平台均明确拒绝。
4. 安装脚本与 preflight 可以公开获取且不含秘密。启用安装入口后，公开 bootstrap 可返回当前共享 `VCPDECK_PSK`、目标 Release 下载地址和 SHA-256；响应禁止缓存和普通日志记录。关闭入口只阻止后续安装请求，不轮换 PSK，也不撤销已安装 Client。
5. 继续使用现有共享 `VCPDECK_PSK` 完成 Client `/client` Socket.IO 握手，不在本阶段引入每机证书、独立 PSK、撤销列表或 mTLS。
6. 一键安装只支持 Windows 10/11 x64、Windows Server 2019+ x64，以及使用 systemd 和 glibc 的 Ubuntu 22.04+、Debian 12+、Rocky/AlmaLinux 9+ x64。ARM64、musl/Alpine、CentOS 7、WSL、容器和无 systemd Linux 明确拒绝。
7. Client、Launcher 和 PM2 以执行安装命令的当前用户运行；sudo/UAC 仅用于安装缺失的系统依赖和注册自启。Client 因此继承该用户的文件、Shell 与 Pi 配置权限。
8. 第一版强制使用 PM2，且 PM2 只托管稳定 Launcher。业务 Client 仍由 Launcher 启动、更新、探活和回退，禁止 PM2 直接托管版本目录中的 Client 入口。
9. 复用当前用户已有 PM2 时保留其他应用，只新增或修复固定名称的 VCPDeck Launcher，并用 `pm2 save` 保存完整进程列表。无 PM2 时安装到 VCPDeck 用户私有工具目录。
10. Linux 使用 PM2 的 systemd startup 集成实现机器启动后恢复；Windows 使用当前用户登录触发的原生计划任务执行 PM2 `resurrect`。Windows 不承诺无人登录时运行，也不把非官方 `pm2-windows-startup` 作为核心依赖。
11. 系统 Node.js 满足 x64 与 Release 基线时复用；否则安装到 VCPDeck 用户私有目录，不覆盖系统 Node 或全局开发环境。Node 和 npm/PM2 下载采用中国大陆镜像优先、官方源回退，并进行可获得的完整性校验。
12. 安装过程允许修改 Client 显示名称和安装目录，其余参数自动决定。保留现有 `client-id`；检测到已有 Client 指向其他 Server 时拒绝，不自动迁移或创建第二实例。
13. 安装是幂等修复流程。失败保留已完成文件、缓存和 PM2 状态，重新执行相同固定命令继续检查和修复，不自动回滚。
14. 只有构件、Launcher、PM2、Client 在线、版本一致、能力上报和显示名称均被验证后，安装器才报告成功；开机自启按最佳努力注册——非管理员无法创建根目录计划任务时降级为明确警告（安装仍成功，仅重启后不自启），以管理员身份重跑可补齐自启并完成最终验收。

## 候选方案

### 为每台机器生成一次性短期令牌

可缩短共享 PSK 的暴露窗口，但要求操作者逐机生成命令，不符合“同一系统长期使用同一条标准命令”的目标，因此不采用。未来若扩大网络暴露，可用新 ADR 引入短期令牌或每 Client 凭据。

### 将共享 PSK直接嵌入复制命令

实现简单，但会进入浏览器剪贴板、Shell history 和进程参数，暴露面更大，因此拒绝。PSK 只在启用后的 bootstrap 响应中交付并写入本机受限配置。

### 由 PM2 直接托管 Client

会与 ADR-0003/0015 的 Launcher 更新和回退模型冲突：Launcher 切换业务版本时，PM2可能把旧 Client 强制拉起。因此 PM2只能托管 Launcher。

### 使用 systemd/Windows Service 替代 PM2

系统原生服务更适合长期生产部署，但两平台实现与权限差异更大，当前需求明确选择 PM2。Windows 无人登录 Service、Linux 原生 user service 可在后续 ADR 中评估。

### 自动创建专用服务账户

隔离更强，但无法默认访问操作者的文件、Shell 和 Pi 配置，不符合当前使用场景，因此使用安装命令的当前用户。

## 后果

### 正面

- 已有 Release 构件可直接用于新 Client 首次安装；
- 一条命令覆盖运行时、配置、守护、自启与上线验收；
- 固定命令不随发版或机器变化，降低重复操作成本；
- PM2 与 Launcher 的职责明确，保留现有更新和回退模型；
- 幂等修复降低网络或依赖安装中断后的恢复成本。

### 负面与风险

- 启用入口后，任何能访问 Server 的机器都可能取得共享 PSK并伪装 Client；禁用入口不能使已经取得的 PSK 失效；
- PM2 成为首次安装的外部依赖，`pm2 save` 会保存当前用户完整进程列表；
- Windows 自启依赖登录计划任务，不是无人登录服务；
- 国内镜像和 npm registry 增加外部供应链与可用性依赖；
- 仅支持明确的 x64 平台矩阵，不能把 Node.js 自身支持 ARM64 等同于完整 Client 构件支持；
- 自定义安装目录、既有 PM2 和多 Node 环境增加跨平台验证成本。

### 兼容与迁移

- 现有 Client、Release、Launcher 和共享 PSK 协议保持不变；
- 新安装开关默认关闭，因此升级 Server 不会自动扩大暴露；
- 已有手工安装可通过固定命令进入幂等修复，只要它指向同一 Server；
- 安装入口关闭不影响已安装 Client 连接和自更新；
- 未来改为每 Client 凭据、签名安装器、原生 Service 或新增架构时，需要新 ADR 和明确迁移路径。

## 验证与退出条件

发布前必须验证：

- 开关默认关闭、持久化并由任意有效业务身份操作；
- 禁用、无同版本 `done` Release、缺平台 archive 时 fail closed；
- 命令和脚本不包含 PSK，bootstrap 响应不可缓存且日志无 PSK；
- Windows x64 与受支持 Linux x64 至少各完成一次无 Node/PM2 的真实首次安装；
- 已有 Node/PM2/其他应用时不主动删除或重启其他应用；
- PM2 只托管 Launcher，Client 自更新和回退仍工作；
- Linux 重启后恢复，Windows 当前用户登录后恢复；
- 同 Server 重跑幂等，其他 Server 安装明确拒绝；
- Server 只有在 Client 在线、版本一致并完成能力上报后才确认成功。

当系统需要公网不可信安装、多租户、逐机撤销、Windows 无人登录运行、ARM64/musl 或不使用 PM2 时，应创建新 ADR 重新评估本决策。
