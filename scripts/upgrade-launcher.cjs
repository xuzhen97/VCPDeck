#!/usr/bin/env node
/**
 * Launcher 一键升级（随发版 zip 分发于 apps/<version>/client/installer/）。
 *
 * 背景：Launcher 不随业务更新自动覆盖（ADR-0015）；本脚本把 deployment.md §9.8 的
 * 手动流程自动化为单个远程 Job——材料零下载：新 Launcher 直接取自本机
 * apps/<version>/launcher/dist/main.js（每次业务更新解压后就位）。
 *
 * 关键设计——两阶段分离执行：
 *   远程 Job 由被守护的业务 Client 进程承载，而升级第一步就是停掉该守护树，
 *   若在 Job 进程内直接执行会自杀。因此默认路径只做校验与规划，随后以
 *   detached 子进程执行停机/覆盖/重启（脱离父进程树存活），日志落盘；
 *   稍后用 --status 核验结果。
 *
 * 用法：
 *   node upgrade-launcher.cjs [--dry-run] [--version=<x.y.z>] [--app-dir=<dir>] [--pm2-name=<name>]
 *   node upgrade-launcher.cjs --status [--version=<x.y.z>] [--app-dir=<dir>] [--pm2-name=<name>]
 *
 * 幂等：已安装文件 sha256 与目标一致时直接跳过。
 */
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const {
	closeSync,
	copyFileSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const PM2_NAME = "vcpdeck-client-launcher";
const LAUNCHER_REL = join("launcher", "dist", "main.js");
const INSTALLED_REL = join("dist", "main.js");

function validatePm2Name(name) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
		throw new Error(`PM2 名无效: ${name || "(空)"}`);
	}
	return name;
}

function parseArgs(argv) {
	const opts = {
		dryRun: false,
		status: false,
		applyDetached: false,
		version: undefined,
		appDir: undefined,
		source: undefined,
		pm2Name: PM2_NAME,
	};
	for (const arg of argv) {
		if (arg === "--dry-run") opts.dryRun = true;
		else if (arg === "--status") opts.status = true;
		else if (arg === "--apply-detached") opts.applyDetached = true;
		else if (arg.startsWith("--version="))
			opts.version = arg.slice("--version=".length);
		else if (arg.startsWith("--app-dir="))
			opts.appDir = arg.slice("--app-dir=".length);
		else if (arg.startsWith("--source="))
			opts.source = arg.slice("--source=".length);
		else if (arg.startsWith("--pm2-name="))
			opts.pm2Name = validatePm2Name(arg.slice("--pm2-name=".length));
		else throw new Error(`未知参数: ${arg}`);
	}
	return opts;
}

function expandHome(p) {
	return resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
}

/** 脚本位于 <appDir>/apps/<V>/client/installer/ 下，向上四级即 appDir */
function deriveAppDir(selfPath) {
	return resolve(dirname(selfPath), "..", "..", "..", "..");
}

function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 选定版本目录：显式 --version 优先，否则取 apps 下含 launcher payload 的最新版本 */
function findVersionDir(appsRoot, wantVersion) {
	if (!existsSync(appsRoot)) {
		throw new Error(`apps 目录不存在: ${appsRoot}`);
	}
	if (wantVersion) {
		const dir = join(appsRoot, wantVersion);
		if (!existsSync(join(dir, LAUNCHER_REL))) {
			throw new Error(`apps/${wantVersion} 缺少 ${LAUNCHER_REL}（该版本未携带 Launcher？）`);
		}
		return dir;
	}
	const candidates = readdirSync(appsRoot)
		.filter((name) => name !== "current")
		.filter((name) => existsSync(join(appsRoot, name, LAUNCHER_REL)))
		.map((name) => ({
			name,
			mtimeMs: statSync(join(appsRoot, name)).mtimeMs,
		}))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (candidates.length === 0) {
		throw new Error(`apps 下没有携带 ${LAUNCHER_REL} 的版本目录`);
	}
	return join(appsRoot, candidates[0].name);
}

/** 解析可用 pm2 入口：优先一键安装器托管的 ~/.vcpdeck/tools/pm2，其次 PATH */
function resolvePm2() {
	const managedBin = join(
		homedir(),
		".vcpdeck",
		"tools",
		"pm2",
		"node_modules",
		"pm2",
		"bin",
		"pm2",
	);
	const candidates = [{ kind: "path", command: "pm2", argsPrefix: [] }];
	if (existsSync(managedBin)) {
		candidates.unshift({
			kind: "node",
			command: process.execPath,
			argsPrefix: [managedBin],
		});
	}
	for (const c of candidates) {
		const probe = spawnSync(c.command, [...c.argsPrefix, "-v"], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (probe.status === 0) return c;
	}
	throw new Error("未找到可用的 pm2（PATH 与 ~/.vcpdeck/tools/pm2 均不可用）");
}

function runPm2(pm, args) {
	return spawnSync(pm.command, [...pm.argsPrefix, ...args], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 60_000,
	});
}

/**
 * 重启已注册守护：优先按名 restart（兼容无 ecosystem.config.cjs 的旧版/
 * 手动安装——该文件仅新增装法写入；再失败才回退 startOrRestart 文件）。
 */
function restartGuard(pm, appDir, pm2Name = PM2_NAME, runImpl = runPm2) {
	const byName = runImpl(pm, ["restart", pm2Name]);
	if (byName.status === 0) return byName;
	return runImpl(pm, ["startOrRestart", join(appDir, "ecosystem.config.cjs")]);
}

/** 守护进程是否在线（读 pm2 jlist 权威状态） */
function pm2Online(pm, pm2Name = PM2_NAME, runImpl = runPm2) {
	const result = runImpl(pm, ["jlist"]);
	try {
		const list = JSON.parse(result.stdout || "[]");
		const app = list.find((x) => x.name === pm2Name);
		return Boolean(app && app.pm2_env && app.pm2_env.status === "online");
	} catch {
		return false;
	}
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 危险阶段：停守护 → 覆盖 → 重启 → 等在线；失败还原备份并重启旧版。 */
function applyDetached(appDir, sourceMain, pm2Name = PM2_NAME, runImpl = runPm2) {
	const log = (...a) => console.log("[launcher-upgrade]", ...a);
	const installedMain = join(appDir, INSTALLED_REL);
	if (!existsSync(sourceMain)) {
		throw new Error(`源 Launcher 不存在: ${sourceMain}`);
	}
	const backup = `${installedMain}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const pm = resolvePm2(); // 先解析 pm2，失败则什么都没动过
	log(`使用 pm2: ${pm.kind} (${pm.command})`);

	try {
		copyFileSync(installedMain, backup);
		log(`已备份: ${backup}`);

		const stopped = runImpl(pm, ["stop", pm2Name]);
		if (stopped.status !== 0) {
			log(`pm2 stop 未成功（进程可能不存在，继续）: ${(stopped.stderr || "").trim()}`);
		} else {
			log("已停止守护进程");
		}

		copyFileSync(sourceMain, installedMain);
		log("已覆盖 dist/main.js，重启守护…");

		const started = restartGuard(pm, appDir, pm2Name, runImpl);
		if (started.status !== 0) {
			throw new Error(`重启守护失败: ${(started.stderr || "").trim()}`);
		}

		const deadline = Date.now() + 30_000;
		for (;;) {
			if (pm2Online(pm, pm2Name, runImpl)) break;
			if (Date.now() > deadline) {
				throw new Error("重启后 30 秒内守护进程未恢复 online");
			}
			sleepSync(1000);
		}
	} catch (e) {
		log(`升级失败: ${e.message}`);
		if (existsSync(backup)) {
			log("还原备份并重启旧版…");
			copyFileSync(backup, installedMain);
			restartGuard(pm, appDir, pm2Name, runImpl);
		}
		return 1;
	}

	log(`升级完成（备份保留于 ${backup}）`);
	return 0;
}

/** 构造 detached 子进程参数，保持显式目标和 PM2 名称不丢失。 */
function buildDetachedArgv(scriptPath, appDir, sourceMain, pm2Name = PM2_NAME) {
	return [
		scriptPath,
		"--apply-detached",
		`--app-dir=${appDir}`,
		`--source=${sourceMain}`,
		`--pm2-name=${pm2Name}`,
	];
}

/** 以 detached 子进程执行危险阶段，返回日志文件路径 */
function spawnDetachedApply(scriptPath, appDir, sourceMain, pm2Name = PM2_NAME) {
	const logPath = join(appDir, "launcher-upgrade.log");
	const out = openSync(logPath, "a");
	const child = spawn(
		process.execPath,
		buildDetachedArgv(scriptPath, appDir, sourceMain, pm2Name),
		{ detached: true, stdio: ["ignore", out, out], windowsHide: true },
	);
	child.unref();
	closeSync(out);
	return logPath;
}

/** 核验：已安装与源一致 + 守护在线（pm2 不可用时降级为仅比对文件并提示） */
function statusMode(
	appDir,
	sourceMain,
	pm2Name = PM2_NAME,
	resolvePm2Impl = resolvePm2,
	runImpl = runPm2,
) {
	const installedMain = join(appDir, INSTALLED_REL);
	const srcSha = sha256File(sourceMain);
	const installedSha = existsSync(installedMain) ? sha256File(installedMain) : null;
	console.log(`[launcher-upgrade] 目标 sha256: ${srcSha}`);
	console.log(`[launcher-upgrade] 已装 sha256: ${installedSha ?? "(不存在)"}`);
	if (installedSha !== srcSha) {
		console.log("[launcher-upgrade] 结果: 未完成（文件不一致）");
		return 1;
	}
	let pmLine = "（pm2 不可用，跳过在线检查）";
	try {
		const pm = resolvePm2Impl();
		pmLine = pm2Online(pm, pm2Name, runImpl) ? "守护在线" : "守护不在线！";
	} catch {
		/* 忽略 */
	}
	console.log(`[launcher-upgrade] 结果: 文件一致，${pmLine}`);
	return 0;
}

function main(argv = process.argv.slice(2)) {
	const opts = parseArgs(argv);
	const selfFile = __filename;
	const appDir = expandHome(opts.appDir ?? deriveAppDir(selfFile));
	const appsRoot = join(appDir, "apps");
	const sourceMain = opts.source
		? expandHome(opts.source)
		: join(findVersionDir(appsRoot, opts.version), LAUNCHER_REL);
	if (!existsSync(sourceMain)) {
		throw new Error(`源 Launcher 不存在: ${sourceMain}`);
	}
	const installedMain = join(appDir, INSTALLED_REL);

	console.log(`[launcher-upgrade] 源文件:      ${sourceMain}`);
	console.log(`[launcher-upgrade] 目标 app-dir: ${appDir}`);
	console.log(`[launcher-upgrade] 目标:        ${installedMain}`);
	console.log(`[launcher-upgrade] PM2 名称:    ${opts.pm2Name}`);

	if (opts.applyDetached) {
		return applyDetached(appDir, sourceMain, opts.pm2Name);
	}

	if (opts.status) {
		return statusMode(appDir, sourceMain, opts.pm2Name);
	}

	if (opts.dryRun) {
		console.log(`[launcher-upgrade] 源 sha256:    ${sha256File(sourceMain)}`);
		console.log("[launcher-upgrade] dry-run：仅校验与规划，不做任何更改");
		return 0;
	}
	if (!existsSync(installedMain)) {
		throw new Error(
			`未找到已安装 Launcher: ${installedMain}（请先用 install.cjs 完成首次安装）`,
		);
	}

	const srcSha = sha256File(sourceMain);
	if (sha256File(installedMain) === srcSha) {
		console.log("[launcher-upgrade] 已安装 Launcher 与目标一致，跳过");
		return 0;
	}

	// 常规路径：父进程只做规划，危险阶段交给 detached 子进程（避免随业务 Client 一起被停杀）
	const logPath = spawnDetachedApply(selfFile, appDir, sourceMain, opts.pm2Name);
	console.log(`[launcher-upgrade] 已在后台分离执行危险阶段，日志: ${logPath}`);
	console.log("[launcher-upgrade] 约 30 秒后用 --status 核验结果");
	return 0;
}

module.exports = {
	PM2_NAME,
	LAUNCHER_REL,
	INSTALLED_REL,
	parseArgs,
	deriveAppDir,
	findVersionDir,
	sha256File,
	main,
	validatePm2Name,
	buildDetachedArgv,
	restartGuard,
	pm2Online,
	statusMode,
};

if (require.main === module) {
	process.exitCode = main();
}
