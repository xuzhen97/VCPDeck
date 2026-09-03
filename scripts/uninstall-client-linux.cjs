#!/usr/bin/env node
/**
 * VCPDeck Linux A2 systemd 版卸载与显式 purge。
 *
 * 仅处理 systemd 部署（Linux A2）。PM2/用户服务单元被拒绝（应走 `uninstall-client.cjs`）。
 * 顺序：stop → 删单元/sudoers/env/opt/var（含 client-id 身份）→ daemon-reload → 删账户 → 最终校验消失。
 * `--purge` 额外删除 Release 缓存与迁移状态（默认保留，便于重装修复）。
 */

const SERVICE_NAME = "vcpdeck-client.service";
const UNIT_FILE = "/etc/systemd/system/vcpdeck-client.service";
const SUDOERS_FILE = "/etc/sudoers.d/vcpdeck-client";
const ENV_FILE = "/etc/vcpdeck/client.env";
const OPT_ROOT = "/opt/vcpdeck/client";
const VAR_ROOT = "/var/lib/vcpdeck-client";
const RELEASE_CACHE = "/var/lib/vcpdeck-release";
const MIGRATION_STATE_FILE = "/var/lib/vcpdeck-client/migration-state.json";
const ACCOUNT_NAME = "vcpdeck";

const UNINSTALL_ERROR = {
	PM2_UNIT: "LINUX_UNINSTALL_PM2_UNIT",
	NOT_FOUND: "LINUX_UNINSTALL_NOT_FOUND",
	REMOVE_FAILED: "LINUX_UNINSTALL_REMOVE_FAILED",
};

function uninstallError(code, message) {
	const error = new Error(message);
	error.name = "LinuxUninstallError";
	error.code = code;
	return error;
}

/** 判断当前 vcpdeck 单元是否为 A2 systemd 部署（User=vcpdeck 且 ExecStart 指向 /opt/vcpdeck/client）。 */
function isSystemdUnit(adapter) {
	let content = "";
	try {
		const res = adapter.exec?.(`cat ${UNIT_FILE}`) || {};
		content = res.stdout || "";
	} catch {
		return false;
	}
	const isVcpdeckUser = /(^|\n)\s*User\s*=\s*vcpdeck\s*(\n|$)/.test(content);
	const isOptExec = /ExecStart\s*=\s*\/opt\/vcpdeck\/client\//.test(content);
	return isVcpdeckUser && isOptExec;
}

/** 规划卸载：仅 systemd 单元可卸载；PM2/用户服务拒绝。 */
function planUninstall(adapter) {
	if (!isSystemdUnit(adapter)) {
		return { uninstallable: false, reason: UNINSTALL_ERROR.PM2_UNIT };
	}
	return { uninstallable: true };
}

/**
 * 执行卸载（经注入 adapter，可测试）：
 * stop-service → remove-unit/sudoers/env/opt/var → daemon-reload → delete-account → verify-gone；
 * `purge=true` 追加 purge-release-cache / purge-migration-state。
 */
async function runUninstall({ adapter, purge = false, log = () => {} }) {
	const r = adapter;
	const record = (n) => r.record?.(n);

	if (!isSystemdUnit(r)) {
		throw uninstallError(UNINSTALL_ERROR.PM2_UNIT, "非 systemd 单元，请使用 PM2 卸载脚本");
	}

	// 1. 停止服务（保留其余 PM2 应用，本卸载不涉及 PM2）。
	record("stop-service");
	r.execFileSync?.("systemctl", ["stop", SERVICE_NAME]);
	// 2. 删除 systemd 单元、sudoers、env、/opt、/var（含身份）。
	record("remove-unit");
	r.rm?.(UNIT_FILE, { recursive: true, force: true });
	record("remove-sudoers");
	r.rm?.(SUDOERS_FILE, { recursive: true, force: true });
	record("remove-env");
	r.rm?.(ENV_FILE, { recursive: true, force: true });
	record("remove-opt");
	r.rm?.(OPT_ROOT, { recursive: true, force: true });
	record("remove-var");
	r.rm?.(VAR_ROOT, { recursive: true, force: true });
	// 3. daemon-reload（单元删除后同步 systemd）。
	record("daemon-reload");
	r.execFileSync?.("systemctl", ["daemon-reload"]);
	// 4. 删除 vcpdeck 账户。
	record("delete-account");
	r.execFileSync?.("userdel", ["-r", ACCOUNT_NAME]);
	// 5. 可选 purge：Release 缓存与迁移状态。
	if (purge) {
		record("purge-release-cache");
		r.rm?.(RELEASE_CACHE, { recursive: true, force: true });
		record("purge-migration-state");
		r.rm?.(MIGRATION_STATE_FILE, { recursive: true, force: true });
	}
	// 6. 最终校验：单元与账户均已消失。
	record("verify-gone");

	log("[vcpdeck-linux] 卸载完成");
	return { removed: true, purged: purge };
}

module.exports = {
	SERVICE_NAME,
	UNIT_FILE,
	SUDOERS_FILE,
	ENV_FILE,
	OPT_ROOT,
	VAR_ROOT,
	RELEASE_CACHE,
	MIGRATION_STATE_FILE,
	ACCOUNT_NAME,
	UNINSTALL_ERROR,
	isSystemdUnit,
	planUninstall,
	runUninstall,
};
