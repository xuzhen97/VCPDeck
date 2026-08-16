# 专题设计文档索引

> 维护责任：各功能模块负责人｜最后核验：2026-08-15

`docs/design/` 是长期 Current 专题设计的入口。专题记录当前已经落地的架构、数据、协议、安全、故障和已知实现偏移；代码、Shared、Prisma schema 和配置读取逻辑决定当前运行事实，Accepted ADR 解释长期决策意图。

## 当前可参考专题

| 领域 | 文档 | 使用方式 |
| --- | --- | --- |
| 身份与认证 | [`identity-and-authentication.md`](./identity-and-authentication.md) | 当前 Identity、Cookie、Bearer、Actor、admin、撤销和安全边界 |
| 远程文件 | [`remote-files.md`](./remote-files.md) | 当前文件 Typed Job、目标路径、轻量操作、导入/导出和失败边界 |
| Storage | [`storage.md`](./storage.md) | 当前 File/Provider、Local/Alibaba 数据路径、状态、安全与恢复边界 |
| FRP | [`frp.md`](./frp.md) | 当前 FrpsInstance、Mapping、Typed Job、frpc、凭据和恢复边界 |
| 远程终端 | [`remote-terminal.md`](./remote-terminal.md) | 当前 PTY、Session、attach、控制权、snapshot、重连和失败边界 |
| 远程 Pi | [`remote-pi.md`](./remote-pi.md) | 当前 Worker、Session/Run、REST/SSE、Extension、隐私、重连与兼容边界 |
| Release/更新 | [`release-and-update.md`](./release-and-update.md) | 当前 Release 编排、Launcher、更新、回退和故障边界 |
| 远程执行 | [`remote-execution.md`](./remote-execution.md) | 当前 command/script、输出、取消、安全边界与 runtime registry 迁移 |

## 新专题模板

新文档应包含：

1. 状态、负责人、日期、适用版本；
2. 问题和非目标；
3. 架构/数据/协议；
4. 状态机与失败路径；
5. 安全、隐私和运维；
6. 兼容、迁移和回滚；
7. 测试与验收；
8. 与 ADR、Current 文档的关系。

专题落地后必须同步 Current 文档；专题过期时移入 archive 或显式标记 Superseded。
