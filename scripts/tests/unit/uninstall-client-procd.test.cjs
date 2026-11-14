/**
 * Task 9：procd 卸载边界测试（ADR-0065）。
 *
 * 默认保留持久身份；purge 需要双重显式确认；停止未收敛时零删除；
 * 混装 systemd/PM2 或服务定义不符时拒绝，不套用旧卸载脚本。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	SERVICE_FILE,
	STATE_DIR,
	CONFIG_DIR,
	runUninstall,
	uninstallTargets,
} = require("../../uninstall-client-procd.cjs");

function fakeAdapter(overrides = {}) {
	const calls = [];
	const adapter = {
		inspectInstall: async () => ({
			marker: true,
			serviceContent: `#!/bin/sh /etc/rc.common\nUSE_PROCD=1\nenv VCPDECK_INSTALLATION_MODE=procd-root\n`,
			systemdUnit: false,
			pm2Residue: false,
		}),
		disableService: async () => void calls.push("disableService"),
		stopService: async () => void calls.push("stopService"),
		assertStopped: async () => void calls.push("assertStopped"),
		removePath: async (target) => void calls.push(`removePath:${target}`),
		...overrides,
	};
	return { adapter, calls };
}

test("默认卸载不删除持久身份，purge 才包含 state 与 /etc/vcpdeck", () => {
	const ordinary = uninstallTargets(false);
	assert.ok(ordinary.includes("/opt/vcpdeck/client"));
	assert.ok(ordinary.includes(SERVICE_FILE));
	assert.ok(!ordinary.includes(STATE_DIR));
	assert.ok(!ordinary.includes(CONFIG_DIR));
	assert.ok(!ordinary.includes("/usr/bin/node"));
	assert.ok(!ordinary.includes("/root"));
	assert.deepEqual(uninstallTargets(true), [
		SERVICE_FILE,
		"/opt/vcpdeck/client",
		STATE_DIR,
		CONFIG_DIR,
	]);
});

test("purge 缺少二次显式确认时拒绝，且不调用任何删除", async () => {
	const { adapter, calls } = fakeAdapter();
	await assert.rejects(
		() => runUninstall(adapter, { purge: true, confirmPurge: false }),
		/PROCD_PURGE_UNAUTHORIZED/,
	);
	assert.deepEqual(calls, []);
});

test("普通卸载：先禁启停、证明已停止，再删服务定义与客户端，保留 state/config", async () => {
	const { adapter, calls } = fakeAdapter();
	const result = await runUninstall(adapter, { purge: false, confirmPurge: false });
	assert.deepEqual(calls, [
		"disableService",
		"stopService",
		"assertStopped",
		`removePath:${SERVICE_FILE}`,
		"removePath:/opt/vcpdeck/client",
	]);
	assert.deepEqual(result.kept, [STATE_DIR, CONFIG_DIR]);
});

test("停止未收敛时零删除", async () => {
	const { adapter, calls } = fakeAdapter({
		assertStopped: async () => {
			calls.push("assertStopped");
			throw new Error("PROCD_STOP_UNCONVERGED");
		},
	});
	await assert.rejects(
		() => runUninstall(adapter, { purge: false, confirmPurge: false, stopTimeoutMs: 0 }),
		/PROCD_STOP_UNCONVERGED/,
	);
	assert.equal(calls.some((call) => call.startsWith("removePath:")), false);
});

test("停服后短暂未收敛会重试，收敛后继续卸载", async () => {
	let attempts = 0;
	const { adapter, calls } = fakeAdapter({
		assertStopped: async () => {
			calls.push("assertStopped");
			attempts += 1;
			if (attempts === 1) throw new Error("PROCD_STOP_UNCONVERGED");
		},
	});
	const result = await runUninstall(adapter, {
		purge: false,
		confirmPurge: false,
		stopPollMs: 1,
	});
	assert.equal(attempts, 2);
	assert.equal(calls.filter((call) => call === "assertStopped").length, 2);
	assert.deepEqual(result.kept, [STATE_DIR, CONFIG_DIR]);
	assert.equal(calls.includes(`removePath:${SERVICE_FILE}`), true);
});

test("缺 ownership marker、服务定义不符或混装 systemd/PM2 时拒绝卸载", async () => {
	for (const [name, patch] of [
		["marker", { marker: false }],
		["service", { serviceContent: "#!/bin/sh\n/etc/init.d/other\n" }],
		["systemd", { systemdUnit: true }],
		["pm2", { pm2Residue: true }],
	]) {
		const { adapter, calls } = fakeAdapter({
			inspectInstall: async () => ({
				marker: true,
				serviceContent: "env VCPDECK_INSTALLATION_MODE=procd-root",
				systemdUnit: false,
				pm2Residue: false,
				...patch,
			}),
		});
		await assert.rejects(
			() => runUninstall(adapter, { purge: false, confirmPurge: false }),
			/PROCD_UNINSTALL_UNSAFE|PROCD_UNINSTALL_MIXED/,
			name,
		);
		assert.deepEqual(calls, [], name);
	}
});

test("服务控制直接执行 init 脚本，不经过 /bin/sh 包装", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "../../uninstall-client-procd.cjs"),
		"utf8",
	);
	assert.doesNotMatch(source, /execFileSync\("\/bin\/sh", \[SERVICE_FILE/);
	assert.match(source, /execFileSync\(SERVICE_FILE, \["status"\]/);
	assert.match(source, /execFileSync\(SERVICE_FILE, \["stop"\]/);
});
