/**
 * Task 9：稳定 Launcher 人工升级测试（ADR-0065）。
 *
 * 目标校验失败不得停服务；启动或 receipt 失败必须还原并拉起旧版本；
 * 升级只替换 dist（与可选 package.json），业务 apps/current、node/runtime、
 * launcher.env 与自动更新流程都不被触碰。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	assertLauncherReceipt,
	restoreLauncherContent,
	runLauncherUpgrade,
	swapLauncherContent,
} = require("../../upgrade-launcher-procd.cjs");

function fakeAdapter(overrides = {}) {
	const calls = [];
	const adapter = {
		verifyTarget: async (dir) => void calls.push(`verifyTarget:${dir}`),
		stopService: async () => void calls.push("stopService"),
		swapLauncher: async (dir) => void calls.push(`swapLauncher:${dir}`),
		startService: async () => void calls.push("startService"),
		verifyReceipt: async () => void calls.push("verifyReceipt"),
		restoreLauncher: async () => void calls.push("restoreLauncher"),
		...overrides,
	};
	return { adapter, calls };
}

function write(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** 造一个既有 launcher：dist + apps + node + runtime + launcher.env + package.json。 */
function makeExistingLauncher(root) {
	const launcher = path.join(root, "launcher");
	write(path.join(launcher, "dist", "main.js"), "old-dist");
	write(path.join(launcher, "package.json"), '{"version":"1.0.0"}');
	write(path.join(launcher, "apps", "1.0.0", "dist", "main.js"), "business-1.0.0");
	write(path.join(launcher, "apps", "current"), "1.0.0");
	write(path.join(launcher, "node", "current", "bin", "node"), "node-binary");
	write(
		path.join(launcher, "runtime", "linux-x64-musl", "node-24.22.3-abc", "bin", "node"),
		"musl-node",
	);
	write(
		path.join(launcher, "launcher.env"),
		"VCPDECK_SERVER=https://example.invalid\nVCPDECK_PSK=deadbeef\n",
	);
	return launcher;
}

function makeStaging(root) {
	const staging = path.join(root, "staging");
	write(path.join(staging, "launcher", "dist", "main.js"), "new-dist");
	write(path.join(staging, "launcher", "package.json"), '{"version":"2.0.0"}');
	return staging;
}

const options = { stagingDir: "/tmp/staging" };

test("升级成功：先验证再停服务，换目录后启动并验收", async () => {
	const { adapter, calls } = fakeAdapter();
	const result = await runLauncherUpgrade(adapter, options);
	assert.deepEqual(calls, [
		"verifyTarget:/tmp/staging",
		"stopService",
		"swapLauncher:/tmp/staging",
		"startService",
		"verifyReceipt",
	]);
	assert.deepEqual(result, { swapped: true });
});

test("目标包无效时不停服务、不换目录", async () => {
	const { adapter, calls } = fakeAdapter({
		verifyTarget: async () => {
			calls.push("verifyTarget");
			throw new Error("PROCD_UPGRADE_TARGET_INVALID");
		},
	});
	await assert.rejects(() => runLauncherUpgrade(adapter, options), /TARGET_INVALID/);
	assert.deepEqual(calls, ["verifyTarget"]);
});

test("receipt 超时：还原旧 Launcher 并重新拉起，报错带 ROLLED_BACK", async () => {
	const { adapter, calls } = fakeAdapter({
		verifyReceipt: async () => {
			calls.push("verifyReceipt");
			throw new Error("PROCD_UPGRADE_RECEIPT_TIMEOUT");
		},
	});
	await assert.rejects(
		() => runLauncherUpgrade(adapter, options),
		/PROCD_UPGRADE_ROLLED_BACK/,
	);
	assert.deepEqual(calls.slice(-3), ["verifyReceipt", "restoreLauncher", "startService"]);
	assert.equal(calls.filter((call) => call === "startService").length, 2);
});

test("还原也失败时同时报告还原失败与原始失败", async () => {
	const { adapter } = fakeAdapter({
		verifyReceipt: async () => {
			throw new Error("PROCD_UPGRADE_RECEIPT_TIMEOUT");
		},
		restoreLauncher: async () => {
			throw new Error("PROCD_UPGRADE_RESTORE_FAILED");
		},
	});
	await assert.rejects(
		() => runLauncherUpgrade(adapter, options),
		/PROCD_UPGRADE_RESTORE_FAILED[\s\S]*PROCD_UPGRADE_RECEIPT_TIMEOUT/,
	);
});

test("swap 只替换 dist 与 package.json，apps/node/runtime/launcher.env 原样保留", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-upgrade-"));
	try {
		const launcher = makeExistingLauncher(root);
		const staging = makeStaging(root);
		const envBefore = fs.readFileSync(path.join(launcher, "launcher.env"), "utf8");

		swapLauncherContent(launcher, staging);

		assert.equal(fs.readFileSync(path.join(launcher, "dist", "main.js"), "utf8"), "new-dist");
		assert.equal(
			fs.readFileSync(path.join(launcher, "package.json"), "utf8"),
			'{"version":"2.0.0"}',
		);
		assert.ok(fs.existsSync(path.join(launcher, "apps", "1.0.0", "dist", "main.js")));
		assert.ok(fs.existsSync(path.join(launcher, "apps", "current")));
		assert.ok(fs.existsSync(path.join(launcher, "node", "current", "bin", "node")));
		assert.ok(
			fs.existsSync(
				path.join(launcher, "runtime", "linux-x64-musl", "node-24.22.3-abc", "bin", "node"),
			),
		);
		assert.equal(fs.readFileSync(path.join(launcher, "launcher.env"), "utf8"), envBefore);

		restoreLauncherContent(launcher);

		assert.equal(fs.readFileSync(path.join(launcher, "dist", "main.js"), "utf8"), "old-dist");
		assert.equal(
			fs.readFileSync(path.join(launcher, "package.json"), "utf8"),
			'{"version":"1.0.0"}',
		);
		assert.ok(fs.existsSync(path.join(launcher, "apps", "current")));
		assert.equal(fs.readFileSync(path.join(launcher, "launcher.env"), "utf8"), envBefore);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("备份缺失时还原直接报错，不删除现有 dist", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-upgrade-"));
	try {
		const launcher = makeExistingLauncher(root);
		assert.throws(() => restoreLauncherContent(launcher), /PROCD_UPGRADE_BACKUP_MISSING/);
		assert.equal(fs.readFileSync(path.join(launcher, "dist", "main.js"), "utf8"), "old-dist");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("receipt 校验发现 apps/current 缺失时报错，不冒充验收成功", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-upgrade-"));
	try {
		const launcher = makeExistingLauncher(root);
		fs.rmSync(path.join(launcher, "apps", "current"));
		assert.throws(() => assertLauncherReceipt(launcher), /apps\/current/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("升级入口不整体换目录，也不触碰状态目录与自动更新流程", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "../../upgrade-launcher-procd.cjs"),
		"utf8",
	);
	assert.doesNotMatch(source, /rmSync\(LAUNCHER_DIR/);
	assert.doesNotMatch(source, /cpSync\([^)]*LAUNCHER_DIR/);
	assert.doesNotMatch(source, /"\/opt\/vcpdeck\/state"/);
	assert.doesNotMatch(source, /updater|autoUpdate/i);
	assert.doesNotMatch(source, /execFileSync\("\/bin\/sh", \[SERVICE_FILE/);
	assert.match(source, /execFileSync\(SERVICE_FILE, \["start"\]/);
});
