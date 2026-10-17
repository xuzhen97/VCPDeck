/**
 * 基础服务启动与 Agent 迁移解耦测试（ADR-0049）。
 *
 * 验证：dev/start、install、隔离测试库与 Release preStart 都不再自动执行 Agent 迁移；
 * 同时历史迁移脚本与 SQL 仍保留在源码中（非破坏性退役，不删除历史数据资产）。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../../..");

function read(p) {
	return fs.readFileSync(path.join(ROOT, p), "utf8");
}

test("Server dev/start 脚本不再执行 Agent 迁移", () => {
	const pkg = JSON.parse(read("packages/server/package.json"));
	for (const scriptName of ["start", "dev"]) {
		const script = pkg.scripts[scriptName];
		assert.ok(script, `${scriptName} 脚本存在`);
		assert.doesNotMatch(
			script,
			/agent-session-migration/,
			`${scriptName}: 不再自动执行 Agent 迁移`,
		);
		// 基础 schema 同步仍保留（不带 --accept-data-loss）
		assert.match(script, /prisma db push/);
	}
});

test("Server main.ts 启动不再断言 Agent 迁移就绪", () => {
	const main = read("packages/server/src/main.ts");
	assert.doesNotMatch(main, /assertAgentMigrationReady/);
	assert.doesNotMatch(main, /agent-session-migration/);
});

test("Release preStart 只做 db push，不再先跑 Agent 迁移", () => {
	const pack = read("scripts/build/pack-release.ts");
	assert.match(pack, /preStart:/);
	const preStartLine = pack
		.split(/\r?\n/)
		.find((line) => line.includes("preStart:"));
	assert.ok(preStartLine, "preStart 行存在");
	assert.doesNotMatch(preStartLine, /agent-session-migration/);
	assert.match(preStartLine, /db push/);
});

test("安装脚本 initDatabase 不再调用 Agent 迁移，但仍执行 db push", () => {
	const install = read("scripts/install.cjs");
	const initIndex = install.indexOf("function initDatabase");
	assert.ok(initIndex > -1, "initDatabase 存在");
	const initBody = install.slice(initIndex, initIndex + 2000);
	assert.doesNotMatch(initBody, /agent-session-migration/);
	assert.match(initBody, /db push|"db",\s*"push"/);
});

test("隔离集成测试库不再预先执行 Agent 迁移", () => {
	const helper = read("scripts/tests/helpers/integration-test-db.cjs");
	assert.doesNotMatch(helper, /agent-session-migration/);
	assert.match(helper, /db/);
});

test("历史迁移脚本与 SQL 仍保留（非破坏性退役）", () => {
	assert.ok(
		fs.existsSync(path.join(ROOT, "packages/server/prisma/agent-session-migration.cjs")),
		"迁移脚本保留",
	);
	assert.ok(
		fs.existsSync(
			path.join(
				ROOT,
				"packages/server/prisma/migrations/20261008000000_agent_session_run_audit",
			),
		),
		"历史迁移目录保留",
	);
});
