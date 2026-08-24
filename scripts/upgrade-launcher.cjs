#!/usr/bin/env node
/**
 * Launcher 一键升级（随发版 zip 分发于 apps/<version>/client/installer/）。
 *
 * 背景：Launcher 不随业务更新自动覆盖（ADR-0015）；本脚本把 deployment.md §9.8 的
 * 手动流程自动化为单个远程 Job——材料零下载：新 Launcher 直接取自本机
 * apps/<version>/launcher/dist/main.js（每次业务更新解压后就位）。
 *
 * 用法：
 *   node upgrade-launcher.cjs [--dry-run] [--version=<x.y.z>] [--app-dir=<dir>]
 *
 * 流程：定位版本 payload → 停 PM2 守护(vcpdeck-client-launcher) → 备份并覆盖
 * <app-dir>/dist/main.js → startOrRestart → 验证在线；失败自动还原备份并重启旧版。
 * 幂等：已安装文件 sha256 与目标一致时直接跳过。
 */
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
	copyFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const PM2_NAME = "vcpdeck-client-launcher";
const LAUNCHER_REL = join("launcher", "dist", "main.js");
const INSTALLED_REL = join("dist", "main.js");

function parseArgs(argv) {
	const opts = { dryRun: false, version: undefined, appDir: undefined };
	for (const arg of argv) {
		if (arg === "--dry-run") opts.dryRun = true;
		else if (arg.startsWith("--version="))
			opts.version = arg.slice("--version=".length);
		else if (arg.startsWith("--app-dir="))
			opts.appDir = arg.slice("--app-dir=".length);
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

/** 守护进程是否在线（读 pm2 jlist 权威状态） */
function pm2Online(pm) {
	const result = runPm2(pm, ["jlist"]);
	try {
		const list = JSON.parse(result.stdout || "[]");
		const app = list.find((x) => x.name === PM2_NAME);
		return Boolean(app && app.pm2_env && app.pm2_env.status === "online");
	} catch {
		return false;
	}
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(argv = process.argv.slice(2)) {
	const opts = parseArgs(argv);
	const appDir = expandHome(opts.appDir ?? deriveAppDir(__filename));
	const appsRoot = join(appDir, "apps");
	const versionDir = findVersionDir(appsRoot, opts.version);
	const sourceMain = join(versionDir, LAUNCHER_REL);
	const installedMain = join(appDir, INSTALLED_REL);

	console.log(`[launcher-upgrade] 版本 payload: ${versionDir}`);
	console.log(`[launcher-upgrade] 目标:        ${installedMain}`);

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

	const backup = `${installedMain}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const pm = resolvePm2();
	console.log(`[launcher-upgrade] 使用 pm2: ${pm.kind} (${pm.command})`);

	try {
		copyFileSync(installedMain, backup);
		console.log(`[launcher-upgrade] 已备份: ${backup}`);

		const stopped = runPm2(pm, ["stop", PM2_NAME]);
		if (stopped.status !== 0) {
			console.log(
				`[launcher-upgrade] pm2 stop 未成功（进程可能不存在，继续）: ${(stopped.stderr || "").trim()}`,
			);
		} else {
			console.log("[launcher-upgrade] 已停止守护进程");
		}

		copyFileSync(sourceMain, installedMain);
		console.log("[launcher-upgrade] 已覆盖 dist/main.js，重启守护…");

		const started = runPm2(pm, ["startOrRestart", join(appDir, "ecosystem.config.cjs")]);
		if (started.status !== 0) {
			throw new Error(
				`pm2 startOrRestart 失败: ${(started.stderr || "").trim()}`,
			);
		}

		const deadline = Date.now() + 30_000;
		for (;;) {
			if (pm2Online(pm)) break;
			if (Date.now() > deadline) {
				throw new Error("重启后 30 秒内守护进程未恢复 online");
			}
			sleepSync(1000);
		}
	} catch (e) {
		console.error(`[launcher-upgrade] 升级失败: ${e.message}`);
		if (existsSync(backup)) {
			console.error("[launcher-upgrade] 还原备份并重启旧版…");
			copyFileSync(backup, installedMain);
			runPm2(pm, ["startOrRestart", join(appDir, "ecosystem.config.cjs")]);
		}
		return 1;
	}

	console.log(
		`[launcher-upgrade] 升级完成: ${versionDir.split(/[/\\]/).pop()}（备份保留于 ${backup}）`,
	);
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
};

if (require.main === module) {
	process.exitCode = main();
}
