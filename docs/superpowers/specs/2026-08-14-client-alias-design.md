# Client 别名（可寻址名字）设计

## 背景

当前机器只有两个身份标识：客户端自生成的 `clientId`（持久化于机器本地文件，稳定但难记、不可改）和 `hostname`（注册时机器自报，可重复、不可由人控制）。机器列表、任务列表均显示 hostname。

目标：为每台机器提供一个**由人管理、全局唯一、可寻址的名字（别名）**，为后续"CLI 按别名操作机器"铺路。

## 需求规则

1. 别名默认取 hostname：机器首次注册时，服务端以 hostname 作为别名。
2. 唯一性兜底：生成时若与已有别名冲突，自动追加数字后缀（`_1`、`_2` …）直到不重复。
3. 服务端可随时修改别名；手动改名同样必须全局唯一，撞重名**直接拒绝**（不自动改后缀，避免用户起的名字被悄悄改动）。
4. 别名是固定字段：只在首次注册（或迁移补录）时生成一次；之后机器 hostname 变化不影响别名；只有服务端改名会改变它。
5. 身份仍是 clientId：别名只是寻址/展示层，不改注册协议、不影响在线状态等既有逻辑。

## 非目标

- 不做"CLI 通过别名操作机器"（后续需求，本轮只保证别名进入 `ClientInfo` 可供寻址）。
- 不改变 hostname 语义（仍为机器真实主机名，注册时刷新）。

## 方案

### 数据模型

`Client` 新增 `name String? @unique`：

- **可空**：运行时走 `prisma db push`，可空列对已有库平滑生效；SQLite 唯一索引允许多个 NULL，迁移前旧记录不冲突。
- **唯一**：并发注册同名机器的极小竞态由唯一索引兜底（失败方下次重连自愈）。

### 注册自愈补齐

`ClientService.register`（`packages/server/src/client/client.service.ts`）：

1. `findUnique` 查询现有记录的 `name`；
2. `nextAvailableName(base)`：从 `base` 起，被占用则依次尝试 `base_1`、`base_2` …（上限 1000 次）；
3. upsert：新机器 create 带 `name`；已有别名 update 不含 `name`（不覆盖）；迁移前旧记录（`name` 为 null）update 补 `name`。

因此存量部署无需一次性迁移脚本——旧机器下次重连即自动补齐唯一别名。

### 改名接口

`PATCH /api/clients/:clientId/name`（body `{ name }`）：

- 空名/非字符串 → 400 `INVALID_CLIENT_NAME`；
- 撞重名 → 409 `CLIENT_NAME_TAKEN`（查询 `name` 相同且 `id` 不同的记录）；
- 客户端不存在 → 404 `CLIENT_NOT_FOUND`（Prisma P2025 转换）。

错误对象遵循 `{ code, message }` + statusCode 约定（同 terminal.controller 的 HttpException 模式）。

### 展示切换

- `ClientInfo` 新增 `name: string`（服务端 `name ?? hostname` 兜底）。
- 机器列表卡片主名、机器工作区标题显示别名；hostname 降为副标题。
- 任务列表 `clientName` 由 `client.hostname` 改为 `client.name ?? client.hostname`（`job.service.ts`）。
- 前端展示点统一 `client.name ?? client.hostname`，兼容旧服务端响应缺 `name` 的情况。

### SDK

`clients.rename(clientId, name)` 新增（`packages/sdk/src/clients.ts`）。

### 前端改名入口（双击编辑）

机器工作区标题支持双击进入编辑态（`packages/frontend/src/pages/machine-workspace.tsx`）：

- 双击名称 → 输入框自动聚焦并全选；Enter/失焦保存，Esc 取消。
- 保存调用 `sdk.clients.rename`，成功后立即更新标题；失败保持编辑态并内联提示（409 → "该名称已被其他机器占用"）。
- 用 ref 防抖避免"回车保存后输入框卸载触发 blur"导致的重复提交。
- 展示名与 10s 自动刷新同步，外部改名也会被刷新生效。

机器列表卡片底部快捷链接与详情页 tab 共用 `MACHINE_TABS`（`packages/frontend/src/lib/utils.ts`），点击直达对应 tab。

## 部署注意

`packages/server/package.json` 的 `start`/`dev` 脚本已加 `prisma db push --accept-data-loss`：本次变更（可空列 + 唯一索引，存量全为 NULL）实际无损，但 Prisma 静态分析会告警。代价是后续破坏性 schema 变更也会自动应用，不再拦截。

## 验收

- 两台同名机器注册，第二台自动获得 `xxx_1`，机器列表可见。
- 改名成功立即生效；改成已存在名字 → 409 且名字不变；空名 → 400。
- 改名后机器列表、任务列表显示新名字。
- 存量记录（name 为 null）重连后自动补齐唯一别名。
- 后续 CLI 可用别名解析到机器（本轮保证 `name` 进入 `ClientInfo`）。

## 已知取舍

- 机器重装（clientId 变化）后别名需重新设置——别名挂在 clientId 上，可接受。
- 手动改名撞重名采用"拒绝"而非"自动加后缀"——避免用户主动起的名字被悄悄改动。
