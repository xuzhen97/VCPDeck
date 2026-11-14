# ADR-0065：iStoreOS Client 采用 musl/procd 系统部署与平台专用轻量构件

- 状态：Accepted
- 日期：2026-11-13
- 批准日期：2026-11-14
- 决策者：项目维护者
- 关联：[ADR-0003](./0003-separate-launcher-for-updates.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)、[ADR-0012](./0012-bundled-release-artifacts.md)、[ADR-0015](./0015-launcher-distributed-with-release.md)、[ADR-0022](./0022-release-artifact-and-launcher-retention.md)、[ADR-0023](./0023-linux-system-client-and-root-equivalent-account.md)、[ADR-0027](./0027-system-level-client-installation-and-clean-migration.md)、[ADR-0063](./0063-content-addressed-release-artifacts.md)
- 适用范围：iStoreOS 24.10 x64 / musl / procd 的 Client；首个实机验收目标为 24.10.8，不代表该系列所有构建均已验证。
- 实施状态：维护者已批准本决策及局部取代范围；兼容实现已完成，iStoreOS 24.10.8 的 0.23.20 安装、procd-root 上线、干净卸载/重装与在线验收已通过；重启/冷启动、FRP/Terminal 端到端、业务更新失败回退与固件升级尚未验收。

## 背景

既有 Linux 系统安装限定 glibc/systemd，并以专用账户加 sudo-all 获得 root 等价能力。iStoreOS 实机使用 musl/procd，系统 Node 为 20，且 `/var` 指向易失的 `/tmp`。仅放开发行版白名单既不能解决 Node 与 PTY 二进制兼容，也会令身份和状态在重启后丢失。

Client 业务已精简为通用机器能力，但完整 Linux 发行包仍包含 Server 运行材料。目标设备持久 overlay 空间有限；本次选择按平台裁剪发行内容，而不是删除 Terminal、FRP 或另建一套缩水 Client。

现有 `@lydell/node-pty-linux-x64` 预编译二进制含 glibc 依赖，不能作为 musl 支持证据。Node 官方 nodejs.org 与 unofficial-builds 都提供 musl Node 24 候选构件，但候选存在不等于已在目标机验证。新的部署例外必须覆盖首次安装及后续业务更新，不能只保证安装脚本退出成功。

## 决策

### 1. 同一 Client，新增有界部署分支

仅增加 iStoreOS 24.10 x64/musl/procd 分支；未知架构、libc、init 或未经确认的平台组合继续失败关闭。不扩展至通用 OpenWrt、ARM、容器或 musl Server，也不扩大 Tailnet 自动安装等独立能力的支持范围。

保持 `procd → 稳定 Launcher → Client`：procd 负责无人登录启动和 Launcher 恢复，Launcher 继续管理业务进程、版本切换、探活和回退。停止服务必须回收受管子进程，避免同身份双实例；不新增常驻更新器。Launcher 自身维护与业务更新分离，不承诺自动自升级。

### 2. root 权限显式报告，状态放在持久目录

此分支由 procd 直接以 root 运行，不安装 sudo 或创建专用账户。沿用可信操作者单信任域，并明确接受任意有效远程操作可能获得整机 root 权限；这不是沙箱，Server 审计也不等于完整主机审计。

Shared 增加明确的 procd 安装模式和直接 root 权限模式，权限由实际有效 UID 验证，不能仅相信用户名或环境声明，也不能冒充 systemd/sudo-all。同步检查 Client、Server、SDK/CLI、Frontend 的解析与合规展示；旧字段缺失仍为未报告，未知值仍失败关闭。部署顺序为支持新契约的 Server 先行，再安装新 Client。

应用与私有运行时放在 `/opt/vcpdeck/client`，身份和持久状态放在 `/opt/vcpdeck/state`，独立 HOME 为 `/opt/vcpdeck/state/home`，敏感配置放在 `/etc/vcpdeck` 并限制 root 访问。不得继承或修改 root 个人 HOME。安装须验证挂载持久性、目录所有权、安全路径与空间；不能使用 tmpfs 或无法确认的目录。日志必须有界，业务状态不得随版本清理。普通重启持久性必须验证；固件升级和恢复出厂设置的数据保存不在本次承诺内。

### 3. 私有 musl Node 与构建端 PTY

保留系统 Node，不降低项目 Node 24 基线；安装使用私有 musl Node 24。Node 官方 nodejs.org 的 `linux-x64-musl` 归档与 unofficial-builds 都可作为候选来源，采用前必须明确版本、可信校验值来源并完成 SHA-256 校验和实机执行验证；不将其描述为官方主发行包支持。

bootstrap 与 Launcher 都须识别 libc，运行时缓存按兼容目标隔离，并验证架构、版本与可执行性。未来更新若无法取得合格 musl 运行时，必须拒绝目标版本并保留旧版本可用性，不回退到 glibc 下载地址。

PTY 在构建端准备匹配 musl 的构件，不向路由器安装编译工具链。必须验证真实终端创建、输入输出、resize、退出及子进程回收；加载失败的既有能力降级不能替代本次兼容验收。frpc 同样必须验证实际二进制与映射闭环。若需要更换基础 PTY 依赖或调整功能范围，应重新确认设计，而非静默扩大实现。

### 4. Client-only musl 构件贯通发布与更新

新增能明确区分 musl 和 Client-only 用途的平台构件，复用同一业务源码与打包管线。构件保留 Client、必要 Launcher、目标平台 PTY/frpc、manifest 与安装材料，不含 Server、Prisma、数据库原生包或 Windows 文件。不引入 PM2、sudo、账户管理或开发编译依赖。

上传校验、存储、平台选择、下载、安装、Launcher 更新须端到端识别用途、架构与 libc；不得向 Server 派发 Client-only 包，不得把所有 Linux Client 都映射到同一构件。既有 Windows/glibc 发布方式保持不变，不能因本次新增 Client 平台强制要求 musl Server 包。

沿用现有完整性校验、签名信任与安全解压边界，不因裁剪构件而降低安全性。ADR-0063 仍为 Proposed，不能引用为 Accepted；其已落地的签名/增量路径须按代码核验兼容。增量候选不能跨 libc 或构件用途复用；不存在兼容基线时只能使用匹配目标的完整包。本次不重写增量发布，也不改变既有信任根。

复用版本保留机制，保护当前与必要回退版本；精简效果以下载量、落盘大小、更新峰值空间和空闲 RSS 的实测为准，不预先承诺百分比。私有 Node 的具体分发形式在实施计划中固定，但首次安装与后续更新必须遵守相同来源与兼容约束。

### 5. 安装成功以闭环验收为准

安装和重复安装须保留身份、拒绝不明资源接管，并在材料准备和校验完成后才切换服务。成功条件包括 procd 定义、真实运行身份、Launcher/Client 存活、同身份上线、版本及核心能力符合预期，不仅是服务注册成功。

卸载默认移除对应服务和应用，保留身份与持久状态；彻底清理需独立高风险授权，不得删除系统 Node 或相邻资源。本次不新增旧 PM2 迁移策略，发现未知旧安装应停止并报告，不自动套用其他平台的清理逻辑。

## 与既有决策的关系

本 ADR 于 2026-11-14 经维护者批准，仅在上述 iStoreOS 分支形成以下例外，其余平台保持原规则：

- ADR-0023：部分取代第 1–7、11–12 项中适用于本分支的平台门禁、systemd/账户/sudo、目录和系统维护方式；保留稳定 Launcher、权限如实上报、非沙箱和审计边界。
- ADR-0027：扩展第 5–6、10 项的 Linux 守护与权限合规组合；保留系统级无人登录启动、严格解析、独立合规验收与人工迁移边界，Windows 和既有迁移策略不变。
- ADR-0012：扩展第 3、4、4.1 节的 musl PTY、平台构件与选包边界；仅本分支使用 Client-only 包，既有两平台构件、esbuild 与最小外部依赖原则不变。
- ADR-0063：其“不拆 server/client 包”不作为本次已确认的 iStoreOS 专用构件约束；不改变其他平台的完整包及增量策略，也不推进该 ADR 的状态。

批准时同步索引和相关 ADR 的部分取代/扩展说明，不改写历史正文。运行行为完成后再同步 Current 文档与 CHANGELOG；不得先把设计写成已支持能力。

## 候选方案

- **只放开安装白名单**：不能解决 libc、procd、持久性和后续更新，拒绝。
- **复用完整 Linux 包，仅替换 Node/PTY**：发布链改动较少，但保留 Server 负担，且仍要修复运行时和平台选择，不符合本次精简方向。
- **新建迷你 Client 或禁用 Terminal**：形成双实现或牺牲核心能力，不采用。
- **强装 glibc/systemd 或替换系统 Node**：侵入路由系统，增加升级与恢复风险，不采用。
- **专用账户加 sudo**：既有 systemd 平台继续采用；此分支已接受直接 root 风险，以减少账户与提权依赖。

## 后果

收益是复用现有业务与 Launcher、避免易失状态、降低不必要发行负担，并让 musl 安装和更新遵循同一兼容边界。代价是新增平台构件、PTY 构建、运行时来源和跨组件协议测试责任。

直接 root 扩大默认操作权限；凭据泄漏可能导致路由器整机接管。配置、日志和错误必须避免泄露 PSK、SSH 凭据及签名下载地址。非默认平台 Node 构件的可用性、供应链与设备库兼容须持续验证，不能以一次安装成功永久推定支持。

## 验证与退出条件

维护者已于 2026-11-14 明确审阅并确认本决策及上述部分取代范围；Accepted 表示长期方向获准，不表示兼容能力已经交付。

交付前必须完成：运行时与缓存隔离、错误平台拒绝、权限漂移和旧契约回归；procd 启停/异常恢复、持久路径、重复安装和卸载边界；真实 Node/PTY/frpc 验证；Jobs、Files、Terminal、FRP、注册重连及相同身份；业务更新与失败回退；现有 Windows/systemd 和发布链回归；体积、内存及峰值空间测量。

实机先做隔离验证，再在明确授权范围安装。完整冷启动验收须另行批准路由器重启；仅完成服务重启不能宣称冷启动已验证。生产发布、设备持久写入和重启均需各自适用授权。

若扩展至其他 OpenWrt/ARM/容器或 musl Server、降低 Node 基线、改变权限隔离或签名信任根、删除核心能力，应重新评估设计与 ADR，不自动扩大本例外。
