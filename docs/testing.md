# VCPDeck 测试策略

> 状态：Current｜维护责任：各包维护者/发布维护者｜最后核验：2026-08-15

## 1. 目标

测试必须覆盖的不只是成功 API，还包括跨进程协议、断线对账、路径/凭据安全、状态机并发、真实 PTY/Pi/FRP 和发布回退。

## 2. 测试层次

| 层次 | 工具/位置 | 适用内容 |
| --- | --- | --- |
| Shared 单元测试 | Vitest，`packages/shared/src/*.test.ts` | parse 函数、错误码、状态和边界常量 |
| Server 单元测试 | Vitest，模块旁测试 | Service 状态机、Controller 映射、Prisma mock |
| Client 单元测试 | Vitest | dispatcher、executor、文件路径、PTY/Pi supervisor |
| SDK 单元测试 | Vitest | URL、认证头、分页、错误归一化 |
| Frontend 组件测试 | Vitest + Testing Library + jsdom | 路由、状态、交互、敏感信息不渲染 |
| 包内集成测试 | `*.integration.test.ts` | Server Gateway/Broker、Client Pi Worker、Terminal |
| 项目 E2E | `scripts/test.cjs` | 真实 Server + mock/真实 Client + REST/WS |
| FRP E2E | `scripts/test-frp.cjs` | 真实 frps/frpc、TCP/HTTP 映射 |
| Launcher 冒烟 | `scripts/smoke-launcher.cjs` | prepare/apply、探活、失败回退 |
| 手工/环境验收 | `docs/verification/` | Windows PTY、外部存储、真实网络和发布演练 |

## 3. 标准命令

```bash
pnpm install
pnpm -r test
pnpm lint
pnpm build
pnpm test
```

按包：

```bash
pnpm --filter @vcpdeck/shared test
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/launcher test
```

FRP：

```bash
pnpm download:frp
pnpm build
pnpm test:frp
```

Launcher：

```bash
pnpm --filter @vcpdeck/launcher build
node scripts/smoke-launcher.cjs
```

`pnpm test` 会使用 3001 端口并重建隔离测试数据库；执行前不要让开发 Server 占用端口。FRP 测试输出 `SKIP` 不算通过。

## 4. 变更对应测试

| 变更 | 最低测试 |
| --- | --- |
| Shared DTO/事件/错误码 | Shared 单测 + Server/Client 双端测试 + compatibility 更新 |
| Prisma schema/查询 | Service 测试 + migration/升级测试 + 备份恢复验证 |
| Job 状态机 | 并发、取消、断线、重连、终态幂等 |
| Exec command/script | 双端 parser、runtime capability、stdin、大小/输出截断、cwd root、timeout、进程树取消、最终输出留痕 |
| 远程文件/路径 | 双端 parser、Windows/Linux 认证 root、UNC/盘符、symlink/junction、不存在目标父链、文本上限、覆盖/临时文件、大小/SHA、取消、断流、失败后下一 Job 派发、重连和 Socket/Job 归属 |
| Terminal | 协议 parser、operator/viewer/token、snapshot/output 同序列、上游 gap/resync、UTF-8 上限、持续输入速率、generation、SQLite 状态、首次/重复 attach-detach TTL、expired 上报、真实 PTY 和进程树 |
| Pi | capability/协议 parser、Owner/Observer、runId/CAS、cwd/projectKey、Session 树、交互/非阻塞 Extension 投影与 Trust、图片、SSE、重连/重启、隐私和真实模型 smoke |
| Storage Provider | 签名篡改/过期、上传下载、Provider 故障、孤儿清理 |
| Storage 阿里云盘真环境验收 | `scripts/setup-alibaba-storage.cjs`（OAuth PKCE 人工引导）+ `scripts/test-release-alibaba.cjs`（ADR-0016 端到端） | 需已创建阿里云盘应用并在浏览器完成一次授权；验证构件转存、302 直链、Server/Client 自更新 |
| FRP | 实例/default/迁移/parser/secret、端口、单 Client 多实例、真实 FRPS/frpc、退出/断线/重启/删除孤儿 E2E |
| Auth/Security | 密码/Cookie/Bearer、禁用/启用、撤销/过期、修改密码、既有 Socket、最后 admin、parser/限速、Actor、防泄漏 |
| Release/Launcher | SHA、archive 路径安全、Windows/Linux 格式、drain、Server 恢复、Client 补更、数据库兼容和回退 |
| Frontend | loading/error/empty、刷新重连、无敏感原文渲染 |

## 5. 测试数据与安全

- 不执行真实破坏性命令；
- 使用临时目录和唯一 Client ID；
- 不在 fixture 中提交真实 Token、PSK、OAuth 凭据或签名 URL；
- 文件测试使用小型合成内容并验证清理；
- 日志断言不得输出 command/script/file content；
- 外部服务测试使用专用测试账户和最小权限目录；
- E2E 失败后必须清理子进程、端口、临时 DB 和 FRP 映射。

## 6. CI 建议门禁

每个 PR：

1. 格式/lint；
2. 受影响包类型检查和单元测试；
3. 全量 `pnpm build`；
4. 核心 `pnpm test`；
5. secret scan、依赖漏洞和静态安全检查；
6. 文档链接及 Mermaid 基本校验。

主分支/发布候选：

- Windows 和 Linux 矩阵；
- 真实 node-pty；
- FRP E2E；
- Pi Worker 集成、锁定 SDK 的 Session JSONL 打开/迁移与真实模型 smoke；
- Launcher 更新/回退；
- 从上一支持版本数据库升级；
- 备份恢复 smoke；
- Frontend 浏览器 E2E（当前尚未建立，应补齐）。

## 7. 发布验收

Release 不得只凭构建成功发布。至少确认：

- health/status/login；
- Client 注册、心跳、别名和 capability；
- exec command/script、stdin、输出边界、timeout、进程树取消和断线对账；
- 文件浏览、文本留痕、写/移/删覆盖、导入/导出、Local/Alibaba 完整性差异、取消/断线和 Storage；
- Terminal attach/input/resync/close、snapshot/seq、控制权、Client/Server 重启、TTL/expired 和真实 PTY；
- Pi Session CRUD/fork/clone、prompt/steer/follow-up/compact/abort、Extension/Trust、图片、SSE、Worker/Client/Server reconnect；
- FRPS probe、单实例映射、frpc 退出/重启、删除孤儿和凭据不泄漏；
- Windows/Linux 构件从上传到 Server 更新、Client 逐台更新、离线补更和失败回退的完整链路；
- 数据库和 Storage 恢复；
- CHANGELOG/compatibility/deployment/operations 已更新。

## 8. 验证文档

`docs/verification/` 保存某次环境验收的证据，应记录：

- 日期、提交、应用版本和协议版本；
- OS/Node/FRP/Pi/数据库环境；
- 命令与结果摘要（脱敏）；
- 失败、跳过项和已知限制；
- 验收人。

- `scripts/setup-alibaba-storage.cjs`：阿里云盘 Storage 后端的人工 OAuth PKCE 授权引导。交互输入 clientId、浏览器完成授权、输入 code 粘回，验证授权后把 Server Storage 后端切换为 `alibaba`。是 `scripts/test-release-alibaba.cjs` 的前置。
- `scripts/test-release-alibaba.cjs`：ADR-0016 发布构件经阿里云盘直连分发的真环境集成测试。自启动 Server Launcher + Client Launcher，打包 0.1.18 → install.cjs 装 0.1.17 → CLI 上传两个平台（确认转存 alibaba + 记录 `storage.mode=direct`）→ 验证 download 302 直链 → 等待 Server/Client 自更新到 0.1.18 → 验证 `VCPDECK_RELEASES_DIR` 不含 zip → 自动清理。

验证文档是时间点证据，不是永久“已支持”声明。支持范围以 `compatibility.md` 和当前 CI 矩阵为准。

## 9. 当前缺口

- 缺完整浏览器 E2E；
- 缺独立、可重复的真实机器 Pi 专项验收矩阵；
- Server 重启窗口内 Job 结果不丢的真实环境验证未完成；
- Terminal snapshot/output seq、上游 gap、UTF-8 snapshot/backlog 上限、持续输入速率、generation、持久状态、首次/重复 attach-detach TTL 和本地 expired 收敛仍缺完整自动化和真实平台门禁；
- 尚未建立持续、可重复的 Windows/Linux 真实 PTY 验收矩阵；
- 远程文件 rootDir 认证、symlink/junction、不存在目标父链、import SHA-256、跨平台覆盖、running cancel、失败后下一 Job 派发和断线终局补报尚无满足长期安全要求的全链路验证；
- 全链路 Release（Server + 多 Client + 故障回退）未自动化；
- 缺数据库升级/回滚兼容测试；
- 认证缺 strict parser、登录限速、Cookie Origin/CSRF、Credential 生命周期、既有 Socket 撤销和最后 admin 防锁死测试；
- FRP 缺同 Client 多实例约束、secret 脱敏、默认实例原子性、Client 重启恢复、frpc 退出状态和删除孤儿的长期门禁；
- 缺稳定的安全 fuzz/速率限制测试；
- 旧集成测试清单存在过时能力描述，新增测试以代码和本文为准。
