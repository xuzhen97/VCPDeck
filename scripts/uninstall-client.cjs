#!/usr/bin/env node
/** VCPDeck Client 一键卸载器：只清理本机 Client，不触碰 Server 数据。 */
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, readFileSync, rmSync } = require("node:fs");
const { homedir, platform, userInfo } = require("node:os");
const { dirname, join, parse, resolve } = require("node:path");
const { stdin, stdout } = require("node:process");
const { createInterface } = require("node:readline/promises");

const PM2_NAME = "vcpdeck-client-launcher";
const STARTUP_TASK = "VCPDeck PM2 Startup";
const STARTUP_SERVICE_PREFIX = "pm2-";
const STATE_VERSION = 1;

function fail(message) {
	throw new Error(message);
}

function parseArgs(argv) {
	const args = { yes: false };
	for (const raw of argv) {
		if (raw === "--yes") args.yes = true;
		else fail(`未知参数: ${raw}`);
	}
	return args;
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

function validateState(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("Client 安装状态无效");
	}
	if (value.version !== STATE_VERSION) fail("Client 安装状态版本不受支持");
	if (typeof value.appDir !== "string" || !value.appDir.trim()) {
		fail("Client 安装状态缺少 appDir");
	}
	const appDir = resolve(value.appDir);
	const home = resolve(homedir());
	const vcpdeckDir = resolve(join(home, ".vcpdeck"));
	const root = parse(appDir).root;
	if (appDir === root || appDir === home || appDir === vcpdeckDir) {
		fail(`拒绝卸载危险 appDir: ${appDir}`);
	}
	const env = readEnv(join(appDir, "launcher.env"));
	if (env.VCPDECK_ARTIFACT !== "client") {
		fail(`appDir 不是 Client 安装目录: ${appDir}`);
	}
	if (resolve(env.VCPDECK_APP_DIR || "") !== appDir) {
		fail(`launcher.env 与 Client 安装目录不一致: ${appDir}`);
	}
	if (value.startup !== undefined && typeof value.startup !== "string") {
		fail("Client 安装状态 startup 无效");
	}
	return { ...value, appDir };
}

function loadState(path = join(homedir(), ".vcpdeck", "client-install.json")) {
	if (!existsSync(path)) fail(`未找到 Client 安装状态: ${path}`);
	try {
		return { path, state: validateState(JSON.parse(readFileSync(path, "utf8"))) };
	} catch (error) {
		if (error instanceof SyntaxError) fail(`Client 安装状态不是有效 JSON: ${path}`);
		throw error;
	}
}

function findCommand(name, isWin = platform() === "win32") {
	const result = spawnSync(isWin ? "where.exe" : "which", [name], {
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
}

function resolveGlobalPm2(existing, nodePath) {
	if (!existing || !/\.cmd$/i.test(existing)) {
		return existing ? { command: existing, argsPrefix: [] } : null;
	}
	const cli = join(dirname(existing), "node_modules", "pm2", "bin", "pm2");
	return existsSync(cli) ? { command: nodePath, argsPrefix: [cli] } : null;
}

function resolvePm2(nodePath = process.execPath, isWin = platform() === "win32") {
	const existing = resolveGlobalPm2(
		findCommand(isWin ? "pm2.cmd" : "pm2", isWin),
		nodePath,
	);
	if (existing) return existing;
	const cli = join(
		homedir(),
		".vcpdeck",
		"tools",
		"pm2",
		"node_modules",
		"pm2",
		"bin",
		"pm2",
	);
	return existsSync(cli) ? { command: nodePath, argsPrefix: [cli] } : null;
}

function runPm2(pm2, args, options = {}) {
	const result = spawnSync(pm2.command, [...pm2.argsPrefix, ...args], {
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		...options,
	});
	if (result.status !== 0) {
		throw new Error(
			`PM2 ${args[0]} 失败${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
		);
	}
	return result.stdout || "";
}

function pm2List(pm2, runner = runPm2) {
	const output = runner(pm2, ["jlist"], { capture: true });
	try {
		const entries = JSON.parse(output || "[]");
		if (!Array.isArray(entries)) throw new Error();
		return entries;
	} catch {
		fail("PM2 jlist 返回无效结果");
	}
}

function expectedLauncherPath(appDir) {
	return resolve(join(appDir, "dist", "main.js"));
}

function assertLauncherProcess(entry, appDir) {
	const actual = resolve(entry?.pm2_env?.pm_exec_path || "");
	if (actual !== expectedLauncherPath(appDir)) {
		fail(
			`PM2 中已存在同名进程但路径不同: ${actual || "未知路径"}`,
		);
	}
}

/**
 * 读取计划任务定义 XML。
 * `schtasks /XML` 声明 UTF-16 但实际按控制台代码页输出单字节，Node 按 utf16le 解码必然乱码；
 * 改用 PowerShell 的 Export-ScheduledTask 并以 base64 回传，避免任何代码页歧义。
 */
function readWindowsTaskXml(taskName, spawn = spawnSync) {
	const quoted = `'${String(taskName).replace(/'/g, "''")}'`;
	const script =
		"$ErrorActionPreference='Stop';" +
		`$xml = Export-ScheduledTask -TaskName ${quoted};` +
		"[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xml))";
	const result = spawn(
		join(
			process.env.SystemRoot || "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		),
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ encoding: "utf8", windowsHide: true },
	);
	const encoded = String(result.stdout || "").trim();
	if (result.status !== 0 || !encoded) return null;
	return Buffer.from(encoded, "base64").toString("utf8");
}

function removeWindowsStartupTask(
	appDir,
	exec = execFileSync,
	readTaskXml = readWindowsTaskXml,
	query = spawnSync,
) {
	const xml = readTaskXml(STARTUP_TASK);
	if (xml === null) {
		// 读不到定义时只在任务确实不存在才跳过，否则拒绝静默留下指向旧目录的自启任务。
		const existing = query("schtasks.exe", ["/Query", "/TN", STARTUP_TASK], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (existing.status === 0) {
			fail(`无法读取 Windows 计划任务 ${STARTUP_TASK}，请以安装时同一用户重跑卸载`);
		}
		return "not-found";
	}
	const output = xml.replace(/\\/g, "/").toLowerCase();
	const normalizedAppDir = appDir.replace(/\\/g, "/").toLowerCase();
	const wrapper = join(appDir, "pm2-resurrect.cmd").replace(/\\/g, "/").toLowerCase();
	const probe = join(appDir, "startup-probe.cjs").replace(/\\/g, "/").toLowerCase();
	const matchesCurrent = output.includes(normalizedAppDir) || output.includes(wrapper) || output.includes(probe);
	if (!matchesCurrent) {
		fail(`Windows 计划任务 ${STARTUP_TASK} 已存在但指向其他命令`);
	}
	exec("schtasks.exe", ["/Delete", "/TN", STARTUP_TASK, "/F"], {
		stdio: "inherit",
	});
	return "removed";
}

// ADR-0027：Windows 系统级卸载固定常量。
const WIN_SYSTEM_ROOT = "C:\\ProgramData\\VCPDeck";
const WIN_SYSTEM_APP_DIR = "C:\\ProgramData\\VCPDeck\\Client";
const WIN_SYSTEM_TASK = "\\VCPDeck\\Client";
const WIN_CLIENT_ID_PATH = "C:\\ProgramData\\VCPDeck\\client-id";

/**
 * 系统级卸载（ADR-0027）：停止任务 → 删除任务 → 将 Client ID 原子保留到 ProgramData → 删除 Client 运行目录。
 * 保留旧用户卸载分支；默认卸载不删除机器身份（client-id 移到固定路径供重装复用）。
 * adapter 可注入（dryRun 不真实落盘/执行），供测试验证顺序与 fail closed。
 */
function uninstallSystemClient(adapter) {
	const statePath = join(WIN_SYSTEM_ROOT, "Client", "install-state.json");
	const state = adapter.readJson(statePath);
	if (!state || typeof state !== "object") throw new Error(`未找到系统级 Client 安装状态: ${statePath}`);
	if (state.version !== STATE_VERSION) throw new Error("Client 安装状态版本不受支持");
	const appDir = typeof state.appDir === "string" ? resolve(state.appDir) : null;
	const root = require("node:path").parse(appDir || "").root;
	const normalizedAppDir = (appDir || "").replace(/\\/g, "/").toLowerCase();
	const normalizedRoot = WIN_SYSTEM_ROOT.replace(/\\/g, "/").toLowerCase();
	if (!appDir || appDir === root || !normalizedAppDir.startsWith(`${normalizedRoot}/`)) {
		throw new Error(`拒绝卸载危险 appDir: ${appDir || "未知"}`);
	}
	const env = adapter.readEnv(join(appDir, "launcher.env"));
	if (env.VCPDECK_ARTIFACT !== "client") throw new Error(`appDir 不是 Client 安装目录: ${appDir}`);
	if (env.VCPDECK_APP_DIR && resolve(env.VCPDECK_APP_DIR) !== appDir) {
		throw new Error(`launcher.env 与 Client 安装目录不一致: ${appDir}`);
	}
	if (typeof state.clientId !== "string" || !/^[0-9a-f-]{36}$/i.test(state.clientId)) {
		throw new Error("Client ID 缺失或非法，拒绝卸载");
	}
	// 停止并删除 SYSTEM 开机任务（任务存在但无法停止时 fail closed）。
	const ended = adapter.spawn("schtasks.exe", ["/End", "/TN", WIN_SYSTEM_TASK, "/F"]);
	if (ended.status !== 0 && ended.status !== null) {
		const exists = adapter.spawn("schtasks.exe", ["/Query", "/TN", WIN_SYSTEM_TASK]);
		if (exists.status === 0) throw new Error(`无法停止计划任务 ${WIN_SYSTEM_TASK}，拒绝继续卸载`);
	}
	adapter.spawn("schtasks.exe", ["/Delete", "/TN", WIN_SYSTEM_TASK, "/F"]);
	// Client ID 原子保留到 ProgramData 固定路径，身份权威不随运行目录删除。
	if (!adapter.dryRun) {
		mkdirSync(WIN_SYSTEM_ROOT, { recursive: true });
		writeFileSync(WIN_CLIENT_ID_PATH, state.clientId.trim(), { mode: 0o600 });
	} else {
		adapter.writeFile(state.clientId, WIN_CLIENT_ID_PATH);
	}
	adapter.icacls(WIN_CLIENT_ID_PATH);
	adapter.rm(appDir);
	return {
		removed: true,
		appDir,
		clientIdPreservedAt: WIN_CLIENT_ID_PATH,
	};
}

function removeStartup({
	appDir,
	startup,
	isWin,
	pm2,
	exec,
} = {}) {
	if (!startup || startup === "not-configured") return "not-configured";
	if (isWin) {
		return removeWindowsStartupTask(appDir, exec);
	}
	const expectedService = `${STARTUP_SERVICE_PREFIX}${userInfo().username}.service`;
	if (startup !== expectedService) {
		fail(`未知 Linux PM2 自启服务: ${startup}`);
	}
	(exec || execFileSync)(
		"sudo",
		[
			pm2.command,
			...pm2.argsPrefix,
			"unstartup",
			"systemd",
			"-u",
			userInfo().username,
			"--hp",
			homedir(),
		],
		{ stdio: "inherit" },
	);
	return "removed";
}

/** 删除 Client 进程、自启和安装目录；调用方应在成功后再删除安装状态文件。 */
function uninstallClient(state, options = {}) {
	const validated = validateState(state);
	const isWin = options.isWin ?? platform() === "win32";
	const pm2 = options.pm2 || resolvePm2(options.nodePath || process.execPath, isWin);
	if (!pm2) fail("找不到 PM2，拒绝删除 Client 目录；请先恢复 PM2 后重试");
	const runner = options.runPm2 || runPm2;
	const entries = pm2List(pm2, runner);
	const launcher = entries.find((entry) => entry?.name === PM2_NAME);
	if (launcher) {
		assertLauncherProcess(launcher, validated.appDir);
		runner(pm2, ["delete", PM2_NAME]);
	}
	runner(pm2, ["save"]);
	const remaining = pm2List(pm2, runner).filter(
		(entry) => entry?.name !== PM2_NAME,
	);
	const startup = remaining.length
		? "preserved-for-other-pm2-apps"
		: removeStartup({
			appDir: validated.appDir,
			startup: validated.startup,
			isWin,
			pm2,
			exec: options.exec || execFileSync,
		});
	(options.removePath || ((path) => rmSync(path, { recursive: true, force: true })))(
		validated.appDir,
	);
	return {
		removed: true,
		appDir: validated.appDir,
		startup,
		preservedPm2Apps: remaining.length,
	};
}

async function confirmRemoval(appDir, yes) {
	if (yes || !stdin.isTTY) return true;
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const answer = (await rl.question(`确认卸载 Client（删除 ${appDir}）？[y/N] `))
			.trim()
			.toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (platform() === "win32" && existsSync(join(WIN_SYSTEM_ROOT, "Client", "install-state.json"))) {
		const adapter = {
			dryRun: false,
			readJson: (p) => {
				try {
					return JSON.parse(readFileSync(p, "utf8"));
				} catch {
					return null;
				}
			},
			readEnv,
			writeFile: (content, p) => writeFileSync(p, content, { mode: 0o600 }),
			rm: (p) => rmSync(p, { recursive: true, force: true }),
			icacls: (p) => {
				execFileSync("icacls.exe", [p, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"], {
					stdio: "inherit",
				});
			},
			spawn: (command, cmdArgs = []) => {
				const result = spawnSync(command, cmdArgs, { encoding: "utf8", windowsHide: true });
				return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
			},
		};
		const result = uninstallSystemClient(adapter);
		console.log(`[vcpdeck] 系统级 Client 运行环境已卸载: ${result.appDir}`);
		console.log(`[vcpdeck] Client ID 已保留: ${result.clientIdPreservedAt}`);
		return;
	}
	const loaded = loadState();
	console.log(`[vcpdeck] 将卸载 Client: ${loaded.state.appDir}`);
	if (!(await confirmRemoval(loaded.state.appDir, args.yes))) {
		console.log("[vcpdeck] 已取消");
		return;
	}
	const result = uninstallClient(loaded.state);
	rmSync(loaded.path, { force: true });
	console.log(`[vcpdeck] Client 运行环境已卸载: ${result.appDir}`);
	if (result.startup === "preserved-for-other-pm2-apps") {
		console.log("[vcpdeck] 检测到其他 PM2 应用，已保留共享自启配置");
	}
	console.log("[vcpdeck] Server 数据、Client ID、缓存和其他 PM2 应用未修改");
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[vcpdeck] 卸载失败: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}

module.exports = {
	uninstallSystemClient,
	WIN_SYSTEM_APP_DIR,
	WIN_CLIENT_ID_PATH,
	parseArgs,
	validateState,
	loadState,
	readEnv,
	findCommand,
	resolveGlobalPm2,
	resolvePm2,
	pm2List,
	assertLauncherProcess,
	readWindowsTaskXml,
	removeWindowsStartupTask,
	removeStartup,
	uninstallClient,
	confirmRemoval,
};
