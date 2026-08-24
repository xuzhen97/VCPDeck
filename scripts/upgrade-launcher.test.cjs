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

function runInFixture(fixture, args) {
	return spawnSync(
		process.execPath,
		[join(fixture.installerDir, "upgrade-launcher.cjs"), ...args],
		{ encoding: "utf8", env: isolatedEnv(), timeout: 60_000 },
	);
}

test("deriveAppDir 从脚本自身位置向上四级推导 appDir", () => {
	const f = makeFixture();
	const mod = require(join(f.installerDir, "upgrade-launcher.cjs"));
	assert.equal(
		mod.deriveAppDir(join(f.installerDir, "upgrade-launcher.cjs")),
		f.root,
	);
	rmSync(f.root, { recursive: true, force: true });
});

test("findVersionDir：显式版本优先；缺 payload 报错；自动取最新", () => {
	const f = makeFixture();
	const mod = require(SCRIPT);
	const appsRoot = join(f.root, "apps");

	assert.equal(mod.findVersionDir(appsRoot, "0.6.2"), join(appsRoot, "0.6.2"));
	assert.throws(() => mod.findVersionDir(appsRoot, "9.9.9"), /缺少/);
	assert.equal(mod.findVersionDir(appsRoot, undefined), join(appsRoot, "0.6.2"));
	rmSync(f.root, { recursive: true, force: true });
});

test("parseArgs 识别全部开关并拒绝未知参数", () => {
	const { parseArgs } = require(SCRIPT);
	assert.deepEqual(
		parseArgs(["--dry-run", "--status", "--apply-detached", "--version=1.2.3"]),
		{
			dryRun: true,
			status: true,
			applyDetached: true,
			version: "1.2.3",
			appDir: undefined,
			source: undefined,
		},
	);
	assert.equal(parseArgs(["--source=C:/x/m.js"]).source, "C:/x/m.js");
	assert.throws(() => parseArgs(["--bogus"]), /未知参数/);
});

test("dry-run：输出规划与 sha256，不修改任何文件", () => {
	const f = makeFixture();
	const res = runInFixture(f, ["--dry-run", `--app-dir=${f.root}`]);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /0\.6\.2/);
	assert.match(res.stdout, /sha256/);
	assert.match(res.stdout, /dry-run/);
	assert.equal(readFileSync(join(f.root, "dist", "main.js"), "utf8"), "OLD-LAUNCHER");
	rmSync(f.root, { recursive: true, force: true });
});

test("已安装与目标一致 → 跳过且不触碰 pm2", () => {
	const f = makeFixture();
	writeFileSync(join(f.root, "dist", "main.js"), "NEW-LAUNCHER");
	const res = runInFixture(f, [`--app-dir=${f.root}`]);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /跳过/);
	rmSync(f.root, { recursive: true, force: true });
});

test("常规路径：父进程零改动并转交分离执行（Job 载体不被自杀）", () => {
	const f = makeFixture();
	const res = runInFixture(f, [`--app-dir=${f.root}`]);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /分离执行/);
	assert.match(res.stdout, /--status/);
	assert.equal(readFileSync(join(f.root, "dist", "main.js"), "utf8"), "OLD-LAUNCHER");
	rmSync(f.root, { recursive: true, force: true });
});

test("--apply-detached：pm2 不可用时快速失败且不留任何更改", () => {
	const f = makeFixture();
	const res = runInFixture(f, ["--apply-detached", `--app-dir=${f.root}`]);
	assert.notEqual(res.status, 0);
	assert.match(`${res.stderr}${res.stdout}`, /pm2/);
	assert.equal(readFileSync(join(f.root, "dist", "main.js"), "utf8"), "OLD-LAUNCHER");
	const backups = require("node:fs")
		.readdirSync(join(f.root, "dist"))
		.filter((x) => x.startsWith("main.js.bak"));
	assert.deepEqual(backups, []);
	rmSync(f.root, { recursive: true, force: true });
});

test("--status：文件不一致报未完成；一致时报通过（pm2 缺失降级提示）", () => {
	const f = makeFixture();
	const mismatch = runInFixture(f, ["--status", `--app-dir=${f.root}`]);
	assert.notEqual(mismatch.status, 0);
	assert.match(mismatch.stdout, /未完成/);

	writeFileSync(join(f.root, "dist", "main.js"), "NEW-LAUNCHER");
	const ok = runInFixture(f, ["--status", `--app-dir=${f.root}`]);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /文件一致/);
	rmSync(f.root, { recursive: true, force: true });
});
