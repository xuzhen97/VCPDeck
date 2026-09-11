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

test("Windows 自启动任务直接执行 Node，并固定最高权限和电池策略", () => {
	const definition = {
		taskName: "VCPDeck PM2 Startup",
		nodePath: "C:\\Users\\x\\.vcpdeck\\runtime\\node\\node.exe",
		pm2Path: "C:\\Users\\x\\.vcpdeck\\tools\\pm2\\bin\\pm2",
		appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
		userSid: "S-1-5-21-1-1001",
		probePath: "C:\\Users\\x\\.vcpdeck\\launcher-client\\startup-probe.cjs",
	};
	const script = installer.buildWindowsStartupTaskScript(definition);
	assert.match(script, /New-ScheduledTaskAction/);
	assert.ok(script.includes(definition.nodePath));
	assert.ok(script.includes(definition.pm2Path));
	assert.ok(script.includes("-WorkingDirectory 'C:\\Users\\x\\.vcpdeck\\launcher-client'"));
	assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User 'S-1-5-21-1-1001'/);
	assert.match(script, /\.Delay = 'PT10S'/);
	assert.match(script, /-LogonType Interactive -RunLevel Highest/);
	assert.match(script, /-AllowStartIfOnBatteries/);
	assert.match(script, /-DontStopIfGoingOnBatteries/);
	assert.match(script, /-StartWhenAvailable/);
	assert.match(script, /-MultipleInstances IgnoreNew/);
	assert.doesNotMatch(script, /pm2-resurrect\.cmd/);
});

test("重复安装会修复 syc 异常引号任务、Limited 和电池限制", () => {
	const expected = {
		nodePath: "C:\\Users\\20338\\.vcpdeck\\runtime\\node\\node.exe",
		pm2Path: "C:\\Users\\20338\\.vcpdeck\\tools\\pm2\\bin\\pm2",
		appDir: "C:\\Users\\20338\\.vcpdeck\\launcher-client",
		userSid: "S-1-5-21-1-1003",
		probePath: "C:\\Users\\20338\\.vcpdeck\\launcher-client\\startup-probe.cjs",
	};
	const sycXml = `<Task><Principals><Principal><UserId>${expected.userSid}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>true</StopIfGoingOnBatteries></Settings><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>\"${expected.appDir}\\pm2-resurrect.cmd\"</Command></Exec></Actions></Task>`;
	assert.equal(installer.classifyWindowsStartupTask(sycXml, expected), "repair");
	assert.equal(
		installer.classifyWindowsStartupTask(
			sycXml.replace(/launcher-client/g, "other-client"),
			expected,
		),
		"conflict",
	);
});

test("Windows 计划任务 XML 经 UTF-8 base64 回传，不受控制台代码页影响", () => {
	const xml = `<Task><Actions><Exec><Command>"C:\\Users\\20338\\.vcpdeck\\launcher-client\\pm2-resurrect.cmd"</Command></Exec></Actions></Task>`;
	const calls = [];
	const decoded = installer.readWindowsTaskXml("VCPDeck PM2 Startup", (command, args) => {
		calls.push([command, args]);
		return { status: 0, stdout: Buffer.from(xml, "utf8").toString("base64") };
	});
	assert.equal(decoded, xml);
	assert.match(calls[0][0], /powershell\.exe$/i);
	assert.match(calls[0][1].join(" "), /Export-ScheduledTask -TaskName 'VCPDeck PM2 Startup'/);
	assert.equal(
		installer.readWindowsTaskXml("VCPDeck PM2 Startup", () => ({ status: 1, stdout: "" })),
		null,
	);
});

test("完全符合定义的 Windows 自启动任务可复用，其他安装目录仍冲突", () => {
	const expected = {
		nodePath: "C:\\Users\\x\\node.exe",
		pm2Path: "C:\\Users\\x\\pm2",
		appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
		userSid: "S-1-5-21-1-1001",
		probePath: "C:\\Users\\x\\.vcpdeck\\launcher-client\\startup-probe.cjs",
	};
	const xml = (command, appDir = expected.appDir) => `<Task><Principals><Principal><UserId>${expected.userSid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Settings><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable></Settings><Triggers><LogonTrigger><UserId>${expected.userSid}</UserId><Delay>PT10S</Delay></LogonTrigger></Triggers><Actions><Exec><Command>${command}</Command><Arguments>--require=\"${expected.probePath}\" \"${expected.pm2Path}\" resurrect</Arguments><WorkingDirectory>${appDir}</WorkingDirectory></Exec></Actions></Task>`;
	assert.equal(installer.classifyWindowsStartupTask(xml(expected.nodePath), expected), "configured");
	assert.equal(installer.classifyWindowsStartupTask(xml("C:\\other\\node.exe", "C:\\other"), expected), "conflict");
});

test("管理员注册经 UAC 执行自包含 ScheduledTasks payload，失败时 fail closed", () => {
	const definition = {
		taskName: "VCPDeck PM2 Startup",
		nodePath: "C:\\x\\node.exe",
		pm2Path: "C:\\x\\pm2",
		appDir: "C:\\x",
		userSid: "S-1-5-21-1-1001",
		probePath: "C:\\x\\startup-probe.cjs",
	};
	const calls = [];
	assert.equal(
		installer.registerStartupTask(definition, (args) => {
			calls.push(args.join(" "));
			return { status: 0 };
		}),
		"windows-logon-task(via-uac)",
	);
	const match = calls[0].match(/-EncodedCommand','([^']+)'/);
	assert.ok(match);
	const payload = Buffer.from(match[1], "base64").toString("utf16le");
	assert.match(payload, /Register-ScheduledTask/);
	assert.match(payload, /RunLevel Highest/);
	assert.throws(
		() => installer.registerStartupTask(definition, () => ({ status: 1 })),
		/UAC|注册失败/,
	);
});
