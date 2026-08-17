/**
 * scripts/install.cjs 单元测试（node:test）
 * 运行: node scripts/install.test.cjs
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
	mkdirSync,
	writeFileSync,
	existsSync,
	readFileSync,
	rmSync,
	mkdtempSync,
} = require("node:fs");
const { tmpdir, platform } = require("node:os");
const { join } = require("node:path");
const install = require("./install.cjs");

const isWin = platform() === "win32";

function makeStaging(root) {
	mkdirSync(join(root, "server", "dist"), { recursive: true });
	mkdirSync(join(root, "client", "dist"), { recursive: true });
	writeFileSync(join(root, "server", "dist", "main.js"), "// server");
	writeFileSync(join(root, "client", "dist", "index.js"), "// client");
	writeFileSync(
		join(root, "manifest.json"),
		JSON.stringify({
			version: "1.2.3",
			artifacts: {
				server: { dir: "server", entry: "dist/main.js" },
				client: { dir: "client", entry: "dist/index.js" },
			},
		}),
	);
}

test("parseArgs 解析合法参数", () => {
	const args = install.parseArgs([
		"--artifact=server",
		"--version=1.2.3",
		"--app-dir=C:/x",
		"--zip=a.zip",
	]);
	assert.equal(args.artifact, "server");
	assert.equal(args.version, "1.2.3");
	assert.equal(
		args.appDir,
		install.parseArgs(["--artifact=server", "--zip=a.zip", "--app-dir=C:/x"])
			.appDir,
	);
	assert.equal(args.zip, "a.zip");
	assert.equal(args.skipDb, undefined);
	assert.equal(args.force, undefined);
});

test("parseArgs 缺 artifact/zip 时报错", () => {
	assert.throws(() => install.parseArgs(["--zip=a.zip"]), /--artifact/);
	assert.throws(() => install.parseArgs(["--artifact=server"]), /--zip/);
	assert.throws(
		() => install.parseArgs(["--artifact=macos", "--zip=a.zip"]),
		/server 或 client/,
	);
});

test("parseArgs 校验版本与 sha256 格式", () => {
	assert.throws(
		() =>
			install.parseArgs(["--artifact=server", "--zip=a.zip", "--version=bad"]),
		/x\.y\.z/,
	);
	assert.throws(
		() =>
			install.parseArgs(["--artifact=server", "--zip=a.zip", "--sha256=xyz"]),
		/sha256/,
	);
});

test("inferVersionFromZip 从文件名取版本", () => {
	assert.equal(
		install.inferVersionFromZip("vcpdeck-0.1.1-win-x64.zip"),
		"0.1.1",
	);
	assert.equal(
		install.inferVersionFromZip("vcpdeck-2.0.0-linux-x64.zip"),
		"2.0.0",
	);
	assert.equal(install.inferVersionFromZip("random.zip"), null);
	assert.equal(install.inferVersionFromZip("vcpdeck-1.0.0.tar.gz"), null);
});

test("sha256File 计算与 createHash 一致", async () => {
	const dir = mkdtempSync(join(tmpdir(), "install-test-"));
	try {
		const f = join(dir, "a.bin");
		const content = Buffer.from("hello install");
		writeFileSync(f, content);
		const expected = createHash("sha256").update(content).digest("hex");
		assert.equal(await install.sha256File(f), expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installFromStaging 安装 server 构件并设置 current 指针", () => {
	const dir = mkdtempSync(join(tmpdir(), "install-test-"));
	try {
		const staging = join(dir, "staging");
		makeStaging(staging);
		const appDir = join(dir, "app");
		const target = install.installFromStaging(staging, {
			artifact: "server",
			version: "1.2.3",
			appDir,
			force: false,
		});
		assert.equal(existsSync(join(target, "server", "dist", "main.js")), true);
		assert.equal(existsSync(join(target, "server", "dist", "index.js")), false);
		assert.equal(existsSync(join(target, "client")), false);
		assert.equal(existsSync(join(target, "manifest.json")), true);
		// current 指针
		if (isWin) {
			const state = JSON.parse(
				readFileSync(join(appDir, "apps", "state.json"), "utf-8"),
			);
			assert.equal(state.current, "1.2.3");
		} else {
			const { readlinkSync } = require("node:fs");
			assert.equal(readlinkSync(join(appDir, "apps", "current")), "1.2.3");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installFromStaging 目标已存在且无 force 时报错", () => {
	const dir = mkdtempSync(join(tmpdir(), "install-test-"));
	try {
		const staging = join(dir, "staging");
		makeStaging(staging);
		const appDir = join(dir, "app");
		install.installFromStaging(staging, {
			artifact: "client",
			version: "1.2.3",
			appDir,
			force: false,
		});
		assert.throws(
			() =>
				install.installFromStaging(staging, {
					artifact: "server",
					version: "1.2.3",
					appDir,
					force: false,
				}),
			/已存在/,
		);
		// --force 可覆盖
		install.installFromStaging(staging, {
			artifact: "server",
			version: "1.2.3",
			appDir,
			force: true,
		});
		assert.equal(
			existsSync(join(appDir, "apps", "1.2.3", "server", "dist", "main.js")),
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installFromStaging 构件不完整时报错", () => {
	const dir = mkdtempSync(join(tmpdir(), "install-test-"));
	try {
		const staging = join(dir, "staging");
		mkdirSync(staging);
		writeFileSync(join(staging, "manifest.json"), "{}");
		const appDir = join(dir, "app");
		assert.throws(
			() =>
				install.installFromStaging(staging, {
					artifact: "server",
					version: "1.2.3",
					appDir,
					force: false,
				}),
			/dist/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("shouldInitDb 仅在 server 且提供 db-url/环境变量时执行", () => {
	assert.equal(install.shouldInitDb("server", "file:x", false), true);
	assert.equal(
		install.shouldInitDb("server", undefined, false, {
			DATABASE_URL: "file:y",
		}),
		true,
	);
	assert.equal(install.shouldInitDb("server", undefined, false, {}), false);
	assert.equal(install.shouldInitDb("server", "file:x", true), false);
	assert.equal(install.shouldInitDb("client", "file:x", false), false);
});
