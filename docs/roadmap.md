# VCPDeck 路线图

> 状态：Planning｜维护责任：项目负责人｜最后核验：2026-08-15｜说明：优先级候选，不代表交付承诺

## 1. 已形成闭环

- Server ↔ Client 注册、心跳、能力上报和重连；
- Typed Job、命令/脚本执行、取消和对账；
- 远程文件浏览、读写、导入/导出和 Storage；
- FRPS 实例及 FRP 映射；
- Cookie/Bearer 身份认证和身份管理；
- 浏览器交互式终端；
- 人机交互式远程 Pi Session；
- Release、Launcher、Server/Client 更新基础实现；
- React 驾驶台和框架无关 SDK。

## 2. 近期优先级：可靠性与安全基线

1. 修正配置命名：统一 `VCPDECK_PSK`，更新示例并决定是否支持文件型 secret；
2. 统一 REST 错误响应和稳定错误码，修复 Auth 普通 Error 落为 500；补齐 Auth/Identity strict parser、登录限速、Cookie Origin/CSRF、Credential 过期/lastUsed/清理、禁用/改密后的既有 Session/Socket 失效和最后 admin 防锁死；
3. 建立生产数据库迁移流程，移除生产路径中的 `db push --accept-data-loss`；
4. 按 ADR-0010 将 exec script 迁移到 Client runtime registry，补齐双端 parser、runtime capability、script/output 上限、cwd root 校验、稳定 timeout 和进程树取消；
5. 修复远程文件边界：以 Client 认证 root/root ID 替代调用方自选 rootDir，修复 symlink/junction 与不存在目标父链校验，增加文件双端 parser、文本/传输上限、import SHA-256、跨平台覆盖/临时文件保证、running cancel/timeout、断线终局补报及 Socket/Job 归属校验；
6. 修复文件 Job error 分支丢弃下一条 scheduler dispatch、Alibaba export 分片 URL 续期路由以及 `FileTransferResult.sha256` 与 Provider/传输方向实际能力的协议偏移；
7. 修复 Terminal snapshot/output seq 统一、上游 gap resync、UTF-8 snapshot/backlog 上限和持续输入速率限制；
8. 完成 Terminal generation 对账、SQLite active/detached 时间同步、Client 断线通知、创建超时收敛、首次/重复 attach-detach TTL 重入和本地 expired 终态上报，并建立 Windows/Linux 真实 PTY 矩阵；
9. 确认 FRP 长期多实例方向：每 Client 强制单 FrpsInstance，或每实例独立 frpc runtime；以新 ADR 实施 secret 脱敏/存储、默认实例原子性、严格 parser、真实 active、Client 重启恢复、可靠删除和 Actor 审计；
10. 完成 exec 断线终局补报，修复 Pi 非阻塞 Extension UI 的 Shared/Client/Server 投影偏移，并完成 Server 重启窗口 Job 对账和 Windows/Linux 全链路 Release E2E，统一 archive 格式；
11. 修复 Release drain 失败后的派发恢复、重复版本构件覆盖和活动 Release 并发上传边界；
12. 增加构件数字签名、严格 manifest/archive 校验和 Launcher 最低版本强制校验；
13. 增加结构化脱敏日志、监控指标和告警；
14. 建立自动备份、恢复演练和数据保留清理；
15. 补齐浏览器 E2E、数据库升级测试和安全 fuzz；
16. 清理/归档与代码冲突的历史设计文档；
17. 按 ADR-0016 将发布归档接入 Storage Provider：统一 Server 下载入口（Local 直发、外部后端 302 临时直链、目标机直连存储不占 Server 带宽），上传转存 provider 并扩展 Release 记录，保持 CLI/协议/Launcher 兼容。

## 3. 中期候选：可运营性

- Client 历史/离线机器查询及显式退役；
- 每 Client 独立凭据、可审计轮换和可选 mTLS；
- 资源级授权、只读角色和操作审批；
- Job 输出的受控持久化、大小限制与脱敏；
- Storage 孤儿扫描、跨 Provider 迁移和容量策略；
- Release 灰度、暂停/恢复、维护窗口和可观测进度；
- 统一 OpenAPI/协议生成及 SDK 发布策略；
- 多平台安装器和系统服务集成。

## 4. 产品方向候选

- TODO 驱动的任务管理、标签和结果审核；
- 可复用工作流、规则和自动触发；
- VCPToolBox 双向桥接与 Agent 对话；
- Client 侧自主 Pi Agent 子任务及单机/多机编排；
- Pi 工具权限/审批策略、Skills/Extensions/Prompt 资源分发、机群用量与审计；
- 主动监控巡检和异常任务生成；
- 移动端或轻量只读端。

这些方向当前不是系统已实现能力。进入开发前需要基于届时锁定的 Pi SDK 重新调研，并完成独立需求、领域模型、安全边界、兼容策略和 ADR；不得把历史 Pi 能力调研或“完全管控”草案当作已接受设计。

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
