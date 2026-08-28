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

function removeWindowsStartupTask(
	appDir,
	exec = execFileSync,
	query = spawnSync,
) {
	const result = query("schtasks.exe", ["/Query", "/TN", STARTUP_TASK, "/V", "/FO", "LIST"], {
		encoding: "utf8",
	});
	if (result.status !== 0) return "not-found";
	const output = String(result.stdout || "").replace(/\\/g, "/").toLowerCase();
	const wrapper = join(appDir, "pm2-resurrect.cmd").replace(/\\/g, "/").toLowerCase();
	if (!output.includes(wrapper)) {
		fail(`Windows 计划任务 ${STARTUP_TASK} 已存在但指向其他命令`);
	}
	exec("schtasks.exe", ["/Delete", "/TN", STARTUP_TASK, "/F"], {
		stdio: "inherit",
	});
	return "removed";
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
	parseArgs,
	validateState,
	loadState,
	readEnv,
	findCommand,
	resolveGlobalPm2,
	resolvePm2,
	pm2List,
	assertLauncherProcess,
	removeWindowsStartupTask,
	removeStartup,
	uninstallClient,
	confirmRemoval,
};
