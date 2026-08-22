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
| CLI 单元/本地集成测试 | Vitest，`packages/cli/src/*.test.ts` | 多环境严格配置、选择优先级、项目查找、凭据引用、命令与 Release SDK 接线 |
| Frontend 组件测试 | Vitest + Testing Library + jsdom | 路由、状态、交互、敏感信息不渲染 |
| 包内集成测试 | `*.integration.test.ts` | Server Gateway/Broker、Client Pi Worker、Terminal |
| 项目 E2E | `scripts/test.cjs` | 真实 Server + mock/真实 Client + REST/WS |
| CLI 能力 E2E | `scripts/test-cli-capabilities.cjs` | 真实 Server + Client 上驱动 CLI 构建产物，逐域验证 clients/jobs/files/frp/storage/terminal/pi 与错误路径（临时物全部隔离在 `.tmp/cli-e2e/`） |
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

`pnpm lint` 由根目录 `biome.json` 驱动（Biome，仅 linter 不含格式化；覆盖 `packages/*/src` 与 `scripts`）：错误级诊断阻塞门禁；降级为 warning 的规则（NestJS DI 未使用参数、noExplicitAny、非空断言等）为已知技术债，新增代码不应新增此类告警。

按包：

```bash
pnpm --filter @vcpdeck/shared test
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/cli test
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

CLI 能力端到端：

```bash
pnpm build          # 需先构建 server/client/cli
test:cli            # 即 node scripts/test-cli-capabilities.cjs
```

AI Agent 会话运行时，Prisma 会拦截测试库 migrate，需操作者明确同意后以 `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=<同意文本>` 前缀运行；人工 shell 无需此变量。

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
| Storage 阿里云盘真环境验收 | `node scripts/test-release-alibaba.cjs`（ADR-0019 一键端到端）：脚本自建同一临时 DB、Server/Client Launcher，按会话把两个 Release 分片直接 PUT Provider，验证 Server 本地无目标 zip、下载 302、更新与清理；仅首次输入 clientId、浏览器 OAuth code 或 3001 端口冲突时需人工介入 |
| FRP | 实例/default/迁移/parser/secret、端口、单 Client 多实例、真实 FRPS/frpc、退出/断线/重启/删除孤儿 E2E |
| Auth/Security | 密码/Cookie/Bearer、禁用/启用、撤销/过期、修改密码、既有 Socket、最后 admin、parser/限速、Actor、防泄漏 |
| Release/Launcher | Shared 严格 parser、Local SHA/raw、Alibaba 会话持久化/恢复/分片刷新/Provider 安全错误/URL 不落库、CLI 实际发送字节 SHA、Server 本地无正文、Windows/Linux 格式、drain、Server 恢复、Client 补更、数据库兼容和回退 |
| Client 一键安装 | 默认关闭、Actor 开关、同版本 done Release、平台拒绝、Node/PM2 镜像回退、SHA、其他 Server 冲突、幂等修复、PM2 只托管 Launcher、Linux 重启、Windows 登录恢复和 Server 上线验收 |
| CLI 多环境与 Release | strict parser、明文秘密/未知字段拒绝、flag/env/project/global 优先级、Git 根、项目 fail closed、Token-first 注册、password/Bearer 缺失、`env check` 身份且不泄漏 Token、直连冲突、原子写入/权限、Local raw 与 Alibaba Provider 分片直传/403 刷新/URL 脱敏/旧 Server 引导兼容，以及 `status/wait` 的重启断线、成功、Release/Client 失败和超时 |
| Git 分发 | 在仓库外用 Node.js 24+/pnpm 10.26+ 从同一 Tag 安装 SDK/Shared，验证构建许可、JS/TS 导入、类型声明和单文件打包；从不同 cwd 调用同一 Skill CLI 验证项目环境隔离 |
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
- Client 一键安装在 Windows x64 与 Linux x64/glibc/systemd 的真实空机、既有 Node/PM2 和重启/登录恢复矩阵；
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
- Windows/Linux 构件从上传到 Server 更新、Client 逐台更新、离线补更和失败回退的完整链路；Alibaba 后端必须证明上传/下载正文均不经过 Server；
- 同一 Git Tag 的 Pi Skill 安装/升级与 SDK/Shared 仓库外安装；
- 数据库和 Storage 恢复；
- CHANGELOG/compatibility/deployment/operations 已更新。

## 8. 验证文档

`docs/verification/` 保存某次环境验收的证据，应记录：

- 日期、提交、应用版本和协议版本；
- OS/Node/FRP/Pi/数据库环境；
- 命令与结果摘要（脱敏）；
- 失败、跳过项和已知限制；
- 验收人。

- `scripts/test-release-alibaba.cjs`：ADR-0019 发布构件向阿里云盘上传/下载双向直连的唯一交互入口。直接运行后自动打包基线/目标版本、用 `install.cjs` 安装并启动隔离的 Server/Client Launcher、在同一临时 DB 中完成阿里云盘授权、按会话分片 PUT 两个平台构件、验证 `storage.mode=direct`、Server Local Release 目录无目标 zip与下载 302、等待 Server/Client 自更新、删除本测试云端对象并清理本测试进程/目录。仅在缺少 clientId、浏览器 OAuth code 或 3001 端口被其他进程占用时暂停请人处理。

验证文档是时间点证据，不是永久“已支持”声明。支持范围以 `compatibility.md` 和当前 CI 矩阵为准。

## 9. 当前缺口

- 缺完整浏览器 E2E；
- 缺独立、可重复的真实机器 Pi 专项验收矩阵；
- Server 重启窗口内 Job 结果不丢的真实环境验证未完成；
- Terminal snapshot/output seq、上游 gap、UTF-8 snapshot/backlog 上限、持续输入速率、generation、持久状态、首次/重复 attach-detach TTL 和本地 expired 收敛仍缺完整自动化和真实平台门禁；
- 尚未建立持续、可重复的 Windows/Linux 真实 PTY 验收矩阵；
- 远程文件 rootDir 认证、symlink/junction、不存在目标父链、import SHA-256、跨平台覆盖、running cancel、失败后下一 Job 派发和断线终局补报尚无满足长期安全要求的全链路验证；
- 全链路 Release（Server + 多 Client + 故障回退）未自动化；
- Client 一键安装代码与单元测试已落地，但 Windows/Linux 真实空机、PM2 自启及重启/登录恢复仍需发布候选环境验收；
- 缺数据库升级/回滚兼容测试；
- 认证缺 strict parser、登录限速、Cookie Origin/CSRF、Credential 生命周期、既有 Socket 撤销和最后 admin 防锁死测试；
- FRP 缺同 Client 多实例约束、secret 脱敏、默认实例原子性、Client 重启恢复、frpc 退出状态和删除孤儿的长期门禁；
- 缺稳定的安全 fuzz/速率限制测试；
- 旧集成测试清单存在过时能力描述，新增测试以代码和本文为准。
