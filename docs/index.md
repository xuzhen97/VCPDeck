# VCPDeck 文档中心

> 维护责任：项目维护者｜最后核验：2026-09-03｜适用版本：`0.6.18` / 当前 `main`

本页是长期文档的统一入口。代码和 `@vcpdeck/shared` 是协议事实来源；文档负责解释边界、语义和操作方式。

## 核心文档

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [`../README.md`](../README.md) | 所有人 | 项目定位、能力边界、快速开始 |
| [`architecture.md`](./architecture.md) | 架构师、开发者、运维 | 系统上下文、组件、通信、数据归属和关键链路 |
| [`tech-stack.md`](./tech-stack.md) | 开发者 | 技术选型、版本、用途和约束 |
| [`domain-model.md`](./domain-model.md) | 开发者、产品设计者 | 核心实体、关系、状态机和不变量 |
| [`protocols.md`](./protocols.md) | 前后端、Client、SDK 开发者 | REST、Socket.IO、SSE、错误和重连语义 |
| [`compatibility.md`](./compatibility.md) | 发布与维护人员 | Server、Client、Launcher、协议和运行时兼容规则 |
| [`documentation-governance.md`](./documentation-governance.md) | 所有维护者、AI | 文档分类、权威关系、生命周期、归档和清理规则 |

## 交付与运行

| 文档 | 内容 |
| --- | --- |
| [`deployment.md`](./deployment.md) | 配置、目录、部署拓扑、首次部署和升级 |
| [`quickstart.md`](./quickstart.md) | 从零到 Server/Client 通讯的快速开始演练（构建、部署、运行、验证） |
| [`operations.md`](./operations.md) | 启停、健康检查、备份恢复、巡检和故障处置 |
| [`security.md`](./security.md) | 信任边界、凭据、敏感数据、威胁与响应 |
| [`testing.md`](./testing.md) | 测试层次、命令、环境和发布门禁 |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 开发流程、变更要求和提交规范 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 用户可感知的版本变更 |

## 决策、规划与专题

| 文档 | 内容 |
| --- | --- |
| [`adr/README.md`](./adr/README.md) | 架构决策记录及新增规则 |
| [`roadmap.md`](./roadmap.md) | 已完成、近期候选和长期方向，不代表交付承诺 |
| [`design/README.md`](./design/README.md) | 当前专题设计文档索引及权威性说明（含 [`design/cli.md`](./design/cli.md) 多环境 CLI） |
| [`archive/README.md`](./archive/README.md) | 历史计划、过期设计和验证记录的归档规则 |

## 文档状态约定

- **Current**：描述当前代码，可以作为维护依据；
- **Design**：已确认的长期设计，必须结合代码核验；
- **Proposal**：候选方案，尚未成为约束；
- **Planning**：路线图和优先级候选，不代表交付承诺；
- **Archived**：已失效，仅保留历史背景；
- **Superseded**：已被明确的新文档或 ADR 替代。

## 维护规则摘要

1. 当前行为以代码、Shared、Prisma 和配置读取逻辑核验；长期决策意图以有效 Accepted ADR 为准；
2. 运行行为变更时，同一 PR 必须更新对应 Current 文档；
3. 新的重大取舍先写 ADR，再更新架构、领域、协议或专题设计；
4. 规划只进入 `roadmap.md`，不得写成当前能力；
5. 过程材料在有效知识收敛后删除；只有确有历史价值的失效材料才归档；
6. 代码、ADR 与 Current 文档冲突时必须报告，不得由 AI 静默猜测；
7. 完整规则见 [`documentation-governance.md`](./documentation-governance.md)。
