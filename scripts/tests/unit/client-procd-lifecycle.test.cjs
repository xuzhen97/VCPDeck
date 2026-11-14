/**
 * Task 8：procd 生命周期与受管进程所有权账本测试（ADR-0065）。
 *
 * 用临时目录伪造 `/proc` 证据，证明 PID 复用、重启后旧账本、证据缺失都不会
 * 被当成"旧实例已消失"，也证明服务模板始终指向稳定 Launcher。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
	claimOwnedLedger,
	readProcessFacts,
	releaseOwnedLedger,
	renderProcdService,
	sameOwnedProcess,
} = require("../../client-procd-lifecycle.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-lifecycle-"));
const procRoot = path.join(tmp, "proc");
fs.mkdirSync(path.join(procRoot, "sys/kernel/random"), { recursive: true });
fs.writeFileSync(path.join(procRoot, "sys/kernel/random/boot_id"), "boot-1\n");
const ledger = path.join(tmp, "owned-process.json");

/** 伪造 /proc/<pid>：stat 第 22 字段是 starttime，status 带 Uid。 */
function writeProc(pid, { startTime = "100", uid = 0 } = {}) {
	const dir = path.join(procRoot, String(pid));
	fs.mkdirSync(dir, { recursive: true });
	const rest = new Array(20).fill("0");
	rest[0] = "S";
	rest[19] = startTime;
	fs.writeFileSync(path.join(dir, "stat"), `${pid} (node) ${rest.join(" ")} 0 0 0\n`);
	fs.writeFileSync(
		path.join(dir, "status"),
		`Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
	);
}

const facts = { bootId: "boot-1", pid: 4242, startTime: "100", uid: 0 };

test("所有权四元组任一不同都不算同一进程", () => {
	assert.equal(sameOwnedProcess(facts, { ...facts }), true);
	for (const patch of [
		{ bootId: "boot-2" },
		{ pid: 4243 },
		{ startTime: "101" },
		{ uid: 1000 },
	]) {
		assert.equal(sameOwnedProcess(facts, { ...facts, ...patch }), false, JSON.stringify(patch));
	}
	assert.equal(sameOwnedProcess(facts, undefined), false);
});

test("读取现场事实：缺 /proc 证据时拒绝猜测", () => {
	writeProc(4242, { startTime: "100", uid: 0 });
	assert.deepEqual(
		readProcessFacts(4242, { bootId: "boot-1", fsRoot: tmp }),
		facts,
	);
	assert.throws(
		() => readProcessFacts(9999, { bootId: "boot-1", fsRoot: tmp }),
		/PROCD_OWNER_UNPROVEN/,
	);
});

test("账本：旧实例仍存活时拒绝启动，重启或 PID 复用才回收", () => {
	writeProc(4242, { startTime: "100" });
	assert.deepEqual(claimOwnedLedger(ledger, facts, { fsRoot: tmp }), { reclaimed: false });
	assert.throws(
		() => claimOwnedLedger(ledger, facts, { fsRoot: tmp }),
		/PROCD_OWNER_ALIVE/,
	);

	// 同一 PID 但 starttime 变化：原进程已退出，PID 被复用。
	writeProc(4242, { startTime: "777" });
	assert.deepEqual(
		claimOwnedLedger(ledger, facts, { fsRoot: tmp }),
		{ reclaimed: true },
	);

	// 重启后 bootId 变化：旧账本一律作废。
	fs.writeFileSync(path.join(procRoot, "sys/kernel/random/boot_id"), "boot-2\n");
	assert.deepEqual(
		claimOwnedLedger(ledger, { ...facts, bootId: "boot-2" }, { fsRoot: tmp }),
		{ reclaimed: true },
	);

	// /proc 无该 PID：旧实例已消失。
	fs.rmSync(path.join(procRoot, "4242"), { recursive: true, force: true });
	assert.deepEqual(
		claimOwnedLedger(ledger, { ...facts, bootId: "boot-2", startTime: "999" }, { fsRoot: tmp }),
		{ reclaimed: true },
	);
});

test("释放账本只删除自己的记录", () => {
	const own = { ...facts, bootId: "boot-2", startTime: "999" };
	assert.ok(fs.existsSync(ledger));
	releaseOwnedLedger(ledger, { ...own, startTime: "1" });
	assert.ok(fs.existsSync(ledger), "别人的账本不得删除");
	releaseOwnedLedger(ledger, own);
	assert.equal(fs.existsSync(ledger), false);
});

test("服务模板：绝对路径启动稳定 Launcher，term_timeout 与停机阶梯一致", () => {
	const rendered = renderProcdService({
		nodePath: "/opt/vcpdeck/client/runtime/current/bin/node",
		entryPath: "/opt/vcpdeck/client/app/launcher/dist/main.js",
		stateHome: "/opt/vcpdeck/state/home",
	});
	assert.match(rendered, /^#!\/bin\/sh \/etc\/rc\.common/m);
	assert.match(rendered, /USE_PROCD=1/);
	assert.match(rendered, /procd_set_param command \/opt\/vcpdeck\/client\/runtime\/current\/bin\/node \/opt\/vcpdeck\/client\/app\/launcher\/dist\/main\.js/);
	assert.match(rendered, /procd_set_param env HOME=\/opt\/vcpdeck\/state\/home/);
	assert.match(rendered, /VCPDECK_INSTALLATION_MODE=procd-root/);
	assert.match(rendered, /procd_set_param env HOME=[^\n]*VCPDECK_APP_DIR=/);
	assert.match(rendered, /procd_set_param respawn 3600 5 0/);
	assert.match(rendered, /procd_set_param term_timeout 15/);
	assert.doesNotMatch(rendered, /apps\/current/);
	assert.doesNotMatch(rendered, /@NODE@|@ENTRY@|@STATE_HOME@/);

	const template = path.join(__dirname, "../../vcpdeck-client.procd");
	const syntax = spawnSync("sh", ["-n", template], { encoding: "utf8" });
	assert.equal(syntax.status, 0, syntax.stderr);
});

test("Client 停机阶梯与 procd term_timeout 不冲突", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "../../../packages/client/src/shutdown.ts"),
		"utf8",
	);
	for (const literal of ["resourcesMs: 8_000", "launcherGraceMs: 10_000", "procdTermMs: 15_000"]) {
		assert.ok(source.includes(literal), literal);
	}
	const template = fs.readFileSync(path.join(__dirname, "../../vcpdeck-client.procd"), "utf8");
	assert.match(template, /term_timeout 15/);
});
