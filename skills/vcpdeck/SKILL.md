---
name: vcpdeck
description: Use VCPDeck through its CLI to access cockpit capabilities exposed by the VCPDeck Server. Use when the user asks to operate VCPDeck from Pi, inspect available CLI capabilities, publish or update VCPDeck, or use machine, Job, file, Terminal, Pi, FRP, Storage, and other commands as they become available. Currently the implemented CLI capability is Release upload and Server/Client self-update initiation.
compatibility: Requires Node.js 24+, the generated vcpdeck.cjs CLI beside this file, and network access to the VCPDeck Server. Individual capabilities may have additional requirements; Release packaging also requires the VCPDeck repository and pnpm.
---

# VCPDeck CLI

本 Skill 是 **VCPDeck CLI 的统一能力入口**，负责说明当前可用命令、调用方式、安全边界和操作流程。Release/自更新只是当前首先落地的一项功能；后续 CLI 与 Server 能力逐步对齐时，在本 Skill 中继续增加机器、Job、文件、Terminal、Pi、FRP、Storage 等功能说明。

Skill 不实现 HTTP、认证、轮询或业务状态机。它调用同目录的 `vcpdeck.cjs`；CLI 复用 `@vcpdeck/sdk` 访问 Server，Server 仍是业务状态和远程操作的控制面。

## 入口与能力发现

在本 `SKILL.md` 所在目录运行：

```bash
node ./vcpdeck.cjs --help
```

若 `vcpdeck.cjs` 不存在，在 VCPDeck 仓库根目录构建：

```bash
pnpm --filter @vcpdeck/cli build
```

以当前 CLI `--help` 和源码为命令事实来源。Server 或 SDK 已经具备某项 API，不代表 CLI 已经提供对应命令；不得自行猜测命令名或把规划能力描述为已实现。

## 当前能力

| 功能域 | CLI 命令 | 状态 | 说明 |
| --- | --- | --- | --- |
| 多环境配置 | `env add/list/show/current/use/remove` | 已实现 | 用户级注册环境，项目级只选择默认环境 |
| Release / 自更新 | `release upload` | 已实现 | 上传 Windows/Linux 两个平台构件；两个构件齐备后由 Server 自动编排 Server/Client 更新 |
| 机器、Job、文件、Terminal、Pi、FRP、Storage 等 | — | 尚未形成 CLI 命令 | 等对应 CLI 落地后再在本 Skill 中增加正式说明，不直接绕过 CLI 调用 |

## 功能：环境选择

用户级环境定义保存在 `~/.vcpdeck/cli/config.json`；项目 `.vcpdeck.json` 只保存环境名。Skill 不直接读取或修改这些 JSON，统一调用 CLI：

```bash
node ./vcpdeck.cjs env list
node ./vcpdeck.cjs env current
```

需要配置时使用：

```bash
node ./vcpdeck.cjs env add dev \
  --server=http://127.0.0.1:3001 \
  --auth=password --username=admin \
  --password-env=VCPDECK_DEV_PASSWORD
node ./vcpdeck.cjs env use dev --global
node ./vcpdeck.cjs env use dev --local
```

Bearer 环境改用 `--auth=bearer --token-env=<VAR>`。不得把密码或 Token 值写进配置或命令。

环境选择顺序为：显式 `--env`、`VCPDECK_ENVIRONMENT`、最近项目配置、全局默认。执行任何业务操作前必须先运行 `env current`，展示并核对环境名、Server 和来源；有副作用操作还需取得用户确认。项目配置损坏、引用不存在环境或目标 Server 不符合预期时停止，不通过 `--server` 绕过。

## 通用操作规则

1. 执行前先用 `--help` 核对命令和参数，不能根据 Server API 猜测 CLI 行为。
2. 向用户展示目标 Server、操作对象和预期副作用；写入、删除、执行、发布、重启等操作必须在执行前取得明确确认。
3. 密码、Cookie、Bearer Token、PSK、签名 URL、云端凭据和敏感正文不得写入命令、日志或回复。命名环境只保存凭据环境变量名，不保存值。
4. 非幂等 POST 的网络结果不明时先查询权威状态，不盲目重试。
5. CLI 成功退出只证明该命令定义的同步阶段成功；涉及异步 Job、Release 或远程运行态时，继续按对应功能说明核对终态。
6. 只报告安全摘要、资源 ID、稳定错误码、状态和下一步，不原样输出可能含敏感信息的 payload 或外部响应。
7. 当前没有对应 CLI 命令的能力应明确告知用户尚未落地，不通过临时 curl、任意 shell 或在 Skill 中复制 SDK 实现来伪造 CLI 能力。

## 功能：Release 上传与 Server/Client 自更新

### 功能语义

`release upload` 上传两个平台 Release archive。第二个平台构件成功登记后，Server 自动编排：

```text
Server 更新并探活 → 逐台更新在线 Client → 离线 Client 后续注册时补更
```

这里的“自更新”是 Server/Client 业务构件更新，**不是 CLI 替换自身，也不包括 Launcher 自动更新**。

### 安全边界

- 第二个平台构件上传成功后会立即触发更新，没有额外确认关卡。
- 上传前必须复述 Server URL、目标版本和两个 archive 路径，并取得明确确认。
- 优先读取用户已在本地设置的 `VCPDECK_ADMIN_USERNAME` / `VCPDECK_ADMIN_PASSWORD`；不要通过会显示值的命令检查，也不要让用户把密码贴到对话中。
- Release 上传是不可盲目重试的 POST。网络结果不明或只上传了一个平台时，先核对发版页面和 Release 记录。
- 同一版本号不得复用。失败后修复问题并使用新版本号。
- Launcher 回退只切回应用版本目录，不回退数据库、Storage 或外部副作用；发布前必须确认备份。

### 发布流程

#### 1. 发布前检查

1. 阅读 `../../docs/design/release-and-update.md`、`../../docs/design/cli.md` 与 `../../docs/deployment.md` §9。
2. 运行 `node ./vcpdeck.cjs env current`，向用户展示环境名、Server 和来源并确认；不要打印凭据值。
3. 确认已备份 SQLite、Storage 和 Release archive。
4. 确认目标 Linux 主机具备 `unzip`，Server/Client Launcher 正常，且没有其他活动 Release。
5. 确认凭据环境变量已由用户在本地设置，不打印其值。
6. 确认版本号严格为 `x.y.z`，并且从未使用。

#### 2. 生成构件

在仓库根目录运行：

```bash
pnpm release --version=x.y.z
```

必须同时得到：

```text
dist-release/vcpdeck-x.y.z-win-x64.zip
dist-release/vcpdeck-x.y.z-linux-x64.zip
```

缺少任一平台时停止，不把单边构件当作完整发布。

#### 3. 最终确认与上传

用户确认 Server、版本和文件后，在本 Skill 目录运行：

```bash
node ./vcpdeck.cjs release upload \
  <repo>/dist-release/vcpdeck-x.y.z-win-x64.zip \
  <repo>/dist-release/vcpdeck-x.y.z-linux-x64.zip
```

命令默认使用刚确认的项目/全局环境，也可显式添加 `--env=<name>`。不要添加 `--password` 或临时改用 `--server` 绕过项目选择。CLI 从环境变量读取凭据、计算 SHA-256，并通过 SDK 流式上传。两个构件必须版本相同且平台各一个。

#### 4. 核对结果

CLI 显示“上传完成”只证明两个上传请求成功，不证明更新完成。当前 CLI 尚无 Release 状态轮询命令，应在 Frontend“发版”页面核对：

```text
uploaded → updating_server → updating_clients → done | failed
```

成功门槛：

- Server 显示目标版本；
- Release 到达 `done`；
- 逐项检查 Client 明细，不能因 Release 为 `done` 就忽略 failed Client；
- 离线 Client 不阻塞 `done`，其后续注册时才补更。

若状态为 `failed`，只报告安全错误摘要和失败阶段。不要自行重复版本、删除数据库记录或覆盖 Launcher。

### 本功能当前不提供

- Launcher 自动更新；Launcher 升级遵循独立人工流程和兼容检查。
- 灰度、分组、暂停/恢复、维护窗口或数据库自动回滚。
- CLI 自身在线更新。

## 后续 CLI 能力扩展规则

每当 CLI 新增并验证一组 Server 能力时，同一变更应在本 Skill 中增加对应功能章节，至少包含：

1. 可用命令和真实 `--help` 用法；
2. 功能语义、状态权威和同步/异步完成边界；
3. 认证方式与敏感信息处理；
4. 读操作、写操作、危险操作及其确认门；
5. 幂等性、超时、取消、重试和断线语义；
6. 成功判定、失败处置和当前已知限制；
7. 与 Server 能力的已对齐项和仍未对齐项。

新增章节只描述已经落地并验证的 CLI 命令。候选命令和未来方向留在 Current 文档的“后续候选”或 Roadmap，不能提前写进“当前能力”。
