# ADR-0001：Server 中心控制面与 Client 主动出站连接

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：`docs/architecture.md`、`docs/server-client-interaction-design.md`

## 背景

目标机器可能位于 NAT、内网或动态网络，浏览器和自动化调用方需要统一认证、审计和状态管理。若各调用方直接访问目标机器，会产生连接、权限、协议和状态分裂。

## 决策

Server 作为唯一控制面；Frontend、SDK 和 CLI 只访问 Server。每台 Client 使用 PSK 主动建立 `/client` Socket.IO 出站连接，并在该连接上复用注册、心跳、Job、文件、FRP、Pi、终端和更新控制事件。

## 候选方案

- Server 主动 SSH/WinRM：目标网络可达性和凭据管理复杂；
- 每种能力独立连接：连接和重连对账碎片化；
- 浏览器直连 Client：无法建立统一认证和审计边界。

## 后果

正面：穿透网络边界更简单；认证、状态和审计集中；Client 能力可演进。

负面：Server 成为控制面单点；断线对账复杂；共享 PSK 需要后续演进为每机身份。

## 验证与退出条件

通过真实 Client 注册、断线重连、Job 对账和多机器调度验证。若未来引入多 Server，需要重新设计连接 lease、共享状态和消息路由，并以新 ADR supersede。
