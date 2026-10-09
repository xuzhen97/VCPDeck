/**
 * Agent 迁移入口接线测试(ADR-0041 Task 1)。
 *
 * 验证:开发/发布/安装三条路径中,显式迁移先于 prisma db push 与启动;
 * 迁移非零退出时阻止后续;Release staging 携带迁移脚本与 SQL。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(p) {
	return fs.readFileSync(path.join(ROOT, p), "utf8");
}

test("Server dev/start 脚本在 prisma generate 后、db push 前执行 Agent 迁移", () => {
	const pkg = JSON.parse(read("packages/server/package.json"));
	for (const scriptName of ["start", "dev"]) {
		const script = pkg.scripts[scriptName];
		assert.ok(script, `${scriptName} 脚本存在`);
		const genIndex = script.indexOf("prisma generate");
		const migIndex = script.indexOf("agent-session-migration");
		const pushIndex = script.indexOf("prisma db push");
		assert.ok(migIndex > genIndex, `${scriptName}: 迁移在 generate 之后`);
		assert.ok(pushIndex > migIndex, `${scriptName}: db push 在迁移之后`);
	}
});

test("Server main.ts 启动前断言迁移就绪", () => {
	const main = read("packages/server/src/main.ts");
	assert.match(main, /assertAgentMigrationReady/);
	// readiness 失败必须先于 listen
	const assertIndex = main.indexOf("assertAgentMigrationReady");
	const listenIndex = main.indexOf(".listen(");
	assert.ok(assertIndex > -1 && listenIndex > assertIndex, "就绪检查先于监听");
});

test("Release preStart 先执行 Agent 迁移再 db push", () => {
	const pack = read("scripts/pack-release.ts");
	assert.match(pack, /preStart:\s*"node agent-session-migration\.cjs && node node_modules\/prisma\/build\/index\.js db push"/);
});

test("安装脚本 initDatabase 先迁移后 push", () => {
	const install = read("scripts/install.cjs");
	const initIndex = install.indexOf("initDatabase");
	const migrationRef = install.indexOf("agent-session-migration");
	assert.ok(initIndex > -1 && migrationRef > -1);
	// 迁移调用应在 db push 前执行(出现顺序)
	const migrationCall = install.indexOf("agent-session-migration", initIndex);
	const pushCall = install.indexOf('"db"', initIndex);
	assert.ok(migrationCall > initIndex, "initDatabase 内引用迁移");
	assert.ok(pushCall > migrationCall, "push 在迁移之后");
});

test("pack-release 为 server staging 携带迁移脚本与 SQL", () => {
	const pack = read("scripts/pack-release.ts");
	assert.match(pack, /agent-session-migration\.cjs/);
	assert.match(pack, /20261008000000_agent_session_run_audit/);
});