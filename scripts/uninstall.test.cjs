/**
 * scripts/uninstall.cjs 单元测试（node:test）
 * 运行: node scripts/uninstall.test.cjs
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	symlinkSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	rmSync,
	mkdtempSync,
} = require("node:fs");
const { tmpdir, platform } = require("node:os");
const { join, resolve } = require("node:path");
const uninstall = require("./uninstall.cjs");

const isWin = platform() === "win32";

/** 构造含若干假版本目录与 current 指针的 appDir */
function makeAppDir(appDir, versions, current) {
	for (const v of versions) {
		mkdirSync(join(appDir, "apps", v), { recursive: true });
		writeFileSync(join(appDir, "apps", v, "marker"), v);
	}
	if (current) {
		if (isWin) {
			writeFileSync(
				join(appDir, "apps", "state.json"),
				JSON.stringify({ current }),
			);
		} else {
			symlinkSync(current, join(appDir, "apps", "current"));
		}
	}
}

test("parseArgs 解析 --version / --current / --app-dir", () => {
	const a = uninstall.parseArgs([
		"--version=1.2.3",
		"--yes",
		"--dry-run",
		"--app-dir=D:/y",
	]);
	assert.equal(a.version, "1.2.3");
	assert.equal(a.yes, true);
	assert.equal(a.dryRun, true);
	assert.equal(a.appDir, resolve("D:/y"));

	const b = uninstall.parseArgs(["--current"]);
	assert.equal(b.current, true);
});

test("parseArgs 版本二选一", () => {
	assert.throws(() => uninstall.parseArgs([]), /--version|--current/);
	assert.throws(
		() => uninstall.parseArgs(["--version=1.2.3", "--current"]),
		/二选一/,
	);
	assert.throws(() => uninstall.parseArgs(["--version=bad"]), /x\.y\.z/);
});

test("remainingVersions 数字排序（降序，排除指定版本）", () => {
	const dir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
	try {
		makeAppDir(dir, ["1.2.3", "0.10.1", "0.9.10", "1.2.2"], null);
		assert.deepEqual(uninstall.remainingVersions(dir, "0.9.10"), [
			"1.2.3",
			"1.2.2",
			"0.10.1",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("currentVersion 读 current 指针（Windows state.json / Linux symlink）", () => {
	const dir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
	try {
		makeAppDir(dir, ["1.0.0"], "1.0.0");
		assert.equal(uninstall.currentVersion(dir), "1.0.0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uninstallVersion 卸载 current 时重定向到剩余最高版本", () => {
	const dir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
	try {
		makeAppDir(dir, ["1.0.0", "2.0.0"], "2.0.0");
		const result = uninstall.uninstallVersion(dir, "2.0.0");
		assert.equal(result.newCurrent, "1.0.0");
		assert.equal(existsSync(join(dir, "apps", "2.0.0")), false);
		assert.equal(uninstall.currentVersion(dir), "1.0.0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uninstallVersion 卸载唯一版本时清空 current 指针", () => {
	const dir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
	try {
		makeAppDir(dir, ["1.0.0"], "1.0.0");
		const result = uninstall.uninstallVersion(dir, "1.0.0");
		assert.equal(result.newCurrent, null);
		assert.equal(existsSync(join(dir, "apps", "1.0.0")), false);
		assert.equal(uninstall.currentVersion(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uninstallVersion 卸载非 current 版本不影响指针", () => {
	const dir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
	try {
		makeAppDir(dir, ["1.0.0", "2.0.0"], "2.0.0");
		const result = uninstall.uninstallVersion(dir, "1.0.0");
		assert.equal(result.newCurrent, "2.0.0");
		assert.equal(existsSync(join(dir, "apps", "1.0.0")), false);
		assert.equal(uninstall.currentVersion(dir), "2.0.0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dryRun 不执行删除", () => {
	const dir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
	try {
		makeAppDir(dir, ["1.0.0"], "1.0.0");
		const result = uninstall.uninstallVersion(dir, "1.0.0", { dryRun: true });
		assert.equal(result.dryRun, true);
		assert.equal(result.newCurrent, null);
		assert.equal(existsSync(join(dir, "apps", "1.0.0")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uninstallVersion 未安装版本时报错", () => {
	const dir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
	try {
		assert.throws(() => uninstall.uninstallVersion(dir, "9.9.9"), /未安装/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
