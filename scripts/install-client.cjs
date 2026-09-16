#!/usr/bin/env node
/** VCPDeck Client 一键安装统一编排器；由平台 bootstrap 准备 Node.js 后调用。 */
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { homedir, hostname, platform, userInfo } = require("node:os");
const { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { stdin, stdout } = require("node:process");
const { createInterface } = require("node:readline/promises");

const PM2_NAME = "vcpdeck-client-launcher";
const INSTALL_STATE_VERSION = 1;

// ADR-0027：Windows 固定机器级安装根与 SYSTEM 开机任务名。
const WINDOWS_APP_DIR = "C:\\ProgramData\\VCPDeck\\Client";
const WINDOWS_CLIENT_TASK = "\\VCPDeck\\Client";
const WINDOWS_SYSTEM_SID = "S-1-5-18"; // NT AUTHORITY\SYSTEM

function parseUrl(value, label, base) {
	try {
		return base ? new URL(value, base) : new URL(value);
	} catch {
		throw new Error(`${label} 不是有效 URL`);
	}
}

function parseArgs(argv) {
	const result = {};
	for (const raw of argv) {
		const index = raw.indexOf("=");
		if (!raw.startsWith("--") || index < 3) continue;
		result[raw.slice(2, index)] = raw.slice(index + 1);
	}
	if (!/^https?:\/\/[^/]+/i.test(result["server-origin"] || "")) {
		throw new Error("--server-origin 必须是带主机名的 HTTP/HTTPS Origin");
	}
	if (result.platform !== "win-x64" && result.platform !== "linux-x64") {
		throw new Error("--platform 必须为 win-x64 或 linux-x64");
	}
	if (!result.node || !existsSync(result.node)) throw new Error("--node 不可用");
	return {
		serverOrigin: parseUrl(result["server-origin"], "--server-origin").origin,
		platform: result.platform,
		nodePath: resolve(result.node),
	};
}

function readEnv(path) {
	if (!existsSync(path)) return {};
	const result = {};
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line || line.trimStart().startsWith("#")) continue;
		const index = line.indexOf("=");
		if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
	}
	return result;
}

function normalizeOrigin(value) {
	if (!value) return null;
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function fetchJson(url, options = {}) {
	const response = await fetch(url, {
		...options,
		signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		throw new Error(
			body.message || body.code || `${url} HTTP ${response.status}`,
		);
	}
	return body;
}

async function download(url, target, expectedSha) {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(600_000),
	});
	if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	mkdirSync(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.tmp`;
	writeFileSync(temp, bytes);
	if (expectedSha && sha256(temp) !== expectedSha.toLowerCase()) {
		rmSync(temp, { force: true });
		throw new Error("下载文件 SHA-256 与 Server 声明不符");
	}
	rmSync(target, { force: true });
	require("node:fs").renameSync(temp, target);
	return target;
}

async function askConfiguration(defaultName, defaultDir) {
	if (!stdin.isTTY)
		return { name: defaultName, appDir: defaultDir, confirmed: true };
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const name =
			(await rl.question(`[vcpdeck] Client 显示名称 [${defaultName}]: `)).trim() ||
			defaultName;
		const rawDir =
			(await rl.question(`[vcpdeck] 安装目录 [${defaultDir}]: `)).trim() ||
			defaultDir;
		const appDir = resolve(rawDir.replace(/^~(?=$|[\\/])/, homedir()));
		console.log("\n[vcpdeck] 安装摘要");
		console.log(`  显示名称: ${name}`);
		console.log(`  安装目录: ${appDir}`);
		const answer = (await rl.question("  确认安装？[Y/n]: "))
			.trim()
			.toLowerCase();
		return {
			name,
			appDir,
			confirmed: answer === "" || answer === "y" || answer === "yes",
		};
	} finally {
		rl.close();
	}
}

/** 清除 Windows 只读属性：Node 写入只读文件会直接报 EPERM，旧安装可能残留该属性。 */
function clearReadOnly(path) {
	try {
		chmodSync(path, 0o600);
	} catch {}
}

/** 读取/生成 Client ID；path 缺省为旧用户级路径，迁移后权威切到 ProgramData 固定位置。 */
function ensureClientId(path = join(homedir(), ".vcpdeck", "client-id"), dryRunRoot = null) {
	if (dryRunRoot) {
		const dryPath = join(dryRunRoot, "client-id");
		let id = "";
		try {
			id = readFileSync(dryPath, "utf8").trim();
		} catch {}
		if (!id) id = randomUUID();
		return id;
	}
	const target = path;
	mkdirSync(dirname(target), { recursive: true });
	let id = "";
	if (existsSync(target)) id = readFileSync(target, "utf8").trim();
	if (!id) {
		id = randomUUID();
		clearReadOnly(target);
		writeFileSync(target, id, { mode: 0o600 });
	}
	return id;
}

function writeLauncherEnv(appDir, serverOrigin, psk, clientId) {
	const path = join(appDir, "launcher.env");
	const content = [
		"# 由 VCPDeck Client 一键安装器生成（敏感值请妥善保管）",
		`VCPDECK_APP_DIR=${appDir}`,
		"VCPDECK_ARTIFACT=client",
		`VCPDECK_SERVER=${serverOrigin}`,
		`VCPDECK_PSK=${psk}`,
		`VCPDECK_CLIENT_ID=${clientId}`,
		"",
	].join("\n");
	mkdirSync(appDir, { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, { mode: 0o600 });
	if (platform() !== "win32") chmodSync(temp, 0o600);
	rmSync(path, { force: true });
	require("node:fs").renameSync(temp, path);
	return path;
}

// Windows 上禁止无 shell 直接 spawn .cmd/.bat（Node 18.20+ 返回 EINVAL），
// 因此优先返回 npm-cli.js，由调用方用 nodePath 执行。
function npmPath(nodePath) {
	const candidates =
		platform() === "win32"
			? [
					join(dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
					join(dirname(nodePath), "npm.cmd"),
				]
			: [
					join(dirname(nodePath), "npm"),
					join(
						dirname(nodePath),
						"..",
						"lib",
						"node_modules",
						"npm",
						"bin",
						"npm-cli.js",
					),
				];
	return candidates.find(existsSync) || "npm";
}

function findCommand(name) {
	const probe = spawnSync(
		platform() === "win32" ? "where.exe" : "which",
		[name],
		{ encoding: "utf8" },
	);
	return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : null;
}

/** 尝试多个 registry 安装 PM2；瞬时失败重试一次，并保留最近一次真实错误用于诊断。 */
function installPm2Retry(registries, install, log = console.log) {
	let lastError = "";
	for (const registry of registries) {
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			log(
				`[vcpdeck] 尝试 PM2 registry: ${registry}${attempt > 1 ? `（第 ${attempt} 次）` : ""}`,
			);
			const result = install(registry);
			if (result.ok) return { ok: true };
			if (result.stderr?.trim()) lastError = result.stderr.trim();
		}
	}
	return { ok: false, lastError };
}

/** 把全局 pm2.cmd 解析为可用 node 执行的 pm2 入口；解析失败返回 null。 */
function resolveGlobalPm2(existing, nodePath) {
	if (!existing || !/\.cmd$/i.test(existing)) {
		return existing ? { command: existing, argsPrefix: [] } : null;
	}
	// pm2 包的真实入口是 bin/pm2（带 shebang 的 JS，可由 node 直接执行）
	const cli = join(dirname(existing), "node_modules", "pm2", "bin", "pm2");
	// Windows 上无 shell 直接执行 .cmd 会 EINVAL；解析不到入口时返回 null，
	// 由调用方回退到私有安装。
	return existsSync(cli) ? { command: nodePath, argsPrefix: [cli] } : null;
}

/** 确保 npm 与其子进程可通过 env 找到安装器选定的私有 Node.js。 */
function buildNodeRuntimeEnv(nodePath, baseEnv = process.env) {
	const pathKey =
		Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") || "PATH";
	const currentPath = baseEnv[pathKey] || "";
	return {
		...baseEnv,
		[pathKey]: [dirname(nodePath), currentPath].filter(Boolean).join(delimiter),
	};
}

function ensurePm2(nodePath, registries) {
	const existing = resolveGlobalPm2(
		findCommand(platform() === "win32" ? "pm2.cmd" : "pm2"),
		nodePath,
	);
	if (existing) return existing;
	const toolRoot = join(homedir(), ".vcpdeck", "tools", "pm2");
	const cli = join(toolRoot, "node_modules", "pm2", "bin", "pm2");
	if (!existsSync(cli)) {
		mkdirSync(toolRoot, { recursive: true });
		writeFileSync(
			join(toolRoot, "package.json"),
			JSON.stringify({ private: true }, null, 2),
		);
		const npm = npmPath(nodePath);
		const command = npm.endsWith(".js") ? nodePath : npm;
		const prefix = npm.endsWith(".js") ? [npm] : [];
		const result = installPm2Retry(registries, (registry) => {
			const out = spawnSync(
				command,
				[
					...prefix,
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					`--registry=${registry}`,
					"pm2@7.0.3",
				],
				{
					cwd: toolRoot,
					encoding: "utf8",
					env: buildNodeRuntimeEnv(nodePath),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const ok = out.status === 0 && existsSync(cli);
			if (ok && out.stdout) console.log(out.stdout.trimEnd());
			// 失败时保留真实输出与启动错误，便于区分网络、npm 配置和无法启动问题
			return {
				ok,
				stderr: ok
					? ""
					: `${out.error?.message || ""}${out.stdout || ""}${out.stderr || ""}`,
			};
		});
		if (!result.ok) {
			const detail = result.lastError
				.split(/\r?\n/)
				.filter(Boolean)
				.slice(-3)
				.join(" | ");
			throw new Error(
				`国内与官方 registry 均无法安装 PM2${detail ? `；最近错误: ${detail}` : ""}`,
			);
		}
	}
	return { command: nodePath, argsPrefix: [cli] };
}

function runPm2(pm2, args, options = {}) {
	const result = spawnSync(pm2.command, [...pm2.argsPrefix, ...args], {
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		...options,
	});
	if (result.status !== 0)
		throw new Error(
			`PM2 ${args[0]} 失败${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
		);
	return result.stdout || "";
}

function writeEcosystem(appDir, nodePath, envPath) {
	const envLoaderPath = join(appDir, "launcher-env.cjs");
	const envLoader = `// 由 VCPDeck Client 一键安装器生成；launcher.env 是配置权威。\nfor (const key of Object.keys(process.env)) {\n  if (key.startsWith("VCPDECK_")) delete process.env[key];\n}\nprocess.loadEnvFile(${JSON.stringify(envPath)});\n`;
	writeFileSync(envLoaderPath, envLoader);

	const path = join(appDir, "ecosystem.config.cjs");
	const runtimeEnv = buildNodeRuntimeEnv(nodePath, { PATH: process.env.PATH || "" });
	const config = `module.exports = ${JSON.stringify(
		{
			apps: [
				{
					name: PM2_NAME,
					script: join(appDir, "dist", "main.js"),
					interpreter: nodePath,
					// preload 先清除 PM2 缓存值，再主动读取 launcher.env；不依赖
					// Node --env-file（不会覆盖同名变量）的默认优先级。
					node_args: [`--require=${envLoaderPath}`],
					// 同时阻止 PM2 在新建进程时继承安装器自身的 VCPDeck 配置。
					filter_env: ["VCPDECK_"],
					env: runtimeEnv,
					cwd: appDir,
					autorestart: true,
					restart_delay: 2000,
					kill_timeout: 15000,
					windowsHide: true,
				},
			],
		},
		null,
		2,
	)};\n`;
	writeFileSync(path, config);
	return path;
}

function powershellQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function defaultPowerShellPath() {
	return join(
		process.env.SystemRoot || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}

/**
 * 读取计划任务定义 XML。
 * `schtasks /XML` 声明 UTF-16 但实际按控制台代码页输出单字节，Node 按 utf16le 解码必然乱码；
 * 改用 PowerShell 的 Export-ScheduledTask 并以 base64 回传，避免任何代码页歧义。
 */
function readWindowsTaskXml(taskName, spawn = spawnSync) {
	const script =
		"$ErrorActionPreference='Stop';" +
		`$xml = Export-ScheduledTask -TaskName ${powershellQuote(taskName)};` +
		"[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xml))";
	const result = spawn(
		defaultPowerShellPath(),
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ encoding: "utf8", windowsHide: true },
	);
	const encoded = String(result.stdout || "").trim();
	if (result.status !== 0 || !encoded) return null;
	return Buffer.from(encoded, "base64").toString("utf8");
}

/** 生成稳定的 Windows 登录任务：直接运行 Node，避免 `.cmd` Action 的引号歧义。 */
function buildWindowsStartupTaskScript(definition) {
	const args = `--require="${definition.probePath}" "${definition.pm2Path}" resurrect`;
	return [
		`$action = New-ScheduledTaskAction -Execute ${powershellQuote(definition.nodePath)} -Argument ${powershellQuote(args)} -WorkingDirectory ${powershellQuote(definition.appDir)}`,
		`$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${powershellQuote(definition.userSid)}`,
		"$trigger.Delay = 'PT10S'",
		`$principal = New-ScheduledTaskPrincipal -UserId ${powershellQuote(definition.userSid)} -LogonType Interactive -RunLevel Highest`,
		"$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew",
		`Register-ScheduledTask -TaskName ${powershellQuote(definition.taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
	].join("\r\n");
}

/** 判断既有任务是否属于当前安装，以及是否完全满足最高权限登录恢复约束。 */
function classifyWindowsStartupTask(xml, expected) {
	const source = String(xml);
	const normalized = source.replace(/\\/g, "/").toLowerCase();
	const appDir = expected.appDir.replace(/\\/g, "/").toLowerCase();
	const workingDirectory = source.match(/<WorkingDirectory>([\s\S]*?)<\/WorkingDirectory>/i)?.[1]
		?.replace(/\\/g, "/")
		.toLowerCase();
	const legacyCommand = source
		.match(/<Command>([\s\S]*?)<\/Command>/i)?.[1]
		?.replace(/&quot;|"/gi, "")
		.replace(/\\/g, "/")
		.trim()
		.toLowerCase();
	if (
		(workingDirectory && workingDirectory !== appDir) ||
		(legacyCommand?.endsWith("pm2-resurrect.cmd") && !legacyCommand.startsWith(`${appDir}/`))
	) {
		return "conflict";
	}
	if (!normalized.includes(appDir)) return "conflict";
	const required = [
		expected.nodePath,
		expected.pm2Path,
		expected.appDir,
		expected.userSid,
		expected.probePath,
	].map((value) => value.replace(/\\/g, "/").toLowerCase());
	return required.every((value) => normalized.includes(value)) &&
		/<runlevel>\s*highestavailable\s*<\/runlevel>/i.test(xml) &&
		/<logontype>\s*interactivetoken\s*<\/logontype>/i.test(xml) &&
		/<delay>\s*pt10s\s*<\/delay>/i.test(xml) &&
		/<disallowstartifonbatteries>\s*false\s*<\/disallowstartifonbatteries>/i.test(xml) &&
		/<stopifgoingonbatteries>\s*false\s*<\/stopifgoingonbatteries>/i.test(xml) &&
		/<startwhenavailable>\s*true\s*<\/startwhenavailable>/i.test(xml)
		? "configured"
		: "repair";
}

/** 通过一次 UAC 注册最高权限计划任务；取消或失败即安装失败。捕获子进程真实错误日志以供诊断。 */
function registerStartupTask(
	definition,
	startPwsh = (args) =>
		spawnSync(defaultPowerShellPath(), args, { encoding: "utf8", windowsHide: true }),
) {
	const pwshExe = defaultPowerShellPath();
	const errLog = join(definition.appDir, "startup-task-error.log");
	rmSync(errLog, { force: true });
	const rawPayload = [
		"$ErrorActionPreference = 'Stop'",
		"try {",
		`  ${buildWindowsStartupTaskScript(definition).split("\r\n").join("\r\n  ")}`,
		"} catch {",
		"  $err = \"$($_.Exception.Message)`n$($_.ScriptStackTrace)\"",
		`  [System.IO.File]::WriteAllText(${powershellQuote(errLog)}, $err, [System.Text.Encoding]::UTF8)`,
		"  exit 1",
		"}",
	].join("\r\n");
	const encoded = Buffer.from(rawPayload, "utf16le").toString("base64");
	const parentCommand =
		`try { ` +
		`$p = Start-Process -FilePath ${powershellQuote(pwshExe)} -Verb RunAs -Wait -PassThru ` +
		`-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode ` +
		`} catch { ` +
		`[System.IO.File]::WriteAllText(${powershellQuote(errLog)}, $_.Exception.Message, [System.Text.Encoding]::UTF8); exit 1 ` +
		`}`;
	const result = startPwsh(["-NoProfile", "-NonInteractive", "-Command", parentCommand]);
	if (result.status !== 0) {
		let detail = "";
		try {
			detail = readFileSync(errLog, "utf8").trim();
		} catch {}
		throw new Error(
			`Windows 自启动任务注册失败或 UAC 被取消${detail ? `：${detail}` : ""}`,
		);
	}
	console.log(`[vcpdeck] 已通过 UAC 注册最高权限登录自启动（${definition.taskName}）`);
	return "windows-logon-task(via-uac)";
}

/** bootstrap 预探测提升状态（whoami 无 shell 调用），供 Node 侧独立复核；探测失败即非合规。 */
function readWindowsElevationIdentity() {
	try {
		const whoami = join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
		const user = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
		const groups = spawnSync(whoami, ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" });
		return {
			administrator: user.status === 0 && groups.status === 0 && /S-1-5-32-544/i.test(groups.stdout || ""),
			highIntegrity: /S-1-16-(12288|16384)/i.test(groups.stdout || ""),
		};
	} catch {
		return { administrator: false, highIntegrity: false };
	}
}

function windowsIdentity() {
	const whoami = join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
	const user = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
	const groups = spawnSync(whoami, ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" });
	const sid = user.stdout?.match(/S-1-5-[\d-]+/i)?.[0];
	if (user.status !== 0 || groups.status !== 0 || !sid) {
		throw new Error("无法读取当前 Windows 用户 SID 与管理员组信息");
	}
	if (!/S-1-5-32-544/i.test(groups.stdout)) {
		throw new Error("Windows Client 必须由本机 Administrators 组成员安装");
	}
	return { sid, whoami };
}

function writeWindowsStartupProbe(appDir, whoamiPath) {
	const path = join(appDir, "startup-probe.cjs");
	const statusPath = join(appDir, "startup-status.json");
	const logPath = join(appDir, "startup.log");
	writeFileSync(path, `const { appendFileSync, writeFileSync } = require("node:fs");\nconst { spawnSync } = require("node:child_process");\nconst statusPath = ${JSON.stringify(statusPath)};\nconst logPath = ${JSON.stringify(logPath)};\nconst result = spawnSync(${JSON.stringify(whoamiPath)}, ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" });\nconst highIntegrity = /S-1-16-(12288|16384)/i.test(result.stdout || "");\nconst write = (success, exitCode) => {\n  const status = { at: new Date().toISOString(), highIntegrity, success, exitCode };\n  writeFileSync(statusPath, JSON.stringify(status));\n  appendFileSync(logPath, JSON.stringify(status) + "\\n");\n};\nwrite(false, null);\nif (!highIntegrity) { write(false, 1); throw new Error("VCPDeck startup requires a high-integrity administrator token"); }\nprocess.once("exit", (code) => write(code === 0, code));\n`);
	return { path, statusPath };
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function configureStartup(pm2, nodePath, appDir) {
	if (platform() === "win32") {
		const wrapper = join(appDir, "pm2-resurrect.cmd");
		writeFileSync(
			wrapper,
			`@echo off\r\n"${pm2.command}" ${pm2.argsPrefix.map((v) => `"${v}"`).join(" ")} resurrect\r\n`,
		);
		const pm2Path = pm2.argsPrefix[0];
		if (pm2.command !== nodePath || !pm2Path) {
			throw new Error("Windows 自启动要求可由安装器 Node 直接执行的 PM2 CLI");
		}
		const identity = windowsIdentity();
		const probe = writeWindowsStartupProbe(appDir, identity.whoami);
		const definition = {
			taskName: "VCPDeck PM2 Startup",
			nodePath,
			pm2Path,
			appDir,
			userSid: identity.sid,
			probePath: probe.path,
		};
		const existing = readWindowsTaskXml(definition.taskName);
		if (existing === null) registerStartupTask(definition);
		else {
			const state = classifyWindowsStartupTask(existing, definition);
			if (state === "conflict") {
				throw new Error(`Windows 计划任务 ${definition.taskName} 已存在但指向其他安装目录`);
			}
			if (state === "repair") registerStartupTask(definition);
		}

		const verified = readWindowsTaskXml(definition.taskName);
		if (verified === null || classifyWindowsStartupTask(verified, definition) !== "configured") {
			throw new Error("Windows 自启动任务定义验收失败");
		}
		const processes = JSON.parse(runPm2(pm2, ["jlist"], { capture: true }));
		if (processes.some((entry) => entry.name !== PM2_NAME)) {
			throw new Error("当前 PM2 daemon 还管理其他应用，拒绝为提权而重启");
		}
		runPm2(pm2, ["kill"]);
		rmSync(probe.statusPath, { force: true });
		execFileSync("schtasks.exe", ["/Run", "/TN", definition.taskName], { stdio: "inherit" });
		const deadline = Date.now() + 30_000;
		let status;
		while (Date.now() < deadline) {
			try {
				status = JSON.parse(readFileSync(probe.statusPath, "utf8"));
			} catch {}
			if (status?.success && status.highIntegrity) break;
			sleepSync(500);
		}
		if (!status?.success || !status.highIntegrity) {
			throw new Error("Windows 自启动任务未能以高完整性令牌恢复 PM2");
		}
		const launcher = pm2Process(pm2);
		if (launcher?.pm2_env?.status !== "online") {
			throw new Error("Windows 自启动任务未能恢复 PM2 Launcher");
		}
		return "windows-logon-task";
	}
	const username = userInfo().username;
	const service = `pm2-${username}.service`;
	const enabled = spawnSync("systemctl", ["is-enabled", service], {
		encoding: "utf8",
	});
	if (enabled.status !== 0) {
		const args = [
			...pm2.argsPrefix,
			"startup",
			"systemd",
			"-u",
			username,
			"--hp",
			homedir(),
		];
		execFileSync("sudo", [pm2.command, ...args], {
			stdio: "inherit",
			env: {
				...process.env,
				PATH: `${dirname(nodePath)}:${process.env.PATH || ""}`,
			},
		});
	}
	const verified = spawnSync("systemctl", ["is-enabled", service], {
		encoding: "utf8",
	});
	if (verified.status !== 0) throw new Error(`systemd 服务 ${service} 未启用`);
	return service;
}

function pm2Process(pm2) {
	const json = runPm2(pm2, ["jlist"], { capture: true });
	try {
		return JSON.parse(json).find((entry) => entry.name === PM2_NAME) || null;
	} catch {
		return null;
	}
}

/**
 * 校验当前 PowerShell 已提升：必须同时是本机 Administrators 成员且持有高完整性令牌；
 * 不满足立即失败，脚本不申请 UAC（ADR-0027）。identity 由 bootstrap 预探测后传入，
 * 也可注入 probe 供测试使用。
 */
function assertElevatedWindowsIdentity(identity) {
	if (identity && identity.__fromProbe) {
		const probe = identity.probe || (() => ({ administrator: false, highIntegrity: false }));
		identity = probe();
	}
	if (!identity || identity.administrator !== true || identity.highIntegrity !== true) {
		throw new Error("请以管理员身份运行 PowerShell 后重跑本命令（脚本不申请 UAC）");
	}
}

/** 生成固定 SYSTEM 开机任务 XML：S-1-5-18、Highest、BootTrigger、失败重启 1 分钟×999。 */
function buildWindowsSystemTaskXml(definition) {
	const nodePath = String(definition.nodePath).replace(/&/g, "&amp;");
	const launcherPath = String(definition.launcherPath).replace(/&/g, "&amp;");
	const appDir = String(definition.appDir).replace(/&/g, "&amp;");
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>VCPDeck Client Launcher (system, ADR-0027)</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT15S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="VCPDeckSystem">
      <UserId>${WINDOWS_SYSTEM_SID}</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowHardTerminate>true</AllowHardTerminate>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="VCPDeckSystem">
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>"${launcherPath}"</Arguments>
      <WorkingDirectory>${appDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** 判断既有 SYSTEM 任务：null→missing；匹配→configured；设置漂移→repair；指向他处→conflict。 */
function classifyWindowsSystemTask(xml, expected) {
	if (!xml || !String(xml).includes(`<UserId>${WINDOWS_SYSTEM_SID}</UserId>`)) {
		return xml ? "conflict" : "missing";
	}
	const source = String(xml);
	const normalized = source.replace(/\\/g, "/").toLowerCase();
	const appDir = String(expected.appDir).replace(/\\/g, "/").toLowerCase();
	const workingDirectory = source.match(/<WorkingDirectory>([\s\S]*?)<\/WorkingDirectory>/i)?.[1]
		?.replace(/\\/g, "/")
		.toLowerCase();
	const command = source.match(/<Command>([\s\S]*?)<\/Command>/i)?.[1]
		?.replace(/\\/g, "/")
		.trim()
		.toLowerCase();
	if (workingDirectory && workingDirectory !== appDir) return "conflict";
	if (command && !command.includes(appDir)) return "conflict";
	const required = [expected.nodePath, expected.launcherPath, expected.appDir]
		.map((value) => String(value).replace(/\\/g, "/").toLowerCase());
	if (!required.every((value) => normalized.includes(value))) return "conflict";
	const settingsOk =
		!/<logontype>/i.test(source) &&
		/<runlevel>\s*highestavailable\s*<\/runlevel>/i.test(source) &&
		/<boottrigger>/i.test(source) &&
		/<delay>\s*pt15s\s*<\/delay>|<delayedtriggerduration>\s*pt15s\s*<\/delayedtriggerduration>/i.test(source) &&
		/<disallowstartifonbatteries>\s*false\s*<\/disallowstartifonbatteries>/i.test(source) &&
		/<stopifgoingonbatteries>\s*false\s*<\/stopifgoingonbatteries>/i.test(source) &&
		/<startwhenavailable>\s*true\s*<\/startwhenavailable>/i.test(source) &&
		/<multipleinstancespolicy>\s*ignorenew\s*<\/multipleinstancespolicy>/i.test(source) &&
		/<executiontimelimit>\s*pt0s\s*<\/executiontimelimit>/i.test(source) &&
		/<restartonfailure>/i.test(source);
	return settingsOk ? "configured" : "repair";
}

/** 发现机器级 Git（机器 PATH、App Paths、标准安装目录）；用户私有 Git 视为不可用（ADR-0027）。 */
function findMachineGit(env = {}) {
	const exists = env.exists || ((p) => existsSync(p));
	const machinePath = (env.env?.PATH || process.env.PATH || "").split(delimiter).filter(Boolean);
	for (const dir of machinePath) {
		const candidate = join(dir, "git.exe");
		if (/^([a-z]:[\/\\]|\\\\|[a-z]:[\/\\]\\ini)/i.test(dir) && exists(candidate)) return candidate;
	}
	const appPaths = env.appPaths ? env.appPaths() : null;
	if (appPaths && typeof appPaths === "string" && exists(appPaths)) return appPaths;
	for (const candidate of [
		"C:\\Program Files\\Git\\cmd\\git.exe",
		"C:\\Program Files (x86)\\Git\\cmd\\git.exe",
	]) {
		if (exists(candidate)) return candidate;
	}
	return null;
}

/** Git 为可选工具：缺失时尝试机器级 winget 安装，任何失败只警告、不阻断 Client 安装。 */
function ensureOptionalMachineGit(env = {}) {
	const git = env.findGit ? env.findGit() : findMachineGit(env);
	if (git) return { git, warning: null };
	const spawn = env.spawn || ((command, args) => spawnSync(command, args, { encoding: "utf8", windowsHide: true }));
	let result;
	try {
		result = spawn("winget.exe", [
			"install",
			"--id",
			"Git.Git",
			"--exact",
			"--scope",
			"machine",
			"--silent",
			"--accept-package-agreements",
			"--accept-source-agreements",
		]);
	} catch {
		return { git: null, warning: "未找到 winget，跳过机器级 Git 安装（不影响 Client 核心能力）" };
	}
	if (!result || result.status !== 0) {
		return { git: null, warning: "机器级 Git 安装失败（不影响 Client 核心能力，可稍后手动安装）" };
	}
	const installed = env.findGit ? env.findGit() : findMachineGit(env);
	return installed ? { git: installed, warning: null } : { git: null, warning: "winget 报告成功但 Git 校验失败（不影响 Client 核心能力）" };
}

/** 探测当前提升管理员的旧用户安装来源；只接受单一、路径已确认、同 Server 的来源（fail closed）。 */
function discoverLegacyWindowsInstall(adapter, serverOrigin) {
	// home 可注入（测试用）；生产取真实用户 HOME，旧来源仅限当前提升管理员所属 Profile。
	const home = typeof adapter.home === "string" && adapter.home ? adapter.home : homedir();
	const statePath = join(home, ".vcpdeck", "client-install.json");
	const state = adapter.dryRun ? adapter.readJson(statePath) : safeReadJson(statePath);
	if (!state || typeof state !== "object") return null;
	const appDirRaw = typeof state.appDir === "string" ? state.appDir : null;
	const appDir = appDirRaw ? resolve(appDirRaw) : null;
	const env = appDir ? adapter.readEnv(join(appDir, "launcher.env")) : {};
	const expectedLauncher = appDir ? resolve(join(appDir, "dist", "main.js")) : null;
	const origin = normalizeOrigin(env.VCPDECK_SERVER || state.serverOrigin);
	const entries = [];
	try {
		const list = JSON.parse(adapter.pm2(["jlist"])?.stdout || "[]");
		if (Array.isArray(list)) {
			for (const entry of list) {
				if (entry?.name === PM2_NAME) entries.push(entry);
			}
		}
	} catch {
		throw new Error("无法读取 PM2 进程列表，拒绝迁移");
	}
	if (!origin || origin !== serverOrigin) {
		throw new Error(`旧 Client 指向其他 Server（${origin || "未知"}），拒绝迁移`);
	}
	const appDirNormalized = (appDir || "").replace(/\\/g, "/");
	const homeBase = join(home, ".vcpdeck").replace(/\\/g, "/");
	if (!appDir || !appDirNormalized.startsWith(`${homeBase}/`)) {
		throw new Error("旧安装目录不在用户 .vcpdeck 下，拒绝迁移");
	}
	if (!state.clientId || !/^[0-9a-f-]{36}$/i.test(state.clientId)) {
		throw new Error("旧 Client ID 缺失或非法，拒绝迁移");
	}
	if (entries.length > 1) throw new Error("发现多个同名 VCPDeck PM2 进程，拒绝迁移");
	if (entries.length === 1) {
		const actual = resolve(entries[0]?.pm2_env?.pm_exec_path || "");
		if (!expectedLauncher || actual !== expectedLauncher) {
			throw new Error(`PM2 中同名进程指向未知目录（${actual || "未知"}），拒绝迁移`);
		}
	}
	return {
		statePath,
		appDir,
		clientId: state.clientId,
		displayName: typeof state.displayName === "string" ? state.displayName : null,
		hasProcess: entries.length === 1,
		serverOrigin: origin,
	};
}

function safeReadJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** 清理已确认的旧 VCPDeck PM2 现场；不删除用户 PM2/Node/个人文件（ADR-0027）。 */
function cleanLegacyWindowsInstall(adapter, source) {
	const record = (name) => adapter.records.push(name);
	record("stop-old-launcher");
	if (source.hasProcess) {
		adapter.pm2(["delete", PM2_NAME]);
		record("delete-old-pm2-entry");
		adapter.pm2(["save"]);
		record("save-remaining-pm2-apps");
		const remaining = safeReadJsonSafePm2(adapter);
		if (!remaining) {
			const removedTask = adapter.spawn("schtasks.exe", ["/Delete", "/TN", "VCPDeck PM2 Startup", "/F"]);
			if (removedTask.status === 0) record("remove-old-startup");
		}
	} else if (adapter.dryRun === false) {
		// 非 dry-run 且无进程：只删除已确认的旧任务，其他 PM2 应用保留。
		const taskXml = readWindowsTaskXml("VCPDeck PM2 Startup");
		if (taskXml === null) {
			const existing = adapter.spawn("schtasks.exe", ["/Query", "/TN", "VCPDeck PM2 Startup"]);
			if (existing.status === 0) throw new Error("无法读取旧计划任务定义，拒绝删除");
		} else if (taskXml.replace(/\\/g, "/").toLowerCase().includes(source.appDir.replace(/\\/g, "/").toLowerCase())) {
			adapter.spawn("schtasks.exe", ["/Delete", "/TN", "VCPDeck PM2 Startup", "/F"]);
			record("remove-old-startup");
		}
	}
	record("remove-old-app-dir");
	if (!adapter.dryRun) {
		rmSync(source.appDir, { recursive: true, force: true });
		try {
			rmSync(source.statePath, { force: true });
		} catch {
			// 状态文件可保留：身份权威已切到 ProgramData。
		}
	}
}

function safeReadJsonSafePm2(adapter) {
	try {
		const list = JSON.parse(adapter.pm2(["jlist"])?.stdout || "[]");
		if (!Array.isArray(list)) return [];
		return list.filter((entry) => entry?.name !== PM2_NAME);
	} catch {
		return [];
	}
}

/**
 * Windows 一键安装（ADR-0027）：先准备并校验全部材料，再清理旧 PM2 现场，
 * 最后安装 SYSTEM 开机任务并验收 Client 真实 SYSTEM 身份。
 * adapter 可注入（dryRun 时不真实落盘/执行命令），供测试验证顺序与 fail closed。
 */
async function runWindowsInstall(options) {
		const { adapter, args, bootstrap, preflight, fetchJson: fetchJsonImpl, download: downloadImpl } = options;
		const dryRun = adapter?.dryRun === true;
		const fetchJsonCall = fetchJsonImpl || fetchJson;
		const downloadCall = downloadImpl || download;
		const record = (name) => adapter?.records?.push(name);

		// 阶段 1：旧来源校验（单一、同 Server、路径已确认），失败即停止。
		record("validate-source");
		const legacy = discoverLegacyWindowsInstall(adapter, args.serverOrigin);

		// 阶段 2：固定机器级布局与私有 Node 就绪。
		adapter.mkdir(WINDOWS_APP_DIR);
		record("prepare-runtime");
		const nodeExe = resolve(args.nodePath || "");
		const runtimeRoot = resolve(WINDOWS_APP_DIR, "runtime", "node");
		const nodeRelative = relative(runtimeRoot, nodeExe);
		if (
			!nodeRelative ||
			nodeRelative === ".." ||
			nodeRelative.startsWith(`..${sep}`) ||
			isAbsolute(nodeRelative)
		) {
			throw new Error("ProgramData 私有 Node.js 路径无效，请重跑安装命令");
		}
		if (!adapter.probe(nodeExe)) throw new Error("ProgramData 私有 Node.js 未就绪，请重跑安装命令");

		// 阶段 3：下载并校验 Release 与低层安装器（清理前全部材料就绪）。
		record("prepare-archive");
		const cacheRoot = args["cache-dir"] || join(homedir(), ".vcpdeck", "cache");
		const cache = join(cacheRoot, `vcpdeck-${bootstrap.releaseVersion}-win-x64.zip`);
		if (!adapter.probe(cache)) {
			await downloadCall(
				new URL(bootstrap.archiveUrl, args.serverOrigin).href,
				cache,
				bootstrap.archiveSha256,
			);
		}
		const lowInstaller = join(cacheRoot, "install.cjs");
		if (!adapter.probe(lowInstaller)) {
			await downloadCall(
				new URL(preflight.lowLevelInstallerUrl, args.serverOrigin).href,
				lowInstaller,
				preflight.lowLevelInstallerSha256,
			);
		}
		record("validate-archive");

		// 阶段 4：清理旧 PM2 现场（材料全部就绪后）。
		if (legacy) cleanLegacyWindowsInstall(adapter, legacy);

		// 阶段 5：全新系统级安装（固定布局，敏感文件收紧 ACL）。
		record("install-system-layout");
		// 必须先重建安装根的可继承授权：0.8.7 之前写入的不可继承 ACE 会让既有子对象
		// （client-id、launcher.env 等）失去全部 ACE 而无法读写；设根 ACE 后由内核传播到既有子对象。
		adapter.icacls(WINDOWS_APP_DIR, { directory: true });
		// 既有文件可能被旧版本改成只读或写入不可继承 ACL：先恢复可写与访问，再读取身份与写入环境。
		for (const name of ["client-id", "launcher.env", "install-state.json"]) {
			const existing = join(WINDOWS_APP_DIR, name);
			if (!adapter.probe(existing)) continue;
			adapter.icacls(existing);
			clearReadOnly(existing);
		}
		// 阶段 5.1：铺设发布物（<appDir>/dist/main.js 与 apps/<版本>/client）。
		// 缺少这一步时 SYSTEM 任务没有可执行入口，只会表现为“未在超时内上线”。
		record("install-release");
		if (!dryRun) {
			console.log(`[vcpdeck] 铺设 Client 发布物 ${bootstrap.releaseVersion}`);
			const lay = adapter.spawn(nodeExe, [
				lowInstaller,
				"--artifact=client",
				`--zip=${cache}`,
				`--version=${bootstrap.releaseVersion}`,
				`--app-dir=${WINDOWS_APP_DIR}`,
				`--sha256=${bootstrap.archiveSha256}`,
				"--no-env",
				"--force",
			]);
			if (lay.status !== 0) {
				throw new Error(`铺设发布物失败：${lay.stderr || `退出码 ${lay.status}`}`);
			}
		}
		for (const entry of [
			join(WINDOWS_APP_DIR, "dist", "main.js"),
			join(WINDOWS_APP_DIR, "apps", bootstrap.releaseVersion, "client", "dist", "index.js"),
		]) {
			if (!adapter.probe(entry)) throw new Error(`发布物缺失：${entry}`);
		}
		const displayName = (typeof args.name === "string" && args.name) || legacy?.displayName || hostname();
		const clientId = legacy?.clientId || ensureClientId(join(WINDOWS_APP_DIR, "client-id"), dryRun ? cacheRoot : null);
		const envContent = [
			"# 由 VCPDeck Client 一键安装器生成（敏感值请妥善保管）",
			`VCPDECK_APP_DIR=${WINDOWS_APP_DIR}`,
			"VCPDECK_ARTIFACT=client",
			`VCPDECK_SERVER=${args.serverOrigin}`,
			`VCPDECK_PSK=${bootstrap.psk}`,
			`VCPDECK_CLIENT_ID=${clientId}`,
			"VCPDECK_INSTALLATION_MODE=windows-system-task",
			"",
		].join("\n");
		const envPath = join(WINDOWS_APP_DIR, "launcher.env");
		if (dryRun) adapter.writeFile(envContent, envPath);
		else writeFileSync(envPath, envContent, { mode: 0o600 });
		adapter.icacls(envPath);
		const state = {
			version: INSTALL_STATE_VERSION,
			serverOrigin: args.serverOrigin,
			appDir: WINDOWS_APP_DIR,
			displayName,
			clientId,
			stage: "install",
			releaseVersion: bootstrap.releaseVersion,
			startup: `scheduled-task:${WINDOWS_CLIENT_TASK}`,
		};
		const statePath = join(WINDOWS_APP_DIR, "install-state.json");
		if (dryRun) adapter.writeFile(JSON.stringify(state), statePath);
		else writeFileSync(statePath, JSON.stringify(state, null, 2));

		// 阶段 6：注册并启动 SYSTEM 开机任务。
		record("register-system-task");
		const taskXml = buildWindowsSystemTaskXml({
			nodePath: nodeExe,
			launcherPath: join(WINDOWS_APP_DIR, "dist", "main.js"),
			appDir: WINDOWS_APP_DIR,
		});
		const xmlPath = join(WINDOWS_APP_DIR, "client-task.xml");
		if (dryRun) adapter.writeFile(taskXml, xmlPath);
		else writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, "utf16le")]));
		const create = adapter.spawn("schtasks.exe", ["/Create", "/XML", xmlPath, "/TN", WINDOWS_CLIENT_TASK, "/RU", "SYSTEM", "/F"]);
		if (create.status !== 0) throw new Error(`SYSTEM 开机任务注册失败：${create.stderr || `退出码 ${create.status}`}`);
		adapter.spawn("schtasks.exe", ["/Query", "/TN", WINDOWS_CLIENT_TASK]);
		adapter.spawn("schtasks.exe", ["/Run", "/TN", WINDOWS_CLIENT_TASK]);
		record("start-system-task");

		// 阶段 7：验收 Client 以新安装模式与 SYSTEM 身份真实上线。
		record("verify-system-client");
		const status = await waitForClient(args.serverOrigin, clientId, bootstrap.psk, bootstrap.releaseVersion, displayName, bootstrap.verificationTimeoutMs || 120_000, fetchJsonCall);
		if (!status || status.installationMode !== "windows-system-task" || status.privilegedMode !== "windows-system") {
			throw new Error(`Client 未通过系统级验收（安装模式=${status?.installationMode || "未报告"}，特权=${status?.privilegedMode || "未报告"}）`);
		}
		state.stage = "done";
		state.completedAt = new Date().toISOString();
		if (dryRun) adapter.writeFile(JSON.stringify(state), statePath);
		else writeFileSync(statePath, JSON.stringify(state, null, 2));

		// Git 为可选机器级工具，失败只警告。
		const gitResult = ensureOptionalMachineGit({});
		if (gitResult.warning) console.warn(`[vcpdeck] ${gitResult.warning}`);

		console.log(`\n[vcpdeck] 安装成功: ${displayName} (${clientId})`);
		console.log(`  版本: ${bootstrap.releaseVersion}`);
		console.log(`  系统任务: ${WINDOWS_CLIENT_TASK}（NT AUTHORITY\\SYSTEM 开机自启）`);
		console.log(`  安装根: ${WINDOWS_APP_DIR}`);
}

async function waitForClient(origin, clientId, psk, version, name, timeoutMs, fetchJsonImpl) {
	const fetchJsonRef = fetchJsonImpl || fetchJson;
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		try {
			last = await fetchJsonRef(
				`${origin}/api/client-installer/clients/${encodeURIComponent(clientId)}/status`,
				{
					headers: { "x-vcpdeck-psk": psk },
					timeoutMs: 15_000,
				},
			);
			if (
				last.registered &&
				last.online &&
				last.clientVersion === version &&
				last.capabilitiesReported
			) {
				if (last.name !== name) {
					await fetchJsonRef(
						`${origin}/api/client-installer/clients/${encodeURIComponent(clientId)}/name`,
						{
							method: "PUT",
							headers: { "content-type": "application/json", "x-vcpdeck-psk": psk },
							body: JSON.stringify({ name }),
							timeoutMs: 15_000,
						},
					);
				}
				return last;
			}
		} catch (error) {
			last = { error: error.message };
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
	}
	throw new Error(
		`Client 未在 ${timeoutMs / 1000} 秒内完成上线验收；最后状态: ${JSON.stringify(last)}`,
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (platform() === "win32") {
		// ADR-0027：Windows 固定 SYSTEM 开机任务安装路径；不再使用 PM2/登录任务。
		assertElevatedWindowsIdentity(readWindowsElevationIdentity());
		const preflight = await fetchJson(
			`${args.serverOrigin}/api/client-installer/preflight?platform=win-x64`,
			{ timeoutMs: 60_000 },
		);
		const bootstrap = await fetchJson(
			`${args.serverOrigin}/api/client-installer/bootstrap`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ platform: "win-x64" }),
				timeoutMs: 60_000,
			},
		);
		const adapter = {
			dryRun: false,
			records: [],
			probe: (p) => existsSync(p),
			readJson: (p) => safeReadJson(p),
			readEnv: (p) => readEnv(p),
			writeFile: (content, p) => writeFileSync(p, content, { mode: 0o600 }),
			mkdir: (p) => mkdirSync(p, { recursive: true }),
			// 目录必须用可继承 ACE（(OI)(CI)）：不可继承的 F 会让子目录丢失全部权限，连管理员也无法再写入。
			icacls: (p, { directory = false } = {}) => {
				const grants = directory
					? ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]
					: ["*S-1-5-18:F", "*S-1-5-32-544:F"];
				execFileSync("icacls.exe", [p, "/inheritance:r", "/grant:r", ...grants], {
					stdio: "inherit",
				});
			},
			spawn: (command, cmdArgs = []) => {
				const result = spawnSync(command, cmdArgs, { encoding: "utf8", windowsHide: true });
				return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
			},
			pm2: (pm2Args) => {
				const result = spawnSync(
					"node",
					[join(homedir(), ".vcpdeck", "tools", "pm2", "node_modules", "pm2", "bin", "pm2"), ...pm2Args],
					{ encoding: "utf8", windowsHide: true },
				);
				return { status: result.status ?? 1, stdout: result.stdout };
			},
		};
		await runWindowsInstall({
			adapter,
			args,
			bootstrap,
			preflight,
			fetchJson,
			download,
		});
		return;
	}
	const defaultDir = join(homedir(), ".vcpdeck", "launcher-client");
	const priorStatePath = join(homedir(), ".vcpdeck", "client-install.json");
	let priorState = {};
	try {
		priorState = JSON.parse(readFileSync(priorStatePath, "utf8"));
	} catch {}
	const priorDir = priorState.appDir ? resolve(priorState.appDir) : defaultDir;
	const priorEnv = readEnv(join(priorDir, "launcher.env"));
	const existingOrigin = normalizeOrigin(
		priorEnv.VCPDECK_SERVER || priorState.serverOrigin,
	);
	if (existingOrigin && existingOrigin !== args.serverOrigin) {
		throw new Error(
			`检测到 Client 已连接其他 Server: ${existingOrigin}；请先卸载或执行独立迁移`,
		);
	}
	const config = await askConfiguration(
		priorState.displayName || hostname(),
		priorDir,
	);
	if (!config.confirmed) {
		console.log("[vcpdeck] 已取消");
		return;
	}
	const clientId = ensureClientId();
	mkdirSync(dirname(priorStatePath), { recursive: true });
	const saveState = (stage, extra = {}) =>
		writeFileSync(
			priorStatePath,
			JSON.stringify(
				{
					version: INSTALL_STATE_VERSION,
					serverOrigin: args.serverOrigin,
					appDir: config.appDir,
					displayName: config.name,
					clientId,
					stage,
					...extra,
				},
				null,
				2,
			),
		);

	saveState("bootstrap");
	const preflight = await fetchJson(
		`${args.serverOrigin}/api/client-installer/preflight?platform=${encodeURIComponent(args.platform)}`,
		{ timeoutMs: 60_000 },
	);
	const bootstrap = await fetchJson(
		`${args.serverOrigin}/api/client-installer/bootstrap`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ platform: args.platform }),
			timeoutMs: 60_000,
		},
	);
	const archiveUrl = parseUrl(
		bootstrap.archiveUrl,
		"archiveUrl",
		args.serverOrigin,
	);
	const cache = join(
		homedir(),
		".vcpdeck",
		"cache",
		"releases",
		basename(archiveUrl.pathname) ||
			`vcpdeck-${bootstrap.releaseVersion}-${args.platform}.zip`,
	);
	if (
		!existsSync(cache) ||
		sha256(cache) !== bootstrap.archiveSha256.toLowerCase()
	) {
		console.log(`[vcpdeck] 下载 Client Release ${bootstrap.releaseVersion}`);
		await download(archiveUrl.href, cache, bootstrap.archiveSha256);
	}
	const lowInstaller = join(homedir(), ".vcpdeck", "cache", "install.cjs");
	await download(
		parseUrl(
			preflight.lowLevelInstallerUrl,
			"lowLevelInstallerUrl",
			args.serverOrigin,
		).href,
		lowInstaller,
		preflight.lowLevelInstallerSha256,
	);
	saveState("install-files", { releaseVersion: bootstrap.releaseVersion });
	const versionManifest = join(
		config.appDir,
		"apps",
		bootstrap.releaseVersion,
		"manifest.json",
	);
	const launcherMain = join(config.appDir, "dist", "main.js");
	const clientMain = join(
		config.appDir,
		"apps",
		bootstrap.releaseVersion,
		"client",
		"dist",
		"index.js",
	);
	if (
		!existsSync(versionManifest) ||
		!existsSync(launcherMain) ||
		!existsSync(clientMain)
	) {
		execFileSync(
			args.nodePath,
			[
				lowInstaller,
				"--artifact=client",
				`--zip=${cache}`,
				`--version=${bootstrap.releaseVersion}`,
				`--app-dir=${config.appDir}`,
				`--sha256=${bootstrap.archiveSha256}`,
				"--no-env",
				"--force",
			],
			{ stdio: "inherit" },
		);
	}
	const envPath = writeLauncherEnv(
		config.appDir,
		args.serverOrigin,
		bootstrap.psk,
		clientId,
	);

	saveState("pm2", { releaseVersion: bootstrap.releaseVersion });
	const pm2 = ensurePm2(args.nodePath, [
		"https://registry.npmmirror.com",
		"https://registry.npmjs.org",
	]);
	const ecosystem = writeEcosystem(config.appDir, args.nodePath, envPath);
	const existing = pm2Process(pm2);
	if (existing) {
		const existingScript = resolve(existing.pm2_env?.pm_exec_path || "");
		if (existingScript !== resolve(launcherMain))
			throw new Error(`PM2 中已存在同名进程但路径不同: ${existingScript}`);
		runPm2(pm2, ["restart", ecosystem, "--only", PM2_NAME, "--update-env"]);
	} else runPm2(pm2, ["start", ecosystem, "--only", PM2_NAME]);
	runPm2(pm2, ["save"]);
	const processInfo = pm2Process(pm2);
	if (processInfo?.pm2_env?.status !== "online")
		throw new Error("PM2 中 Launcher 未处于 online");

	// 先验证 Client 上线：这是安装的核心结果，不应被后续可选的自启配置失败掩盖
	saveState("verify", { releaseVersion: bootstrap.releaseVersion });
	await waitForClient(
		args.serverOrigin,
		clientId,
		bootstrap.psk,
		bootstrap.releaseVersion,
		config.name,
		bootstrap.verificationTimeoutMs || 120_000,
	);

	// Windows 安装必须真实验证最高权限登录任务；不得以当前会话在线掩盖自启动失败。
	const startup = configureStartup(pm2, args.nodePath, config.appDir);
	await waitForClient(
		args.serverOrigin,
		clientId,
		bootstrap.psk,
		bootstrap.releaseVersion,
		config.name,
		bootstrap.verificationTimeoutMs || 120_000,
	);
	saveState("done", {
		releaseVersion: bootstrap.releaseVersion,
		startup,
		completedAt: new Date().toISOString(),
	});
	console.log(`\n[vcpdeck] 安装成功: ${config.name} (${clientId})`);
	console.log(`  版本: ${bootstrap.releaseVersion}`);
	console.log(`  PM2: ${PM2_NAME}`);
	console.log(`  自启: ${startup}`);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(
			`\n[vcpdeck] 安装失败: ${error instanceof Error ? error.message : String(error)}`,
		);
		console.error(`[vcpdeck] 已保留现场；修复后重新执行同一条安装命令。`);
		if (platform() === "win32") {
			console.error(`[vcpdeck] Windows 诊断：任务 ${WINDOWS_CLIENT_TASK}；安装现场 ${WINDOWS_APP_DIR}`);
		} else {
			console.error(`[vcpdeck] 日志: pm2 logs ${PM2_NAME} --lines 100`);
		}
		process.exitCode = 1;
	});
}

module.exports = {
	WINDOWS_APP_DIR,
	WINDOWS_CLIENT_TASK,
	assertElevatedWindowsIdentity,
	readWindowsElevationIdentity,
	buildWindowsSystemTaskXml,
	classifyWindowsSystemTask,
	findMachineGit,
	ensureOptionalMachineGit,
	discoverLegacyWindowsInstall,
	cleanLegacyWindowsInstall,
	runWindowsInstall,
	parseArgs,
	readEnv,
	normalizeOrigin,
	ensureClientId,
	installPm2Retry,
	resolveGlobalPm2,
	buildNodeRuntimeEnv,
	npmPath,
	writeEcosystem,
	buildWindowsStartupTaskScript,
	classifyWindowsStartupTask,
	registerStartupTask,
	readWindowsTaskXml,
};
