// ADR-0027：Windows SYSTEM 开机任务安装器的纯函数/adapter 测试（不触碰真实系统）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const installer = require("./install-client.cjs");

/** 记录型 adapter：dry-run 时文件操作不真实落盘，命令调用全部记录。 */
function recordingAdapter() {
	const records = [];
	let deleted = false;
	const taskXml = systemXml("C:\\node.exe", "C:\\launcher.js", "C:\\app");
	const adapter = {
		records,
		dryRun: true,
		home: "C:\\Users\\x",
		probe: () => true,
		readJson: (path) =>
		path.endsWith("client-install.json")
			? {
					serverOrigin: "https://deck.example.com",
					appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
					clientId: "11111111-2222-4333-8444-555555555555",
					displayName: "x",
				}
			: {},
		readEnv: () => ({}),
		writeFile: (p) => {
			records.push(`write:${p}`);
		},
		mkdir: (p) => {
			records.push(`mkdir:${p}`);
		},
		icacls: (p) => {
			records.push(`icacls:${p}`);
		},
		spawn: (command, args = []) => {
			const key = `${command}:${args.join(" ")}`;
			records.push(key);
			if (command === "schtasks.exe" && args[0] === "/Create" && args.join(" ").includes("\\VCPDeck\\Client")) return { status: 0 };
			if (command === "schtasks.exe" && args[0] === "/Query" && args.join(" ").includes("\\VCPDeck\\Client")) return { status: 0, stdout: taskXml };
			return { status: 1, stderr: `unexpected ${command}` };
		},
		// 默认：旧 VCPDeck PM2 进程指向已确认的旧 app-dir；delete 后视为已删除；fail-closed 测试整体替换。
		pm2: (args) => {
			records.push(`pm2:${args.join(" ")}`);
			if (args[0] === "delete") deleted = true;
			if (args[0] === "jlist") {
				if (deleted) return { status: 0, stdout: "[]" };
				return {
					status: 0,
					stdout: JSON.stringify([
						{ name: "vcpdeck-client-launcher", pm2_env: { pm_exec_path: "C:\\Users\\x\\.vcpdeck\\launcher-client\\dist\\main.js" } },
					]),
				};
			}
			return { status: 0 };
		},
	};
	return adapter;
}

function systemXml(nodePath, launcherPath, appDir, extra = "") {
	return `<Task><Principal id="Author"><UserId>S-1-5-18</UserId><LogonType>ServiceAccount</LogonType><RunLevel>HighestAvailable</RunLevel></Principal><Triggers><BootTrigger><StartWhenAvailable>true</StartWhenAvailable></BootTrigger><TimeTrigger><Enabled>true</Enabled><Delay>PT15S</Delay></TimeTrigger></Triggers><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Attempts>999</Attempts></RestartOnFailure></Settings><Actions><Exec><Command>${nodePath}</Command><Arguments>"${launcherPath}"</Arguments><WorkingDirectory>${appDir}</WorkingDirectory></Exec></Actions>${extra}</Task>`;
}

test("固定 ProgramData 安装根", () => {
	assert.equal(installer.WINDOWS_APP_DIR, "C:\\ProgramData\\VCPDeck\\Client");
});

test("未提升管理员 PowerShell 立即失败，不申请 UAC", () => {
	const elevated = /管理员[\u0020\u3000]PowerShell|请以管理员/;
	assert.throws(
		() => installer.assertElevatedWindowsIdentity({ administrator: true, highIntegrity: false }),
		elevated,
	);
	assert.throws(
		() => installer.assertElevatedWindowsIdentity({ administrator: false, highIntegrity: true }),
		elevated,
	);
	installer.assertElevatedWindowsIdentity({ administrator: true, highIntegrity: true });
});

test("PowerShell bootstrap 用 WindowsPrincipal 判断提升，不从 Groups 误查 Mandatory Label", () => {
	for (const name of ["install-client-bootstrap.ps1", "uninstall-client-bootstrap.ps1"]) {
		const source = readFileSync(join(__dirname, name), "utf8");
		assert.match(source, /\.IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
		assert.doesNotMatch(source, /\$identity\.Groups|S-1-16-/);
		assert.match(source, /if \(-not \$isAdmin\)/);
	}
});

test("Windows 安装失败诊断指向 SYSTEM 任务，不再只提示旧 PM2 日志", () => {
	const source = readFileSync(join(__dirname, "install-client.cjs"), "utf8");
	assert.match(source, /if \(platform\(\) === "win32"\)/);
	assert.match(source, /Windows 诊断/);
	assert.match(source, /日志: pm2 logs/);
});

test("SYSTEM 任务 XML 固定 S-1-5-18、ServiceAccount、开机触发与失败重启，且不含 PM2", () => {
	const xml = installer.buildWindowsSystemTaskXml({
		nodePath: "C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node.exe",
		launcherPath: "C:\\ProgramData\\VCPDeck\\Client\\dist\\main.js",
		appDir: "C:\\ProgramData\\VCPDeck\\Client",
	});
	assert.match(xml, /<UserId>S-1-5-18<\/UserId>/);
	assert.match(xml, /<LogonType>ServiceAccount<\/LogonType>/);
	assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
	assert.match(xml, /<BootTrigger>/);
	assert.match(xml, /<Delay>PT15S<\/Delay>|<DelayedTriggerDuration>PT15S<\/DelayedTriggerDuration>/);
	assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
	assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
	assert.match(xml, /<RestartOnFailure>/);
	assert.doesNotMatch(xml, /pm2/i);
});

test("SYSTEM 任务分类：匹配 configured、漂移 repair、冲突 conflict", () => {
	const expected = {
		nodePath: "C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node.exe",
		launcherPath: "C:\\ProgramData\\VCPDeck\\Client\\dist\\main.js",
		appDir: "C:\\ProgramData\\VCPDeck\\Client",
	};
	const okXml = systemXml(expected.nodePath, expected.launcherPath, expected.appDir);
	assert.equal(installer.classifyWindowsSystemTask(okXml, expected), "configured");
	assert.equal(
		installer.classifyWindowsSystemTask(okXml.replace("<RunLevel>HighestAvailable</RunLevel>", "<RunLevel>Limited</RunLevel>"), expected),
		"repair",
	);
	assert.equal(
		installer.classifyWindowsSystemTask(
			okXml.replace(/C:\\ProgramData\\VCPDeck\\Client/g, "C:\\other"),
			expected,
		),
		"conflict",
	);
	assert.equal(installer.classifyWindowsSystemTask(null, expected), "missing");
});

test("机器级 Git 发现：任一命中即不调用 winget", () => {
	const found = installer.findMachineGit({
		exists: (p) => p.toLowerCase().endsWith("git.exe"),
		appPaths: () => null,
		env: { PATH: "C:\\nope" },
	});
	assert.ok(found);
	const result = installer.ensureOptionalMachineGit({
		findGit: () => found,
		spawn: () => assert.fail("不应调用 winget"),
	});
	assert.equal(result.warning, null);
});

test("Git 全部缺失时调用精确 winget 参数", () => {
	let call = null;
	const result = installer.ensureOptionalMachineGit({
		findGit: () => (call ? "C:\\Program Files\\Git\\cmd\\git.exe" : null),
		spawn: (command, args) => {
			call = { command, args };
			return { status: 0 };
		},
	});
	assert.equal(result.warning, null);
	assert.deepEqual(call, {
		command: "winget.exe",
		args: [
			"install",
			"--id",
			"Git.Git",
			"--exact",
			"--scope",
			"machine",
			"--silent",
			"--accept-package-agreements",
			"--accept-source-agreements",
		],
	});
});

test("winget 不存在/失败只警告，不阻断安装", () => {
	const missing = installer.ensureOptionalMachineGit({
		findGit: () => null,
		spawn: () => ({ status: 127, stderr: "winget not found" }),
	});
	assert.match(missing.warning, /Git/);
	const failed = installer.ensureOptionalMachineGit({
		findGit: () => null,
		spawn: () => ({ status: 1, stderr: "install failed" }),
	});
	assert.match(failed.warning, /Git/);
});

test("Windows 安装状态机：完整材料就绪后才清理，顺序与 fail closed 固定", () => {
	const adapter = recordingAdapter();
	const run = installer.runWindowsInstall({
		adapter,
		args: {
			serverOrigin: "https://deck.example.com",
			platform: "win-x64",
			nodePath: "C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node.exe",
		},
		bootstrap: {
			releaseVersion: "9.9.9",
			archiveUrl: "/api/releases/9.9.9/file?platform=win-x64",
			archiveSha256: "ab".repeat(32),
			psk: "test-psk",
			verificationTimeoutMs: 1000,
		},
		preflight: {
			lowLevelInstallerUrl: "/api/client-installer/assets/install.cjs",
			lowLevelInstallerSha256: "cd".repeat(32),
		},
		fetchJson: async () => ({
			registered: true,
			online: true,
			clientVersion: "9.9.9",
			name: "deck",
			capabilitiesReported: true,
			installationMode: "windows-system-task",
			privilegedMode: "windows-system",
		}),
		download: async () => {},
	});
	const promise = run.catch(() => {
		assert.fail("安装状态机失败");
		return null;
	});
	return promise.then(() => {
		const steps = adapter.records.filter((r) => !r.startsWith("write:") && !r.startsWith("icacls:"));
		assert.deepEqual(
			steps,
			[
				"validate-source",
				"pm2:jlist",
				"mkdir:C:\\ProgramData\\VCPDeck\\Client",
				"prepare-runtime",
				"prepare-archive",
				"validate-archive",
				"stop-old-launcher",
				"pm2:delete vcpdeck-client-launcher",
				"delete-old-pm2-entry",
				"pm2:save",
				"save-remaining-pm2-apps",
				"pm2:jlist",
				"remove-old-app-dir",
				"install-system-layout",
				"register-system-task",
				"schtasks.exe:/Create /XML C:\\ProgramData\\VCPDeck\\Client\\client-task.xml /TN \\VCPDeck\\Client /F",
				"schtasks.exe:/Query /TN \\VCPDeck\\Client",
				"schtasks.exe:/Run /TN \\VCPDeck\\Client",
				"start-system-task",
				"verify-system-client",
			],
		);
		assert.ok(adapter.records.some((r) => r === "icacls:C:\\ProgramData\\VCPDeck\\Client\\launcher.env"));
	});
});

test("SYSTEM 任务使用 bootstrap 传入的 ProgramData Node 路径，不假设 runtime\\node\\node.exe", async () => {
	const adapter = recordingAdapter();
	let taskXml = "";
	adapter.writeFile = (content, path) => {
		adapter.records.push(`write:${path}`);
		if (path.endsWith("client-task.xml")) taskXml = content;
	};
	await installer.runWindowsInstall({
		adapter,
		args: {
			serverOrigin: "https://deck.example.com",
			platform: "win-x64",
			nodePath: "C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node-24.15.0\\node.exe",
		},
		bootstrap: {
			releaseVersion: "9.9.9",
			archiveUrl: "/api/releases/9.9.9/file?platform=win-x64",
			archiveSha256: "ab".repeat(32),
			psk: "test-psk",
			verificationTimeoutMs: 1000,
		},
		preflight: {
			lowLevelInstallerUrl: "/api/client-installer/assets/install.cjs",
			lowLevelInstallerSha256: "cd".repeat(32),
		},
		fetchJson: async () => ({
			registered: true,
			online: true,
			clientVersion: "9.9.9",
			name: "deck",
			capabilitiesReported: true,
			installationMode: "windows-system-task",
			privilegedMode: "windows-system",
		}),
		download: async () => {},
	});
	assert.equal(
		taskXml.includes("<Command>C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node.exe</Command>"),
		false,
	);
	assert.equal(
		taskXml.includes(
			"<Command>C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node-24.15.0\\node.exe</Command>",
		),
		true,
	);
});

test("旧来源指向不同 Server 时在 stop-old-launcher 前 fail closed", () => {
	const adapter = recordingAdapter();
	adapter.readJson = (path) =>
		path.endsWith("client-install.json")
			? {
					serverOrigin: "https://other.example.com",
					appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
					clientId: "c1",
					displayName: "x",
			  }
			: {};
	adapter.pm2 = () => {
		adapter.records.push("pm2:unexpected");
		return { status: 0, stdout: "[]" };
	};
	const run = installer.runWindowsInstall({
		adapter,
		args: {
			serverOrigin: "https://deck.example.com",
			platform: "win-x64",
			nodePath: "C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node.exe",
		},
		bootstrap: { releaseVersion: "9.9.9", archiveUrl: "/f", archiveSha256: "ab".repeat(32), psk: "p" },
		preflight: { lowLevelInstallerUrl: "/l", lowLevelInstallerSha256: "cd".repeat(32) },
		fetchJson: async () => ({ registered: true }),
		download: async () => {},
	});
	return run
		.then(() => assert.fail("应拒绝跨 Server 迁移"))
		.catch((error) => {
			assert.match(error.message, /Server/);
			assert.ok(!adapter.records.includes("stop-old-launcher"), "未进入清理阶段");
			assert.ok(
				!adapter.records.some((r) => r.startsWith("pm2:delete") || r.startsWith("pm2:save")),
				"未变更 PM2 状态",
			);
		});
});

test("旧 PM2 同名进程指向其他目录时在清理前 fail closed", () => {
	const adapter = recordingAdapter();
	adapter.readJson = (path) =>
		path.endsWith("client-install.json")
			? {
					serverOrigin: "https://deck.example.com",
					appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
					clientId: "11111111-2222-4333-8444-555555555555",
			  }
			: {};
	adapter.pm2 = (args) => {
		adapter.records.push(`pm2:${args.join(" ")}`);
		if (args[0] === "jlist")
			return {
				status: 0,
				stdout: JSON.stringify([
					{ name: "vcpdeck-client-launcher", pm2_env: { pm_exec_path: "C:\\other\\dist\\main.js" } },
				]),
			};
		return { status: 0 };
	};
	const run = installer.runWindowsInstall({
		adapter,
		args: {
			serverOrigin: "https://deck.example.com",
			platform: "win-x64",
			nodePath: "C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node.exe",
		},
		bootstrap: { releaseVersion: "9.9.9", archiveUrl: "/f", archiveSha256: "ab".repeat(32), psk: "p" },
		preflight: { lowLevelInstallerUrl: "/l", lowLevelInstallerSha256: "cd".repeat(32) },
		fetchJson: async () => ({ registered: true }),
		download: async () => {},
	});
	return run
		.then(() => assert.fail("应拒绝未知进程归属"))
		.catch((error) => {
			assert.match(error.message, /PM2/);
			assert.ok(!adapter.records.includes("delete-old-pm2-entry"), "未删除 PM2 条目");
		});
});

test("系统级卸载：停任务 → 删任务 → 保留 Client ID → 删运行目录", () => {
	const uninstaller = require("./uninstall-client.cjs");
	// 确保使用当前构建的卸载器（CJS 模块缓存不影响本进程）
	delete require.cache[require.resolve("./uninstall-client.cjs")];
	const records = [];
	const adapter = {
		records,
		dryRun: true,
		readJson: (path) =>
			path.endsWith("install-state.json")
				? {
						version: 1,
						serverOrigin: "https://deck.example.com",
						appDir: "C:\\ProgramData\\VCPDeck\\Client",
						displayName: "deck",
						clientId: "11111111-2222-4333-8444-555555555555",
					}
				: null,
		readEnv: () => ({ VCPDECK_ARTIFACT: "client", VCPDECK_APP_DIR: "C:\\ProgramData\\VCPDeck\\Client" }),
		writeFile: (content, p) => records.push(`write:${p}`),
		rm: (p) => records.push(`rm:${p}`),
		icacls: (p) => records.push(`icacls:${p}`),
		spawn: (command, args = []) => {
			records.push(`${command}:${args.join(" ")}`);
			return { status: 0, stdout: "ok" };
		},
	};
	const result = uninstaller.uninstallSystemClient(adapter);
	assert.deepEqual(result, {
		removed: true,
		appDir: "C:\\ProgramData\\VCPDeck\\Client",
		clientIdPreservedAt: "C:\\ProgramData\\VCPDeck\\client-id",
	});
	const actions = records;
	assert.deepEqual(actions, [
		"schtasks.exe:/End /TN \\VCPDeck\\Client /F",
		"schtasks.exe:/Delete /TN \\VCPDeck\\Client /F",
		"write:C:\\ProgramData\\VCPDeck\\client-id",
		"icacls:C:\\ProgramData\\VCPDeck\\client-id",
		"rm:C:\\ProgramData\\VCPDeck\\Client",
	]);
	assert.match(records.find((r) => r.startsWith("write:C:\\ProgramData\\VCPDeck\\client-id")), /client-id/);
});

test("系统级卸载拒绝危险根目录与 Client ID 缺失状态", () => {
	const uninstaller = require("./uninstall-client.cjs");
	const adapter = {
		dryRun: true,
		readJson: (path) =>
			path.endsWith("install-state.json")
				? {
						version: 1,
						serverOrigin: "https://deck.example.com",
						appDir: "C:\\",
						displayName: "x",
						clientId: "11111111-2222-4333-8444-555555555555",
					}
				: null,
		readEnv: () => ({ VCPDECK_ARTIFACT: "client", VCPDECK_APP_DIR: "C:\\" }),
		writeFile: () => {},
		rm: () => assert.fail("不得删除"),
		icacls: () => {},
		spawn: () => ({ status: 0, stdout: "ok" }),
	};
	assert.throws(() => uninstaller.uninstallSystemClient(adapter), /appDir/);
	const missing = {
		...adapter,
		readEnv: () => ({ VCPDECK_ARTIFACT: "client", VCPDECK_APP_DIR: "C:\\ProgramData\\VCPDeck\\Client" }),
		readJson: () => ({
			version: 1,
			serverOrigin: "https://deck.example.com",
			appDir: "C:\\ProgramData\\VCPDeck\\Client",
			displayName: "x",
		}),
	};
	assert.throws(() => uninstaller.uninstallSystemClient(missing), /Client ID/);
});
