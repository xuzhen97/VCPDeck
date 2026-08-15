# 自更新与发版设计文档（Self-Update & Release）

> 状态：设计已确认，进入实施。任务清单见 §12，完成一项勾选一项。

## 1. 背景与目标

打通「修 bug → job 日志验证 → 发版 → 自动更新」闭环：

- **服务端、客户端均支持自更新**，发版包经服务端上传到存储，两端各自下载、校验后执行自更新
- 新增 **launcher** 模块：负责启动 server/client 并执行自更新；launcher 稳定后**冻结、不参与自更新**
- 更新过程**优雅停机**：先停止接收新任务，等运行中 job 全部完成后才停止进程
- **无灰度**：全量依次更新（服务端先、客户端逐个）；无人工确认关卡，上传即触发
- 方案跨平台（Windows / Linux），不依赖具体目标环境

## 2. 需求决策记录（澄清结论）

| 决策点 | 结论 |
| -------- | ------ |
| 更新包形态 | 跨平台 zip（编译产物 + 依赖 + 脚本），目标机器只需 Node 即可运行，**不打包 Node 运行时** |
| Node 版本保障 | launcher 的初始化脚本检测/下载指定版本 Node（参考 `scripts/ensure-frpc.cjs` 模式：已存在则跳过） |
| 更新顺序 | 服务端先自更新，成功后客户端全量依次更新；离线客户端下次重连补更 |
| 优雅停机 | 更新信号 → 停止接新任务 → 等待运行中 job 完成 → 退出 → 更新 → 重启 |
| 失败回退 | 保留上一版本目录；新版本启动失败/探活失败自动回退 |
| 版本号 | 用户手动指定，从简：一个 release 一个 `x.y.z`，同时涵盖 server 与 client 构件 |
| 灰度 | 不需要 |
| AI agent | 不在本次范围；接口做成可程序化调用的 REST API，CLI 以后薄封装 |
| 发版前验证 | 「job 日志核对修复」为人工步骤，不进系统；系统内验证指包完整性校验 + 启动后健康检查 |
| 触发方式 | 上传即触发更新，无人工关卡 |

## 3. 总体架构

```
┌─ 开发机（你）──────────────┐
│ 改代码 → pnpm release 打包  │──POST /api/releases（zip）──▶ ┌─ 服务端机器 ──────────────────────┐
│ （生成 zip + sha256）       │                              │ launcher（冻结，手动部署一次）     │
└────────────────────────────┘                              │   ├─ ensure-node：保障 Node 版本   │
                                                            │   ├─ 守护 server 进程             │
                                                            │   └─ 执行自更新 + 失败回退        │
                                                            │ server（NestJS）                  │
                                                            │   ├─ Release 模块：存储/编排      │
                                                            │   └─ 优雅停机：停 dispatch、等 job│
                                                            └──────────────┬───────────────────┘
                                                                           │ WS 下发更新指令
                                                 ┌─────────────────────────┼──────────────────────────┐
                                                 ▼                         ▼                          ▼
                                     ┌─ 客户端机器 A ────────────┐ ┌─ 客户端机器 B ────────────┐   …依次更新
                                     │ launcher（冻结）          │ │ launcher（冻结）          │
                                     │ client（Node 代理）       │ │ client（Node 代理）       │
                                     │  优雅停机后由 launcher 更新│ │  （同上）                 │
                                     └───────────────────────────┘ └───────────────────────────┘
```

新增/变更的代码面：

```
packages/launcher/                 ← 新增：启动器（冻结、不自更新）
  src/
    ensure-node.ts                 # Node 版本检测/下载/缓存
    control.ts                     # 本地控制通道（127.0.0.1 + token）
    versions.ts                    # apps/<version>/ 目录管理与原子切换
    updater.ts                     # 下载/校验/解压/健康检查/回退
    daemon.ts                      # 进程守护与拉起策略
packages/shared/src/update.ts      ← 新增：更新协议类型与事件名
packages/server/src/release/       ← 新增：release 模块（存储、REST、编排、优雅停机）
packages/client/src/update.ts      ← 新增：客户端优雅停机与更新处理
scripts/pack-release.ts            ← 新增：跨平台打包脚本
```

## 4. 版本号方案

- 一个 release 一个版本号 `x.y.z`，由用户（发版时）手动指定，同时涵盖 server 与 client 两个构件
- 版本号通过打包脚本在构建时注入（替代当前 `shared/src/index.ts` 与 `client/src/register.ts` 中硬编码的 `"0.0.0"`）
- 客户端版本上报复用现有 `Client.clientVersion` 字段（注册报文 `MachineRegister.clientVersion`）
- 服务端自身版本通过新增 `GET /api/status` 暴露（同时供 launcher 健康探活）
- launcher 自身版本独立（冻结，仅作兼容性校验：`manifest.launcherMinVersion`）

## 5. 更新包格式

单文件：`vcpdeck-<version>.zip`，结构：

```
vcpdeck-1.2.0.zip
├─ manifest.json
├─ server/            # packages/server 产物：dist/ + generated/ + schema.prisma + node_modules（含 prisma CLI）
└─ client/            # packages/client 产物：dist/（含 frp/<platform>/ 多平台二进制）+ node_modules
```

`manifest.json`：

```json
{
  "version": "1.2.0",
  "nodeVersion": ">=24",
  "launcherMinVersion": "1.0.0",
  "sha256": "<zip 整体 sha256，由打包脚本生成，上传时服务端复核>",
  "artifacts": {
    "server": { "dir": "server/", "entry": "dist/main.js", "preStart": "prisma db push" },
    "client": { "dir": "client/", "entry": "dist/index.js" }
  }
}
```

跨平台要点（构建机侧，全部在打包脚本内完成）：

- `.npmrc` 配 `supportedArchitectures`（win32-x64、linux-x64），pnpm 一次装齐全平台原生依赖（`node-pty`、`@libsql/*` 等可选依赖）
- frp 用现有 `scripts/download-frp.ts --platform=win-x64,linux-x64` 全量下进 `dist/frp/<platform>/`
- Prisma 7 + libsql adapter 为纯 JS/WASM，无原生查询引擎，`prisma generate` 产物随包携带
- 打包时把 pnpm symlink 结构拍平成真实文件（`pnpm deploy` 或脚本复制，含 `@vcpdeck/shared` 编译产物）
- `preStart` 钩子：服务端启动前执行 `prisma db push`（zip 自带 prisma CLI，无 schema 变更时秒过）

## 6. Launcher 设计

每台机器**手动部署一次**（`install-launcher.cjs`），之后冻结。目标机器职责边界：launcher 只负责「启动 + 更新 + 回退」，业务逻辑全部在 server/client 进程内。

### 6.1 目录布局

```
<app dir>/                       # launcher 安装目录（默认 ~/.vcpdeck/launcher）
├─ launcher/                     # launcher 自身（冻结）
│  ├─ dist/                      # launcher 编译产物
│  └─ node/                      # ensure-node 下载的 Node 运行时缓存
├─ control.json                  # 本地控制通道地址：{ port, token, pid }
├─ apps/
│  ├─ current -> 1.2.0           # 当前生效版本（Linux 符号链接 / Windows 用指针文件，见 6.4）
│  ├─ 1.2.0/                     # 已解压的版本（含 server/ 或 client/ 构件）
│  └─ 1.1.0/                     # 上一版本（回退用，最多保留 1 份）
└─ state.json                    # 当前版本、目标版本、更新状态、失败计数
```

### 6.2 职责

| 职责 | 说明 |
| ------ | ------ |
| 确保 Node | 启动前比对 `manifest.nodeVersion`，缺失/不满足则下载官方 Node 到 `launcher/node/<version>/` 缓存，下次直接复用；下载源默认官方，可配镜像（npmmirror） |
| 启动/守护 | `node apps/current/<artifact>/<entry>` 拉起 server 或 client；进程崩溃按退避策略拉起（更新切换期间除外） |
| 自更新执行 | 收到更新指令 → 下载 zip → sha256 校验 → 解压到 `apps/<version>/` → 切换 current → 启动 → 健康检查 → 失败回退 |
| 失败回退 | 保留上一版本目录；新版本启动后 N 秒内退出/连续崩溃/探活失败 → 自动切回上一版本并记录状态 |
| preStart 钩子 | server 构件启动前执行 manifest 声明的 `prisma db push`（幂等） |

### 6.3 本地控制通道（launcher ↔ 被守护进程）

- launcher 启动时监听 `127.0.0.1` 随机端口 + 随机 token，写入 `control.json`
- server/client 通过环境变量 `VCPDECK_LAUNCHER_PORT` / `VCPDECK_LAUNCHER_TOKEN` 获知地址
- 被守护进程请求自更新：`POST http://127.0.0.1:<port>/update`，body：`{ version, url, sha256 }`
- 选 127.0.0.1 HTTP 而非 Unix socket：Windows/Linux 行为一致，无平台分支

### 6.4 版本切换（Windows 兼容）

- 先停进程再换文件（launcher 与被守护进程是两个进程，天然满足 Windows 文件占用约束）
- Linux 用符号链接切换 current；Windows 不用 symlink（权限问题），改用 `state.json` 记录 current 指向的版本目录，daemon 按指针启动

### 6.5 更新状态机

```
idle → downloading → verifying → extracting → switching → starting → health-check
   ↑                                                          │        │
   └──────────────── 失败回退（切回上一版本）──────────────────┘        └→ active（上报成功）
```

## 7. 服务端设计

### 7.1 数据模型（Prisma 新增）

```prisma
model Release {
  id        String   @id
  version   String   @unique
  sha256    String
  fileName  String
  size      Int
  status    String   @default("uploaded")  // uploaded | updating_server | updating_clients | done | failed
  clientStates String @default("{}")       // clientId -> pending | updating | done | failed（JSON）
  errorMessage String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

沿用现有 schema 的 JSON 字符串字段风格（如 `Client.capabilities`），不单独建状态表。

### 7.2 REST API（`packages/server/src/release/`）

| 端点 | 说明 |
| ------ | ------ |
| `POST /api/releases/upload` | raw stream 上传 zip（query: version、sha256；body 为 zip 字节）→ 校验 sha256/version 不重复 → 存 `data/releases/<version>.zip` → 写 Release 表 → 触发编排（弃 multipart，避免引入 multer 依赖）。受全局 AuthGuard 保护 |
| `GET /api/releases` | release 列表（分页，遵循 AGENTS.md 分页规范）。受全局 AuthGuard 保护 |
| `GET /api/releases/:version/file` | 下载更新包（客户端 launcher 使用）。`@Public()` 公开，完整性由 sha256 校验兑底 |
| `GET /api/status` | `{ serverVersion, activeRelease }`，供 launcher 健康探活与前端展示。`@Public()` 公开 |

鉴权：上传/列表沿用全局 AuthGuard（内部使用，需管理员会话）；下载与状态端点公开（客户端 launcher 无会话），风险由 sha256 完整性校验兑底。CLI 以后薄封装为 `vcpdeck release` 命令。

### 7.3 更新编排（全自动状态机）

Release 状态流转：

```
uploaded → updating_server → updating_clients → done
    │              │                 │
    └──────────────┴─────────────→ failed（附 errorMessage，不阻塞后续 release）
```

**① 服务端自更新**

1. orchestrator 置 `status = updating_server`
2. 服务端进入优雅停机（见 7.4）
3. 服务端调用本机 launcher `/update`，随后退出；launcher 接管：切换版本 → 启动 → 健康检查（`GET /api/status` 探活且版本匹配）
4. 新服务端启动后从 Release 表恢复编排状态，继续 ②
5. 若新版本启动失败，launcher 自动回退旧版本；旧服务端启动后发现自身版本 ≠ 目标版本 → 置 `status = failed`（DB 是唯一事实来源，崩溃安全）

**② 客户端全量依次更新**

1. 对**在线且 `clientVersion < release.version`** 的客户端按序（每次一台）经 WS 下发 `update:request`（含 version、下载 URL、sha256）
2. 客户端优雅停机完成后回 `update:ready`，随后客户端 launcher 下载/校验/切换/重启
3. 客户端重连注册，服务端核对 `clientVersion == release.version` → 标记该客户端 done → 下一台
4. 单台超时（默认 10 分钟可配）或失败 → 标记 failed，继续下一台，不阻塞整体
5. 离线客户端：下次注册时比对版本，落后则触发补更（同流程）
6. 全部处理完 → `status = done`（存在 failed 的客户端时仍为 done，failed 明细在 clientStates）

### 7.4 服务端优雅停机

1. 停止新 dispatch：pending job 保持 pending，不派发
2. 等待所有 `RUNNING`/`WAITING_INPUT` job 收敛为终态（job 在客户端执行，服务端只等状态；超时上限默认 10 分钟可配）
3. 广播 `server:shutdown` 事件（提示客户端服务端将重启、自动重连）
4. 进程退出（launcher 接管后续）

> 风险与对策：服务端重启窗口内客户端完成的 job，依赖 socket.io-client 断线缓冲 + 重连后补发（现有客户端已具备自动重连）。此项列入 E2E 验证项 F2。

## 8. 客户端设计

### 8.1 优雅停机（收到 `update:request` 后）

1. 置本地 draining 标志：拒绝新 dispatch（服务端侧同时不再向该客户端派活，双重保险）
2. 等待 executor 中运行中的 job 全部完成并成功上报（超时上限默认 10 分钟可配，超时强制退出）
3. 回 `update:ready`，调用本机 launcher `/update`，进程退出
4. 终端/agent 会话随进程退出中断（元数据在 DB，重连后恢复）——当前阶段可接受

### 8.2 重连与补更

- 注册报文 `clientVersion` 使用构建时注入的真实版本（替换硬编码 `"0.0.0"`）
- 服务端在注册/心跳处理时比对版本，落后则走 §7.3② 补更流程
- 更新完成后重连即完成闭环，无需额外协议往返

## 9. 协议变更（`packages/shared/src/update.ts`）

事件名（并入 `Events` 常量）：

| 事件 | 方向 | 载荷 |
| ------ | ------ | ------ |
| `update:request` | server → client | `{ releaseVersion, url, sha256, timeoutMs? }` |
| `update:ready` | client → server | `{ clientId, releaseVersion }` |
| `update:failed` | client → server | `{ clientId, releaseVersion, reason }` |
| `server:shutdown` | server → 广播 | `{ expectedVersion?, reconnectDelayMs? }` |

新增类型：`UpdateManifest`（§5）、`UpdateRequest`、`UpdateReady`、`UpdateFailed`。

## 10. 安全与校验

- zip 整体 sha256：打包时生成写入 manifest，上传时服务端复核，两端下载后再校验，通过才解压
- 更新包下载沿用现有 REST 无鉴权策略（内部使用），不新增鉴权面
- launcher 本地控制通道绑定 127.0.0.1 + 随机 token，仅本机可达
- 更新相关日志脱敏（版本号、URL 不含敏感信息；不打印包内容与密钥）

## 11. 发版工作流（用户侧）

```
① 修复 bug → 构建验证 → 用 job 日志核对修复效果（人工，现有流程）
② pnpm release --version 1.2.1
   ├─ 全平台构建（supportedArchitectures + 多平台 frp）
   ├─ 拍平 node_modules → 注入版本号 → 生成 manifest + zip + sha256
③ 上传：vcpdeck release upload ./vcpdeck-1.2.1.zip --server <url>（CLI 薄封装；CLI 完成前可直接 curl POST /api/releases）
④ 之后全自动：服务端自更新 → 客户端依次更新 → 状态可在 GET /api/releases 查看
```

## 12. 任务拆分 TODO

勾选方式：完成一项后把 `- [ ]` 改为 `- [x]`，并在行尾注明完成日期。

**TDD 判定准则**：可单测的纯逻辑（状态机、协议编解码、校验、版本比对、目录切换）→ 标 TDD（先写失败测试再实现）；依赖真实进程/网络/构建链的行为 → 用集成或冒烟测试覆盖，不标 TDD。

### 阶段 A：协议与版本注入

- [x] A1 `packages/shared/src/update.ts`：更新事件名（并入 `Events`）、payload 类型、`UpdateManifest` 类型 — 2026-06-15
- [x] A2 版本号构建注入：替换 `shared` 与 client 注册中硬编码的 `"0.0.0"`（打包脚本注入） — 2026-06-15

### 阶段 B：服务端

- [x] B1 Prisma `Release` 模型 + `release.service`（上传记录、状态流转、sha256 校验、clientStates 维护）——（TDD） — 2026-06-15
- [x] B2 REST API：`POST /api/releases/upload` 上传、`GET /api/releases` 列表、`GET /api/releases/:version/file` 下载——（TDD） — 2026-06-15
- [x] B3 更新编排 orchestrator：状态机（uploaded → updating_server → updating_clients → done/failed）、逐台下发、超时与失败不阻塞——（TDD） — 2026-06-15
- [x] B4 服务端优雅停机：停 dispatch → 等 RUNNING job 收敛（超时可配）→ 广播 `server:shutdown` → 退出——（TDD） — 2026-06-15
- [x] B5 `GET /api/status`：暴露 `serverVersion` 与 release 状态（launcher 探活 + 前端展示） — 2026-06-15
- [x] B6 服务端 ↔ launcher 本地控制通道调用（读 control.json、请求 /update、重试）——（TDD） — 2026-06-15

### 阶段 C：launcher 包

- [x] C1 `packages/launcher` 包骨架 + `ensure-node`（检测/下载/缓存，参考 `ensure-frpc.cjs` 模式，下载源可配镜像）——（TDD） — 2026-06-15
- [x] C2 版本目录管理与原子切换（`apps/<version>/` + current 指针，Windows 兼容策略）——（TDD） — 2026-06-15
- [x] C3 更新执行器（下载 → sha256 校验 → 解压 → 切换 → 启动 → 健康检查 → 失败回退）——（TDD） — 2026-06-15
- [x] C4 进程守护（启动、崩溃退避拉起、更新期间拉起抑制）——不适合 TDD（真实进程行为，冒烟/E2E 覆盖） — 2026-06-15
- [x] C5 本地控制通道服务端（127.0.0.1 + token、`/prepare`/`/apply` 处理、preStart 钩子 `prisma db push`）——（TDD） — 2026-06-15

### 阶段 D：客户端

- [ ] D1 客户端优雅停机：收到 `update:request` → 拒新 job → 等运行中 job 完成并上报 → 回 `update:ready` → 调 launcher → 退出——（TDD）
- [ ] D2 版本上报与补更：注册带真实版本；服务端比对触发离线补更——（TDD）
- [ ] D3 客户端调用本机 launcher 控制通道（与 B6 同协议）——（TDD）

### 阶段 E：打包与发版

- [ ] E1 `scripts/pack-release.ts`：全平台构建 → 拍平 node_modules（pnpm deploy/复制）→ 多平台 frp → 注入版本 → 生成 manifest + zip + sha256——不适合 TDD（构建脚本，冒烟测试：产物可解压、可启动）
- [ ] E2 CLI 发版命令：`@vcpdeck/cli release upload`（薄封装 `POST /api/releases`，打印上传/更新进度）——不适合 TDD（薄封装，冒烟测试）

### 阶段 F：端到端验证

- [ ] F1 完整演练：测试环境走通「上传 → 服务端自更新 → 客户端依次更新 → 手动制造失败验证回退」——集成测试，不适合 TDD
- [ ] F2 断线验证：服务端重启窗口内完成的 job 结果不丢（socket.io 缓冲 + 重连核对）——集成测试，不适合 TDD

## 13. 边界与后续扩展

- **本次不做**：灰度发布、更新签名（后续可加 HMAC）、launcher 自更新、AI agent 环节、更新窗口定时（到点更新）
- **预留**：REST API 已可程序化调用，后续 SDK 加 `release` 方法、CLI 加命令、AI agent 经 CLI 完成全流程
