const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, dirname, join } = require("node:path");
const installer = require("./install-client.cjs");

test("parseArgs 接受固定 Origin、平台和 Node", () => {
	const result = installer.parseArgs([
		"--server-origin=https://deck.example.com/path",
		"--platform=linux-x64",
		`--node=${process.execPath}`,
	]);
	assert.equal(result.serverOrigin, "https://deck.example.com");
	assert.equal(result.platform, "linux-x64");
});

test("Windows bootstrap 的 Node 探测兼容 Windows PowerShell 5.1", () => {
	const source = readFileSync(
		join(__dirname, "install-client-bootstrap.ps1"),
		"utf8",
	);
	assert.match(source, /\| & \$Path -/);
	assert.doesNotMatch(source, /& \$Path -e/);

	if (process.platform !== "win32") return;
	const start = source.indexOf("function Test-Node");
	const end = source.indexOf("\n$node =", start);
	assert.ok(start >= 0 && end > start, "应能提取 Test-Node 函数");
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-node-probe-"));
	try {
		const probe = join(dir, "probe.ps1");
		writeFileSync(
			probe,
			`${source.slice(start, end)}\n$node = (Get-Command node -ErrorAction Stop).Source\nif (-not (Test-Node $node)) { exit 1 }\n`,
		);
		const result = spawnSync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-File", probe],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr || result.stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveGlobalPm2 将全局 pm2.cmd 解析为 node + bin/pm2，避免无 shell spawn .cmd", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-pm2-resolve-"));
	try {
		const nodePath = process.execPath;
		// 非 .cmd 命令直接透传
		assert.deepEqual(installer.resolveGlobalPm2("/usr/bin/pm2", nodePath), {
			command: "/usr/bin/pm2",
			argsPrefix: [],
		});
		assert.equal(installer.resolveGlobalPm2(null, nodePath), null);

		// pm2.cmd 旁有 pm2 包入口 bin/pm2 时用 node 执行
		const pm2Bin = join(dir, "node_modules", "pm2", "bin");
		mkdirSync(pm2Bin, { recursive: true });
		writeFileSync(join(pm2Bin, "pm2"), "");
		assert.deepEqual(installer.resolveGlobalPm2(join(dir, "pm2.cmd"), nodePath), {
			command: nodePath,
			argsPrefix: [join(pm2Bin, "pm2")],
		});

		// 解析不到 pm2.js 时返回 null，回退私有安装
		assert.equal(
			installer.resolveGlobalPm2(
				join(tmpdir(), "no-such-dir", "pm2.cmd"),
				nodePath,
			),
			null,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("npmPath 在 Windows 上优先 npm-cli.js，避免直接执行 npm.cmd", () => {
	if (process.platform !== "win32") return;
	const npm = installer.npmPath(process.execPath);
	assert.ok(npm.endsWith("npm-cli.js"), `应优先 npm-cli.js，实际 ${npm}`);
});

test("writeEcosystem 强制以 launcher.env 覆盖 PM2 缓存的 VCPDECK 环境", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-ecosystem-"));
	try {
		const envPath = join(dir, "launcher.env");
		writeFileSync(
			envPath,
			"VCPDECK_SERVER=http://new.example.com:3001\nVCPDECK_PSK=file-psk\n",
		);
		const ecosystemPath = installer.writeEcosystem(
			dir,
			process.execPath,
			envPath,
		);
		delete require.cache[require.resolve(ecosystemPath)];
		const config = require(ecosystemPath);
		const envLoaderPath = join(dir, "launcher-env.cjs");
		assert.deepEqual(config.apps[0].filter_env, ["VCPDECK_"]);
		assert.deepEqual(config.apps[0].node_args, [
			`--require=${envLoaderPath}`,
		]);
		assert.deepEqual(Object.keys(config.apps[0].env), ["PATH"]);
		assert.ok(
			config.apps[0].env.PATH.startsWith(`${dirname(process.execPath)}${delimiter}`),
			"PM2 Launcher 环境应优先使用安装器选定的私有 Node",
		);

		const result = spawnSync(
			process.execPath,
			[
				`--require=${envLoaderPath}`,
				"-e",
				"process.stdout.write(process.env.VCPDECK_SERVER + '|' + process.env.VCPDECK_PSK)",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					VCPDECK_SERVER: "http://old.example.com:3001",
					VCPDECK_PSK: "cached-psk",
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "http://new.example.com:3001|file-psk");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseArgs 拒绝不支持平台与不可用 Node", () => {
	assert.throws(
		() =>
			installer.parseArgs([
				"--server-origin=https://deck.example.com",
				"--platform=linux-arm64",
				`--node=${process.execPath}`,
			]),
		/platform/,
	);
	assert.throws(
		() =>
			installer.parseArgs([
				"--server-origin=https://deck.example.com",
				"--platform=linux-x64",
				"--node=missing-node",
			]),
		/node/,
	);
});

test("readEnv 与 normalizeOrigin 支持已有安装冲突检测", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-client-installer-"));
	try {
		mkdirSync(dir, { recursive: true });
		const env = join(dir, "launcher.env");
		writeFileSync(
			env,
			"VCPDECK_SERVER=https://old.example.com/path\nVCPDECK_PSK=secret\n",
		);
		assert.equal(
			installer.readEnv(env).VCPDECK_SERVER,
			"https://old.example.com/path",
		);
		assert.equal(
			installer.normalizeOrigin(installer.readEnv(env).VCPDECK_SERVER),
			"https://old.example.com",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("私有 Node 的 bin 目录会注入 PM2 安装子进程 PATH", () => {
	const nodePath = join("opt", "vcpdeck", "runtime", "node", "bin", "node");
	const originalPath = ["usr", "local", "bin"].join(delimiter);
	const env = installer.buildNodeRuntimeEnv(nodePath, {
		PATH: originalPath,
		VCPDECK_TEST: "preserved",
	});
	assert.equal(env.PATH, `${dirname(nodePath)}${delimiter}${originalPath}`);
	assert.equal(env.VCPDECK_TEST, "preserved");
});

test("installPm2Retry 瞬时失败会重试并从后续 registry 成功", () => {
	const calls = [];
	const result = installer.installPm2Retry(
		["r1", "r2"],
		(registry) => {
			calls.push(registry);
			// r1 两次都失败，r2 第一次成功
			return registry === "r1" ? { ok: false, stderr: "ETIMEDOUT" } : { ok: true };
		},
		() => {},
	);
	assert.equal(result.ok, true);
	assert.deepEqual(calls, ["r1", "r1", "r2"]);
});

test("installPm2Retry 全部失败时保留最近真实错误", () => {
	const result = installer.installPm2Retry(
		["r1", "r2"],
		() => ({ ok: false, stderr: "npm ERR! 404 Not Found" }),
		() => {},
	);
	assert.equal(result.ok, false);
	assert.match(result.lastError, /npm ERR! 404/);
});

test("registerStartupTask 非管理员被拒时降级为 not-configured 并警示", () => {
	const warnings = [];
	const outcome = installer.registerStartupTask(
		"VCPDeck PM2 Startup",
		"C:\\Users\\xuzhe\\.vcpdeck\\launcher-client\\pm2-resurrect.cmd",
		() => {
			const error = new Error("spawn schtasks.exe 拒绝访问。\r\n");
			throw error;
		},
		(message) => warnings.push(message),
	);
	assert.equal(outcome, "not-configured");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /管理员/);
});

test("registerStartupTask 英文 Access is denied 同样降级", () => {
	const outcome = installer.registerStartupTask(
		"T",
		"C:\\x\\pm2-resurrect.cmd",
		() => {
			throw new Error("Access is denied.");
		},
		() => {},
	);
	assert.equal(outcome, "not-configured");
});

test("registerStartupTask 非权限错误仍抛出", () => {
	assert.throws(() =>
		installer.registerStartupTask("T", "C:\\x", () => {
			throw new Error("schtasks 已存在但指向其他命令");
		}),
	);
});

test("registerStartupTask 创建成功返回 windows-logon-task", () => {
const called = [];
const outcome = installer.registerStartupTask(
"T",
"C:\\x\\pm2-resurrect.cmd",
(file, args) => {
called.push([file, args[4]]);
},
);
assert.equal(outcome, "windows-logon-task");
assert.deepEqual(called, [["schtasks.exe", "T"]]);
});

test("retryStartupTaskAsAdmin 发起 UAC 提权重试且 payload 可解码验证", () => {
const calls = [];
const outcome = installer.retryStartupTaskAsAdmin(
"VCPDeck PM2 Startup",
"C:\\Users\\xuzhe\\.vcpdeck\\launcher-client\\pm2-resurrect.cmd",
(args) => {
calls.push(args.join(" "));
return { status: 0, stdout: "" };
},
);
assert.equal(outcome, "windows-logon-task(via-uac)");
assert.equal(calls.length, 1);
assert.match(calls[0], /-Verb RunAs -Wait -PassThru/);
const m = calls[0].match(/-EncodedCommand','([^']+)'/);
assert.ok(m, "应包含 EncodedCommand payload");
const payload = Buffer.from(m[1], "base64").toString("utf16le");
assert.match(payload, /\/Create/);
assert.ok(payload.includes("VCPDeck PM2 Startup"));
assert.ok(payload.includes("pm2-resurrect.cmd"));
});

test("retryStartupTaskAsAdmin 提权失败也降级并打印可复制兜底命令", () => {
const warns = [];
const outcome = installer.retryStartupTaskAsAdmin(
"VCPDeck PM2 Startup",
"C:\\x\\pm2-resurrect.cmd",
() => ({ status: 1, stdout: "" }),
(message) => warns.push(message),
);
assert.equal(outcome, "not-configured");
assert.equal(warns.length, 1);
assert.match(warns[0], /schtasks \/Create/);
assert.ok(warns[0].includes("VCPDeck PM2 Startup"));
});
