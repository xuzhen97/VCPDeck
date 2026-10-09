const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const prefix = path.join(os.tmpdir(), "vcpdeck-db-test-");
const markerName = ".vcpdeck-integration-test";

function createIntegrationTestDb() {
	const directory = fs.mkdtempSync(prefix);
	const databasePath = path.join(directory, "test.db").replace(/\\/g, "/");
	const marker = randomUUID();
	fs.writeFileSync(path.join(directory, markerName), marker, {
		encoding: "utf8",
		flag: "wx",
	});
	return { directory, databaseUrl: `file:${databasePath}`, marker };
}

function assertIntegrationTestDb(context) {
	const directory = path.resolve(context?.directory ?? "");
	const expectedUrl = `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`;
	let storedMarker = "";
	try {
		storedMarker = fs.readFileSync(path.join(directory, markerName), "utf8");
	} catch {
		// 统一走下方安全拒绝分支，不暴露底层文件系统信息。
	}
	if (
		path.dirname(directory) !== path.resolve(os.tmpdir()) ||
		!/^vcpdeck-db-test-[A-Za-z0-9]{6}$/.test(path.basename(directory)) ||
		context?.databaseUrl !== expectedUrl ||
		typeof context?.marker !== "string" ||
		storedMarker !== context.marker
	) {
		throw new Error(`拒绝操作非集成测试数据库: ${context?.databaseUrl ?? "<missing>"}`);
	}
}

function initializeIntegrationTestDb(context, serverDir) {
	assertIntegrationTestDb(context);
	// ADR-0041:Server 启动前要求显式 Agent migration 已应用。隔离库按与生产相同的
	// 顺序初始化:先跑显式迁移建 Agent 表与版本标记(全新库无存量可迁移),
	// 再 db push 同步其余 schema。
	execFileSync(
		process.execPath,
		[path.join("prisma", "agent-session-migration.cjs")],
		{
			cwd: serverDir,
			env: { ...process.env, DATABASE_URL: context.databaseUrl },
			stdio: "inherit",
		},
	);
	execFileSync(
		process.execPath,
		[
			"node_modules/prisma/build/index.js",
			"db",
			"push",
			"--schema",
			"prisma/schema.prisma",
		],
		{
			cwd: serverDir,
			env: { ...process.env, DATABASE_URL: context.databaseUrl },
			stdio: "inherit",
		},
	);
}

function cleanupIntegrationTestDb(context) {
	if (!context) return;
	assertIntegrationTestDb(context);
	fs.rmSync(context.directory, { recursive: true, force: true });
}

module.exports = {
	createIntegrationTestDb,
	assertIntegrationTestDb,
	initializeIntegrationTestDb,
	cleanupIntegrationTestDb,
};
