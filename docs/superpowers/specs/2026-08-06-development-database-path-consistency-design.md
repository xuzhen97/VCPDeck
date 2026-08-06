# 开发数据库路径一致性修复设计

## 背景

`pnpm dev:all` 启动 Server 时会先执行 `prisma db push`，再由 `PrismaService` 连接 SQLite。

当前存在两套数据库地址来源：

- `packages/server/prisma.config.cjs` 未加载 `.env` 时默认使用 `file:./prisma/dev.db`。
- `packages/server/src/main.ts` 通过 `dotenv/config` 读取 `packages/server/.env`，其中历史示例值为 `file:./dev.db`。

Prisma CLI 与 libSQL 对这两个值分别连接：

- `packages/server/prisma/dev.db`：现有开发库，包含完整表结构和开发数据。
- `packages/server/dev.db`：运行时新建的空库。

因此 `db push` 成功后，运行时仍会在空库查询 `Identity`，报 `SQLITE_ERROR: no such table: main.Identity`。

## 目标

- `pnpm dev:all` 的 Prisma CLI 与 Server 运行时连接同一个开发库。
- 兼容现有 `.env` 中的历史值 `file:./dev.db`。
- 保留 `packages/server/prisma/dev.db` 中的现有开发数据。
- 不影响集成测试传入的绝对临时数据库 URL。
- 不增加依赖或配置层。

## 非目标

- 不迁移或复制开发数据。
- 不改动数据库模型和迁移策略。
- 不让 Prisma CLI 自动加载 `.env`。
- 不删除除已确认的 0 字节 `packages/server/dev.db` 之外的数据库文件。

## 方案

### 运行时兼容历史开发地址

在 `resolveDatabaseUrl()` 中将历史相对值 `file:./dev.db` 视为开发库别名，并解析为当前 Server 工作目录下的 `prisma/dev.db` 绝对文件 URL。

其他行为保持不变：

- 未设置或空字符串：使用 `prisma/dev.db`。
- `file:./dev.db`：兼容映射到 `prisma/dev.db`。
- 显式绝对 `file:` URL：原样返回，保证根集成测试继续使用系统临时库。
- 其他显式 URL：原样返回。

### 修正规范示例

将 `packages/server/.env.example` 的数据库地址改为：

```dotenv
DATABASE_URL="file:./prisma/dev.db"
```

同时修正仓库根 `.env.example` 中的同一示例格式，使新环境不再生成历史歧义值。

不自动修改用户现有的 `packages/server/.env`；兼容分支保证旧文件仍可正常运行。

### 清理失败产物

完成验证后，删除已确认满足以下条件的 `packages/server/dev.db`：

- 未被 Git 跟踪；
- 文件大小为 0；
- SQLite 表集合为空；
- 来源为本次失败启动。

不删除 `packages/server/prisma/dev.db` 或其 WAL/SHM/journal 文件。

## 测试策略

按 TDD 添加回归测试：

1. `resolveDatabaseUrl("file:./dev.db", serverCwd)` 必须返回 `serverCwd/prisma/dev.db` 的绝对文件 URL。
2. 显式绝对临时数据库 URL必须原样返回。
3. 未设置和空字符串仍回退开发库。
4. `.env.example` 不再包含 `file:./dev.db`。

最终验证：

- 运行 URL 解析测试和 Server 完整测试。
- 构建 Server。
- 启动 `pnpm dev:all`，确认 Server 健康检查成功且不再出现 `no such table`。
- 启动前后比较 `packages/server/prisma/dev.db` 及伴随文件的哈希，确认开发库未被替换或清空。
- 停止本次启动的进程并确认端口释放。

## 验收标准

- `pnpm dev:all` 能正常启动 Server、Frontend 和 Client。
- `/api/health` 返回成功。
- Server 日志不含 `no such table: main.Identity`。
- 现有开发库哈希不变，数据仍位于 `packages/server/prisma/dev.db`。
- 根集成测试的绝对临时数据库覆盖逻辑保持通过。
- 已确认的 0 字节错误数据库被删除。
