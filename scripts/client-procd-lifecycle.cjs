/**
 * procd 生命周期与受管进程所有权账本（ADR-0065）。
 *
 * 只认 bootId + PID + 进程 starttime + UID 四元组：PID 复用、重启后的旧账本
 * 都不会被误认成同一个受管根进程。无法证明旧实例已消失时拒绝启动。
 */
const fs = require("node:fs");
const path = require("node:path");

const LEDGER_NAME = "owned-process.json";
const PROCD_TEMPLATE_NAME = "vcpdeck-client.procd";

/**
 * 账本记录与现场事实是否指向同一个进程。
 * @returns {boolean}
 */
function sameOwnedProcess(saved, live) {
	return (
		Boolean(saved) &&
		Boolean(live) &&
		saved.bootId === live.bootId &&
		saved.pid === live.pid &&
		saved.startTime === live.startTime &&
		saved.uid === live.uid
	);
}

/** 读取内核 boot_id；容器内也能读到同一值。 */
function readBootId(fsRoot = "/") {
	return fs
		.readFileSync(path.join(fsRoot, "proc/sys/kernel/random/boot_id"), "utf8")
		.trim();
}

/**
 * 读取一个 PID 的现场事实。
 * @throws {Error} `/proc` 证据缺失时抛 `PROCD_OWNER_UNPROVEN`，绝不猜测
 */
function readProcessFacts(pid, { bootId, fsRoot = "/" } = {}) {
	let stat;
	let status;
	try {
		stat = fs.readFileSync(path.join(fsRoot, `proc/${pid}/stat`), "utf8");
		status = fs.readFileSync(path.join(fsRoot, `proc/${pid}/status`), "utf8");
	} catch {
		throw new Error("PROCD_OWNER_UNPROVEN");
	}
	const commEnd = stat.lastIndexOf(")");
	const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
	const startTime = fields[19];
	const uidLine = /^Uid:\s+(\d+)/m.exec(status);
	if (startTime === undefined || !uidLine) throw new Error("PROCD_OWNER_UNPROVEN");
	return { bootId, pid, startTime, uid: Number(uidLine[1]) };
}

/**
 * 认领所有权账本。已有账本时必须先证明旧拥有者已消失，否则抛 `PROCD_OWNER_ALIVE`。
 * @returns {{reclaimed: boolean}} 是否回收了旧账本
 */
function claimOwnedLedger(ledgerPath, facts, { fsRoot = "/" } = {}) {
	try {
		fs.writeFileSync(ledgerPath, `${JSON.stringify(facts)}\n`, { flag: "wx" });
		return { reclaimed: false };
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const saved = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
	let live;
	try {
		live = readProcessFacts(saved.pid, { bootId: facts.bootId, fsRoot });
	} catch {
		live = undefined;
	}
	if (sameOwnedProcess(saved, live)) throw new Error("PROCD_OWNER_ALIVE");
	fs.writeFileSync(ledgerPath, `${JSON.stringify(facts)}\n`);
	return { reclaimed: true };
}

/** 只删除自己拥有的账本，避免覆盖后来者的记录。 */
function releaseOwnedLedger(ledgerPath, facts) {
	let saved;
	try {
		saved = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
	} catch {
		return;
	}
	if (sameOwnedProcess(saved, facts)) fs.rmSync(ledgerPath, { force: true });
}

/**
 * 渲染 procd 服务定义：绝对路径启动稳定 Launcher，term_timeout 与停机阶梯一致。
 * @param {{nodePath: string, entryPath: string, stateHome: string, appDir?: string}} values
 */
function renderProcdService(values) {
	const template = fs.readFileSync(
		path.join(__dirname, PROCD_TEMPLATE_NAME),
		"utf8",
	);
	// appDir 默认取 entryPath 的上两级（<appDir>/dist/main.js），与 install.cjs 布局一致。
	const appDir = values.appDir ?? path.dirname(path.dirname(values.entryPath));
	return template
		.replaceAll("@NODE@", values.nodePath)
		.replaceAll("@ENTRY@", values.entryPath)
		.replaceAll("@STATE_HOME@", values.stateHome)
		.replaceAll("@APP_DIR@", appDir);
}

module.exports = {
	LEDGER_NAME,
	claimOwnedLedger,
	readBootId,
	readProcessFacts,
	releaseOwnedLedger,
	renderProcdService,
	sameOwnedProcess,
};
