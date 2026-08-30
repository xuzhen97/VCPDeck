# ADR-0022：Release 归档与 Launcher 本地版本采用独立保留策略

- 状态：Accepted
- 日期：2026-08-29
- 决策者：项目维护者
- 关联：[`ADR-0003`](./0003-separate-launcher-for-updates.md)、[`ADR-0015`](./0015-launcher-distributed-with-release.md)、[`ADR-0019`](./0019-direct-release-upload-to-external-storage.md)、[`docs/design/release-and-update.md`](../design/release-and-update.md)

## 背景

每次发布会同时留下 Server 权威的双平台 Release 归档，以及各 Server/Client 主机上由 Launcher 解压的业务版本目录。当前两者都没有自动保留和清理机制，Local Release 目录、外部 Storage Provider、上传会话与 Launcher `apps/<version>/` 会无限增长。

Release 数据库记录及 Client 更新结果承担长期审计职责，而 archive 正文主要服务下载、安装和更新；二者不应被迫采用相同生命周期。Launcher 的本地版本目录还承担失败回退职责，其安全保护集合只能由掌握 current、previous 和切换结果的 Launcher 判断，不能由 Server 远程猜测。

## 决策

1. Release 审计元数据与 archive 正文分离生命周期。Release 行、原始文件名、SHA-256、大小、平台、发布者和 Client 更新结果长期保留；满足策略的 Local 或外部 archive 正文可以删除。
2. Server 使用固定保留策略：最近 3 个成功 Release 始终保留，所有未满 30 天的成功 Release继续保留；失败或未完整上传的 Release 也保留 30 天。当前 Server 版本、活动 Release 和最新有效安装/补更目标始终受保护。
3. Release archive 使用 `available → deleting → cleaned` 生命周期。`deleting` 停止下载和目标选择，并允许 Server 重启后继续幂等删除；只有确认正文已删除或原对象已不存在后才能进入 `cleaned`。删除失败必须保留定位信息并恢复为可重试状态。
4. 过期未完成上传会话在到期后保留 24 小时宽限；清理时先删除 Provider 临时对象，再删除会话元数据。Provider 失败时保留会话供后续重试。
5. Launcher 独立清理自己管理的 `apps/`。每台机器保留 current、除 current 外最近 2 个健康切换成功的历史版本，以及正在 prepare/apply 的目标和直接 previous。成功历史由 Launcher 原子持久化；状态无法可信解析时暂停自动删除。
6. Server 与 Launcher 不新增远程目录清理协议。Server 的 `/releases` 页面只预览和执行 Server 权威的 archive 与上传会话清理，手动执行也不得绕过固定保留策略。
7. 新安装直接使用具备本地清理能力的新 Launcher。存量 Launcher 通过既有备份、替换、重启验证和失败恢复脚本做一次性迁移；不为本次迁移建立长期 Launcher 自动升级协议或状态机。

## 候选方案

- **统一由 Server 清理所有机器的历史版本**：拒绝。Server 不掌握各 Launcher 的 current、previous、pending 和本地目录真实状态，引入远程删除协议会扩大误删与安全风险。
- **只保留固定数量，不设时间保底**：拒绝。发布频繁时会过快丢失近期诊断和恢复材料；数量与 30 天保底同时满足后再删除更保守。
- **按磁盘或 Provider 容量阈值触发**：暂不采用。容量查询依赖后端且首次清理会发生在压力时刻，结果不稳定；后续有真实容量治理需求时再评估。
- **删除 Release 数据库行并级联删除正文**：拒绝。会丢失发布者、状态转换、失败原因和 Client 更新结果等审计信息。
- **把存量 Launcher 升级建设为长期自动编排子系统**：拒绝。本次只是向现有安装迁移一次清理能力，新增注册字段、兼容协议和升级状态机会显著超过实际需求。

## 后果

正面：

- Local 与外部 Storage 的 Release 正文以及各机器本地版本目录不再无限增长；
- Release 历史审计不因回收大文件而消失；
- Server 和 Launcher 各自在已有权威边界内判断清理安全性；
- `deleting` 状态使对象删除与数据库更新之间的进程崩溃可以恢复；
- 固定规则易于预览、测试和运维解释。

代价与风险：

- Shared、Server、SDK 和 Frontend 必须理解 archive 可用性，不能再以 archive 对象存在等同于正文可下载；
- 外部 Provider 凭据丢失或后端切换后，历史对象可能无法自动删除，系统必须保留引用并报告而不能伪造成功；
- Launcher 需要维护成功切换历史；该状态损坏时会选择暂停清理，可能暂时多占空间；
- 存量 Launcher 需要执行一次性升级，新能力不会仅通过业务版本切换自动出现；
- 当前固定数量和时间不是容量上限，极端发布频率下 30 天内仍可能保留较多构件。

## 验证与退出条件

- 测试覆盖最近 3 个成功 Release、30 天保底、当前/活动/最新目标保护以及失败和未完整 Release 的候选判断；
- Local 文件和 Provider 对象删除必须幂等，并覆盖删除失败、Provider 不可用、并发状态变化和 Server 重启后遗留 `deleting` 恢复；
- 已清理 archive 不得参与下载、编排、离线补更或一键安装，但 Release 审计信息仍可查看；
- Launcher 在 Windows state 文件和 Linux current symlink 两种模式下都只删除已知安全候选，健康失败回退不得丢失 previous；
- `retention` 状态缺失或损坏时不得猜测并批量删除旧目录；
- 新安装和存量 Launcher 一次性迁移均需真实验证备份、重启与失败恢复。

若未来引入多 Server 共享控制面、Server 远程管理 Launcher 目录、容量驱动策略、长期 Launcher 自动升级或可配置保留策略，应重新评估并以新 ADR 补充或取代本决策。
