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
			pm2Name: "vcpdeck-client-launcher",
		},
	);
	assert.equal(parseArgs(["--source=C:/x/m.js"]).source, "C:/x/m.js");
	assert.equal(
		parseArgs(["--pm2-name=vcpdeck-server-launcher"]).pm2Name,
		"vcpdeck-server-launcher",
	);
	assert.throws(() => parseArgs(["--pm2-name="]), /PM2 名/);
	assert.throws(() => parseArgs(["--pm2-name=-server"]), /PM2 名/);
	assert.throws(() => parseArgs(["--pm2-name=server\u0000x"]), /PM2 名/);
	assert.throws(() => parseArgs(["--bogus"]), /未知参数/);
});

test("dry-run：输出规划、源文件、目标 app-dir 和 PM2 名，不修改任何文件", () => {
	const f = makeFixture();
	const res = runInFixture(f, [
		"--dry-run",
		`--app-dir=${f.root}`,
		"--pm2-name=vcpdeck-server-launcher",
	]);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /0\.6\.2/);
	assert.match(res.stdout, /sha256/);
	assert.match(res.stdout, /源文件/);
	assert.match(res.stdout, /目标 app-dir/);
	assert.match(res.stdout, /vcpdeck-server-launcher/);
	assert.match(res.stdout, /dry-run/);
	assert.equal(readFileSync(join(f.root, "dist", "main.js"), "utf8"), "OLD-LAUNCHER");
	rmSync(f.root, { recursive: true, force: true });
});

test("显式外部 source 不要求 source 位于 target app-dir", () => {
	const f = makeFixture();
	const target = mkdtempSync(join(tmpdir(), "vcpdeck-server-target-"));
	const source = join(f.versionDir, "launcher", "dist", "main.js");
	const res = runInFixture(f, [
		"--dry-run",
		`--app-dir=${target}`,
		`--source=${source}`,
		"--pm2-name=vcpdeck-server-launcher",
	]);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /源文件/);
	assert.match(res.stdout, /vcpdeck-server-launcher/);
	rmSync(f.root, { recursive: true, force: true });
	rmSync(target, { recursive: true, force: true });
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

test("detached 参数保留显式 PM2 名称", () => {
	const mod = require(SCRIPT);
	assert.deepEqual(
		mod.buildDetachedArgv("/installer/upgrade-launcher.cjs", "/server", "/client/main.js", "vcpdeck-server-launcher"),
		[
			"/installer/upgrade-launcher.cjs",
			"--apply-detached",
			"--app-dir=/server",
			"--source=/client/main.js",
			"--pm2-name=vcpdeck-server-launcher",
		],
	);
});

test("restartGuard 与 pm2Online 使用显式 PM2 名称", () => {
	const mod = require(SCRIPT);
	const calls = [];
	const run = (_pm, args) => {
		calls.push(args);
		if (args[0] === "jlist") {
			return { status: 0, stdout: JSON.stringify([{ name: "vcpdeck-server-launcher", pm2_env: { status: "online" } }]) };
		}
		return { status: 0, stdout: "", stderr: "" };
	};
	mod.restartGuard({ command: "pm2", argsPrefix: [] }, "/server", "vcpdeck-server-launcher", run);
	assert.equal(mod.pm2Online({ command: "pm2", argsPrefix: [] }, "vcpdeck-server-launcher", run), true);
	assert.deepEqual(calls, [["restart", "vcpdeck-server-launcher"], ["jlist"]]);
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

test("statusMode 使用显式 PM2 名称检查 online 状态", () => {
	const f = makeFixture();
	const mod = require(SCRIPT);
	writeFileSync(join(f.root, "dist", "main.js"), "NEW-LAUNCHER");
	const calls = [];
	const result = mod.statusMode(
		f.root,
		join(f.versionDir, "launcher", "dist", "main.js"),
		"vcpdeck-server-launcher",
		() => ({ kind: "fake", command: "pm2", argsPrefix: [] }),
		(_pm, args) => {
			calls.push(args);
			return {
				status: 0,
				stdout: JSON.stringify([
					{
						name: "vcpdeck-server-launcher",
						pm2_env: { status: "online" },
					},
				]),
			};
		},
	);
	assert.equal(result, 0);
	assert.deepEqual(calls, [["jlist"]]);
	rmSync(f.root, { recursive: true, force: true });
});
