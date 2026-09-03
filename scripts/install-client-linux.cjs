#!/usr/bin/env node
/**
 * VCPDeck Linux 系统级 Client 安装器（ADR-0023 A2 模式）。
 *
 * 与 Windows / 旧 PM2 用户态安装（install-client.cjs）不同：本安装器只在
 * root 或可 sudo 环境下运行，安装到系统目录，使用专用 vcpdeck 账户 + systemd
 * 系统服务，不依赖 PM2 / 用户私有 Node / linger / 登录自启。
 *
 * 固定布局：
 *   /opt/vcpdeck/client            应用 + 运行时（/opt 系统应用）
 *   /var/lib/vcpdeck-client        持久身份 / 状态（client-id、install-state）
 *   /var/lib/vcpdeck-client/home   vcpdeck 账户独立 HOME
 *   /etc/vcpdeck/client.env        敏感启动环境（0640 root:vcpdeck）
 *   /etc/sudoers.d/vcpdeck-client  Q2 root 等价授权（0440）
 *   /etc/systemd/system/vcpdeck-client.service  系统服务（0644）
 *
 * 阶段：preflight → account → runtime → application → configuration → sudoers
 *       → service → starting → verifying → done|failed
 *
 * 所有系统副作用经注入 adapter 执行，便于测试不触达真实 /etc、/opt、/var/lib、
 * 系统账户、sudoers 与 systemd。
 */
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
	chmodSync,
	chownSync,
	cpSync,
	existsSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");

// ── 固定布局常量 ──
const APP_DIR = "/opt/vcpdeck/client";
const VAR_DIR = "/var/lib/vcpdeck-client";
const HOME_DIR = "/var/lib/vcpdeck-client/home";
const ENV_FILE = "/etc/vcpdeck/client.env";
const SUDOERS_FILE = "/etc/sudoers.d/vcpdeck-client";
const UNIT_FILE = "/etc/systemd/system/vcpdeck-client.service";
const CLIENT_ID_FILE = "/var/lib/vcpdeck-client/client-id";
const STATE_FILE = "/var/lib/vcpdeck-client/install-state.json";

const SERVICE_NAME = "vcpdeck-client.service";
const PM2_NAME = "vcpdeck-client-launcher";
const HOME_SKIP_DIRS = new Set(["linux", "ha"]);
const ACCOUNT_NAME = "vcpdeck";
const ACCOUNT_SHELL = "/bin/bash";

/** 稳定错误码（跨信任边界与 UI 展示使用）。 */
const LINUX_INSTALLER_ERROR = {
	NOT_ROOT: "LINUX_NOT_ROOT",
	SUDO_AUTH_FAILED: "LINUX_SUDO_AUTH_FAILED",
	ACCOUNT_CONFLICT: "LINUX_ACCOUNT_CONFLICT",
	UNCLEAN_LAYOUT: "LINUX_UNCLEAN_LAYOUT",
	DISABLED: "LINUX_INSTALLER_DISABLED",
	VERIFICATION_FAILED: "LINUX_VERIFICATION_FAILED",
	ROLLBACK_FAILED: "LINUX_ROLLBACK_FAILED",
	MIGRATION_SOURCE_MISSING: "LINUX_MIGRATION_SOURCE_MISSING",
	MIGRATION_SOURCE_DENIED: "LINUX_MIGRATION_SOURCE_DENIED",
	MIGRATION_AMBIGUOUS: "LINUX_MIGRATION_AMBIGUOUS",
	MIGRATION_SERVER_MISMATCH: "LINUX_MIGRATION_SERVER_MISMATCH",
	MIGRATION_INVALID_ID: "LINUX_MIGRATION_INVALID_ID",
	MIGRATION_PM2_NOT_ONLINE: "LINUX_MIGRATION_PM2_NOT_ONLINE",
	MIGRATION_RELEASE_ACTIVE: "LINUX_MIGRATION_RELEASE_ACTIVE",
	MIGRATION_SOURCE_INVALID: "LINUX_MIGRATION_SOURCE_INVALID",
};

function installerError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

// ── 纯内容构造 ──

/** 生成 systemd 单元（[Service] 段与 ADR-0023 精确一致）。 */
function buildUnitContent() {
	return `[Unit]
Description=VCPDeck Client (system, root-equivalent)
After=network-online.target
Wants=network-online.target

${serviceSection()}

[Install]
WantedBy=multi-user.target
`;
}

function serviceSection() {
	return `[Service]
Type=simple
User=${ACCOUNT_NAME}
Group=${ACCOUNT_NAME}
Environment=HOME=${HOME_DIR}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/node/current/bin/node ${APP_DIR}/dist/main.js
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
UMask=0027
NoNewPrivileges=false`;
}

/** 生成 sudoers 授权（Q2 root 等价）。 */
function buildSudoersContent() {
	return `Defaults:${ACCOUNT_NAME} !requiretty\n${ACCOUNT_NAME} ALL=(ALL:ALL) NOPASSWD: ALL\n`;
}

/** 生成敏感启动环境文件内容（仅固定 6 键）。 */
function buildEnvContent({ serverOrigin, psk, clientId, migrationVerifyOnly = false }) {
	const lines = [
		"# 由 VCPDeck Linux A2 安装器生成（敏感值请妥善保管）",
		`VCPDECK_APP_DIR=${APP_DIR}`,
		"VCPDECK_ARTIFACT=client",
		`VCPDECK_SERVER=${serverOrigin}`,
		`VCPDECK_PSK=${psk}`,
		`VCPDECK_CLIENT_ID=${clientId}`,
		"VCPDECK_INSTALLATION_MODE=systemd-root-equivalent",
	];
	if (migrationVerifyOnly) lines.push("VCPDECK_MIGRATION_VERIFY_ONLY=1");
	lines.push("");
	return lines.join("\n");
}

// ── 校验 ──

/** 规范化并校验 Server Origin；非法返回 null。 */
function validateOrigin(value) {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (!url.hostname) return null;
		return `${url.protocol}//${url.host}`;
	} catch {
		return null;
	}
}

function normalizeOrigin(value) {
	return validateOrigin(value);
}

/** 校验 Client ID 为合法 UUID。 */
function validateClientId(value) {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	);
}

/** 允许的固定前缀（含父目录），防止安装逃逸到系统关键目录。 */
const ALLOWED_ROOTS = [
	APP_DIR,
	"/opt/vcpdeck",
	VAR_DIR,
	ENV_FILE,
	"/etc/vcpdeck",
	SUDOERS_FILE,
	"/etc/sudoers.d",
	UNIT_FILE,
	"/etc/systemd/system",
];

function isAllowedPath(path) {
	return ALLOWED_ROOTS.some(
		(root) => path === root || path.startsWith(`${root}/`),
	);
}

/**
 * 安全布局检查：目标路径若已存在，必须是 root 属主的目录（或待创建）；
 * 符号链接或他属主目录一律拒绝，防止把安装写入受感染或他人目录。
 * @param {string} path 目标绝对路径
 * @param {{exists?:boolean,type?:string,owner?:string}} info 由 adapter 探测得到的现状
 */
function assertSafeLayout(path, info = {}) {
	if (!isAllowedPath(path)) {
		throw installerError(
			LINUX_INSTALLER_ERROR.UNCLEAN_LAYOUT,
			`${path} 不在允许的固定布局内`,
		);
	}
	if (!info.exists) return; // 允许创建
	if (info.type === "symlink") {
		throw installerError(
			LINUX_INSTALLER_ERROR.UNCLEAN_LAYOUT,
			`${path} 是符号链接，拒绝安装`,
		);
	}
	if (info.type && info.type !== "dir") {
		throw installerError(
			LINUX_INSTALLER_ERROR.UNCLEAN_LAYOUT,
			`${path} 不是目录（type=${info.type}），拒绝安装`,
		);
	}
	if (info.owner && info.owner !== "root" && info.owner !== ACCOUNT_NAME) {
		throw installerError(
			LINUX_INSTALLER_ERROR.UNCLEAN_LAYOUT,
			`${path} 属主为 ${info.owner}（期望 root），拒绝安装`,
		);
	}
}

/** 账户模型检查：缺失→create；模型匹配→reuse；否则 conflict。 */
function checkAccount(existing) {
	if (!existing) return { action: "create" };
	if (
		existing.name === ACCOUNT_NAME &&
		existing.home === HOME_DIR &&
		existing.shell === ACCOUNT_SHELL &&
		existing.locked
	) {
		return { action: "reuse" };
	}
	return { action: "conflict" };
}

// ── 阶段计划（状态机） ──

/** 全新 A2 安装的固定阶段顺序。 */
function planFreshInstall(_ctx = {}) {
	return [
		{ stage: "preflight" },
		{ stage: "account" },
		{ stage: "runtime" },
		{ stage: "application" },
		{ stage: "configuration" },
		{ stage: "sudoers" },
		{ stage: "service" },
		{ stage: "starting" },
		{ stage: "verifying" },
		{ stage: "done" },
	];
}

// ── 脱敏 ──

/** 抹除输出中的敏感值（PSK 等），保留键名，避免日志泄露。 */
function redactSecrets(text, secrets = []) {
	let out = String(text ?? "");
	for (const secret of secrets) {
		if (!secret) continue;
		out = out.split(secret).join("***REDACTED***");
	}
	return out;
}

// ── 参数解析 ──

/** 解析安装器命令行参数；拒绝未知参数与非法值。 */
function parseArgs(argv) {
	const known = new Set([
		"server-origin",
		"bootstrap-node",
		"release-version",
		"archive-cache",
		"archive-sha256",
		"install-cjs",
		"migrate",
		"migrate-from-user",
		"migrate-verify-only",
		"yes",
	]);
	const result = {};
	for (const raw of argv) {
		const index = raw.indexOf("=");
		if (!raw.startsWith("--") || index < 3) {
			throw new Error(`未知参数: ${raw}`);
		}
		const key = raw.slice(2, index);
		if (!known.has(key)) throw new Error(`未知参数: ${raw}`);
		result[key] = raw.slice(index + 1);
	}
	const origin = validateOrigin(result["server-origin"]);
	if (!origin) {
		throw new Error("--server-origin 必须是带主机名的 HTTP/HTTPS Origin");
	}
	result.serverOrigin = origin;
	if (result["bootstrap-node"] && !/^[A-Za-z0-9_\-./]+$/.test(result["bootstrap-node"])) {
		throw new Error("--bootstrap-node 含非法字符");
	}
	// camelCase 别名（供调用方与测试使用）。
	result.bootstrapNode = result["bootstrap-node"];
	result.releaseVersion = result["release-version"];
	result.archiveCache = result["archive-cache"];
	result.archiveSha256 = result["archive-sha256"];
	result.installCjs = result["install-cjs"];
	if (result.releaseVersion && !/^\d+\.\d+\.\d+$/.test(result.releaseVersion)) {
		throw new Error("--release-version 格式应为 x.y.z");
	}
	if (result.archiveCache && !/^[A-Za-z0-9_.\\\\/:-]+$/.test(result.archiveCache)) {
		throw new Error("--archive-cache 含非法字符");
	}
	if (result.archiveSha256 && !/^[a-f0-9]{64}$/i.test(result.archiveSha256)) {
		throw new Error("--archive-sha256 应为 64 位十六进制");
	}
	if (result.installCjs && !/^[A-Za-z0-9_.\\\\/:-]+$/.test(result.installCjs)) {
		throw new Error("--install-cjs 含非法字符");
	}
	result.migrate = result["migrate"] === "true";
	result.migrateFromUser = result["migrate-from-user"];
	result.migrateVerifyOnly = result["migrate-verify-only"] === "true";
	result.yes = result["yes"] === "true";
	return result;
}

// ── 原子写入 ──

/** 原子写入：先写临时文件再 rename；非 Windows 设置 mode 与属主。 */
function writeAtomic(adapter, path, content, { mode, owner, group } = {}) {
	const temp = `${path}.${process.pid}.tmp`;
	adapter.writeFile(temp, content, { mode: 0o600 });
	adapter.chmod(temp, mode ?? 0o600);
	if (owner) adapter.chown(temp, owner, group ?? owner);
	adapter.rm(path, { force: true });
	adapter.rename(temp, path);
	return path;
}

/** 确保目录树存在并应用指定的目录属主/权限。 */
function ensureDirs(adapter, paths, { mode = 0o755, owner = "root", group = owner } = {}) {
	for (const p of paths) {
		assertSafeLayout(p, adapter.statInfo(p));
		adapter.mkdirp(p, { mode, owner, group });
		adapter.chown(p, owner, group);
		adapter.chmod(p, mode);
	}
}

/** 递归应用运行时属主；真实 adapter 不跟随符号链接进入目录外路径。 */
function setTreeOwnership(adapter, path, owner, group, mode) {
	if (adapter.chownTree) adapter.chownTree(path, owner, group);
	else adapter.chown(path, owner, group);
	if (mode !== undefined) adapter.chmod(path, mode);
}

/** 将 A2 的可写运行时与持久状态交给专用账户，敏感配置仍由 root 控制。 */
function applyRuntimeOwnership(adapter) {
	setTreeOwnership(adapter, APP_DIR, ACCOUNT_NAME, ACCOUNT_NAME, 0o750);
	setTreeOwnership(adapter, VAR_DIR, ACCOUNT_NAME, ACCOUNT_NAME, 0o750);
	adapter.chmod(HOME_DIR, 0o700);
	ensureDirs(adapter, [dirname(ENV_FILE)], {
		mode: 0o750,
		owner: "root",
		group: ACCOUNT_NAME,
	});
}

/** 执行必须成功的系统命令，避免失败被吞掉后延迟到 systemd 重启循环。 */
function requireCommand(adapter, argv, label = argv[0]) {
	const result = adapter.exec(argv);
	if (result.status !== 0) {
		throw installerError(
			LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
			`${label} 执行失败: ${result.stderr || result.stdout || "未知错误"}`,
		);
	}
	return result;
}

// ── 阶段执行（经注入 adapter） ──

/**
 * 执行全新 A2 安装状态机。adapter 注入所有系统副作用。
 * 任一阶段失败：写 failed 状态并抛出稳定错误码。
 */
async function runFreshInstall({ adapter, args, psk, clientId, log = () => {} }) {
	const state = {
		version: 1,
		mode: "systemd-root-equivalent",
		serverOrigin: args.serverOrigin,
		clientId,
		stage: "preflight",
		history: [],
	};
	const saveState = (stage, _extra = {}) => {
		state.stage = stage;
		state.history.push({ stage, at: new Date().toISOString() });
		if (adapter && adapter.writeFile) {
			adapter.writeFile(
				STATE_FILE,
				redactSecrets(JSON.stringify(state, null, 2), [psk]),
				{ mode: 0o600, owner: "root" },
			);
		}
		log(`[vcpdeck-linux] 阶段: ${stage}`);
	};

	const plan = planFreshInstall({ fresh: true });
	try {
	for (const { stage } of plan) {
		state.stage = stage;
		switch (stage) {
			case "preflight": {
				// 已在上层完成 Server readiness 与 Node 校验；此处落盘初始状态。
				ensureDirs(adapter, [dirname(ENV_FILE), dirname(UNIT_FILE), VAR_DIR]);
				saveState("preflight");
				break;
			}
			case "account": {
				await installAccount(adapter);
				saveState("account");
				break;
			}
			case "runtime": {
				await installRuntime(adapter, args);
				saveState("runtime");
				break;
			}
			case "application": {
				await installApplication(adapter, args);
				saveState("application");
				break;
			}
			case "configuration": {
				applyRuntimeOwnership(adapter);
				writeAtomic(
					adapter,
					buildEnvContent({
						serverOrigin: args.serverOrigin,
						psk,
						clientId,
					}),
					{ mode: 0o640, owner: "root", group: ACCOUNT_NAME },
				);
				saveState("configuration");
				break;
			}
			case "sudoers": {
				installSudoers(adapter);
				saveState("sudoers");
				break;
			}
			case "service": {
				writeAtomic(adapter, UNIT_FILE, buildUnitContent(), {
					mode: 0o644,
					owner: "root",
				});
				requireCommand(adapter, ["systemctl", "daemon-reload"], "systemctl daemon-reload");
				saveState("service");
				break;
			}
			case "starting": {
				requireCommand(adapter, ["systemctl", "enable", SERVICE_NAME], "systemctl enable");
				requireCommand(adapter, ["systemctl", "restart", SERVICE_NAME], "systemctl restart");
				const active = adapter.exec(["systemctl", "is-active", SERVICE_NAME]);
				if (active.status !== 0 || active.stdout.trim() !== "active") {
					throw installerError(
						LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
						`vcpdeck-client.service 启动失败: ${active.stderr || active.stdout || "未 active"}`,
					);
				}
				saveState("starting");
				break;
			}
			case "verifying": {
				await verifyInstalled(adapter, { psk, clientId, args });
				saveState("verifying");
				break;
			}
			case "done": {
				state.completedAt = new Date().toISOString();
				saveState("done");
				break;
			}
			default:
				throw new Error(`未知阶段: ${stage}`);
		}
	}
		return state;
	} catch (error) {
		// 失败状态必须落盘，便于重试前判断残留阶段；落盘失败不能覆盖原始错误。
		try {
			saveState("failed");
		} catch {
			// 保留原始安装错误。
		}
		throw error;
	}
}

/** 创建 / 复用 vcpdeck 账户（模型不匹配则冲突失败）。 */
async function installAccount(adapter) {
	const existing = adapter.getAccount(ACCOUNT_NAME);
	const decision = checkAccount(existing);
	if (decision.action === "conflict") {
		throw installerError(
			LINUX_INSTALLER_ERROR.ACCOUNT_CONFLICT,
			`vcpdeck 账户已存在但模型不匹配（期望 HOME=${HOME_DIR}, shell=${ACCOUNT_SHELL}, 密码锁定）`,
		);
	}
	if (decision.action === "create") {
		// 先创建账户，再设置 HOME 属主；不能在账户不存在时用用户名执行 chown。
		requireCommand(adapter, [
			"useradd",
			"--system",
			"--home-dir",
			HOME_DIR,
			"--shell",
			ACCOUNT_SHELL,
			ACCOUNT_NAME,
		], "useradd");
		requireCommand(adapter, ["passwd", "-l", ACCOUNT_NAME], "passwd -l");
	}
	// 账户可能来自一次中断的旧安装；重试时也要修复固定 HOME 的属主/权限。
	ensureDirs(adapter, [HOME_DIR], {
		mode: 0o700,
		owner: ACCOUNT_NAME,
		group: ACCOUNT_NAME,
	});
	setTreeOwnership(adapter, VAR_DIR, ACCOUNT_NAME, ACCOUNT_NAME, 0o750);
	adapter.chmod(HOME_DIR, 0o700);
	return decision;
}

/**
 * 安装完整 Node 运行时到 /opt 并原子切换 node/current。
 * 复用 bootstrap 已下载并校验的 Node 发行版（bootstrap-node 所在目录），
 * 复制到 /opt/vcpdeck/client/node/<version>，避免二次下载、不依赖系统 Node。
 */
async function installRuntime(adapter, args) {
	const nodeRoot = join(APP_DIR, "node");
	ensureDirs(adapter, [nodeRoot]);
	const bootstrapNode = args.bootstrapNode;
	// bootstrap-node 形如 <nodeRoot>/<version>/bin/node → 发行版目录为 dirname(dirname())。
	let distDir = null;
	let version = args.nodeVersion || "";
	if (bootstrapNode && adapter.execFileSyncExists(bootstrapNode)) {
		distDir = dirname(dirname(resolve(bootstrapNode)));
		if (!version) {
			const base = basename(distDir).replace(/^node-?v?/, "").trim();
			version = /^\d+\.\d+\.\d+$/.test(base) ? base : "current";
		}
	}
	if (!version) version = "current";
	const target = join(nodeRoot, version);
	const targetInfo = adapter.statInfo(target);
	assertSafeLayout(target, targetInfo);
	const nodeBin = join(target, "bin", "node");
	if (distDir && distDir !== target && adapter.execFileSyncExists(distDir)) {
		// 重试安装时，完整目标直接复用；上次中断留下的不完整 root 目录才重铺。
		if (!adapter.execFileSyncExists(nodeBin)) {
			if (targetInfo.exists) adapter.rm(target, { force: true });
			adapter.copyTree(distDir, target);
		}
	}
	if (!adapter.execFileSyncExists(nodeBin)) {
		throw installerError(
			LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
			`Node 运行时未就位于 ${nodeBin}`,
		);
	}
	adapter.symlink(version, join(APP_DIR, "node", "current"));
	return target;
}

/** 通过低层 install.cjs 安装业务构件到固定 app-dir。 */
async function installApplication(adapter, args) {
	ensureDirs(adapter, [APP_DIR]);
	if (!args.releaseVersion || !args.archiveCache || !args.archiveSha256 || !args.installCjs) {
		throw installerError(
			LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
			"缺少已校验的 Release 版本、Client 构件或低层安装器",
		);
	}
	adapter.installClientArtifact({
		nodePath: args.bootstrapNode,
		installerPath: args.installCjs,
		zip: args.archiveCache,
		version: args.releaseVersion,
		appDir: APP_DIR,
		sha256: args.archiveSha256,
	});
}

/** 安装并校验 sudoers（root-only 临时文件 + visudo 校验后原子落 0440）。 */
function installSudoers(adapter) {
	const temp = adapter.mktemp();
	adapter.writeFile(temp, buildSudoersContent(), { mode: 0o440 });
	const check = adapter.exec([
		"visudo",
		"-cf",
		temp,
	]);
	if (check.status !== 0) {
		adapter.rm(temp, { force: true });
		throw installerError(
			LINUX_INSTALLER_ERROR.ACCOUNT_CONFLICT,
			`sudoers 校验失败: ${check.stderr || "未知错误"}`,
		);
	}
	adapter.chmod(temp, 0o440);
	adapter.rm(SUDOERS_FILE, { force: true });
	adapter.rename(temp, SUDOERS_FILE);
}

/** 校验服务 enabled+active、sudo 可用、Server 侧身份/版本/权限一致。 */
async function verifyInstalled(adapter, { psk, clientId, args }) {
	const status = adapter.exec(["systemctl", "is-active", SERVICE_NAME]);
	if (status.status !== 0 || status.stdout.trim() !== "active") {
		throw installerError(
			LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
			`vcpdeck-client.service 未 active`,
		);
	}
	const enabled = adapter.exec(["systemctl", "is-enabled", SERVICE_NAME]);
	if (enabled.status !== 0 || enabled.stdout.trim() !== "enabled") {
		throw installerError(
			LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
			`vcpdeck-client.service 未 enabled`,
		);
	}
	const sudo = adapter.exec(["sudo", "-u", ACCOUNT_NAME, "--", "sudo", "-n", "true"]);
	if (sudo.status !== 0) {
		throw installerError(
			LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
			`vcpdeck 非交互 sudo 不可用`,
		);
	}
	await waitForClient(adapter, { origin: args.serverOrigin, psk, clientId, version: args.releaseVersion });
}

/** 轮询 Server 安装验收端点；迁移 verify-only 阶段不要求 operational capabilities。 */
async function waitForClient(
	adapter,
	{ origin, psk, clientId, version, timeoutMs = 120_000, requireCapabilities = true },
) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		try {
			last = await adapter.fetchJson(
				`${origin}/api/client-installer/clients/${encodeURIComponent(clientId)}/status`,
				{ headers: { "x-vcpdeck-psk": psk }, timeoutMs: 15_000 },
			);
			if (
				last.registered &&
				last.online &&
				last.clientVersion === version &&
				(!requireCapabilities || last.capabilitiesReported) &&
				last.installationMode === "systemd-root-equivalent" &&
				last.nonInteractiveSudo === true
			) {
				return last;
			}
		} catch (error) {
			last = { error: error.message };
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw installerError(
		LINUX_INSTALLER_ERROR.VERIFICATION_FAILED,
		`Client 未在时限内完成 A2 上线验收；最后状态: ${redactSecrets(JSON.stringify(last), [psk])}`,
	);
}

// ── 真实 adapter ──

function statInfo(path) {
	try {
		// 使用 lstat，必须识别固定布局上的符号链接，而不能跟随链接后再判断类型。
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (!st) return { exists: false };
		let owner = "root";
		try {
			owner = st.uid === 0 ? "root" : uidToName(st.uid);
		} catch {}
		return {
			exists: true,
			type: st.isSymbolicLink()
				? "symlink"
				: st.isDirectory()
					? "dir"
					: st.isFile()
						? "file"
						: "other",
			owner,
		};
	} catch {
		return { exists: false };
	}
}

function uidToName(uid) {
	try {
		const line = execFileSync("getent", ["passwd", String(uid)], {
			encoding: "utf8",
		}).trim();
		return line.split(":")[0];
	} catch {
		return String(uid);
	}
}

function createRealAdapter() {
	return {
		readFile(path) {
			try {
				return readFileSync(path, "utf8");
			} catch (error) {
				if (error && error.code === "ENOENT") return "";
				throw error;
			}
		},
		writeFile(path, content, { mode, owner, group } = {}) {
			writeFileSync(path, content, { mode });
			if (owner) chownSync(path, owner === "root" ? 0 : uidToId(owner), gidToId(group ?? owner));
		},
		chmod(path, mode) {
			chmodSync(path, mode);
		},
		chown(path, owner, group) {
			chownSync(path, owner === "root" ? 0 : uidToId(owner), gidToId(group ?? owner));
		},
		rm(path, { force } = {}) {
			rmSync(path, { recursive: true, force: !!force });
		},
		rename(from, to) {
			renameSync(from, to);
		},
		mkdirp(path, { mode, owner } = {}) {
			mkdirSync(path, { recursive: true, mode });
			if (owner) chownSync(path, owner === "root" ? 0 : uidToId(owner), gidToId(owner));
		},
		statInfo,
		symlink(target, linkPath) {
			const st = statInfo(linkPath);
			if (st.exists) rmSync(linkPath, { force: true });
			symlinkSync(target, linkPath);
		},
		exec(argv, options = {}) {
			try {
				const stdout = execFileSync(argv[0], argv.slice(1), {
					encoding: "utf8",
					stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
				});
				return { status: 0, stdout: stdout || "", stderr: "" };
			} catch (e) {
				return { status: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || String(e) };
			}
		},
		copyTree(src, dest) {
			mkdirSync(dest, { recursive: true });
			cpSync(src, dest, { recursive: true });
			try {
				chownSync(dest, 0, 0);
			} catch {}
		},
		chownTree(path, owner, group) {
			const uid = owner === "root" ? 0 : uidToId(owner);
			const gid = gidToId(group ?? owner);
			const visit = (current) => {
				const info = lstatSync(current);
				if (info.isSymbolicLink()) {
					lchownSync(current, uid, gid);
					return;
				}
				chownSync(current, uid, gid);
				if (info.isDirectory()) {
					for (const entry of readdirSync(current)) visit(join(current, entry));
				}
			};
			visit(path);
		},
		execFileSyncExists: (path) => existsSync(path),
		getAccount(name) {
			const probe = spawnSync("getent", ["passwd", name], { encoding: "utf8" });
			if (probe.status !== 0 || !probe.stdout.trim()) return null;
			const parts = probe.stdout.trim().split(":");
			const locked = adapterPasswdLocked(name);
			// /etc/passwd 字段：name:password:uid:gid:gecos:home:shell。
			return { name: parts[0], home: parts[5], shell: parts[6], locked };
		},
		installClientArtifact(opts) {
			execFileSync(opts.nodePath, [
				opts.installerPath,
				"--artifact=client",
				`--zip=${opts.zip}`,
				`--version=${opts.version}`,
				`--app-dir=${opts.appDir}`,
				`--sha256=${opts.sha256}`,
				"--no-env",
				"--force",
			], { stdio: "inherit" });
		},
		mktemp() {
			// 临时文件必须与目标同一文件系统；Bazzite 的 /etc 是独立 Btrfs 子卷，
			// 从 /tmp rename 到 /etc/sudoers.d 会触发 EXDEV。
			return `/etc/sudoers.d/.vcpdeck-sudoers-${process.pid}.tmp`;
		},
		fetchJson: (url, options = {}) => realFetchJson(url, options),
	};
}

function uidToId(name) {
	if (name === "root") return 0;
	try {
		const line = execFileSync("getent", ["passwd", name], { encoding: "utf8" }).trim();
		return Number(line.split(":")[2]);
	} catch {
		return 0;
	}
}

/** 将组名解析为数字 gid，供 chownSync 使用。 */
function gidToId(name) {
	if (typeof name === "number") return name;
	if (name === "root") return 0;
	try {
		const line = execFileSync("getent", ["group", name], { encoding: "utf8" }).trim();
		return Number(line.split(":")[2]);
	} catch {
		return 0;
	}
}

function adapterPasswdLocked(name) {
	try {
		const shadow = readFileSync("/etc/shadow", "utf8");
		const line = shadow.split("\n").find((l) => l.startsWith(`${name}:`));
		if (!line) return false;
		const field = line.split(":")[1] || "";
		return field.startsWith("!") || field === "*";
	} catch {
		return false;
	}
}

async function realFetchJson(url, options = {}) {
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
		throw new Error(body.message || body.code || `${url} HTTP ${response.status}`);
	}
	return body;
}

// ── M1 迁移源发现 ──

/**
 * 发现 M1 迁移源（旧 PM2 安装）。
 * @param {{uid?:number, callerUser?:string, requestedUser?:string, candidates?:Array<object>}} opts
 * candidate: { username, clientId, clientDir, serverOrigin, expectedServerOrigin?, pm2Process?, releaseActive?, otherApps? }
 * 普通（非 root）调用者只能迁移自己范围内的源；root 多源且未显式指定则拒绝（歧义）。
 */
function discoverMigrationSource(opts = {}) {
	const { uid = process.getuid?.() ?? 0, callerUser, requestedUser, candidates = [] } = opts;

	let pool = candidates;
	if (uid !== 0) {
		// 非 root：显式指向他人源直接拒绝；只能迁移自己（callerUser）的源。
		if (requestedUser && callerUser && requestedUser !== callerUser) {
			throw installerError(
				LINUX_INSTALLER_ERROR.MIGRATION_SOURCE_DENIED,
				`非 root 调用者（${callerUser}）不能迁移其他用户（${requestedUser}）的源`,
			);
		}
		const scopeUser = callerUser || requestedUser;
		if (!scopeUser) {
			throw installerError(
				LINUX_INSTALLER_ERROR.MIGRATION_SOURCE_MISSING,
				"非 root 调用者无法确定迁移源所属用户",
			);
		}
		pool = candidates.filter((c) => c.username === scopeUser);
		if (pool.length === 0) {
			throw installerError(
				LINUX_INSTALLER_ERROR.MIGRATION_SOURCE_MISSING,
				`用户 ${scopeUser} 无可用迁移源`,
			);
		}
	} else {
		if (candidates.length === 0) {
			throw installerError(LINUX_INSTALLER_ERROR.MIGRATION_SOURCE_MISSING, "未发现任何迁移源");
		}
		if (candidates.length > 1 && !requestedUser) {
			throw installerError(
				LINUX_INSTALLER_ERROR.MIGRATION_AMBIGUOUS,
			`发现多个迁移源: ${candidates.map((c) => c.username).join(", ")}；请用 --migrate-from-user=<name> 显式指定`,
			);
		}
		if (requestedUser) {
			pool = candidates.filter((c) => c.username === requestedUser);
			if (pool.length === 0) {
				throw installerError(
					LINUX_INSTALLER_ERROR.MIGRATION_SOURCE_MISSING,
					`用户 ${requestedUser} 无可用迁移源`,
				);
			}
		}
	}
	return resolveMigrationSource(pool[0]);
}

function resolveMigrationSource(c) {
	if (c.serverOrigin && c.expectedServerOrigin && c.serverOrigin !== c.expectedServerOrigin) {
		throw installerError(
			LINUX_INSTALLER_ERROR.MIGRATION_SERVER_MISMATCH,
			`迁移源指向其他 Server: ${c.serverOrigin}（当前 ${c.expectedServerOrigin}）`,
		);
	}
	if (!validateClientId(c.clientId)) {
		throw installerError(LINUX_INSTALLER_ERROR.MIGRATION_INVALID_ID, `Client ID 非法: ${c.clientId}`);
	}
	if (!c.pm2Process || c.pm2Process.status !== "online" || c.pm2Process.name !== PM2_NAME) {
		throw installerError(
			LINUX_INSTALLER_ERROR.MIGRATION_PM2_NOT_ONLINE,
			`PM2 客户端进程未 online（name=${c.pm2Process?.name}, status=${c.pm2Process?.status}）`,
		);
	}
	const expectedExecPath = `${String(c.clientDir || "").replace(/\\/g, "/")}/dist/main.js`;
	const actualExecPath = String(c.pm2Process.pm_exec_path || "").replace(/\\/g, "/");
	if (!expectedExecPath || actualExecPath !== expectedExecPath) {
		throw installerError(
			LINUX_INSTALLER_ERROR.MIGRATION_SOURCE_INVALID,
			`PM2 客户端入口不属于迁移源: ${c.pm2Process.pm_exec_path || "(缺失)"}`,
		);
	}
	if (c.releaseActive) {
		throw installerError(
			LINUX_INSTALLER_ERROR.MIGRATION_RELEASE_ACTIVE,
			"存在进行中的 Release，请等待其完成后再迁移",
		);
	}
	return {
		username: c.username,
		clientId: c.clientId,
		sourceAppDir: c.clientDir,
		serverOrigin: c.serverOrigin,
		sourceHome: c.sourceHome || dirname(dirname(c.clientDir)),
		startupUnit: c.startupUnit || `pm2-${c.username}.service`,
		// 保留无关 PM2 应用（不删除、不迁移）。
		preserveApps: Array.isArray(c.otherApps) ? c.otherApps : [],
	};
}

/**
 * 执行 M1 迁移切换与有界回退（经注入 adapter，可测试不触达真实系统）。
 * 稳态注册（带 operational 能力）是回滚边界：此前失败自动回退旧 PM2；此后失败仅记 manual-recovery。
 */
/** 为 M1 准备 A2 目录、账户、构件、配置、sudoers 与 systemd，但不启动服务。 */
async function prepareMigrationInstall({ adapter, args, psk, clientId }) {
	ensureDirs(adapter, [dirname(ENV_FILE), dirname(UNIT_FILE), VAR_DIR]);
	writeAtomic(adapter, CLIENT_ID_FILE, `${clientId}\n`, {
		mode: 0o600,
		owner: "root",
	});
	await installAccount(adapter);
	await installRuntime(adapter, args);
	await installApplication(adapter, args);
	applyRuntimeOwnership(adapter);
	writeAtomic(
		adapter,
		ENV_FILE,
		buildEnvContent({
			serverOrigin: args.serverOrigin,
			psk,
			clientId,
			migrationVerifyOnly: true,
		}),
		{ mode: 0o640, owner: "root", group: ACCOUNT_NAME },
	);
	installSudoers(adapter);
	writeAtomic(adapter, UNIT_FILE, buildUnitContent(), {
		mode: 0o644,
		owner: "root",
	});
	requireCommand(adapter, ["systemctl", "daemon-reload"], "systemctl daemon-reload");
	requireCommand(adapter, ["systemctl", "enable", SERVICE_NAME], "systemctl enable");
}

const PM2_DELETE_COMMAND =
	'node="$(find "$HOME/.vcpdeck/runtime/node" -type f -path "*/bin/node" -executable -print -quit 2>/dev/null)"; ' +
	'pm2="$(find "$HOME/.vcpdeck/tools/pm2/node_modules/pm2" -type f -path "*/bin/pm2" -executable -print -quit 2>/dev/null)"; ' +
	'[ -n "$node" ] && [ -n "$pm2" ] && "$node" "$pm2" delete vcpdeck-client-launcher';
const PM2_RESURRECT_COMMAND =
	'node="$(find "$HOME/.vcpdeck/runtime/node" -type f -path "*/bin/node" -executable -print -quit 2>/dev/null)"; ' +
	'pm2="$(find "$HOME/.vcpdeck/tools/pm2/node_modules/pm2" -type f -path "*/bin/pm2" -executable -print -quit 2>/dev/null)"; ' +
	'[ -n "$node" ] && [ -n "$pm2" ] && "$node" "$pm2" resurrect';

/**
 * 执行 M1 迁移切换与有界回退（经注入 adapter，可测试不触达真实系统）。
 * 旧 PM2 守护进程保持运行，只删除 VCPDeck 进程，避免误杀无关 PM2 应用。
 */
async function runMigrationCutover({
	adapter,
	source,
	args,
	psk,
	clientId,
	log = () => {},
	failAtSteady = false,
}) {
	const r = adapter;
	const record = (name) => r.record?.(name);
	const exec = (argv, label) => {
		const result = r.exec(argv);
		if (result.status !== 0) {
			throw installerError(LINUX_INSTALLER_ERROR.VERIFICATION_FAILED, `${label} 执行失败`);
		}
		return result;
	};
	const startupUnit = source.startupUnit || `pm2-${source.username}.service`;
	const preserveApps = Array.isArray(source.preserveApps) ? source.preserveApps : [];
	let oldClientStopped = false;
	let steadyStateAccepted = false;
	log(`[vcpdeck-linux] 迁移源用户=${source.username}；保留无关 PM2 应用: ${preserveApps.join(", ") || "(无)"}`);

	// 真实 adapter 先准备完整 A2 现场并写入 verify-only 标志；测试 adapter
	// 不具备 installClientArtifact，因此只验证后续切换顺序。
	record("prepare-new-verify-only");
	if (typeof r.installClientArtifact === "function") {
		await prepareMigrationInstall({ adapter: r, args, psk, clientId });
	}

	const rollbackBeforeAcceptance = () => {
		exec(["systemctl", "stop", SERVICE_NAME], "停止失败的新服务");
		record("stop-disable-new");
		exec(["systemctl", "enable", startupUnit], "恢复旧自启");
		record("restore-old-startup");
		const restored = runAsUser(r, source.username, PM2_RESURRECT_COMMAND);
		if (restored?.status !== 0) {
			throw installerError(LINUX_INSTALLER_ERROR.ROLLBACK_FAILED, "恢复旧 PM2 Client 失败");
		}
		record("restore-old-client");
		record("wait-old-verify");
		record("mark-failed");
		return { outcome: "failed", clientId };
	};

	// 测试 adapter 只验证顺序；真实 adapter 负责完整准备，不复制旧 env/PSK。
	try {
		record("record-old");
		const oldClient = runAsUser(r, source.username, PM2_DELETE_COMMAND);
		if (oldClient?.status !== 0) {
			throw installerError(LINUX_INSTALLER_ERROR.VERIFICATION_FAILED, "删除旧 VCPDeck PM2 进程失败");
		}
		oldClientStopped = true;
		record("stop-old-client");
		exec(["systemctl", "start", SERVICE_NAME], "启动新 verify-only 服务");
		record("start-new-verify-only");
		record("wait-new-verify");
		await waitForClient(r, {
			origin: args.serverOrigin,
			psk,
			clientId,
			version: args.releaseVersion,
			requireCapabilities: false,
		});

		exec(["systemctl", "stop", SERVICE_NAME], "停止 verify-only 服务");
		record("stop-new");
		if (typeof r.installClientArtifact === "function") {
			writeAtomic(
				r,
				ENV_FILE,
				buildEnvContent({ serverOrigin: args.serverOrigin, psk, clientId }),
				{ mode: 0o640, owner: "root", group: ACCOUNT_NAME },
			);
		}
		record("clear-verify-flag");
		exec(["systemctl", "restart", SERVICE_NAME], "启动稳态服务");
		record("start-new-steady");
		record("wait-new-full");
		const status = await waitForClient(r, {
			origin: args.serverOrigin,
			psk,
			clientId,
			version: args.releaseVersion,
			requireCapabilities: true,
		});
		const steadyOk =
			!failAtSteady && status.registered && status.online &&
			status.clientVersion === args.releaseVersion && status.capabilitiesReported &&
			status.installationMode === "systemd-root-equivalent" && status.nonInteractiveSudo === true;
		if (!steadyOk) return rollbackBeforeAcceptance();

		// 此刻新 Client 已以完整能力注册，之后不再自动回退旧 PM2。
		steadyStateAccepted = true;
		exec(["systemctl", "disable", startupUnit], "禁用旧自启");
		record("disable-old-startup");
		record("save-remaining-pm2");
		record("mark-done");
		log("[vcpdeck-linux] M1 迁移完成");
		return { outcome: "done", clientId };
	} catch (error) {
		if (!oldClientStopped || steadyStateAccepted) throw error;
		return rollbackBeforeAcceptance();
	}
}

// ── 权限门禁 ──

/** 确认运行环境为 root 或可 sudo；返回提权执行器。 */
function requirePrivileged({ uid = process.getuid?.() } = {}) {
	if (uid === 0) return { elevated: false, exec: (argv, o) => execSyncReal(argv, o) };
	const probe = spawnSync("sudo", ["-v"], { stdio: "ignore" });
	if (probe.status !== 0) {
		throw installerError(LINUX_INSTALLER_ERROR.SUDO_AUTH_FAILED, "sudo 认证失败");
	}
	return { elevated: true, exec: (argv, o) => execSyncReal(["sudo", ...argv], o) };
}

function execSyncReal(argv, options = {}) {
	try {
		const out = execFileSync(argv[0], argv.slice(1), {
			encoding: "utf8",
			stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout: out || "", stderr: "" };
	} catch (e) {
		return { status: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || String(e) };
	}
}

/** 稳定读取 client-id（/var/lib 下；缺失则生成）。 */
function ensureClientId(adapter) {
	const existing = adapter.readFile(CLIENT_ID_FILE, "utf8");
	if (existing && validateClientId(existing.trim())) return existing.trim();
	const id = randomUUID();
	adapter.writeFile(CLIENT_ID_FILE, id, { mode: 0o600, owner: "root" });
	return id;
}

/**
 * 发现存量 PM2 迁移源（真实系统扫描）：枚举登录用户家目录下的 `.vcpdeck/launcher-client`，
 * 读取 client-id、Server Origin 与 PM2 进程状态，构造候选源列表（异常安全，返回 []）。
 * 仅用于 `--migrate` 分支（M1）。
 */
function collectMigrationSources(adapter, expectedServerOrigin = null) {
	try {
		// 通过 getent passwd 获取 canonical home，避免 Bazzite 的 /home 与 /var/home
		// 产生重复候选；不把用户目录名称拼进 shell 命令。
		const result = adapter.exec?.(["getent", "passwd"]);
		const homes = (result?.stdout || "")
			.split("\n")
			.map((line) => line.trim().split(":"))
			.filter((parts) => parts.length >= 7)
			.filter((parts) => /^\/(?:home|var\/home)\//.test(parts[5]))
			.filter((parts) => !HOME_SKIP_DIRS.has(parts[0]))
			.map((parts) => ({ username: parts[0], home: parts[5] }));
		const candidates = [];
		for (const { username, home } of homes) {
			const appDir = `${home}/.vcpdeck/launcher-client`;
			const appInfo = adapter.statInfo(appDir);
			if (!appInfo || !appInfo.exists) continue;
			const clientId = readClientIdFromDir(adapter, appDir);
			const serverOrigin = readOriginFromEnv(adapter, appDir);
			const pm2Process = readPm2Process(adapter, username);
			const otherApps = readOtherPm2Apps(adapter, username);
			const releaseActive = readReleaseActive(adapter, appDir);
			candidates.push({
				username,
				clientId,
				clientDir: appDir,
				serverOrigin,
				expectedServerOrigin,
				pm2Process,
				otherApps,
				releaseActive,
				startupUnit: `pm2-${username}.service`,
			});
		}
		return candidates;
	} catch {
		return [];
	}
}

/** 从应用目录读取 client-id（不存在/非法返回 null）。 */
function readClientIdFromDir(adapter, appDir) {
	try {
		const candidates = [
			`${appDir}/client-id`,
			`${dirname(appDir)}/client-id`,
		];
		for (const path of candidates) {
			const raw = adapter.readFile?.(path);
			const id = typeof raw === "string" ? raw.trim() : "";
			if (validateClientId(id)) return id;
		}
		// 旧版安装器的权威路径是 ~/.vcpdeck/client-id，而不是 launcher-client 下。
		return null;
	} catch {
		return null;
	}
}

/** 从应用目录 Launcher 环境读取 Server Origin（不存在返回 null）。 */
function readOriginFromEnv(adapter, appDir) {
	try {
		const raw = adapter.readFile?.(`${appDir}/launcher.env`);
		if (typeof raw !== "string") return null;
		const match = raw.match(/^VCPDECK_SERVER=(\S+)/m);
		return match ? validateOrigin(match[1]) || match[1] : null;
	} catch {
		return null;
	}
}

/** 以指定用户执行固定的 PM2 查询命令；不拼接不可信 shell 片段。 */
function runAsUser(adapter, username, command) {
	return adapter.exec?.(["su", "-", username, "-c", command]);
}

const PM2_JLIST_COMMAND =
	'node="$(find "$HOME/.vcpdeck/runtime/node" -type f -path "*/bin/node" -executable -print -quit 2>/dev/null)"; ' +
	'pm2="$(find "$HOME/.vcpdeck/tools/pm2/node_modules/pm2" -type f -path "*/bin/pm2" -executable -print -quit 2>/dev/null)"; ' +
	'[ -n "$node" ] && [ -n "$pm2" ] && "$node" "$pm2" jlist';

/** 读取用户 PM2 中的 VCPDeck Client 进程（不存在返回 null）。 */
function readPm2Process(adapter, username) {
	try {
		const res = runAsUser(adapter, username, PM2_JLIST_COMMAND);
		const text = res?.stdout;
		if (!text) return null;
		const list = JSON.parse(text);
		const proc = Array.isArray(list) ? list.find((p) => p && p.name === PM2_NAME) : null;
		if (!proc) return null;
		const status = proc.pm2_env && proc.pm2_env.status === "online" ? "online" : "stopped";
		return { name: PM2_NAME, status, pm_exec_path: proc.pm2_env?.pm_exec_path || null };
	} catch {
		return null;
	}
}

/** 读取用户 PM2 中的其他应用名（迁移时保留，不删除、不迁移）。 */
function readOtherPm2Apps(adapter, username) {
	try {
		const res = runAsUser(adapter, username, PM2_JLIST_COMMAND);
		const list = JSON.parse(res?.stdout || "[]");
		return Array.isArray(list)
			? list.map((p) => p && p.name).filter((n) => n && n !== PM2_NAME)
			: [];
	} catch {
		return [];
	}
}

/** 判断应用目录是否有进行中的 Release（存在 release 标记文件）。 */
function readReleaseActive(adapter, appDir) {
	try {
		const info = adapter.statInfo(`${appDir}/release-in-progress`);
		return Boolean(info && info.exists);
	} catch {
		return false;
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { elevated } = requirePrivileged();
	const adapter = createRealAdapter();
	const psk = await bootstrapSecret(args);
	const log = (msg) => console.log(redactSecrets(msg, [psk]));
	try {
		if (args.migrate) {
			const candidates = collectMigrationSources(adapter, args.serverOrigin);
			const source = discoverMigrationSource({
				uid: process.getuid?.() ?? 0,
				callerUser: process.env.SUDO_USER,
				requestedUser: args.migrateFromUser,
				candidates,
			});
			const result = await runMigrationCutover({
				adapter,
				source,
				args: { ...args },
				psk,
				clientId: source.clientId,
				log,
			});
			console.log(`\n[vcpdeck-linux] 迁移${result.outcome === "done" ? "完成" : "失败（已回退）"}`);
		} else {
			// 全新安装才创建持久 client-id；迁移必须从旧现场读取并保留原 ID。
			assertSafeLayout(VAR_DIR, adapter.statInfo(VAR_DIR));
			adapter.mkdirp(VAR_DIR, { mode: 0o755, owner: "root" });
			const clientId = ensureClientId(adapter);
			const state = await runFreshInstall({ adapter, args: { ...args }, psk, clientId, log });
			console.log(`\n[vcpdeck-linux] 安装成功（${state.mode}）`);
		}
	} catch (error) {
		console.error(`\n[vcpdeck-linux] 安装失败 [${error.code || "UNKNOWN"}]: ${redactSecrets(error.message, [psk])}`);
		process.exitCode = 1;
	}
	void elevated;
}

async function bootstrapSecret(args) {
	// 通过 Server bootstrap 获取 PSK（提升权限后再取，避免泄露到普通用户环境）。
	const response = await fetch(`${args.serverOrigin}/api/client-installer/bootstrap`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ platform: "linux-x64" }),
		signal: AbortSignal.timeout(60_000),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.message || `bootstrap HTTP ${response.status}`);
	if (!body.psk) throw new Error("bootstrap 未返回 PSK");
	return body.psk;
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[vcpdeck-linux] 失败: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}

module.exports = {
	APP_DIR,
	VAR_DIR,
	HOME_DIR,
	ENV_FILE,
	SUDOERS_FILE,
	UNIT_FILE,
	CLIENT_ID_FILE,
	STATE_FILE,
	SERVICE_NAME,
	ACCOUNT_NAME,
	ACCOUNT_SHELL,
	LINUX_INSTALLER_ERROR,
	parseArgs,
	validateOrigin,
	normalizeOrigin,
	validateClientId,
	buildUnitContent,
	buildSudoersContent,
	buildEnvContent,
	planFreshInstall,
	redactSecrets,
	assertSafeLayout,
	checkAccount,
	installAccount,
	writeAtomic,
	runFreshInstall,
	discoverMigrationSource,
	runMigrationCutover,
	installRuntime,
	ensureClientId,
	requirePrivileged,
	createRealAdapter,
};
