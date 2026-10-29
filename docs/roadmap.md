# VCPDeck 路线图

> 状态：Planning｜维护责任：项目负责人｜最后核验：2026-08-23｜说明：优先级候选，不代表交付承诺

## 1. 已形成闭环

- Server ↔ Client 注册、心跳、能力上报和重连；
- Typed Job、命令/脚本执行、取消和对账；
- 远程文件浏览、读写、导入/导出和 Storage；
- FRPS 实例及 FRP 映射；
- Cookie/Bearer 身份认证和身份管理；
- 浏览器交互式终端；
- Release、Launcher、Server/Client 更新基础实现；
- CLI 全域命令对齐控制面能力（jobs/files/frp/storage/terminal/features/tasks/agents），支持 TUI 终端直连，并有真实 Server+Client 的 CLI 能力端到端测试；
- 功能目录（ADR-0056）：机器上的可复用设施及其调用契约，CLI `features` + 机器「功能」Tab 与全局功能页，验证由调用方执行；
- A2A Task 与 ACP 后端无关任务模型（ADR-0057）：`SendMessage/GetTask/ListTasks/CancelTask`、AgentPlacement、权限扩展与任务审计；CLI `tasks`/`agents`（含 `agents create`）；
- ~~Remote Dev Session v1（ADR-0058）~~：已于 [ADR-0060](./adr/0060-retire-rds-consolidate-a2a.md) 退役，agent 任务收敛到 A2A Task；端口调试走 FRP 映射；
- ~~远程 DSH WebUI 通道（ADR-0059）~~：已于 [ADR-0061](./adr/0061-retire-remote-dsh-webui.md) 退役，跨机开发改由操作者自行在目标机使用 DSH；
- React 驾驶台和框架无关 SDK。

## 2. 近期优先级：可靠性与安全基线

1. 修正配置命名：统一 `VCPDECK_PSK`，更新示例并决定是否支持文件型 secret；
2. 统一 REST 错误响应和稳定错误码，修复 Auth 普通 Error 落为 500；补齐 Auth/Identity strict parser、登录限速、Cookie Origin/CSRF、Credential 过期/lastUsed/清理、禁用/改密后的既有 Session/Socket 失效和最后 admin 防锁死；
3. 建立生产数据库迁移流程：开发/启动脚本已改为不带 `--accept-data-loss` 的 `db push`，但仍需把生产升级从 `db push` 换成可审查的 Prisma migration；
4. 按 ADR-0010 将 exec script 迁移到 Client runtime registry，补齐双端 parser、runtime capability、script/output 上限、cwd root 校验、稳定 timeout 和进程树取消；
5. 修复远程文件边界：以 Client 认证 root/root ID 替代调用方自选 rootDir，修复 symlink/junction 与不存在目标父链校验，增加文件双端 parser、文本/传输上限、import SHA-256、跨平台覆盖/临时文件保证、running cancel/timeout、断线终局补报及 Socket/Job 归属校验；
6. 修复文件 Job error 分支丢弃下一条 scheduler dispatch、Alibaba export 分片 URL 续期路由以及 `FileTransferResult.sha256` 与 Provider/传输方向实际能力的协议偏移；
7. 修复 Terminal snapshot/output seq 统一、上游 gap resync、UTF-8 snapshot/backlog 上限和持续输入速率限制；
8. 完成 Terminal generation 对账、SQLite active/detached 时间同步、Client 断线通知、创建超时收敛、首次/重复 attach-detach TTL 重入和本地 expired 终态上报，并建立 Windows/Linux 真实 PTY 矩阵；
9. 确认 FRP 长期多实例方向：每 Client 强制单 FrpsInstance，或每实例独立 frpc runtime；以新 ADR 实施 secret 脱敏/存储、默认实例原子性、严格 parser、真实 active、Client 重启恢复、可靠删除和 Actor 审计；
10. 完成 exec 断线终局补报，并完成 Server 重启窗口 Job 对账和 Windows/Linux 全链路 Release E2E，统一 archive 格式；
11. 修复 Release drain 失败后的派发恢复、重复版本构件覆盖和活动 Release 并发上传边界；
12. 增加构件数字签名、严格 manifest/archive 校验和 Launcher 最低版本强制校验；
13. 结构化脱敏日志已覆盖 Job 路径（ADR-0054）；剩余：其余 `console.*` 的统一化、监控指标和告警；
14. 建立自动备份、恢复演练和数据保留清理；
15. 补齐浏览器 E2E、数据库升级测试和安全 fuzz；
16. 清理/归档与代码冲突的历史设计文档；
17. 按 ADR-0019 完成发布构件上传/下载双向数据面分离：Alibaba 由 CLI 分片直传 Provider、下载经统一入口 302，Server 只管理权限、持久化会话、元数据和编排；Local 保留 Server raw stream。
18. 执行 ADR-0041 的 contract 步骤：确认该版本稳定后，清理遗留 `agent.session` Job 行与 Job 上不再使用的三个模式列（本次发布只做 expand，刻意不删，以保证回退无需恢复备份）。

## 3. 中期候选：可运营性

- Client 历史/离线机器查询及显式退役；
- 每 Client 独立凭据、可审计轮换和可选 mTLS；
- 资源级授权、只读角色和操作审批；
- Job 输出的受控持久化、大小限制与脱敏；
- Storage 孤儿扫描、跨 Provider 迁移和容量策略；
- Release 灰度、暂停/恢复、维护窗口和可观测进度；
- 统一 OpenAPI/协议生成及 SDK 发布策略；
- 扩展 Client 安装器到 ARM64/musl/macOS，并评估 Windows 无人登录 Service 与 PM2 之外的系统原生托管；当前只支持 ADR-0018 的 Windows/Linux x64 范围。

## 4. 产品方向候选

- TODO 驱动的任务管理、标签和结果审核；
- 跨机 agent 委托的真实双机验收：A2A 通道已在单机 Client 上端到端验证，A→B 跨机与真实 Linux 目标仍未验证。方向见 [ADR-0057](./adr/0057-a2a-hub-and-backend-agnostic-task-model.md)；
- 基于功能目录的可复用工作流、规则和自动触发（目录本身已落地，见 §1；编排、自动执行与产物回传仍未实现）；
- VCPToolBox 双向桥接与 Agent 对话；
- 主动监控巡检和异常任务生成；
- 移动端或轻量只读端。

这些方向当前不是系统已实现能力。Pi／DSH 专用集成已按 ADR-0049 退役，任何重新引入都必须先重新评估成本并另立 ADR。
## 5. 明确暂不承诺

- 公网多租户 SaaS；
- 高可用多 Server / SQLite 共享写入；
- Kubernetes 官方部署；
- 通用插件市场；
- 内建向量知识库（该能力属于 VCPToolBox 边界）。

## 6. 进入开发的门槛

候选项只有同时具备以下条件才进入“进行中”：

- 明确用户问题与验收标准；
- 架构和安全影响分析；
- 数据/协议兼容与回滚方案；
- 测试策略和运维方式；
- 所需 ADR/专题设计已评审；
- 不与当前阶段核心可靠性工作冲突。
