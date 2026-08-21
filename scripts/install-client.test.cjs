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
const { join } = require("node:path");
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
