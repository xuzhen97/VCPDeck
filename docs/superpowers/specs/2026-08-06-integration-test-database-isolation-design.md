# 根集成测试数据库隔离设计

## 背景

根命令 `pnpm test` 执行 `scripts/test.cjs`。当前脚本的 `cleanDb()` 会直接删除 `packages/server/prisma/dev.db`，随后启动 Server。由于 Prisma CLI 配置和运行时 `PrismaService` 都硬编码同一个开发库路径，集成测试会破坏开发数据，包括存储后端配置、阿里云授权信息和任务历史。

## 目标

- 根集成测试不得读取、修改或删除开发数据库。
- 每次集成测试使用唯一、空白的 SQLite 数据库。
- Prisma `db push` 与运行时 Server 必须连接同一个测试数据库。
- 测试成功、失败或抛出异常后均清理测试数据库目录。
- 正常开发不设置 `DATABASE_URL` 时，仍默认使用 `packages/server/prisma/dev.db`。

## 非目标

- 不改变数据库模型、迁移策略或生产部署方式。
- 不修改其他集成测试的端口占用处理。
- 不实现开发数据库备份或恢复。
- 不增加依赖或通用配置抽象。

## 方案

### 统一数据库 URL

`packages/server/prisma.config.cjs` 优先使用 `process.env.DATABASE_URL`，未设置时保持 `file:./prisma/dev.db`。这样 `prisma db push` 可由调用方选择数据库，同时保留现有开发默认行为。

`PrismaService` 使用相同的 `DATABASE_URL`。未设置时，它仍将 `./prisma/dev.db` 解析为 Server 工作目录下的绝对文件 URL。设置时，直接把该 URL 传给 `PrismaLibSql`，确保 Prisma CLI 与运行时不会连接不同数据库。

### 每次测试创建唯一数据库

`scripts/test.cjs` 使用 Node 标准库 `fs.mkdtempSync()` 在系统临时目录创建唯一目录，并将其中的 `test.db` 转换为 SQLite `file:` URL。

启动 Server 时，将该 URL 作为 `DATABASE_URL` 放入子进程环境。Server 的 `pnpm start` 先执行 `prisma db push`，再运行应用；两步继承同一环境变量，因此共享同一测试库。

删除现有 `cleanDb()`。根集成测试不再计算或删除 `packages/server/prisma/dev.db` 路径。

### 清理

现有统一收尾链路在停止 Server 后递归删除本次创建的临时目录。清理目标来自 `mkdtempSync()` 的返回值，不接受外部路径，也不回退到开发库。

临时目录创建失败时，测试立即失败。清理失败时输出临时目录和错误信息，但不尝试删除其他位置。

## 数据流

```text
scripts/test.cjs
  ├─ mkdtemp(system temp) → <unique>/test.db
  ├─ DATABASE_URL=file:<unique>/test.db
  └─ spawn pnpm start
       ├─ prisma db push → DATABASE_URL
       └─ node dist/main.js
            └─ PrismaService → DATABASE_URL
```

开发启动不传 `DATABASE_URL`：

```text
pnpm dev/start
  ├─ prisma db push → file:./prisma/dev.db
  └─ PrismaService → packages/server/prisma/dev.db
```

## 测试策略

使用 Node 内置 `node:test`，不新增测试框架或依赖。

回归测试验证：

1. 未设置 `DATABASE_URL` 时，Prisma CLI 配置保留开发库默认值。
2. 设置 `DATABASE_URL` 时，Prisma CLI 配置使用指定 URL。
3. 运行时数据库 URL 解析与 Prisma CLI 使用同一覆盖值。
4. 集成测试脚本不再包含删除开发库的逻辑。
5. 临时数据库辅助逻辑只创建并清理自身临时目录。

最终验证：

- 运行新增回归测试。
- 运行 Server 测试与构建。
- 运行根集成测试。
- 在根集成测试前后计算 `packages/server/prisma/dev.db` 哈希；如果文件存在，哈希必须完全一致。

## 验收标准

- `pnpm test` 完整通过。
- 测试前后的开发数据库内容和哈希不变。
- 测试使用的数据库位于系统临时目录，而不是仓库内。
- 正常 `pnpm dev` / Server `pnpm start` 未设置覆盖值时仍使用现有开发数据库。
- 不增加依赖，不修改无关工作区文件。
