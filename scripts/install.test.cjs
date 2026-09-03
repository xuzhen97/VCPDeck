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
const { join, resolve } = require("node:path");
const install = require("./install.cjs");

const isWin = platform() === "win32";

function makeStaging(root) {
	mkdirSync(join(root, "launcher", "dist"), { recursive: true });
	mkdirSync(join(root, "server", "dist"), { recursive: true });
	mkdirSync(join(root, "client", "dist"), { recursive: true });
	writeFileSync(join(root, "launcher", "dist", "main.js"), "// launcher");
	writeFileSync(join(root, "server", "dist", "main.js"), "// server");
	writeFileSync(join(root, "client", "dist", "index.js"), "// client");
	writeFileSync(
		join(root, "manifest.json"),
		JSON.stringify({
			version: "1.2.3",
			launcher: { dir: "launcher", entry: "dist/main.js" },
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

test("parseArgs 解析无值布尔参数，避免低层安装器进入 TTY 交互", () => {
	const args = install.parseArgs([
		"--artifact=client",
		"--zip=a.zip",
		"--version=1.2.3",
		"--no-env",
		"--force",
	]);
	assert.equal(args.noEnv, true);
	assert.equal(args.force, true);
	assert.equal(args.skipDb, undefined);
	assert.throws(
		() => install.parseArgs(["--artifact=client", "--zip=a.zip", "--unknown"]),
		/未知参数/,
	);
});

test("parseArgs 按构件选择默认 app-dir，同机 Server/Client 隔离", () => {
	assert.equal(
		install.parseArgs(["--artifact=server", "--zip=a.zip"]).appDir,
		join(require("node:os").homedir(), ".vcpdeck", "launcher"),
	);
	assert.equal(
		install.parseArgs(["--artifact=client", "--zip=a.zip"]).appDir,
		join(require("node:os").homedir(), ".vcpdeck", "launcher-client"),
	);
	assert.equal(
		install.parseArgs(["--artifact=client", "--zip=a.zip", "--app-dir=C:/custom"])
			.appDir,
		resolve("C:/custom"),
	);
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
		() => install.parseArgs(["--artifact=server", "--zip=a.zip", "--sha256=xyz"]),
		/sha256/,
	);
});

test("parseArgs 解析并校验 --port", () => {
	const args = install.parseArgs([
		"--artifact=server",
		"--zip=a.zip",
		"--port=8080",
	]);
	assert.equal(args.port, 8080);
	assert.throws(
		() => install.parseArgs(["--artifact=server", "--zip=a.zip", "--port=0"]),
		/--port/,
	);
	assert.throws(
		() => install.parseArgs(["--artifact=server", "--zip=a.zip", "--port=70000"]),
		/--port/,
	);
	assert.throws(
		() => install.parseArgs(["--artifact=server", "--zip=a.zip", "--port=abc"]),
		/--port/,
	);
	// client 也能解析，但只对 server 写入 env
	assert.equal(
		install.parseArgs(["--artifact=client", "--zip=a.zip", "--port=8080"]).port,
		8080,
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
		assert.equal(existsSync(join(appDir, "dist", "main.js")), true);
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
		writeFileSync(
			join(staging, "manifest.json"),
			JSON.stringify({ launcher: { dir: "launcher", entry: "dist/main.js" } }),
		);
		const appDir = join(dir, "app");
		assert.throws(
			() =>
				install.installFromStaging(staging, {
					artifact: "server",
					version: "1.2.3",
					appDir,
					force: false,
				}),
			/launcher\.dir|dist/,
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

test("generateSecret 生成 64 位 hex 强随机值", () => {
	const a = install.generateSecret();
	const b = install.generateSecret();
	assert.match(a, /^[a-f0-9]{64}$/);
	assert.notEqual(a, b);
});

test("shouldWriteEnv 仅在未 --no-env 且 artifact 已知时生成", () => {
	assert.equal(install.shouldWriteEnv({ artifact: "server" }), true);
	assert.equal(
		install.shouldWriteEnv({ artifact: "server", noEnv: true }),
		false,
	);
	assert.equal(install.shouldWriteEnv({}), false);
});

test("buildEnvFile server 含 PSK/密码/DB/Releases，client 含 PSK/Server", () => {
	const server = install.buildEnvFile({
		artifact: "server",
		appDir: "C:/app",
		psk: "k1",
		adminPassword: "p1",
		dbUrl: "file:C:/app/server.db",
		releasesDir: "C:/app/releases",
	});
	assert.match(server, /VCPDECK_APP_DIR=C:\/app/);
	assert.match(server, /VCPDECK_ARTIFACT=server/);
	assert.match(server, /VCPDECK_PSK=k1/);
	assert.match(server, /VCPDECK_ADMIN_PASSWORD=p1/);
	assert.match(server, /DATABASE_URL=file:C:\/app\/server\.db/);
	assert.match(server, /VCPDECK_RELEASES_DIR=C:\/app\/releases/);
	assert.doesNotMatch(server, /VCPDECK_SERVER=/);

	// 显式 port 时写入 VCPDECK_PORT；未提供时不写（保持默认 3001）
	assert.doesNotMatch(server, /VCPDECK_PORT=/);
	const withPort = install.buildEnvFile({
		artifact: "server",
		appDir: "C:/app",
		psk: "k1",
		adminPassword: "p1",
		dbUrl: "file:C:/app/server.db",
		releasesDir: "C:/app/releases",
		port: 8080,
	});
	assert.match(withPort, /VCPDECK_PORT=8080/);

	const client = install.buildEnvFile({
		artifact: "client",
		appDir: "C:/app",
		psk: "k2",
		serverUrl: "http://192.168.1.5:3001",
		clientId: "node-1",
	});
	assert.match(client, /VCPDECK_ARTIFACT=client/);
	assert.match(client, /VCPDECK_PSK=k2/);
	assert.match(client, /VCPDECK_SERVER=http:\/\/192\.168\.1\.5:3001/);
	assert.match(client, /VCPDECK_CLIENT_ID=node-1/);
	assert.doesNotMatch(client, /VCPDECK_ADMIN_PASSWORD=/);
	// client 未给 serverUrl 时不写该行
	const partial = install.buildEnvFile({
		artifact: "client",
		appDir: "C:/app",
		psk: "k",
	});
	assert.doesNotMatch(partial, /VCPDECK_SERVER=/);
});

test("writeEnvFile 写入并返回路径（非 Windows 权限 600）", () => {
	const dir = mkdtempSync(join(tmpdir(), "install-test-"));
	try {
		const envPath = install.writeEnvFile(dir, "VCPDECK_PSK=x\n");
		assert.equal(join(dir, "launcher.env"), envPath);
		assert.equal(readFileSync(envPath, "utf-8"), "VCPDECK_PSK=x\n");
		if (!isWin) {
			const { statSync } = require("node:fs");
			assert.equal(statSync(envPath).mode & 0o777, 0o600);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectEnvArgs 非 TTY 用显式参数或随机/默认值", async () => {
	const server = await install.collectEnvArgs({
		artifact: "server",
		appDir: "C:/app",
	});
	assert.match(server.psk, /^[a-f0-9]{64}$/);
	assert.match(server.adminPassword, /^[a-f0-9]{64}$/);
	assert.equal(server.dbUrl, `file:${join("C:/app", "server.db")}`);
	assert.equal(server.releasesDir, join("C:/app", "releases"));

	const serverExplicit = await install.collectEnvArgs({
		artifact: "server",
		appDir: "C:/app",
		psk: "fixed-psk",
		adminPassword: "fixed-pass",
		dbUrl: "file:db",
		releasesDir: "/data/releases",
	});
	assert.equal(serverExplicit.psk, "fixed-psk");
	assert.equal(serverExplicit.adminPassword, "fixed-pass");
	assert.equal(serverExplicit.dbUrl, "file:db");
	assert.equal(serverExplicit.releasesDir, "/data/releases");

	const client = await install.collectEnvArgs({ artifact: "client" });
	assert.match(client.psk, /^[a-f0-9]{64}$/);
	assert.equal(client.serverUrl, "");

	const clientExplicit = await install.collectEnvArgs({
		artifact: "client",
		serverUrl: "http://s:3001",
	});
	assert.equal(clientExplicit.serverUrl, "http://s:3001");
});

test("installFromStaging 缺少 Launcher 时拒绝安装", () => {
	const dir = mkdtempSync(join(tmpdir(), "install-test-"));
	try {
		const staging = join(dir, "staging");
		makeStaging(staging);
		const manifestPath = join(staging, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		delete manifest.launcher;
		writeFileSync(manifestPath, JSON.stringify(manifest));
		assert.throws(
			() =>
				install.installFromStaging(staging, {
					artifact: "server",
					version: "1.2.3",
					appDir: join(dir, "app"),
					force: false,
				}),
			/launcher\.dir/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installFromStaging 每个版本目录保留已验证 Launcher 构件（供 systemd 升级），稳定 dist 不随版本切换", () => {
	const root = mkdtempSync(join(tmpdir(), "vcpdeck-install-"));
	const staging = join(root, "staging");
	const appDir = join(root, "app");
	makeStaging(staging);
	try {
		install.installFromStaging(staging, {
			artifact: "client",
			version: "1.2.3",
			appDir,
			force: true,
		});
		// 版本内保留经 staging 验证的 Launcher 构件（systemd 自升级源）。
		const versionLauncher = join(appDir, "apps", "1.2.3", "launcher", "dist", "main.js");
		assert.ok(existsSync(versionLauncher), "版本目录缺少 launcher 构件");
		assert.equal(readFileSync(versionLauncher, "utf8"), "// launcher");
		// 稳定 Launcher 仍安装在 appDir/dist/main.js（不在版本目录内）。
		const stable = join(appDir, "dist", "main.js");
		assert.ok(existsSync(stable));
		assert.equal(readFileSync(stable, "utf8"), "// launcher");
		// 版本目录不应包含稳定 dist 路径（两者独立）。
		assert.ok(!existsSync(join(appDir, "apps", "1.2.3", "dist")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("installFromStaging 保留已有 Launcher", () => {
	const dir = mkdtempSync(join(tmpdir(), "install-test-"));
	try {
		const staging = join(dir, "staging");
		makeStaging(staging);
		const appDir = join(dir, "app");
		mkdirSync(join(appDir, "dist"), { recursive: true });
		writeFileSync(join(appDir, "dist", "main.js"), "// existing launcher");
		install.installFromStaging(staging, {
			artifact: "server",
			version: "1.2.3",
			appDir,
			force: false,
		});
		assert.equal(
			readFileSync(join(appDir, "dist", "main.js"), "utf-8"),
			"// existing launcher",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectEnvArgs TTY 分支：回车用随机/默认值", async () => {
	const { PassThrough } = require("node:stream");
	const input = new PassThrough();
	input.isTTY = true;
	const output = new PassThrough();
	const p = install.collectEnvArgs(
		{ artifact: "server", appDir: "C:/app" },
		{ input, output },
	);
	// 逐行延时输入（模拟真人回车节奏；同步连续 write 会撞 readline 注册竞态）
	for (let i = 0; i < 3; i++) {
		input.write("\n");
		await new Promise((r) => setTimeout(r, 10));
	}
	const v = await p;
	assert.match(v.psk, /^[a-f0-9]{64}$/);
	assert.match(v.adminPassword, /^[a-f0-9]{64}$/);
	assert.equal(v.dbUrl, `file:${join("C:/app", "server.db")}`);
	assert.equal(v.releasesDir, join("C:/app", "releases"));
});

test("collectEnvArgs TTY 分支：手输值优先于显式参数与默认", async () => {
	const { PassThrough } = require("node:stream");
	const input = new PassThrough();
	input.isTTY = true;
	const output = new PassThrough();
	const p = install.collectEnvArgs(
		{ artifact: "client", appDir: "C:/app" },
		{ input, output },
	);
	input.write("my-psk\n");
	await new Promise((r) => setTimeout(r, 10));
	input.write("http://s2:3001\n");
	const v = await p;
	assert.equal(v.psk, "my-psk");
	assert.equal(v.serverUrl, "http://s2:3001");
});
