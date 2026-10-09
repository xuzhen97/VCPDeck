/**
 * Agent 会话/执行/审计显式数据库迁移(ADR-0041 Task 1)。
 *
 * 设计约束(与 Spec/Plan 一致):
 * - 显式执行,不依赖 `prisma db push` 生成 Agent 表;失败/阻塞非零退出;
 * - 可重入:以 AgentMigration 单行版本 + SQL digest 记账,重复运行幂等;
 * - 活跃 Run(pending/running/waiting_input/disconnected)与未确认删除预约
 *   阻止迁移并整体回滚,等待旧协议排干,不猜测终局;
 * - 不伪造历史 Run:旧 payload 只含当前 runId,历史不导出;
 * - 旧 Job 行保留为只读迁移材料,状态/正文/结果不复制进新控制面。
 *
 * CLI:node agent-session-migration.cjs
 *   全新库(无 Client/Job 表)天然没有存量可迁移,只建表并记账;
 *   存量库存在活跃 Run 或未确认删除预约时阻塞。
 */
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

// 依赖从**脚本自身所在目录**向上解析,不依赖进程 cwd:
// - 源码布局:packages/server/prisma/ → 向上找到 packages/server/node_modules;
// - 发布构件布局:server/(prisma/ 被摊平到构件根) → 直接命中 server/node_modules。
// 若以 __dirname/.. 为基准,发布构件会去 apps/<version>/node_modules 找依赖而
// MODULE_NOT_FOUND(2026-10-09 0.17.0 首次发布即因此失败)。
const pkgRequire = createRequire(path.join(__dirname, "package.json"));
const { createClient } = pkgRequire("@libsql/client");

const MIGRATION_VERSION = "20261008000000_agent_session_run_audit";
/** 活动/未决状态:任一存在即阻塞迁移(与 PiRunService ACTIVE_STATUSES 对应)。 */
const BLOCKING_JOB_STATUSES = new Set([
	"pending", "running", "waiting_input", "disconnected",
]);
/** 已确认删除预约的 payload 形状:deleteToken + previousStatus。 */
const DELETABLE_PREVIOUS = new Set(["idle", "done", "error"]);

class AgentMigrationBlockedError extends Error {
	constructor(message) {
		super(message);
		this.name = "AgentMigrationBlockedError";
		this.code = "AGENT_MIGRATION_BLOCKED";
	}
}

function sqlDigest(sqlPath) {
	const { readFileSync } = require("node:fs");
	return createHash("sha256").update(readFileSync(sqlPath, "utf8")).digest("hex");
}

/** 读取迁移 SQL;文件缺失视为部署残缺,直接失败。 */
/**
 * 定位迁移 SQL。锚点是 **server 包根**(cwd),不是 __dirname:
 * 发布构件的 server 入口是 esbuild 打包产物,模块被内联后 __dirname 变成
 * `<server>/dist`,按它去找必然落空(2026-10-09 0.17.0 预发布验证即撞此坑)。
 * Launcher(daemon 以构件目录为 cwd)、install.cjs 与 dev 脚本均保证 cwd = server 包根。
 * 候选:
 * 1. `<server>/prisma/agent-session-migration.sql` —— 发布构件(pack-release 落位);
 * 2. `<server>/prisma/migrations/<version>/migration.sql` —— 源码布局;
 * 3. 模块目录下的源码布局 —— 仅当调用方直接以模块目录为 cwd 时的兜底。
 * 都找不到时报出已查找路径,而不是无从下手的 ENOENT。
 */
function resolveMigrationSqlPath(baseDir = process.cwd()) {
	const { existsSync } = require("node:fs");
	const candidates = [
		path.join(baseDir, "prisma", "agent-session-migration.sql"),
		path.join(baseDir, "prisma", "migrations", MIGRATION_VERSION, "migration.sql"),
		path.join(__dirname, "migrations", MIGRATION_VERSION, "migration.sql"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new AgentMigrationBlockedError(
			`找不到迁移 SQL,已查找: ${candidates.join(", ")}`,
		);
	}
	return found;
}

/**
 * 定位 Prisma config:源码在 server 包根,发布构件摊平到与脚本同层。
 * 找不到时返回 null,由调用方退回内置默认值。
 */
function resolvePrismaConfigPath(baseDir = __dirname) {
	const { existsSync } = require("node:fs");
	const candidates = [
		path.join(baseDir, "prisma.config.cjs"),
		path.join(baseDir, "..", "prisma.config.cjs"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 解析 CLI 入口使用的数据库地址。
 * - 显式 DATABASE_URL 永远优先(安装器与生产单元文件都依赖这一点);
 * - 未设置时退回 Prisma config 的 datasource(即开发库),并把其中的相对
 *   `file:./prisma/dev.db` 按 **server 包根** 解析成绝对 file URL ——
 *   Prisma CLI 也是以包根为基准,脚本必须等价,否则换 cwd 调用会连错库。
 */
function resolveCliDatabaseUrl(env = process.env, serverRoot = null) {
	const explicit = env?.DATABASE_URL;
	if (explicit) return explicit;
	const configPath = resolvePrismaConfigPath();
	// 相对路径的基准就是 config 所在目录(源码=server 包根,构件=构件根)。
	const baseDir = serverRoot ?? (configPath ? path.dirname(configPath) : __dirname);
	let configured = "file:./prisma/dev.db";
	if (configPath) {
		try {
			const config = require(configPath);
			if (typeof config?.datasource?.url === "string") configured = config.datasource.url;
		} catch {
			// 配置不可读时沿用同一默认位置,不因此失败。
		}
	}
	const relative = /^file:(?:\.\/)?(.*)$/.exec(configured);
	if (!relative) return configured;
	return pathToFileURL(path.resolve(baseDir, relative[1])).href;
}

function loadSql(sqlPath) {
	const { readFileSync } = require("node:fs");
	return readFileSync(sqlPath, "utf8");
}

/**
 * 解析旧 Job payload;只接受迁移关心的安全形状。
 * 返回 { kind: "empty" | "run" | "delete", ... };形状非法返回 { kind: "invalid" }。
 */
function parseLegacyPayload(raw) {
	if (typeof raw !== "string") return { kind: "invalid" };
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "{}") return { kind: "empty" };
	let value;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return { kind: "invalid" };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
	const keys = Object.keys(value);
	if (keys.length === 1 && keys[0] === "runId" && typeof value.runId === "string" && value.runId.length > 0) {
		return { kind: "run", runId: value.runId };
	}
	if (
		keys.length === 2 && keys.includes("deleteToken") && keys.includes("previousStatus")
		&& typeof value.deleteToken === "string" && value.deleteToken.length > 0
		&& DELETABLE_PREVIOUS.has(value.previousStatus)
	) {
		return { kind: "delete", deleteToken: value.deleteToken, previousStatus: value.previousStatus };
	}
	return { kind: "invalid" };
}

/** 将旧 agent.session 状态映射为新会话状态;不认识的返回 null(阻塞)。 */
function mapLegacyStatus(status, payload) {
	switch (status) {
		case "idle":
		case "done":
		case "error":
			return { status: "available", legacyJobStatus: status };
		case "cancelled": {
			if (payload.kind === "delete") {
				// 未确认删除预约:等待排干,不猜测远端结果。
				return null;
			}
			if (payload.kind === "empty") {
				return { status: "deleted", legacyJobStatus: "cancelled" };
			}
			return null; // run payload + cancelled 形状非法
		}
		default:
			return null;
	}
}

/**
 * 执行迁移。options:
 * - url: SQLite DATABASE_URL(libsql 格式);
 * - sqlPath: migration.sql 绝对路径;
 * 返回 { migratedSessions, alreadyApplied }。
 */
async function migrateAgentSessions(options) {
	const { url, sqlPath } = options ?? {};
	if (!url || !sqlPath) {
		throw new AgentMigrationBlockedError("migrateAgentSessions 需要 url 与 sqlPath");
	}
	const client = createClient({ url });
	try {
		const sql = loadSql(sqlPath);
		const digest = sqlDigest(sqlPath);

		// 幂等检查:已应用且 digest 一致 → 直接返回。
		const existingMarker = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='AgentMigration'",
		);
		if (existingMarker.rows.length > 0) {
			const marker = await client.execute(
				"SELECT version, sqlDigest FROM AgentMigration LIMIT 1",
			);
			if (marker.rows.length > 0) {
				const row = marker.rows[0];
				if (row.version !== MIGRATION_VERSION) {
					throw new AgentMigrationBlockedError(
						`AgentMigration 版本不符: ${row.version} != ${MIGRATION_VERSION}`,
					);
				}
				if (row.sqlDigest !== digest) {
					throw new AgentMigrationBlockedError("AgentMigration SQL digest 不符,库与部署不一致");
				}
				return { migratedSessions: 0, alreadyApplied: true };
			}
		}
		// 标记表在但无标记行:结构可能来自 db push,进入下方结构探测。
		const hasMarkerTable = existingMarker.rows.length > 0;

		// 结构探测:三张 Agent 表可能在标记行缺失时已存在(例如有人单独跑过
		// prisma db push 建库)。此时直接采用既有结构,只做存量迁移与记账,
		// 不再重复 CREATE TABLE——否则会以 table already exists 硬失败且无法自愈。
		const AGENT_TABLES = ["AgentSession", "AgentRun", "AgentAuditEvent"];
		const allTables = new Set(
			(await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(
				(row) => String(row.name),
			),
		);
		const presentAgentTables = AGENT_TABLES.filter((name) => allTables.has(name));
		if (presentAgentTables.length === 0 && hasMarkerTable) {
			throw new AgentMigrationBlockedError(
				"AgentMigration 表存在但 Agent 数据表缺失,库结构不完整,拒绝迁移",
			);
		}
		if (presentAgentTables.length > 0 && presentAgentTables.length < AGENT_TABLES.length) {
			throw new AgentMigrationBlockedError(
				`Agent 表处于中间状态(已有 ${presentAgentTables.join(", ")}),无法判断结构完整性,拒绝迁移`,
			);
		}
		const adoptedExistingTables = presentAgentTables.length === AGENT_TABLES.length;
		if (adoptedExistingTables) {
			// 采用前必须确认唯一索引在位:activeRunId 与审计幂等键是 CAS/去重的依据,
			// 缺了就等于悄悄弱化并发保证,这比直接失败危险。
			const requiredIndexes = {
				AgentSession: ["AgentSession_activeRunId_key"],
				AgentAuditEvent: ["AgentAuditEvent_operationId_event_result_key"],
			};
			for (const [table, indexes] of Object.entries(requiredIndexes)) {
				const present = new Map(
					(await client.execute(`PRAGMA index_list("${table}")`)).rows.map((row) => [
						String(row.name),
						Number(row.unique),
					]),
				);
				const missing = indexes.filter((name) => present.get(name) !== 1);
				if (missing.length > 0) {
					throw new AgentMigrationBlockedError(
						`既有 ${table} 缺少唯一索引(${missing.join(", ")}),拒绝采用:该索引是并发保证的依据`,
					);
				}
			}
		}

		// 旧数据检查仅在存在 Job 表时执行(全新库跳过)。
		const jobTable = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='Job'",
		);
		const hasJobTable = jobTable.rows.length > 0;
		let legacyRows = [];
		if (hasJobTable) {
			// 列集合必须先探测:ADR-0039 之前建的旧库没有这三个模式列,直接 SELECT 会让
			// 升级路径在 SQL 层崩掉(迁移跑在 db push 之前,列还没补上)。缺失的列按 NULL
			// 处理 —— 该库里不可能存在携带这些值的行,所以不构成信息丢失或放行。
			const jobColumns = new Set(
				(await client.execute('PRAGMA table_info("Job")')).rows.map((column) =>
					String(column.name),
				),
			);
			const required = ["id", "clientId", "type", "status", "payload"];
			const missing = required.filter((column) => !jobColumns.has(column));
			if (missing.length > 0) {
				throw new AgentMigrationBlockedError(
					`Job 表缺少必要列(${missing.join(", ")}),无法判断存量会话状态,拒绝迁移`,
				);
			}
			const optional = [
				"toolExecutionModeOverride",
				"executionModeNeedsConfirmation",
				"legacyExecutionModeOverride",
				"createdAt",
				"finishedAt",
				"createdByIdentityId",
				"createdByName",
				"createdVia",
			];
			const selectList = [
				...required,
				...optional.filter((column) => jobColumns.has(column)),
			];
			const agentSessions = await client.execute(
				`SELECT ${selectList.join(", ")} FROM Job WHERE type = 'agent.session'`,
			);
			legacyRows = agentSessions.rows;
		}
		if (legacyRows.length > 0 && !hasJobTable) {
			throw new AgentMigrationBlockedError("内部错误:legacyRows 与 hasJobTable 不一致");
		}

		// 先检查全部存量,再在单事务内建表+迁移+记账。
		const mapped = [];
		for (const row of legacyRows) {
			const payload = parseLegacyPayload(row.payload);
			if (payload.kind === "invalid") {
				throw new AgentMigrationBlockedError(`会话 ${row.id} 的 payload 形状非法,拒绝迁移`);
			}
			if (BLOCKING_JOB_STATUSES.has(row.status)) {
				throw new AgentMigrationBlockedError(
					`会话 ${row.id} 仍有活跃执行(状态 ${row.status}),先按旧协议排干再升级`,
				);
			}
			if (row.status === "cancelled" && payload.kind === "delete") {
				throw new AgentMigrationBlockedError(
					`会话 ${row.id} 存在未确认删除预约,先在旧版本完成或回滚删除再升级`,
				);
			}
			const target = mapLegacyStatus(row.status, payload);
			if (!target) {
				throw new AgentMigrationBlockedError(`会话 ${row.id} 的状态 ${row.status} 无法安全映射`);
			}
			mapped.push({ row, payload, target });
		}

		// 目标 ID 冲突检查:AgentSession 已存在同 id 行(异常状态)时阻塞。
		if (hasJobTable && mapped.length > 0) {
			const sessionTable = await client.execute(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='AgentSession'",
			);
			if (sessionTable.rows.length > 0) {
				const existingIds = await client.execute("SELECT id FROM AgentSession");
				const ids = new Set(existingIds.rows.map((r) => r.id));
				for (const { row } of mapped) {
					if (ids.has(row.id)) {
						throw new AgentMigrationBlockedError(`会话 ${row.id} 在 AgentSession 中已存在,拒绝覆盖`);
					}
				}
			}
		}

		// libsql 的回调式 transaction 提交行为不可靠,改用手动事务;
		// 且 sqlite3 驱动单次 execute 只可靠应用首条 DDL,必须逐语句执行
		// (剥离纯注释行,避免注释粘进语句首部导致语法错误)。
		const statements = sql
			.split(/;\s*(?=\n|$)/)
			.map((statement) => statement
				.split("\n")
				.filter((line) => !line.trim().startsWith("--"))
				.join("\n")
				.trim())
			.filter(Boolean);
		const tx = await client.transaction("write");
		try {
			// 采用既有结构时跳过建表:表与索引已由 db push 建好,重复 CREATE 会硬失败。
			if (!adoptedExistingTables) {
				for (const statement of statements) {
					await tx.execute(statement);
				}
			}
			for (const { row, target } of mapped) {
				await tx.execute({
					sql: `INSERT INTO "AgentSession"
						("id","clientId","status","ownerIdentityId","ownerName","createdAt","updatedAt",
						 "toolExecutionModeOverride","executionModeNeedsConfirmation","legacyExecutionModeOverride",
						 "deletedAt","migratedFromJob","legacyJobStatus")
						VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
					args: [
						row.id, row.clientId, target.status,
						row.createdByIdentityId ?? null, row.createdByName ?? null,
						row.createdAt ?? new Date().toISOString(),
						row.createdAt ?? new Date().toISOString(),
						row.toolExecutionModeOverride ?? null,
						row.executionModeNeedsConfirmation ? 1 : 0,
						row.legacyExecutionModeOverride ?? null,
						target.status === "deleted" ? (row.finishedAt ?? new Date().toISOString()) : null,
						1, target.legacyJobStatus,
					],
				});
			}
			await tx.execute({
				sql: 'INSERT INTO "AgentMigration" ("version","sqlDigest","appliedAt") VALUES (?,?,?)',
				args: [MIGRATION_VERSION, digest, new Date().toISOString()],
			});
			await tx.commit();
		} catch (error) {
			await tx.rollback().catch(() => {});
			throw error;
		}

		return { migratedSessions: mapped.length, alreadyApplied: false, adoptedExistingTables };
	} finally {
		try { client.close(); } catch { /* 已关闭 */ }
	}
}

/** 启动前就绪检查:AgentMigration 已应用且 digest 一致;否则抛出阻塞错误。 */
async function assertAgentMigrationReady(options) {
	const { url, sqlPath } = options ?? {};
	if (!url || !sqlPath) {
		throw new AgentMigrationBlockedError("assertAgentMigrationReady 需要 url 与 sqlPath");
	}
	const client = createClient({ url });
	try {
		const marker = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='AgentMigration'",
		);
		if (marker.rows.length === 0) {
			throw new AgentMigrationBlockedError("AgentMigration 未应用:Agent 表缺失");
		}
		const rows = await client.execute("SELECT version, sqlDigest FROM AgentMigration LIMIT 1");
		if (rows.rows.length === 0) {
			throw new AgentMigrationBlockedError("AgentMigration 记录缺失");
		}
		const digest = sqlDigest(sqlPath);
		if (rows.rows[0].version !== MIGRATION_VERSION || rows.rows[0].sqlDigest !== digest) {
			throw new AgentMigrationBlockedError("AgentMigration 版本/SQL digest 与部署不一致");
		}
	} finally {
		try { client.close(); } catch { /* 已关闭 */ }
	}
}

module.exports = {
	AgentMigrationBlockedError,
	MIGRATION_VERSION,
	migrateAgentSessions,
	assertAgentMigrationReady,
	// 仅供测试与 CLI 入口:解析“该连哪个库”与“SQL 在哪”的策略只此一处。
	resolveCliDatabaseUrl,
	resolveMigrationSqlPath,
	resolvePrismaConfigPath,
};

// CLI 入口:node agent-session-migration.cjs
if (require.main === module) {
	const databaseUrl = resolveCliDatabaseUrl();
	const sqlPath = resolveMigrationSqlPath();
	migrateAgentSessions({ url: databaseUrl, sqlPath })
		.then((result) => {
			console.log(
				`[agent-migration] ${result.alreadyApplied ? "已应用,跳过" : `迁移完成: ${result.migratedSessions} 个会话`}`,
			);
			process.exit(0);
		})
		.catch((error) => {
			// 阻塞错误本身就是给运维看的说明;其余错误必须带上底层原因,
			// 否则只能看到“迁移执行失败”而无从下手。
			const reason = error instanceof AgentMigrationBlockedError
				? error.message
				: `迁移执行失败: ${error?.message ?? String(error)}`;
			console.error(`[agent-migration] ${reason}`);
			process.exit(1);
		});
}
