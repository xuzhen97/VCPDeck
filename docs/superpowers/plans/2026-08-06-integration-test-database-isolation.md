# 根集成测试数据库隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让根集成测试始终使用唯一临时 SQLite 数据库，保证 `packages/server/prisma/dev.db` 在测试前后不被读取、修改或删除。

**Architecture:** Server 的 Prisma CLI 配置和运行时 PrismaService 统一尊重 `DATABASE_URL`，未设置时继续使用现有开发库。根集成测试通过一个小型标准库辅助模块创建并清理唯一临时数据库目录，再把 URL 传给 Server 子进程。

**Tech Stack:** Node.js CommonJS、`node:test`、Prisma 7、SQLite/libSQL、TypeScript、pnpm。

## Global Constraints

- 不增加依赖。
- 不改变数据库模型、迁移策略或生产部署方式。
- 不修改其他集成测试的端口占用处理。
- 不实现开发数据库备份或恢复。
- 未设置 `DATABASE_URL` 时仍默认使用 `packages/server/prisma/dev.db`。
- 不覆盖或提交工作区已有的无关改动。

---

## File Structure

- `packages/server/src/prisma/database-url.ts`：运行时数据库 URL 的唯一解析函数。
- `packages/server/src/prisma/database-url.test.ts`：验证覆盖值和开发默认值。
- `packages/server/src/prisma/prisma.service.ts`：消费解析后的 URL创建 Prisma adapter。
- `packages/server/prisma.config.cjs`：Prisma CLI 使用环境覆盖或开发默认值。
- `scripts/integration-test-db.cjs`：创建、描述和清理根集成测试的唯一临时数据库。
- `scripts/integration-test-db.test.cjs`：使用真实临时目录验证生命周期与脚本安全边界。
- `scripts/test.cjs`：使用临时数据库环境启动 Server，并在统一收尾中清理。

### Task 1: 统一 Server 运行时数据库 URL

**Files:**

- Create: `packages/server/src/prisma/database-url.ts`
- Create: `packages/server/src/prisma/database-url.test.ts`
- Modify: `packages/server/src/prisma/prisma.service.ts:1-13`

**Interfaces:**

- Produces: `resolveDatabaseUrl(databaseUrl?: string, cwd?: string): string`
- Consumes: `process.env.DATABASE_URL` and `process.cwd()`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./database-url.js";

describe("resolveDatabaseUrl", () => {
  it("returns the explicit database URL unchanged", () => {
    expect(resolveDatabaseUrl("file:C:/Temp/vcpdeck/test.db", "D:/repo/server"))
      .toBe("file:C:/Temp/vcpdeck/test.db");
  });

  it("defaults to the server development database", () => {
    expect(resolveDatabaseUrl(undefined, "D:/repo/server"))
      .toBe("file:///D:/repo/server/prisma/dev.db");
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/prisma/database-url.test.ts
```

Expected: FAIL because `./database-url.js` does not exist.

- [ ] **Step 3: 写最小实现并接入 PrismaService**

```ts
// packages/server/src/prisma/database-url.ts
import * as path from "node:path";

export function resolveDatabaseUrl(
  databaseUrl = process.env.DATABASE_URL,
  cwd = process.cwd(),
): string {
  if (databaseUrl) return databaseUrl;
  const dbPath = path.resolve(cwd, "prisma/dev.db").replace(/\\/g, "/");
  return `file:///${dbPath}`;
}
```

将 `PrismaService` 中的硬编码路径替换为：

```ts
const factory = new PrismaLibSql({ url: resolveDatabaseUrl() }, {});
```

并删除不再需要的 `node:path` import。

- [ ] **Step 4: 运行测试、LSP 和 Server 构建**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/prisma/database-url.test.ts
pnpm --filter @vcpdeck/server build
```

Expected: 2 tests PASS; build exits 0.

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/prisma/database-url.ts packages/server/src/prisma/database-url.test.ts packages/server/src/prisma/prisma.service.ts
git commit -m "fix: 支持覆盖 Server 数据库地址"
```

### Task 2: 让 Prisma CLI 使用相同覆盖值

**Files:**

- Create: `scripts/prisma-config.test.cjs`
- Modify: `packages/server/prisma.config.cjs:1-7`

**Interfaces:**

- Consumes: `process.env.DATABASE_URL`
- Produces: Prisma config `datasource.url`

- [ ] **Step 1: 写失败测试**

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const configPath = path.resolve(__dirname, "../packages/server/prisma.config.cjs");

function loadConfig(databaseUrl) {
  const previous = process.env.DATABASE_URL;
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  delete require.cache[configPath];
  try {
    return require(configPath);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    delete require.cache[configPath];
  }
}

test("Prisma config preserves the development default", () => {
  assert.equal(loadConfig(undefined).datasource.url, "file:./prisma/dev.db");
});

test("Prisma config honors DATABASE_URL", () => {
  assert.equal(
    loadConfig("file:C:/Temp/vcpdeck/test.db").datasource.url,
    "file:C:/Temp/vcpdeck/test.db",
  );
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test scripts/prisma-config.test.cjs
```

Expected: default test PASS and override test FAIL because the config is hard-coded.

- [ ] **Step 3: 写最小实现**

```js
const { defineConfig } = require("@prisma/config");

module.exports = defineConfig({
  datasource: {
    url: process.env.DATABASE_URL || "file:./prisma/dev.db",
  },
});
```

- [ ] **Step 4: 运行测试和 Server 构建**

Run:

```bash
node --test scripts/prisma-config.test.cjs
pnpm --filter @vcpdeck/server build
```

Expected: 2 tests PASS; build exits 0.

- [ ] **Step 5: 提交**

```bash
git add scripts/prisma-config.test.cjs packages/server/prisma.config.cjs
git commit -m "fix: 统一 Prisma CLI 数据库地址"
```

### Task 3: 根集成测试使用唯一临时数据库

**Files:**

- Create: `scripts/integration-test-db.cjs`
- Create: `scripts/integration-test-db.test.cjs`
- Modify: `scripts/test.cjs:1-25,118-125,1136-1160,2061-2077`

**Interfaces:**

- Produces: `createIntegrationTestDb(): { directory: string, databaseUrl: string }`
- Produces: `cleanupIntegrationTestDb(context): void`
- Consumes: Server child process `env.DATABASE_URL`

- [ ] **Step 1: 写失败测试**

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createIntegrationTestDb,
  cleanupIntegrationTestDb,
} = require("./integration-test-db.cjs");

test("creates and cleans a unique integration database directory", () => {
  const first = createIntegrationTestDb();
  const second = createIntegrationTestDb();
  try {
    assert.notEqual(first.directory, second.directory);
    assert.match(first.databaseUrl, /^file:/);
    assert.equal(path.dirname(new URL(first.databaseUrl).pathname).replace(/^\/(.:\/)/, "$1"), first.directory.replace(/\\/g, "/"));
    fs.writeFileSync(path.join(first.directory, "test.db"), "test");
  } finally {
    cleanupIntegrationTestDb(first);
    cleanupIntegrationTestDb(second);
  }
  assert.equal(fs.existsSync(first.directory), false);
  assert.equal(fs.existsSync(second.directory), false);
});

test("root integration test no longer deletes the development database", () => {
  const source = fs.readFileSync(path.join(__dirname, "test.cjs"), "utf8");
  assert.doesNotMatch(source, /unlinkSync\s*\(/);
  assert.doesNotMatch(source, /["']dev\.db["']/);
  assert.match(source, /DATABASE_URL:\s*testDatabase\.databaseUrl/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test scripts/integration-test-db.test.cjs
```

Expected: FAIL because `integration-test-db.cjs` does not exist.

- [ ] **Step 3: 写最小辅助模块**

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function createIntegrationTestDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-test-"));
  return {
    directory,
    databaseUrl: pathToFileURL(path.join(directory, "test.db")).href,
  };
}

function cleanupIntegrationTestDb(context) {
  if (!context) return;
  fs.rmSync(context.directory, { recursive: true, force: true });
}

module.exports = { createIntegrationTestDb, cleanupIntegrationTestDb };
```

- [ ] **Step 4: 接入根集成测试**

在 `scripts/test.cjs` 顶部导入辅助函数并创建模块级 `testDatabase`：

```js
const {
  createIntegrationTestDb,
  cleanupIntegrationTestDb,
} = require("./integration-test-db.cjs");

const testDatabase = createIntegrationTestDb();
```

删除 `cleanDb()` 定义和 `main()` 中的调用。启动 Server 时加入：

```js
DATABASE_URL: testDatabase.databaseUrl,
```

统一收尾中，在 Server 进程停止后执行：

```js
cleanupIntegrationTestDb(testDatabase);
```

- [ ] **Step 5: 运行辅助测试并确认 GREEN**

Run:

```bash
node --test scripts/integration-test-db.test.cjs
```

Expected: 2 tests PASS.

- [ ] **Step 6: 提交**

```bash
git add scripts/integration-test-db.cjs scripts/integration-test-db.test.cjs scripts/test.cjs
git commit -m "fix: 隔离根集成测试数据库"
```

### Task 4: 证明开发数据库不变

**Files:**

- Verify only; do not modify production files.

**Interfaces:**

- Consumes: Tasks 1-3 complete behavior.
- Produces: verification evidence.

- [ ] **Step 1: 记录开发数据库状态**

Run:

```bash
if [ -f packages/server/prisma/dev.db ]; then sha256sum packages/server/prisma/dev.db > .tmp/dev-db-before.sha256; else echo missing > .tmp/dev-db-before.sha256; fi
```

Expected: snapshot file exists.

- [ ] **Step 2: 运行新增回归测试**

Run:

```bash
node --test scripts/integration-test-db.test.cjs scripts/prisma-config.test.cjs
pnpm --filter @vcpdeck/server exec vitest run src/prisma/database-url.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: 运行 Server 测试和构建**

Run:

```bash
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/server build
```

Expected: all tests PASS; build exits 0.

- [ ] **Step 4: 运行根集成测试**

Run:

```bash
pnpm test
```

Expected: integration report has zero failures.

- [ ] **Step 5: 比较开发数据库状态**

Run:

```bash
if [ -f packages/server/prisma/dev.db ]; then sha256sum packages/server/prisma/dev.db > .tmp/dev-db-after.sha256; else echo missing > .tmp/dev-db-after.sha256; fi
diff -u .tmp/dev-db-before.sha256 .tmp/dev-db-after.sha256
```

Expected: `diff` exits 0 with no output.

- [ ] **Step 6: 运行诊断、变更范围检查和独立复核**

Run diagnostics for all modified source/test files, then:

```bash
git diff --check
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: no blocking diagnostics; only planned files are committed; unrelated working-tree changes remain untouched.

- [ ] **Step 7: 记录验证结果**

No code commit is required unless verification exposes a defect. Report exact test counts, build result, database hash equality, changed files, and residual risks.
