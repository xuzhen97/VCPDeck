/**
 * 稳定 Launcher 的人工升级入口（ADR-0065）。
 *
 * 只替换 `<launcher>/dist`（以及目标自带的 `package.json`）：先验证 staging 里确实有
 * `launcher/dist/main.js`，再备份这两个条目、停服务、原子替换、启动并验收；任一步失败
 * 即还原备份并重新拉起旧版本。
 *
 * `apps/`（业务版本）、`node/`、`runtime/` 与 0600 的 `launcher.env`（Server/PSK）都在
 * launcher 目录下，升级绝不能整体换目录，否则一次升级会删掉业务指针与凭据。
 * 业务 `apps/current`、状态目录与自动更新流程都不在这里改动。
 */
const fs = require("node:fs");
const path = require("node:path");

const SERVICE_FILE = "/etc/init.d/vcpdeck-client";
const CLIENT_DIR = "/opt/vcpdeck/client";
const LAUNCHER_DIR = path.join(CLIENT_DIR, "launcher");
const DIST_NAME = "dist";
const DIST_BACKUP_NAME = ".dist.previous";
const PKG_NAME = "package.json";
const PKG_BACKUP_NAME = ".package.previous.json";

function distDir(launcherDir) {
	return path.join(launcherDir, DIST_NAME);
}

function distBackupDir(launcherDir) {
	return path.join(launcherDir, DIST_BACKUP_NAME);
}

function pkgFile(launcherDir) {
	return path.join(launcherDir, PKG_NAME);
}

function pkgBackupFile(launcherDir) {
	return path.join(launcherDir, PKG_BACKUP_NAME);
}

/**
 * 用 staging 里的 `launcher/dist`（与可选 `package.json`）替换 launcher 的对应条目。
 * 其余目录（apps/node/runtime/launcher.env）原样保留。
 * @param {string} launcherDir launcher 根目录
 * @param {string} stagingDir 解包后的发布 staging
 */
function swapLauncherContent(launcherDir, stagingDir) {
	const stagedDist = path.join(stagingDir, "launcher", DIST_NAME);
	const stagedPkg = path.join(stagingDir, "launcher", PKG_NAME);
	const backup = distBackupDir(launcherDir);
	fs.rmSync(backup, { recursive: true, force: true });
	fs.rmSync(pkgBackupFile(launcherDir), { force: true });
	if (fs.existsSync(distDir(launcherDir))) fs.renameSync(distDir(launcherDir), backup);
	fs.cpSync(stagedDist, distDir(launcherDir), { recursive: true, verbatimSymlinks: true });
	if (fs.existsSync(stagedPkg)) {
		if (fs.existsSync(pkgFile(launcherDir))) fs.renameSync(pkgFile(launcherDir), pkgBackupFile(launcherDir));
		fs.cpSync(stagedPkg, pkgFile(launcherDir));
	}
}

/**
 * 还原上一次 swap 备份的 dist（与 package.json）。备份缺失时抛错，绝不先删当前目录。
 * @param {string} launcherDir launcher 根目录
 */
function restoreLauncherContent(launcherDir) {
	const backup = distBackupDir(launcherDir);
	if (!fs.existsSync(backup)) {
		throw new Error("PROCD_UPGRADE_BACKUP_MISSING");
	}
	fs.rmSync(distDir(launcherDir), { recursive: true, force: true });
	fs.renameSync(backup, distDir(launcherDir));
	const pkgBackup = pkgBackupFile(launcherDir);
	if (fs.existsSync(pkgBackup)) {
		fs.rmSync(pkgFile(launcherDir), { force: true });
		fs.renameSync(pkgBackup, pkgFile(launcherDir));
	}
}

/** 本地可判定的验收：dist 入口、业务指针、凭据文件、服务状态都必须仍在位。 */
function assertLauncherReceipt(launcherDir) {
	if (!fs.existsSync(path.join(distDir(launcherDir), "main.js"))) {
		throw new Error("PROCD_UPGRADE_RECEIPT_TIMEOUT: dist/main.js 缺失");
	}
	if (!fs.existsSync(path.join(launcherDir, "apps", "current"))) {
		throw new Error("PROCD_UPGRADE_RECEIPT_TIMEOUT: apps/current 缺失");
	}
	if (!fs.existsSync(path.join(launcherDir, "launcher.env"))) {
		throw new Error("PROCD_UPGRADE_RECEIPT_TIMEOUT: launcher.env 缺失");
	}
	require("node:child_process").execFileSync(SERVICE_FILE, ["status"], {
		stdio: "ignore",
		timeout: 10_000,
	});
}

/**
 * 执行稳定 Launcher 升级。
 * @param {object} adapter 生产实现与 fake 共用：verifyTarget/stopService/swapLauncher/startService/verifyReceipt/restoreLauncher
 * @param {{stagingDir: string}} options
 * @returns {Promise<{swapped: boolean}>}
 */
async function runLauncherUpgrade(adapter, options) {
	await adapter.verifyTarget(options.stagingDir);
	await adapter.stopService();
	try {
		await adapter.swapLauncher(options.stagingDir);
		await adapter.startService();
		await adapter.verifyReceipt();
		return { swapped: true };
	} catch (error) {
		try {
			await adapter.restoreLauncher();
		} catch (restoreError) {
			throw new Error(
				`PROCD_UPGRADE_RESTORE_FAILED: ${restoreError.message}（原始失败: ${error.message}）`,
			);
		}
		await adapter.startService();
		throw new Error(`PROCD_UPGRADE_ROLLED_BACK: ${error.message}`);
	}
}

/** 生产 adapter：只换 dist/package.json，保留 apps、node、runtime 与 launcher.env。 */
function createSystemAdapter() {
	return {
		async verifyTarget(stagingDir) {
			if (!fs.existsSync(path.join(stagingDir, "launcher", DIST_NAME, "main.js"))) {
				throw new Error("PROCD_UPGRADE_TARGET_INVALID");
			}
		},
		async stopService() {
			require("node:child_process").execFileSync(SERVICE_FILE, ["stop"], {
				timeout: 20_000,
			});
		},
		async swapLauncher(stagingDir) {
			swapLauncherContent(LAUNCHER_DIR, stagingDir);
		},
		async startService() {
			require("node:child_process").execFileSync(SERVICE_FILE, ["start"], {
				timeout: 30_000,
			});
		},
		async verifyReceipt() {
			assertLauncherReceipt(LAUNCHER_DIR);
		},
		async restoreLauncher() {
			restoreLauncherContent(LAUNCHER_DIR);
		},
	};
}

async function main(argv = process.argv.slice(2)) {
	const index = argv.indexOf("--staging");
	const stagingDir = index >= 0 ? argv[index + 1] : undefined;
	if (!stagingDir) {
		console.error("usage: node upgrade-launcher-procd.cjs --staging <dir>");
		process.exit(1);
	}
	if (process.geteuid?.() !== 0) {
		console.error("PROCD_ROOT_REQUIRED");
		process.exit(1);
	}
	try {
		await runLauncherUpgrade(createSystemAdapter(), { stagingDir });
		process.stdout.write("launcher-upgraded\n");
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}

if (require.main === module) void main();

module.exports = {
	LAUNCHER_DIR,
	assertLauncherReceipt,
	restoreLauncherContent,
	runLauncherUpgrade,
	swapLauncherContent,
};
