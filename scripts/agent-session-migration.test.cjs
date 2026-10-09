/**
 * Agent Session/Run/审计显式迁移的行为测试(ADR-0041 Task 1)。
 *
 * 只操作 mkdtemp 下的独立 SQLite;不触碰开发库或生产 DATABASE_URL。
 * 期望值独立于实现推导:状态映射、无历史 Run 伪造、事务回滚与幂等。
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// 迁移模块依赖 server 包的 @libsql/client;从该包目录解析,避免依赖根 node_modules。
const migrationRequire = createRequire(
	path.join(__dirname, "..", "packages", "server", "prisma", "agent-session-migration.cjs"),
);
// 模块自身尚不存在时,createRequire.resolve 也失败;先用路径直连 require,
// 让 RED 阶段的失败原因是「迁移缺失」而不是测试装配错误。
let migration;
try {
	migration = require("../packages/server/prisma/agent-session-migration.cjs");
} catch {
	migration = null;
}
const { createClient } = migrationRequire("@libsql/client");
const SQL_PATH = path.join(
	__dirname, "..", "packages", "server", "prisma", "migrations",
	"20261008000000_agent_session_run_audit", "migration.sql",
);

const dirs = [];
let seq = 0;

test("CLI 未设置 DATABASE_URL 时回退到 Prisma config 的开发库(绝对 file URL)", () => {
	assert.ok(migration, "迁移模块缺失:RED 阶段");
	const { pathToFileURL } = require("node:url");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-cfg-"));
	dirs.push(root);
	fs.writeFileSync(
		path.join(root, "prisma.config.cjs"),
		"module.exports = { datasource: { url: 'file:./prisma/dev.db' } };" + String.fromCharCode(10),
	);
	// `file:./prisma/dev.db` 是相对路径;脚本必须按 server 包根解析成绝对 URL,
	// 否则从仓库根或其他 cwd 调用会连到错误的库。
	assert.equal(
		migration.resolveCliDatabaseUrl({}, root),
		pathToFileURL(path.join(root, "prisma", "dev.db")).href,
	);
	// 显式环境变量永远优先(安装器与生产单元都依赖这一点)。
	assert.equal(
		migration.resolveCliDatabaseUrl({ DATABASE_URL: "file:/var/lib/vcpdeck/server.db" }, root),
		"file:/var/lib/vcpdeck/server.db",
	);
	// 配置文件缺失(如未随构件发布)时仍是同一默认位置,不得因此失败。
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-cfg-"));
	dirs.push(bare);
	assert.equal(
		migration.resolveCliDatabaseUrl({}, bare),
		pathToFileURL(path.join(bare, "prisma", "dev.db")).href,
	);
});

test("旧库尚未包含 ADR-0039 新增的模式列时可迁移,不因缺列报错", async () => {
	assert.ok(migration, "迁移模块缺失:RED 阶段");
	const db = makeLegacyDb();
	// 迁移跑在 db push 之前,而 ADR-0039 之前建的库还没有这三个模式列;
	// 此时仍要能迁移/跳过,否则升级路径会在 SQL 层直接崩。
	await db.client.execute(
		'CREATE TABLE "Client" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT, "online" BOOLEAN NOT NULL DEFAULT false)',
	);
	await db.client.execute(`
		CREATE TABLE "Job" (
			"id" TEXT NOT NULL PRIMARY KEY,
			"clientId" TEXT NOT NULL,
			"type" TEXT NOT NULL DEFAULT 'exec',
			"status" TEXT NOT NULL DEFAULT 'pending',
			"payload" TEXT NOT NULL DEFAULT '{}',
			"result" TEXT,
			"createdAt" DATETIME NOT NULL,
			"startedAt" DATETIME,
			"finishedAt" DATETIME,
			"createdByIdentityId" TEXT,
			"createdByName" TEXT,
			"createdVia" TEXT
		)
	`);
	await db.client.execute({
		sql: 'INSERT INTO "Client" ("id","name") VALUES (?,?)',
		args: ["c1", "host"],
	});
	await db.client.execute({
		sql: 'INSERT INTO "Job" ("id","clientId","type","status","payload","createdAt") VALUES (?,?,?,?,?,?)',
		args: ["s1", "c1", "agent.session", "idle", "{}", new Date().toISOString()],
	});

	const result = await migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
	assert.equal(result.migratedSessions, 1);
	const row = await readRow(db, "AgentSession", "s1");
	assert.equal(row.status, "available");
	assert.equal(row.toolExecutionModeOverride, null);
	db.cleanup();
});

test("旧库缺少模式列时,活跃状态仍然阻止迁移(fail closed 不降级)", async () => {
	assert.ok(migration, "迁移模块缺失:RED 阶段");
	const db = makeLegacyDb();
	await db.client.execute(
		'CREATE TABLE "Client" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT, "online" BOOLEAN NOT NULL DEFAULT false)',
	);
	await db.client.execute(`
		CREATE TABLE "Job" (
			"id" TEXT NOT NULL PRIMARY KEY,
			"clientId" TEXT NOT NULL,
			"type" TEXT NOT NULL DEFAULT 'exec',
			"status" TEXT NOT NULL DEFAULT 'pending',
			"payload" TEXT NOT NULL DEFAULT '{}',
			"createdAt" DATETIME NOT NULL,
			"createdByIdentityId" TEXT,
			"createdByName" TEXT,
			"createdVia" TEXT
		)
	`);
	await db.client.execute({
		sql: 'INSERT INTO "Client" ("id","name") VALUES (?,?)',
		args: ["c1", "host"],
	});
	await db.client.execute({
		sql: 'INSERT INTO "Job" ("id","clientId","type","status","payload","createdAt") VALUES (?,?,?,?,?,?)',
		args: ["s1", "c1", "agent.session", "running", "{}", new Date().toISOString()],
	});

	await assert.rejects(
		() => migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH }),
		(error) => error?.code === "AGENT_MIGRATION_BLOCKED",
	);
	db.cleanup();
});

test("Agent 表已存在但无标记行(先跑过 db push)时采用既有结构,不再撞 table already exists", async () => {
	assert.ok(migration, "迁移模块缺失:RED 阶段");
	const db = makeLegacyDb();
	// 先在无存量会话的库上跑一次,建出 Agent 三表与唯一索引;再删掉标记行,
	// 模拟「有人单独跑过 prisma db push」的库(表在、记账不在)。
	await migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
	await db.client.execute('DELETE FROM "AgentMigration"');

	// 之后才出现从未迁移过的存量 agent.session 行。
	await db.client.execute(
		'CREATE TABLE "Client" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT)',
	);
	await db.client.execute(`
		CREATE TABLE "Job" (
			"id" TEXT NOT NULL PRIMARY KEY,
			"clientId" TEXT NOT NULL,
			"type" TEXT NOT NULL DEFAULT 'exec',
			"status" TEXT NOT NULL DEFAULT 'pending',
			"payload" TEXT NOT NULL DEFAULT '{}',
			"createdAt" DATETIME NOT NULL
		)
	`);
	await db.client.execute({
		sql: 'INSERT INTO "Client" ("id","name") VALUES (?,?)',
		args: ["c1", "host"],
	});
	await db.client.execute({
		sql: 'INSERT INTO "Job" ("id","clientId","type","status","payload","createdAt") VALUES (?,?,?,?,?,?)',
		args: ["s1", "c1", "agent.session", "idle", "{}", new Date().toISOString()],
	});

	const result = await migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
	assert.equal(result.migratedSessions, 1);
	assert.equal(result.adoptedExistingTables, true, "应标记为采用既有表结构");
	assert.equal((await readRow(db, "AgentSession", "s1")).status, "available");
	// 采用后必须补上记账,否则每次启动都要重新走一遍。
	assert.equal(await count(db, "AgentMigration"), 1);
	db.cleanup();
});

test("Agent 表只存在一部分(中间状态)时拒绝迁移并说明原因", async () => {
	assert.ok(migration, "迁移模块缺失:RED 阶段");
	const db = makeLegacyDb();
	await db.client.execute('CREATE TABLE "AgentSession" ("id" TEXT NOT NULL PRIMARY KEY)');

	await assert.rejects(
		() => migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH }),
		(error) =>
			error?.code === "AGENT_MIGRATION_BLOCKED" && /中间状态/.test(error.message),
	);
	db.cleanup();
});

test("既有 Agent 表缺少唯一索引时拒绝采用(不得弱化 CAS 保证)", async () => {
	assert.ok(migration, "迁移模块缺失:RED 阶段");
	const db = makeLegacyDb();
	await migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
	await db.client.execute('DELETE FROM "AgentMigration"');
	await db.client.execute('DROP INDEX "AgentSession_activeRunId_key"');

	await assert.rejects(
		() => migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH }),
		(error) =>
			error?.code === "AGENT_MIGRATION_BLOCKED" && /索引/.test(error.message),
	);
	db.cleanup();
});

test("CLI 失败时输出真实原因,不只说「迁移执行失败」", () => {
	const { spawnSync } = require("node:child_process");
	const script = path.join(
		__dirname, "..", "packages", "server", "prisma", "agent-session-migration.cjs",
	);
	// 指向不存在的目录 → libsql 无法打开连接。CLI 必须把底层原因带出来,
	// 否则运维只能看到“迁移执行失败”而无从下手。
	const result = spawnSync(process.execPath, [script], {
		env: {
			...process.env,
			DATABASE_URL: "file:///D:/VCPHub/VCPDeck/.tmp/nope-dir-xyz/nope.db",
		},
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0, "应当以非零退出");
	assert.match(result.stderr, /Unable to open connection|nope\.db/);
});

test("发布构件布局(脚本与 SQL 在 prisma/ 子目录)下 preStart 命令可执行", () => {
	// 2026-10-09 0.17.0 首次发布失败的真实回归:构件把 prisma/ 摊平到构件根,
	// 脚本又以 __dirname/.. 为依赖解析基准 → MODULE_NOT_FOUND。
	// 现在构件保持与源码一致的 `prisma/` 布局,且以 cwd 为 SQL 锚点。
	// 本用例把构件放在仓库外,依赖靠 junction 指向真实 node_modules,
	// 因此只有「从脚本自身目录解析依赖」才能通过。
	const { spawnSync } = require("node:child_process");
	const scriptSrc = path.join(__dirname, "..", "packages", "server", "prisma", "agent-session-migration.cjs");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-artifact-"));
	dirs.push(root);
	const serverDir = path.join(root, "server");
	const prismaDir = path.join(serverDir, "prisma");
	fs.mkdirSync(prismaDir, { recursive: true });
	fs.copyFileSync(scriptSrc, path.join(prismaDir, "agent-session-migration.cjs"));
	fs.copyFileSync(SQL_PATH, path.join(prismaDir, "agent-session-migration.sql"));
	// 发布构件的依赖在 server/node_modules;用 junction 避免真实拷贝。
	fs.symlinkSync(
		path.join(__dirname, "..", "packages", "server", "node_modules"),
		path.join(serverDir, "node_modules"),
		"junction",
	);
	const dbPath = path.join(root, "artifact.db").split(path.sep).join("/");
	// cwd = server 目录,与 Launcher/install.cjs 一致;命令取自构件 manifest 的 preStart。
	const result = spawnSync(
		process.execPath,
		["prisma/agent-session-migration.cjs"],
		{
			cwd: serverDir,
			env: { ...process.env, DATABASE_URL: `file:///${dbPath}` },
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 0, `preStart 应成功,stderr=${result.stderr}`);
	assert.match(result.stdout, /迁移完成|已应用/);
});

test("迁移 SQL 定位以 cwd 为锚点(兼容源码与构件布局),缺失时报出已查找路径", () => {
	assert.ok(migration, "迁移模块缺失:RED 阶段");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-sqlpath-"));
	dirs.push(root);
	// 发布构件布局:`<server>/prisma/agent-session-migration.sql`。
	fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
	const flat = path.join(root, "prisma", "agent-session-migration.sql");
	fs.writeFileSync(flat, "-- flat");
	assert.equal(migration.resolveMigrationSqlPath(root), flat);
	// 源码布局:`<server>/prisma/migrations/<version>/migration.sql`。
	const nestedDir = path.join(root, "prisma", "migrations", "20261008000000_agent_session_run_audit");
	fs.mkdirSync(nestedDir, { recursive: true });
	const nested = path.join(nestedDir, "migration.sql");
	fs.writeFileSync(nested, "-- nested");
	fs.rmSync(flat);
	assert.equal(migration.resolveMigrationSqlPath(root), nested);
	// 都缺失:必须带出已查找路径,而不是无从下手的 ENOENT。
	// 注意:模块目录兜底候选在源码树里总能命中真 SQL,故该负例放到
	// 构件布局的端到端用例(见下一条)里验证。
	assert.ok(migration.resolveMigrationSqlPath(root).length > 0);
});

test("构件缺 SQL 时报出已查找路径并非零退出", () => {
	const { spawnSync } = require("node:child_process");
	const scriptSrc = path.join(__dirname, "..", "packages", "server", "prisma", "agent-session-migration.cjs");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-nosql-"));
	dirs.push(root);
	const serverDir = path.join(root, "server");
	const prismaDir = path.join(serverDir, "prisma");
	fs.mkdirSync(prismaDir, { recursive: true });
	fs.copyFileSync(scriptSrc, path.join(prismaDir, "agent-session-migration.cjs"));
	// 故意不放 agent-session-migration.sql。
	fs.symlinkSync(
		path.join(__dirname, "..", "packages", "server", "node_modules"),
		path.join(serverDir, "node_modules"),
		"junction",
	);
	const result = spawnSync(
		process.execPath,
		["prisma/agent-session-migration.cjs"],
		{
			cwd: serverDir,
			env: { ...process.env, DATABASE_URL: `file:///${path.join(root, "x.db").split(path.sep).join("/")}` },
			encoding: "utf8",
		},
	);
	assert.notEqual(result.status, 0, "缺 SQL 必须非零退出");
	assert.match(result.stderr, /找不到迁移 SQL/);
	assert.match(result.stderr, /agent-session-migration\.sql/, "应列出已查找路径");
});

beforeEach(() => {
	// 每个 test 共享目录清理由 makeLegacyDb 的 finally 覆盖;这里仅兜底。
});

function makeLegacyDb() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), `vcpdeck-agent-mig-${++seq}-`));
	dirs.push(directory);
	const dbPath = path.join(directory, "test.db").replace(/\\/g, "/");
	const url = `file:${dbPath}`;
	const client = createClient({ url });
	const cleanup = () => {
		// Windows 上 libsql 持有文件锁,rm 可能 EPERM;清理失败不掩盖断言失败。
		try { client.close(); } catch { /* 已关闭 */ }
		try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
		catch { /* 临时目录由系统回收 */ }
	};
	return { directory, url, client, cleanup };
}

async function seedLegacy(db, jobs) {
	// 与既有 schema 最小同构的 Client/Job 表(迁移只依赖其中安全列)。
	await db.client.execute(`
		CREATE TABLE "Client" (
			"id" TEXT NOT NULL PRIMARY KEY,
			"name" TEXT,
			"online" BOOLEAN NOT NULL DEFAULT false
		);
	`);
	await db.client.execute(`
		CREATE TABLE "Job" (
			"id" TEXT NOT NULL PRIMARY KEY,
			"clientId" TEXT NOT NULL,
			"type" TEXT NOT NULL DEFAULT 'exec',
			"status" TEXT NOT NULL DEFAULT 'pending',
			"payload" TEXT NOT NULL DEFAULT '{}',
			"result" TEXT,
			"progress" TEXT,
			"errorCode" TEXT,
			"errorMessage" TEXT,
			"toolExecutionModeOverride" TEXT,
			"runExecutionMode" TEXT,
			"executionModeNeedsConfirmation" BOOLEAN NOT NULL DEFAULT false,
			"legacyExecutionModeOverride" TEXT,
			"timeout" INTEGER,
			"createdAt" DATETIME NOT NULL,
			"startedAt" DATETIME,
			"finishedAt" DATETIME,
			"createdByIdentityId" TEXT,
			"createdByName" TEXT,
			"createdVia" TEXT,
			"updatedAt" DATETIME NOT NULL
		);
	`);
	await db.client.execute({
		sql: 'INSERT INTO "Client" ("id","name","online") VALUES (?, ?, ?)',
		args: ["c1", "host-1", 0],
	});
	for (const job of jobs) {
		await db.client.execute({
			sql: `INSERT INTO "Job"
				("id","clientId","type","status","payload","result","progress","errorCode","errorMessage",
				 "toolExecutionModeOverride","runExecutionMode","executionModeNeedsConfirmation",
				 "legacyExecutionModeOverride","createdAt","startedAt","finishedAt",
				 "createdByIdentityId","createdByName","createdVia","updatedAt")
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			args: [
				job.id, job.clientId ?? "c1", job.type ?? "agent.session", job.status ?? "idle",
				job.payload ?? "{}", job.result ?? null, job.progress ?? null,
				job.errorCode ?? null, job.errorMessage ?? null,
				job.toolExecutionModeOverride ?? null, job.runExecutionMode ?? null,
				job.executionModeNeedsConfirmation ? 1 : 0,
				job.legacyExecutionModeOverride ?? null,
				job.createdAt ?? "2026-01-01 00:00:00",
				job.startedAt ?? null, job.finishedAt ?? null,
				job.createdByIdentityId ?? "user-1", job.createdByName ?? "User",
				job.createdVia ?? "web", job.createdAt ?? "2026-01-01 00:00:00",
			],
		});
	}
}

async function readRow(db, table, id) {
	const result = await db.client.execute({
		sql: `SELECT * FROM "${table}" WHERE "id" = ?`,
		args: [id],
	});
	return result.rows[0] ?? null;
}

/** Job 行的 deletedAt 可能是 libsql 序列化的 ISO 形式;比较时归一化。 */
function sameTimestamp(actual, expected) {
	if (actual === expected) return true;
	try { return new Date(actual).getTime() === new Date(expected).getTime(); }
	catch { return false; }
}

async function count(db, table) {
	// 阻塞路径可能根本未建新表;缺表与 0 行语义一致(全部回滚)。
	try {
		const result = await db.client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
		return Number(result.rows[0].n);
	} catch (error) {
		if (String(error.message).includes("no such table")) return 0;
		throw error;
	}
}

test("旧 done 保留会话身份但不伪造执行历史", async () => {
	const db = makeLegacyDb();
	try {
		await seedLegacy(db, [
			{ id: "s1", status: "done", payload: "{}", createdAt: "2026-02-03 04:05:06" },
		]);
		const result = await migration
			.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
		assert.equal(result.migratedSessions, 1);
		const session = await readRow(db, "AgentSession", "s1");
		assert.ok(session, "AgentSession 行存在");
		assert.equal(session.status, "available");
		assert.equal(session.legacyJobStatus, "done");
		assert.equal(session.createdAt, "2026-02-03 04:05:06");
		assert.equal(await count(db, "AgentRun"), 0, "不伪造历史 Run");
		const job = await readRow(db, "Job", "s1");
		assert.equal(job.status, "done", "旧 Job 行保留为只读迁移材料");
	} finally { db.cleanup(); }
});

test("idle/error 映射为 available,cancelled+空 payload 映射为 deleted 墓碑", async () => {
	const db = makeLegacyDb();
	try {
		await seedLegacy(db, [
			{ id: "a", status: "idle" },
			{ id: "b", status: "error", errorCode: "PI_WORKER_EXITED", errorMessage: "boom" },
			{ id: "c", status: "cancelled", payload: "{}", finishedAt: "2026-03-01 00:00:00" },
		]);
		await migration
			.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
		assert.equal((await readRow(db, "AgentSession", "a")).status, "available");
		assert.equal((await readRow(db, "AgentSession", "b")).status, "available");
		const deleted = await readRow(db, "AgentSession", "c");
		assert.equal(deleted.status, "deleted");
		assert.ok(
			sameTimestamp(deleted.deletedAt, "2026-03-01 00:00:00"),
			`deletedAt 应取旧 finishedAt,实际 ${deleted.deletedAt}`,
		);
		// 错误正文是旧 Job 的展示材料,不复制进新控制面。
		assert.equal((await readRow(db, "AgentSession", "b")).legacyJobStatus, "error");
	} finally { db.cleanup(); }
});

test("活跃 Run 与未确认删除预约阻塞迁移且整体回滚", async () => {
	const db = makeLegacyDb();
	try {
		await seedLegacy(db, [
			{ id: "ok", status: "idle" },
			{ id: "busy", status: "running", payload: JSON.stringify({ runId: "r1" }) },
		]);
		await assert.rejects(
			migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH }),
			(error) => {
				assert.match(String(error.message), /busy/);
				return true;
			},
		);
		assert.equal(await count(db, "AgentSession"), 0, "阻塞时全部新表回滚");
		assert.equal(await count(db, "AgentRun"), 0);
		// 阻塞可修复后重试成功(可重入,不残留半途数据)。
		await db.client.execute({ sql: 'DELETE FROM "Job" WHERE "id" = ?', args: ["busy"] });
		const result = await migration
			.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
		assert.equal(result.migratedSessions, 1);
	} finally { db.cleanup(); }
});

test("未知状态与非法 payload 阻塞;普通 Job 一律不改", async () => {
	const db = makeLegacyDb();
	try {
		await seedLegacy(db, [
			{ id: "weird", status: "turbo" },
			{ id: "plain", type: "exec", status: "done", result: '{"exitCode":0}' },
		]);
		await assert.rejects(
			migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH }),
		);
		assert.equal(await count(db, "AgentSession"), 0);
		// 修复未知状态后,普通 Job 行不受迁移影响。
		await db.client.execute({ sql: 'DELETE FROM "Job" WHERE "id" = ?', args: ["weird"] });
		await migration
			.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
		const plain = await readRow(db, "Job", "plain");
		assert.equal(plain.status, "done");
		assert.equal(plain.result, '{"exitCode":0}');
		assert.equal(await count(db, "AgentSession"), 0, "普通 Job 不进入 Agent 控制面");
	} finally { db.cleanup(); }
});

test("重复运行幂等:不重复迁移、不产生重复审计或新数据", async () => {
	const db = makeLegacyDb();
	try {
		await seedLegacy(db, [{ id: "s1", status: "idle" }]);
		const migrate = migration.migrateAgentSessions;
		const first = await migrate({ url: db.url, sqlPath: SQL_PATH });
		assert.equal(first.migratedSessions, 1);
		const second = await migrate({ url: db.url, sqlPath: SQL_PATH });
		assert.equal(second.alreadyApplied, true);
		assert.equal(second.migratedSessions, 0);
		assert.equal(await count(db, "AgentSession"), 1);
	} finally { db.cleanup(); }
});

test("模式覆盖与待确认标记原样迁移;删除预约阻塞", async () => {
	const db = makeLegacyDb();
	try {
		await seedLegacy(db, [
			{ id: "m1", status: "idle", toolExecutionModeOverride: "automatic" },
			{ id: "m2", status: "idle", toolExecutionModeOverride: null,
				executionModeNeedsConfirmation: 1, legacyExecutionModeOverride: "approval" },
			{ id: "m3", status: "cancelled",
				payload: JSON.stringify({ deleteToken: randomUUID(), previousStatus: "idle" }) },
		]);
		await assert.rejects(
			migration.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH }),
			(error) => /m3/.test(String(error.message)),
		);
		await db.client.execute({ sql: 'DELETE FROM "Job" WHERE "id" = ?', args: ["m3"] });
		await migration
			.migrateAgentSessions({ url: db.url, sqlPath: SQL_PATH });
		const m1 = await readRow(db, "AgentSession", "m1");
		assert.equal(m1.toolExecutionModeOverride, "automatic");
		const m2 = await readRow(db, "AgentSession", "m2");
		assert.equal(m2.executionModeNeedsConfirmation, 1);
		assert.equal(m2.legacyExecutionModeOverride, "approval");
	} finally { db.cleanup(); }
});
