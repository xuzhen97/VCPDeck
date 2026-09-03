#!/usr/bin/env node
/**
 * VCPDeck Linux A2 systemd 版 Launcher 自升级。
 *
 * 与 PM2 版 `upgrade-launcher.cjs` 并存：本脚本仅在 systemd 部署（Linux A2）下使用。
 * 升级脱离 Client service cgroup：用受限 transient `systemd-run`（root、Timeout、KillMode=process、
 * 无 PrivateNetwork、无 NewerCredentials）在单元外执行替换，避免 systemd 自杀（ADR-0023 §5）。
 * 稳态 systemd 单元内不直接替换自身可执行文件；替换走 transient 单元 + 原子 rename + daemon-reload + restart。
 */

const UNIT_FILE = "/etc/systemd/system/vcpdeck-client.service";
const SERVICE_NAME = "vcpdeck-client.service";
const STABLE_LAUNCHER = "/opt/vcpdeck/client/launcher/dist/main.js";

const UPGRADE_ERROR = {
	PM2_UNIT: "LINUX_UPGRADE_PM2_UNIT",
	OLD_MISSING: "LINUX_UPGRADE_OLD_MISSING",
	NEW_MISSING: "LINUX_UPGRADE_NEW_MISSING",
	SYSTEMD_RUN_FAILED: "LINUX_UPGRADE_SYSTEMD_RUN_FAILED",
	RESTART_FAILED: "LINUX_UPGRADE_RESTART_FAILED",
};

function upgradeError(code, message) {
	const error = new Error(message);
	error.name = "SystemdUpgradeError";
	error.code = code;
	return error;
}

/** 判断当前 vcpdeck 单元是否为 A2 systemd 部署（而非 PM2/用户服务）。 */
function isSystemdUnit(adapter) {
	let content = "";
	try {
		const res = adapter.exec?.(`cat ${UNIT_FILE}`) || {};
		content = res.stdout || "";
	} catch {
		return false;
	}
	// A2 单元特征：User=vcpdeck 且 ExecStart 指向 /opt/vcpdeck/client。
	const isVcpdeckUser = /(^|\n)\s*User\s*=\s*vcpdeck\s*(\n|$)/.test(content);
	const isOptExec = /ExecStart\s*=\s*\/opt\/vcpdeck\/client\//.test(content);
	return isVcpdeckUser && isOptExec;
}

/**
 * 规划 systemd Launcher 升级：校验单元类型、旧/新 Launcher 存在性。
 * @returns {{upgradeable:boolean, reason?:string, newLauncherPath?:string}}
 */
function planSystemdUpgrade(adapter, newVersion = null) {
	if (!isSystemdUnit(adapter)) {
		return { upgradeable: false, reason: UPGRADE_ERROR.PM2_UNIT };
	}
	const oldInfo = adapter.statInfo?.(STABLE_LAUNCHER);
	if (!oldInfo || !oldInfo.exists) {
		return { upgradeable: false, reason: UPGRADE_ERROR.OLD_MISSING };
	}
	// 新 Launcher 必须已存在于某版本目录（apps/<version>/launcher/dist/main.js）。
	let newVersionPath = null;
	if (newVersion) {
		newVersionPath = `/opt/vcpdeck/client/apps/${newVersion}/launcher/dist/main.js`;
		const newInfo = adapter.statInfo?.(newVersionPath);
		if (!newInfo || !newInfo.exists) {
			return { upgradeable: false, reason: UPGRADE_ERROR.NEW_MISSING };
		}
	} else {
		// 无显式版本：探测 apps 下是否存在任何已就绪版本目录的 Launcher。
		return { upgradeable: false, reason: UPGRADE_ERROR.NEW_MISSING };
	}
	return { upgradeable: true, newLauncherPath: newVersionPath };
}

/**
 * 执行 systemd Launcher 升级（经注入 adapter，可测试）：
 * verify-old → systemd-run（transient，脱 cgroup）→ verify-new → 原子替换 → daemon-reload → restart → verify 新版本。
 */
async function runSystemdUpgrade({
	adapter,
	newVersion,
	appsDir = "/opt/vcpdeck/client/apps",
	log = () => {},
}) {
	const r = adapter;
	const record = (n) => r.record?.(n);

	// 1. 校验旧 Launcher 与单元。
	record("verify-old");
	const plan = planSystemdUpgrade(r, newVersion);
	if (!plan.upgradeable) {
		throw upgradeError(plan.reason, `无法规划升级: ${plan.reason}`);
	}
	// 2. 用 transient systemd-run（脱 Client cgroup）预校验新版本可加载。
	record("systemd-run");
	const runRes = r.execFileSync?.(
		"systemd-run",
		[
			"--unit=vcpdeck-launcher-upgrade",
			"timeout",
			"60",
			"node",
			plan.newLauncherPath,
			"--version-check",
		],
	);
	if (!runRes || runRes.status !== 0) {
		throw upgradeError(UPGRADE_ERROR.SYSTEMD_RUN_FAILED, "systemd-run 预校验失败");
	}
	// 3. 校验新版本文件完整（owner root、存在）。
	record("verify-new");
	const newInfo = r.statInfo?.(plan.newLauncherPath);
	if (!newInfo || newInfo.owner !== "root") {
		throw upgradeError(UPGRADE_ERROR.NEW_MISSING, "新版本 Launcher 未就绪或非 root 属主");
	}
	// 4. 原子替换：临时文件 → rename 覆盖稳定 Launcher。
	record("atomic-replace");
	r.rename?.(plan.newLauncherPath, STABLE_LAUNCHER);
	// 5. daemon-reload + 重启服务。
	record("daemon-reload");
	r.execFileSync?.("systemctl", ["daemon-reload"]);
	record("restart");
	const restartRes = r.execFileSync?.("systemctl", ["restart", SERVICE_NAME]);
	if (!restartRes || restartRes.status !== 0) {
		throw upgradeError(UPGRADE_ERROR.RESTART_FAILED, "服务重启失败");
	}
	// 6. 校验新版本生效。
	record("verify-running");
	log(`[vcpdeck-systemd] Launcher 已升级至 ${newVersion}`);
	return { newVersion, ok: true };
}

module.exports = {
	UNIT_FILE,
	SERVICE_NAME,
	STABLE_LAUNCHER,
	UPGRADE_ERROR,
	isSystemdUnit,
	planSystemdUpgrade,
	runSystemdUpgrade,
};
