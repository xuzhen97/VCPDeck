/**
 * VCPDeck Client（iStoreOS procd 部署）卸载入口（ADR-0065）。
 *
 * 默认只移除服务定义与应用目录，保留持久身份与 root-only 配置；
 * purge 必须显式 `--purge --confirm-purge`，且仍需操作者单独授权。
 */
const fs = require("node:fs");
const path = require("node:path");
const { readProcessFacts } = require("./client-procd-lifecycle.cjs");

const SERVICE_FILE = "/etc/init.d/vcpdeck-client";
const CLIENT_DIR = "/opt/vcpdeck/client";
const STATE_DIR = "/opt/vcpdeck/state";
const CONFIG_DIR = "/etc/vcpdeck";
const LEDGER_FILE = path.join(STATE_DIR, "owned-process.json");

/**
 * 卸载目标白名单。默认保留 state 与 /etc/vcpdeck（凭据）。
 * @param {boolean} purge 是否连持久状态一起删除
 * @returns {readonly string[]}
 */
function uninstallTargets(purge) {
	const ordinary = [SERVICE_FILE, CLIENT_DIR];
	return purge ? [...ordinary, STATE_DIR, CONFIG_DIR] : ordinary;
}

/**
 * 停服后等待进程与账本真正收敛。procd 的停止命令返回时子进程未必已经退出。
 * @param {object} adapter 含 assertStopped 的适配器
 * @param {{stopTimeoutMs?: number, stopPollMs?: number}} options 等待上限与轮询间隔
 */
async function waitForStopped(adapter, options) {
	const timeoutMs = options.stopTimeoutMs ?? 20_000;
	const pollMs = options.stopPollMs ?? 500;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await adapter.assertStopped();
			return;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "PROCD_STOP_UNCONVERGED" || Date.now() >= deadline) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	}
}

/**
 * 执行卸载。
 * @param {object} adapter 生产实现与 fake 共用：inspectInstall/disableService/stopService/assertStopped/removePath/readLedger
 * @param {{purge: boolean, confirmPurge: boolean, stopTimeoutMs?: number, stopPollMs?: number}} options
 * @returns {Promise<{purged: boolean, kept: readonly string[]}>}
 */
async function runUninstall(adapter, options) {
	if (options.purge && !options.confirmPurge) {
		throw new Error("PROCD_PURGE_UNAUTHORIZED");
	}
	const state = await adapter.inspectInstall();
	if (!state.marker) throw new Error("PROCD_UNINSTALL_UNSAFE");
	if (state.serviceContent !== null && !state.serviceContent.includes("VCPDECK_INSTALLATION_MODE=procd-root")) {
		throw new Error("PROCD_UNINSTALL_UNSAFE");
	}
	if (state.systemdUnit || state.pm2Residue) throw new Error("PROCD_UNINSTALL_MIXED");

	await adapter.disableService();
	await adapter.stopService();
	await waitForStopped(adapter, options);
	await adapter.removePath(SERVICE_FILE);
	for (const target of uninstallTargets(options.purge)) {
		if (target !== SERVICE_FILE) await adapter.removePath(target);
	}
	return {
		purged: options.purge,
		kept: options.purge ? [] : [STATE_DIR, CONFIG_DIR],
	};
}

/** 通过 rc.common status 判断服务此刻是否仍在运行（退出码 0 = 运行中）。 */
function serviceRunning() {
	try {
		require("node:child_process").execFileSync(SERVICE_FILE, ["status"], {
			stdio: "ignore",
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

/** 生产 adapter：所有删除前先 lstat，拒绝符号链接与白名单外路径。 */
function createSystemAdapter() {
	const allowed = new Set(uninstallTargets(true));
	const safeRemove = (target) => {
		if (!allowed.has(target)) throw new Error("PROCD_UNINSTALL_UNSAFE");
		let stat;
		try {
			stat = fs.lstatSync(target);
		} catch {
			return;
		}
		if (stat.isSymbolicLink()) throw new Error("PROCD_UNINSTALL_UNSAFE");
		fs.rmSync(target, { recursive: true, force: false });
	};
	return {
		async inspectInstall() {
			let serviceContent = null;
			try {
				serviceContent = fs.readFileSync(SERVICE_FILE, "utf8");
			} catch {
				serviceContent = null;
			}
			return {
				marker: fs.existsSync(path.join(STATE_DIR, "home")) && fs.existsSync(CLIENT_DIR),
				serviceContent,
				systemdUnit: fs.existsSync("/etc/systemd/system/vcpdeck-client.service"),
				pm2Residue: fs.existsSync("/etc/systemd/system/pm2-root.service"),
			};
		},
		async disableService() {
			if (fs.existsSync(SERVICE_FILE)) {
				require("node:child_process").execFileSync(SERVICE_FILE, ["disable"], {
					timeout: 15_000,
				});
			}
		},
		async stopService() {
			if (fs.existsSync(SERVICE_FILE)) {
				require("node:child_process").execFileSync(SERVICE_FILE, ["stop"], {
					timeout: 20_000,
				});
			}
		},
		async assertStopped() {
			let ledger;
			try {
				ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
			} catch {
				// 账本缺失不代表没有进程：用服务状态兜底，避免默许遗留进程。
				if (serviceRunning()) throw new Error("PROCD_STOP_UNCONVERGED");
				return;
			}
			let bootId;
			try {
				bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			} catch {
				throw new Error("PROCD_STOP_UNCONVERGED");
			}
			try {
				const live = readProcessFacts(ledger.pid, { bootId });
				if (
					live.bootId === ledger.bootId &&
					live.startTime === ledger.startTime &&
					live.uid === ledger.uid
				) {
					throw new Error("PROCD_STOP_UNCONVERGED");
				}
			} catch (error) {
				if (error.message === "PROCD_STOP_UNCONVERGED") throw error;
				// 进程已不存在：/proc 证据缺失即视为已停止，但仍要看服务状态。
				if (serviceRunning()) throw new Error("PROCD_STOP_UNCONVERGED");
			}
		},
		async removePath(target) {
			safeRemove(target);
		},
	};
}

async function main(argv = process.argv.slice(2)) {
	if (!argv.includes("--uninstall")) {
		console.error("usage: node uninstall-client-procd.cjs --uninstall [--purge --confirm-purge]");
		process.exit(1);
	}
	if (process.geteuid?.() !== 0) {
		console.error("PROCD_ROOT_REQUIRED");
		process.exit(1);
	}
	const purge = argv.includes("--purge");
	const confirmPurge = argv.includes("--confirm-purge");
	try {
		const result = await runUninstall(createSystemAdapter(), { purge, confirmPurge });
		process.stdout.write(`uninstalled${result.purged ? " (purged)" : ""}\n`);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}

if (require.main === module) void main();

module.exports = {
	CLIENT_DIR,
	CONFIG_DIR,
	SERVICE_FILE,
	STATE_DIR,
	createSystemAdapter,
	runUninstall,
	uninstallTargets,
};
