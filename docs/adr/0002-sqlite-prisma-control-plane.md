# ADR-0002：控制面使用 SQLite 与 Prisma

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：`docs/tech-stack.md`、`docs/domain-model.md`

## 背景

VCPDeck 当前是个人驾驶台，目标是低运维成本的单控制面部署，同时需要关系模型、状态查询和迁移能力。

## 决策

Server 使用 SQLite 持久化身份、Client、Job、File、FRP、Terminal 和 Release 元数据，通过 Prisma 访问，并使用 libSQL adapter。文件正文和远程实时资源不存入 SQLite。

## 候选方案

- PostgreSQL：并发和运维能力更强，但当前部署成本更高；
- 纯 JSON/文件：迁移、关系一致性和查询能力不足；
- Redis/队列作为事实来源：不适合长期业务状态和审计。

## 后果

正面：部署简单、备份直观、类型化数据访问。

负面：Server 为单写节点；不能直接扩展到多实例；生产迁移和一致备份仍需建立；切换 PostgreSQL 不是无成本操作。

## 验证与退出条件

持续验证数据库增长、写锁、备份恢复和迁移时间。出现多 Server、高并发写入或远程数据库硬需求时，启动新 ADR 评估 PostgreSQL。
