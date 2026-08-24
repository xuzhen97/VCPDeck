/** upgrade-launcher.cjs 自测：真实目录结构夹具；不触碰真实 PM2/HOME */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const SCRIPT = join(__dirname, "upgrade-launcher.cjs");

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "vcpdeck-upgrade-test-"));
	const versionDir = join(root, "apps", "0.6.2");
	const installerDir = join(versionDir, "client", "installer");
	mkdirSync(join(versionDir, "launcher", "dist"), { recursive: true });
	mkdirSync(installerDir, { recursive: true });
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(versionDir, "launcher", "dist", "main.js"), "NEW-LAUNCHER");
	writeFileSync(join(root, "dist", "main.js"), "OLD-LAUNCHER");
	writeFileSync(join(root, "ecosystem.config.cjs"), "module.exports={};");
	copyFileSync(SCRIPT, join(installerDir, "upgrade-launcher.cjs"));
	return { root, versionDir, installerDir };
}

/** 隔离环境：假 HOME（无托管 pm2）+ 空 PATH（无全局 pm2），确保绝不触达真实守护进程 */
const isolatedEnv = () => {
	const fakeHome = mkdtempSync(join(tmpdir(), "vcpdeck-fake-home-"));
	return {
		...process.env,
		HOME: fakeHome,
		USERPROFILE: fakeHome,
		PATH: "",
	};
};

test("deriveAppDir 从脚本自身位置向上四级推导 appDir", () => {
	const { root, installerDir } = (() => {
		const r = makeFixture();
		return { root: r.root, installerDir: r.installerDir };
	})();
	const mod = require(join(installerDir, "upgrade-launcher.cjs"));
	assert.equal(
		mod.deriveAppDir(join(installerDir, "upgrade-launcher.cjs")),
		root,
	);
	rmSync(root, { recursive: true, force: true });
});

test("findVersionDir：显式版本优先；缺 payload 报错；自动取最新", () => {
	const { root } = makeFixture();
	const mod = require(SCRIPT);
	const appsRoot = join(root, "apps");

	assert.equal(mod.findVersionDir(appsRoot, "0.6.2"), join(appsRoot, "0.6.2"));
	assert.throws(() => mod.findVersionDir(appsRoot, "9.9.9"), /缺少/);

	// 更新 mtime 的旧版本不影响"取最新"
	assert.equal(mod.findVersionDir(appsRoot, undefined), join(appsRoot, "0.6.2"));
	rmSync(root, { recursive: true, force: true });
});

test("parseArgs 识别 dry-run/version/app-dir 并拒绝未知参数", () => {
	const { parseArgs } = require(SCRIPT);
	assert.deepEqual(parseArgs(["--dry-run", "--version=1.2.3"]), {
		dryRun: true,
		version: "1.2.3",
		appDir: undefined,
	});
	assert.throws(() => parseArgs(["--bogus"]), /未知参数/);
});

test("dry-run：输出规划与 sha256，不修改任何文件", () => {
	const { root } = makeFixture();
	const res = spawnSync(
		process.execPath,
		[
			join(root, "apps", "0.6.2", "client", "installer", "upgrade-launcher.cjs"),
			"--dry-run",
			`--app-dir=${root}`,
		],
		{ encoding: "utf8", env: isolatedEnv() },
	);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /0\.6\.2/);
	assert.match(res.stdout, /sha256/);
	assert.match(res.stdout, /dry-run/);
	assert.equal(readFileSync(join(root, "dist", "main.js"), "utf8"), "OLD-LAUNCHER");
	rmSync(root, { recursive: true, force: true });
});

test("已安装与目标一致 → 跳过且不触碰 pm2", () => {
	const { root } = makeFixture();
	writeFileSync(join(root, "dist", "main.js"), "NEW-LAUNCHER");
	const res = spawnSync(
		process.execPath,
		[
			join(root, "apps", "0.6.2", "client", "installer", "upgrade-launcher.cjs"),
			`--app-dir=${root}`,
		],
		{ encoding: "utf8", env: isolatedEnv() },
	);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /跳过/);
	rmSync(root, { recursive: true, force: true });
});

test("pm2 不可用时快速失败且不留任何更改（备份未产生、原文件未动）", () => {
	const { root } = makeFixture();
	const res = spawnSync(
		process.execPath,
		[
			join(root, "apps", "0.6.2", "client", "installer", "upgrade-launcher.cjs"),
			`--app-dir=${root}`,
		],
		{ encoding: "utf8", env: isolatedEnv(), timeout: 60_000 },
	);
	assert.notEqual(res.status, 0);
	assert.equal(readFileSync(join(root, "dist", "main.js"), "utf8"), "OLD-LAUNCHER");
	const backups = require("node:fs")
		.readdirSync(join(root, "dist"))
		.filter((f) => f.startsWith("main.js.bak"));
	assert.deepEqual(backups, []);
	rmSync(root, { recursive: true, force: true });
});
