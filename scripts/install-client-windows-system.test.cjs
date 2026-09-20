// ADR-0027：Windows SYSTEM 开机任务安装器的纯函数/adapter 测试（不触碰真实系统）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
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
			if (command === "schtasks.exe" && args[0] === "/End" && args.join(" ").includes("\\VCPDeck\\Client")) return { status: 0 };
			if (command === "schtasks.exe" && args[0] === "/Query" && args.join(" ").includes("\\VCPDeck\\Client")) return { status: 0, stdout: taskXml };
			return { status: 1, stderr: `unexpected ${command}` };
		},
		listProcesses: () => [
			{ pid: 4000, parentPid: 100, creationDate: "launcher" },
			{ pid: 4001, parentPid: 4000, creationDate: "client" },
		],
		killProcessTree: (tree) => records.push(`kill-tree:${tree.map((entry) => entry.pid).join(",")}`),
		// 默认：旧 VCPDeck PM2 进程指向已确认的旧 app-dir；delete 后视为已删除；fail-closed 测试整体替换。
		pm2: (args) => {
			records.push(`pm2:${args.join(" ")}`);
			if (args[0] === "delete") deleted = true;
			if (args[0] === "jlist") {
				if (deleted) return { status: 0, stdout: "[]" };
				return {
					status: 0,
					stdout: JSON.stringify([
						{ pid: 4000, name: "vcpdeck-client-launcher", pm2_env: { pm_exec_path: "C:\\Users\\x\\.vcpdeck\\launcher-client\\dist\\main.js" } },
					]),
				};
			}
			return { status: 0 };
		},
	};
	return adapter;
}

function systemXml(nodePath, launcherPath, appDir, extra = "") {
	return `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal><Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT15S</Delay></BootTrigger></Triggers><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions><Exec><Command>${nodePath}</Command><Arguments>"${launcherPath}"</Arguments><WorkingDirectory>${appDir}</WorkingDirectory></Exec></Actions>${extra}</Task>`;
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

test("Windows ACL 使用 icacls 的 SID:权限格式，不把 SDDL 当作 grant 参数", () => {
	for (const source of [
		readFileSync(join(__dirname, "install-client.cjs"), "utf8"),
		readFileSync(join(__dirname, "uninstall-client.cjs"), "utf8"),
	]) {
		assert.match(source, /\/grant:r/);
		assert.match(source, /\*S-1-5-18:F/);
		assert.match(source, /\*S-1-5-32-544:F/);
		assert.doesNotMatch(source, /\/grant:S:\(A;;GA;;;(?:SY|BA)\)/);
	}
});

test("安装根 ACE 可继承，且 bootstrap 能自愈不可写现场", () => {
	// 不可继承的目录 ACE 会让 runtime 等子目录丢失全部权限，连管理员也无法再写入。
	const installer = readFileSync(join(__dirname, "install-client.cjs"), "utf8");
	assert.match(installer, /\*S-1-5-18:\(OI\)\(CI\)F/);
	assert.match(installer, /\*S-1-5-32-544:\(OI\)\(CI\)F/);
	assert.match(installer, /icacls\(WINDOWS_APP_DIR, \{ directory: true \}\)/);
	// 重建根 ACE 必须早于读 client-id：既有文件在旧版本下已失去全部 ACE，
	// 晚于此时才设置 ACL 会先抛 EPERM（open client-id）。
	const clientIdReadIndex = installer.search(/ensureClientId\(\s*join\(WINDOWS_APP_DIR/);
	assert.ok(clientIdReadIndex > 0, "应能定位 SYSTEM 安装的 client-id 读取");
	assert.ok(
		installer.indexOf("adapter.icacls(WINDOWS_APP_DIR, { directory: true })") < clientIdReadIndex,
		"安装根 ACL 必须先于 client-id 读取",
	);
	// 只读属性会让 Node 写入报 EPERM；既有文件的空 DACL 也需逐对象显式授权。
	assert.match(installer, /function clearReadOnly/);
	assert.match(installer, /clearReadOnly\(target\);/);
	assert.ok(
		installer.indexOf('for (const name of ["client-id", "launcher.env", "install-state.json"])') <
			clientIdReadIndex,
		"既有文件修复必须先于 client-id 读取",
	);

	const bootstrap = readFileSync(join(__dirname, "install-client-bootstrap.ps1"), "utf8");
	assert.match(bootstrap, /function Repair-AppDirAcl/);
	assert.match(bootstrap, /\*S-1-5-18:\(OI\)\(CI\)F/);
	assert.match(bootstrap, /\/T \/C/);
	assert.match(bootstrap, /takeown\.exe \/F \$appDir \/A \/R \/D Y/);
});

test("bootstrap 直接解压到 runtime 根，并暴露 Node 源的真实失败原因", () => {
	const bootstrap = readFileSync(join(__dirname, "install-client-bootstrap.ps1"), "utf8");
	// 解压zip 内部已有 node-v<版本>-win-x64 顶层目录，直接落到 runtime 根可避免失效目录与跨目录移动。
	assert.match(bootstrap, /node-v\$v-win-x64\\node\.exe/);
	assert.match(bootstrap, /Expand-Archive \$zip \$runtimeRoot -Force/);
	assert.doesNotMatch(bootstrap, /Move-Item \(Join-Path \$tmp/);
	// 两个源都失败时必须把最后一次真实异常带出，否则只能看到笼统的“无法准备 Node.js”。
	assert.match(bootstrap, /\$lastError/);
	assert.match(bootstrap, /失败）：\$lastError/);
	// Get-FileHash 来自 Microsoft.PowerShell.Utility：PSModulePath 被 PowerShell 7 模块覆盖时
	// Windows PowerShell 5.1 加载的 Utility 不含该 cmdlet，报“无法识别”而使安装失败；改用 .NET。
	assert.doesNotMatch(bootstrap, /Get-FileHash\s+-Algorithm/);
	assert.match(bootstrap, /function Get-Sha256/);
	assert.match(bootstrap, /\[Security\.Cryptography\.SHA256\]::Create\(\)\.ComputeHash/);

	// SHASUMS256 解析不能依赖固定双空格，否则匹配失败会变成空引用异常。
	assert.match(bootstrap, /-split '\\r\?\\n'/);
	assert.match(bootstrap, /-split '\\s\+'/);
});

test("别名被旧记录占用时不阻断安装，只给出可操作警告", () => {
	const source = readFileSync(join(__dirname, "install-client.cjs"), "utf8");
	const start = source.indexOf("if (last.name !== name) {");
	assert.ok(start > 0, "应能定位验收后的别名设置");
	const block = source.slice(start, source.indexOf("\t\t\t\treturn last;", start));
	// 旧记录占用别名时会返回 409；安装此时已在线验收通过，不能让它等到 120 秒超时。
	assert.match(block, /try \{/);
	assert.match(block, /catch \(error\)/);
	assert.match(block, /console\.warn/);
	assert.doesNotMatch(block, /throw /);
});

test("重装复用 ADR-0027 保留的机器身份，不新建重复 Client ID", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-clientid-"));
	try {
		const target = join(dir, "Client", "client-id");
		const preserved = join(dir, "client-id");
		const id = "f794cbdc-7147-4d43-9919-00841236e8ab";
		writeFileSync(preserved, `${id}\n`);
		assert.equal(installer.ensureClientId(target, null, preserved), id);
		assert.equal(readFileSync(target, "utf8"), id);
		// 目标文件已有身份时不被保留路径覆盖
		const own = "a07a04d6-1b61-4658-869b-25f24a42982f";
		writeFileSync(target, own);
		assert.equal(installer.ensureClientId(target, null, preserved), own);
		// 保留值非法时仍生成新身份
		writeFileSync(preserved, "not-a-uuid");
		rmSync(target);
		assert.notEqual(installer.ensureClientId(target, null, preserved), "not-a-uuid");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("缓存构件必须按 SHA-256 校验，低层安装器不能只靠文件名复用", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-cache-"));
	try {
		const file = join(dir, "install.cjs");
		writeFileSync(file, "// v1\n");
		const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
		assert.equal(installer.cachedArtifactOk(file, sha), true);
		// 旧版本缓存（内容不同）必须判定为需要重新下载
		assert.equal(installer.cachedArtifactOk(file, "ab".repeat(32)), false);
		assert.equal(installer.cachedArtifactOk(join(dir, "missing.cjs"), sha), false);
		assert.equal(installer.cachedArtifactOk(file, undefined), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	// SYSTEM 流程的两个缓存（Release zip 与 install.cjs）都必须走内容校验
	const source = readFileSync(join(__dirname, "install-client.cjs"), "utf8");
	assert.match(source, /cachedArtifactOk\(cache, bootstrap\.archiveSha256, adapter\.probe\)/);
	assert.match(
		source,
		/cachedArtifactOk\(lowInstaller, preflight\.lowLevelInstallerSha256, adapter\.probe\)/,
	);
});

test("Windows 安装失败诊断指向 SYSTEM 任务，不再只提示旧 PM2 日志", () => {
	const source = readFileSync(join(__dirname, "install-client.cjs"), "utf8");
	assert.match(source, /if \(platform\(\) === "win32"\)/);
	assert.match(source, /Windows 诊断/);
	assert.match(source, /日志: pm2 logs/);
});

test("SYSTEM 任务 XML 固定 S-1-5-18、最高权限、开机触发与失败重启，且不含 PM2", () => {
	const xml = installer.buildWindowsSystemTaskXml({
		nodePath: "C:\\ProgramData\\VCPDeck\\Client\\runtime\\node\\node.exe",
		launcherPath: "C:\\ProgramData\\VCPDeck\\Client\\dist\\main.js",
		appDir: "C:\\ProgramData\\VCPDeck\\Client",
	});
	assert.match(xml, /<\?xml version="1\.0" encoding="UTF-16"\?>/);
	assert.match(xml, /<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/);
	assert.match(xml, /<UserId>S-1-5-18<\/UserId>/);
	assert.doesNotMatch(xml, /<LogonType>/);
	assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
	assert.match(xml, /<BootTrigger>/);
	const bootTrigger = xml.match(/<BootTrigger>([\s\S]*?)<\/BootTrigger>/)?.[1] || "";
	assert.match(bootTrigger, /<Delay>PT15S<\/Delay>/);
	assert.doesNotMatch(bootTrigger, /<StartWhenAvailable>/);
	assert.doesNotMatch(xml, /<TimeTrigger>/);
	const settings = xml.match(/<Settings>([\s\S]*?)<\/Settings>/)?.[1] || "";
	assert.match(settings, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
	assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
	assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
	assert.match(xml, /<RestartOnFailure>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<Count>999<\/Count>[\s\S]*<\/RestartOnFailure>/);
	assert.doesNotMatch(xml, /<Attempts>/);
	assert.doesNotMatch(xml, /pm2/i);
});

test("SYSTEM 任务 XML 写入为带 BOM 的 UTF-16LE", () => {
	const source = readFileSync(join(__dirname, "install-client.cjs"), "utf8");
	assert.match(source, /Buffer\.from\(\[0xff, 0xfe\]\)/);
	assert.match(source, /Buffer\.from\(taskXml, "utf16le"\)/);
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

test("旧 PM2 目录清理等待 Windows 进程句柄释放", () => {
	let call = null;
	installer.removeTreeWithRetries("C:\\Users\\x\\.vcpdeck\\launcher-client", (path, options) => {
		call = { path, options };
	});
	assert.deepEqual(call, {
		path: "C:\\Users\\x\\.vcpdeck\\launcher-client",
		options: { recursive: true, force: true, maxRetries: 20, retryDelay: 500 },
	});
});

test("旧目录直接删除 EPERM 时原子隔离后继续迁移，不触碰其他目录", () => {
	const adapter = recordingAdapter();
	adapter.dryRun = false;
	adapter.removeTree = () => {
		const error = new Error("EPERM, Permission denied");
		error.code = "EPERM";
		throw error;
	};
	adapter.quarantineTree = (source) => {
		adapter.records.push(`quarantine:${source}`);
		return `${source}.vcpdeck-orphan-test`;
	};
	adapter.writeDiagnostic = (_error, source) => {
		adapter.records.push(`diagnostic:${source.quarantinePath}`);
		return "C:\\ProgramData\\VCPDeck\\Client\\install-diagnostic.log";
	};
	installer.cleanLegacyWindowsInstall(adapter, {
		appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
		statePath: "C:\\Users\\x\\.vcpdeck\\client-install.json",
		hasProcess: false,
	});
	assert.ok(adapter.records.includes("quarantine:C:\\Users\\x\\.vcpdeck\\launcher-client"));
	assert.ok(adapter.records.includes("diagnostic:C:\\Users\\x\\.vcpdeck\\launcher-client.vcpdeck-orphan-test"));
});

test("旧目录删除与隔离都失败但 Server 确认旧 Client 离线时保留目录继续", () => {
	const adapter = recordingAdapter();
	adapter.dryRun = false;
	adapter.removeTree = () => {
		const error = new Error("EPERM, delete denied");
		error.code = "EPERM";
		throw error;
	};
	adapter.quarantineTree = () => {
		const error = new Error("EBUSY, rename denied");
		error.code = "EBUSY";
		throw error;
	};
	adapter.writeDiagnostic = (error, source) => {
		adapter.records.push(`diagnostic:${error.message}:${source.appDir}`);
		return "C:\\ProgramData\\VCPDeck\\Client\\install-diagnostic.log";
	};
	installer.cleanLegacyWindowsInstall(adapter, {
		appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
		statePath: "C:\\Users\\x\\.vcpdeck\\client-install.json",
		hasProcess: false,
		confirmedOffline: true,
	});
	assert.ok(adapter.records.includes("preserve-locked-old-app-dir"));
	assert.ok(adapter.records.includes("diagnostic:EBUSY, rename denied:C:\\Users\\x\\.vcpdeck\\launcher-client"));
});

test("旧目录删除与隔离都失败且未确认离线时 fail closed", () => {
	const adapter = recordingAdapter();
	adapter.dryRun = false;
	adapter.removeTree = () => { throw Object.assign(new Error("EPERM, delete denied"), { code: "EPERM" }); };
	adapter.quarantineTree = () => { throw Object.assign(new Error("EBUSY, rename denied"), { code: "EBUSY" }); };
	adapter.writeDiagnostic = () => "C:\\ProgramData\\VCPDeck\\Client\\install-diagnostic.log";
	assert.throws(
		() => installer.cleanLegacyWindowsInstall(adapter, {
			appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
			statePath: "C:\\Users\\x\\.vcpdeck\\client-install.json",
			hasProcess: false,
			confirmedOffline: false,
		}),
		/rename denied/,
	);
});

test("旧 PM2 使用自定义名称时按 Launcher 路径识别并删除真实条目", () => {
	const adapter = recordingAdapter();
	adapter.pm2 = (args) => {
		adapter.records.push(`pm2:${args.join(" ")}`);
		if (args[0] === "jlist") {
			return {
				status: 0,
				stdout: JSON.stringify([
					{ pid: 4100, name: "my-vcpdeck", pm2_env: { pm_exec_path: "C:\\ProgramData\\node.exe", args: ["--env-file=x", "C:\\Users\\x\\.vcpdeck\\launcher-client\\dist\\main.js"] } },
					{ pid: 9900, name: "other-app", pm2_env: { pm_exec_path: "C:\\other\\main.js" } },
				]),
			};
		}
		return { status: 0 };
	};
	adapter.listProcesses = () => [
		{ pid: 4100, parentPid: 100, creationDate: "launcher" },
		{ pid: 4200, parentPid: 4100, creationDate: "client" },
		{ pid: 4300, parentPid: 4200, creationDate: "worker" },
		{ pid: 9900, parentPid: 100, creationDate: "unrelated" },
	];
	adapter.killProcessTree = (tree) => adapter.records.push(`kill-tree:${tree.map((entry) => entry.pid).join(",")}`);
	const source = installer.discoverLegacyWindowsInstall(adapter, "https://deck.example.com");
	assert.equal(source.pm2Name, "my-vcpdeck");
	assert.equal(source.processRoot.pid, 4100);
	installer.cleanLegacyWindowsInstall(adapter, source);
	assert.ok(adapter.records.includes("pm2:delete my-vcpdeck"));
	assert.ok(adapter.records.includes("kill-tree:4100,4200,4300"));
	assert.ok(!adapter.records.some((record) => record.includes("9900")));
});

test("旧 Launcher PID 在清理前被复用时 fail closed，不终止新进程", () => {
	const adapter = recordingAdapter();
	let scans = 0;
	adapter.listProcesses = () => {
		scans += 1;
		return [{ pid: 4000, parentPid: 100, creationDate: scans === 1 ? "old-launcher" : "new-unrelated-process" }];
	};
	assert.throws(
		() => {
			const source = installer.discoverLegacyWindowsInstall(adapter, "https://deck.example.com");
			installer.cleanLegacyWindowsInstall(adapter, source);
		},
		/PID 已被其他进程复用/,
	);
	assert.ok(!adapter.records.some((record) => record.startsWith("pm2:delete")));
	assert.ok(!adapter.records.some((record) => record.startsWith("kill-tree:")));
});

test("同名 PM2 条目指向其他目录时不误杀，即使另有路径匹配条目也拒绝迁移", () => {
	const adapter = recordingAdapter();
	adapter.pm2 = () => ({
		status: 0,
		stdout: JSON.stringify([
			{ name: "vcpdeck-client-launcher", pm2_env: { pm_exec_path: "C:\\other\\main.js" } },
			{ name: "my-vcpdeck", pm2_env: { pm_exec_path: "C:\\Users\\x\\.vcpdeck\\launcher-client\\dist\\main.js" } },
		]),
	});
	assert.throws(
		() => installer.discoverLegacyWindowsInstall(adapter, "https://deck.example.com"),
		/多个同名 VCPDeck PM2 进程/,
	);
	assert.ok(!adapter.records.some((record) => record.startsWith("pm2:delete")));
});

test("Release 下载遇到瞬时 fetch failed 后重试", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-download-"));
	const target = join(dir, "release.zip");
	let calls = 0;
	try {
		await installer.download("https://deck.example.com/release.zip", target, null, async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("fetch failed");
			return new Response("zip", { status: 200 });
		}, async () => {});
		assert.equal(calls, 2);
		assert.equal(readFileSync(target, "utf8"), "zip");

		let bodyCalls = 0;
		await installer.download("https://deck.example.com/release.zip", target, null, async () => {
			bodyCalls += 1;
			if (bodyCalls === 1) return { ok: true, arrayBuffer: async () => { throw new TypeError("terminated"); } };
			return new Response("complete", { status: 200 });
		}, async () => {});
		assert.equal(bodyCalls, 2);
		assert.equal(readFileSync(target, "utf8"), "complete");

		let fatalCalls = 0;
		await assert.rejects(
			installer.download("https://deck.example.com/missing.zip", target, null, async () => {
				fatalCalls += 1;
				return new Response("missing", { status: 404 });
			}, async () => {}),
			/HTTP 404/,
		);
		assert.equal(fatalCalls, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
				"kill-tree:4000,4001",
				"stop-old-process-tree",
				"pm2:save",
				"save-remaining-pm2-apps",
				"pm2:jlist",
				"schtasks.exe:/Delete /TN VCPDeck PM2 Startup /F",
				"remove-old-app-dir",
				"stop-system-task-for-layout",
				"schtasks.exe:/Query /TN \\VCPDeck\\Client",
				"schtasks.exe:/End /TN \\VCPDeck\\Client",
				"install-system-layout",
				"install-release",
				"register-system-task",
				"schtasks.exe:/Create /XML C:\\ProgramData\\VCPDeck\\Client\\client-task.xml /TN \\VCPDeck\\Client /RU SYSTEM /F",
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

test("旧 PM2 查询失败时 fail closed，不得误判为无迁移源", () => {
	const adapter = recordingAdapter();
	adapter.pm2 = () => ({ status: 1, stderr: "pm2 cli missing" });
	assert.throws(
		() => installer.discoverLegacyWindowsInstall(adapter, "https://deck.example.com"),
		/无法读取 PM2 进程列表.*pm2 cli missing/,
	);
});

test("旧 PM2 删除失败时保留旧目录并停止迁移", () => {
	const adapter = recordingAdapter();
	adapter.dryRun = false;
	adapter.pm2 = (args) =>
		args[0] === "delete"
			? { status: 1, stderr: "delete failed" }
			: { status: 0, stdout: "[]" };
	assert.throws(
		() =>
			installer.cleanLegacyWindowsInstall(adapter, {
				appDir: "C:\\Users\\x\\.vcpdeck\\launcher-client",
				statePath: "C:\\Users\\x\\.vcpdeck\\client-install.json",
				hasProcess: true,
				processRoot: { pid: 4000, parentPid: 100, creationDate: "launcher" },
			}),
		/PM2 delete 失败.*delete failed/,
	);
	assert.ok(!adapter.records.includes("remove-old-app-dir"));
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
