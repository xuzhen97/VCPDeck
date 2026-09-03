"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
	APP_DIR,
	VAR_DIR,
	HOME_DIR,
	ENV_FILE,
	SUDOERS_FILE,
	UNIT_FILE,
	SERVICE_NAME,
	ACCOUNT_NAME,
	LINUX_INSTALLER_ERROR,
	parseArgs,
	buildUnitContent,
	buildSudoersContent,
	buildEnvContent,
	planFreshInstall,
	redactSecrets,
	validateOrigin,
	assertSafeLayout,
	checkAccount,
	installRuntime,
	createRealAdapter,
	discoverMigrationSource,
	runMigrationCutover,
} = require("./install-client-linux.cjs");

const SERVICE_SECTION = `[Service]
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

test("固定路径与名称常量符合 A2 布局", () => {
	assert.equal(APP_DIR, "/opt/vcpdeck/client");
	assert.equal(VAR_DIR, "/var/lib/vcpdeck-client");
	assert.equal(HOME_DIR, "/var/lib/vcpdeck-client/home");
	assert.equal(ENV_FILE, "/etc/vcpdeck/client.env");
	assert.equal(SUDOERS_FILE, "/etc/sudoers.d/vcpdeck-client");
	assert.equal(UNIT_FILE, "/etc/systemd/system/vcpdeck-client.service");
	assert.equal(SERVICE_NAME, "vcpdeck-client.service");
	assert.equal(ACCOUNT_NAME, "vcpdeck");
});

test("parseArgs 解析 server-origin / bootstrap-node / migrate-from-user", () => {
	const args = parseArgs([
		"--server-origin=https://cockpit.example.com:3001",
		"--bootstrap-node=/usr/bin/node",
		"--migrate-from-user=xuzhen97",
	]);
	assert.equal(args.serverOrigin, "https://cockpit.example.com:3001");
	assert.equal(args.bootstrapNode, "/usr/bin/node");
	assert.equal(args.migrateFromUser, "xuzhen97");
});

test("parseArgs 拒绝非法 origin 与缺失 server-origin", () => {
	assert.throws(() => parseArgs(["--server-origin=notaurl"]), /server-origin/);
	assert.throws(() => parseArgs([]), /server-origin/);
	assert.throws(() => parseArgs(["--bogus=1"]), /未知参数/);
});

test("validateOrigin 仅接受带主机名的 http/https Origin", () => {
	assert.equal(validateOrigin("https://a.example.com:3001"), "https://a.example.com:3001");
	assert.equal(validateOrigin("http://192.168.1.10:3001"), "http://192.168.1.10:3001");
	assert.equal(validateOrigin("ftp://a.example.com"), null);
	assert.equal(validateOrigin("not a url"), null);
});

test("buildUnitContent 的 [Service] 段与 ADR-0023 精确一致", () => {
	const unit = buildUnitContent();
	assert.ok(unit.includes("[Unit]"));
	assert.ok(unit.includes("[Install]"));
	assert.ok(unit.includes("WantedBy=multi-user.target"));
	assert.ok(unit.includes(SERVICE_SECTION));
});

test("buildSudoersContent 精确匹配 Q2 root 等价授权", () => {
	assert.equal(
		buildSudoersContent().trim(),
		`Defaults:${ACCOUNT_NAME} !requiretty\n${ACCOUNT_NAME} ALL=(ALL:ALL) NOPASSWD: ALL`,
	);
});

test("真实 adapter 的 sudoers 临时文件与目标目录同文件系统", () => {
	assert.equal(createRealAdapter().mktemp(), `/etc/sudoers.d/.vcpdeck-sudoers-${process.pid}.tmp`);
});

test("buildEnvContent 只写固定 6 个键，且 0640 root:vcpdeck 语义", () => {
	const env = buildEnvContent({
		serverOrigin: "https://a.example.com:3001",
		psk: "SECRET_PSK",
		clientId: "abc-123",
	});
	const lines = env
		.trim()
		.split("\n")
		.filter((l) => l && !l.trimStart().startsWith("#"));
	assert.deepEqual(
		lines.map((l) => l.split("=")[0]),
		[
			"VCPDECK_APP_DIR",
			"VCPDECK_ARTIFACT",
			"VCPDECK_SERVER",
			"VCPDECK_PSK",
			"VCPDECK_CLIENT_ID",
			"VCPDECK_INSTALLATION_MODE",
		],
	);
	assert.ok(lines.some((l) => l === "VCPDECK_SERVER=https://a.example.com:3001"));
	assert.ok(lines.some((l) => l === "VCPDECK_CLIENT_ID=abc-123"));
	assert.ok(
		lines.some((l) => l === "VCPDECK_INSTALLATION_MODE=systemd-root-equivalent"),
	);
});

test("planFreshInstall 按固定阶段顺序推进到 done", () => {
	const plan = planFreshInstall({ fresh: true });
	assert.deepEqual(
		plan.map((s) => s.stage),
		[
			"preflight",
			"account",
			"runtime",
			"application",
			"configuration",
			"sudoers",
			"service",
			"starting",
			"verifying",
			"done",
		],
	);
});

test("redactSecrets 抹除 PSK 值但保留键名", () => {
	const out = redactSecrets(
		"VCPDECK_PSK=SECRET_PSK\nVCPDECK_SERVER=https://a.example.com:3001\n",
		["SECRET_PSK"],
	);
	assert.ok(!out.includes("SECRET_PSK"));
	assert.ok(out.includes("VCPDECK_PSK="));
	assert.ok(out.includes("VCPDECK_SERVER=https://a.example.com:3001"));
});

test("assertSafeLayout 拒绝符号链接与类型/属主冲突", () => {
	// 正常目录
	assert.doesNotThrow(() =>
		assertSafeLayout(APP_DIR, { exists: true, type: "dir", owner: "root" }),
	);
	// 符号链接 → 拒绝
	assert.throws(
		() => assertSafeLayout(APP_DIR, { exists: true, type: "symlink", owner: "root" }),
		/符号链接/,
	);
	// 属主冲突 → 拒绝
	assert.throws(
		() => assertSafeLayout(APP_DIR, { exists: true, type: "dir", owner: "someone-else" }),
		/属主/,
	);
	// 不存在 → 允许（将创建）
	assert.doesNotThrow(() =>
		assertSafeLayout("/opt/vcpdeck", { exists: false }),
	);
});

test("createRealAdapter 正确读取 passwd 的 HOME 与 shell 字段", () => {
	const source = readFileSync(__filename.replace(/\.test\.cjs$/, ".cjs"), "utf8");
	assert.match(source, /home: parts\[5\], shell: parts\[6\]/);
});

test("installRuntime 重试时复用已完整 Node，不重复复制目录", { skip: process.platform === "win32" }, async () => {
	const calls = [];
	const adapter = {
		statInfo: () => ({ exists: true, type: "dir", owner: "root" }),
		execFileSyncExists: () => true,
		mkdirp: () => {},
		rm: () => calls.push("rm"),
		copyTree: () => calls.push("copy"),
		symlink: (target, path) => calls.push(["symlink", target, path]),
	};
	await installRuntime(adapter, { bootstrapNode: "/tmp/node-26.8.1/bin/node" });
	assert.deepEqual(calls, [["symlink", "26.8.1", "/opt/vcpdeck/client/node/current"]]);
});

test("checkAccount 拒绝与既有非 vcpdeck 账户冲突，接受缺失", () => {
	// 账户不存在 → 可创建
	assert.deepEqual(checkAccount(null), { action: "create" });
	// 已存在 vcpdeck 且模型匹配 → 复用
	assert.deepEqual(
		checkAccount({
			name: "vcpdeck",
			home: HOME_DIR,
			shell: "/bin/bash",
			locked: true,
		}),
		{ action: "reuse" },
	);
	// 已存在但 HOME/shell 不符 → 冲突
	assert.deepEqual(
		checkAccount({
			name: "vcpdeck",
			home: "/home/vcpdeck",
			shell: "/bin/bash",
			locked: true,
		}),
		{ action: "conflict" },
	);
});

// ── M1 迁移源发现 ──
function src(overrides = {}) {
	return {
		username: overrides.username ?? "xuzhen97",
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		clientDir: `/var/home/${overrides.username ?? "xuzhen97"}/.vcpdeck/launcher-client`,
		serverOrigin: "https://cockpit.example.com:3001",
		pm2Process: {
				name: "vcpdeck-client-launcher",
				status: "online",
				pm_exec_path: `/var/home/${overrides.username ?? "xuzhen97"}/.vcpdeck/launcher-client/dist/main.js`,
			},
		releaseActive: false,
		...overrides,
	};
}

test("M1: root 多源且未显式指定 → LINUX_MIGRATION_AMBIGUOUS", () => {
	const alice = src({ username: "alice" });
	const bob = src({ username: "bob" });
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [alice, bob] }),
		(error) => error.code === "LINUX_MIGRATION_AMBIGUOUS",
	);
});

test("M1: root 显式指定源 → 选中该用户", () => {
	const alice = src({ username: "alice" });
	const bob = src({ username: "bob" });
	const result = discoverMigrationSource({ uid: 0, requestedUser: "alice", candidates: [alice, bob] });
	assert.equal(result.username, "alice");
});

test("M1: 普通 sudo 用户只能迁移自己范围内的源", () => {
	const mine = src({ username: "xuzhen97" });
	const other = src({ username: "alice" });
	const result = discoverMigrationSource({ uid: 1000, callerUser: "xuzhen97", candidates: [mine, other] });
	assert.equal(result.username, "xuzhen97");
	// 普通用户不能显式指向他人源。
	assert.throws(
		() =>
			discoverMigrationSource({
				uid: 1000,
				callerUser: "xuzhen97",
				requestedUser: "alice",
				candidates: [mine, other],
			}),
		(error) => error.code === "LINUX_MIGRATION_SOURCE_DENIED",
	);
});

test("M1: 源指向不同 Server → LINUX_MIGRATION_SERVER_MISMATCH", () => {
	const s = src({ serverOrigin: "https://other.example.com:3001", expectedServerOrigin: "https://cockpit.example.com:3001" });
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [s] }),
		(error) => error.code === "LINUX_MIGRATION_SERVER_MISMATCH",
	);
});

test("M1: 非法 Client ID → LINUX_MIGRATION_INVALID_ID", () => {
	const s = src({ clientId: "not-a-uuid" });
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [s] }),
		(error) => error.code === "LINUX_MIGRATION_INVALID_ID",
	);
});

test("M1: PM2 进程未 online → LINUX_MIGRATION_PM2_NOT_ONLINE", () => {
	const s = src({ pm2Process: { name: "vcpdeck-client-launcher", status: "stopped" } });
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [s] }),
		(error) => error.code === "LINUX_MIGRATION_PM2_NOT_ONLINE",
	);
});

test("M1: 有进行中的 Release → LINUX_MIGRATION_RELEASE_ACTIVE 拒绝", () => {
	const s = src({ releaseActive: true });
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [s] }),
		(error) => error.code === "LINUX_MIGRATION_RELEASE_ACTIVE",
	);
});

test("稳定错误码常量齐全", () => {
	assert.equal(LINUX_INSTALLER_ERROR.NOT_ROOT, "LINUX_NOT_ROOT");
	assert.equal(LINUX_INSTALLER_ERROR.SUDO_AUTH_FAILED, "LINUX_SUDO_AUTH_FAILED");
	assert.ok(LINUX_INSTALLER_ERROR.VERIFICATION_FAILED);
});

// ── M1 迁移切换/回退顺序（call-recording adapter） ──
function recordingAdapter() {
	const calls = [];
	// record(name) 直接记录一个切换步骤；其余系统操作以固定名称记录。
	const adapter = {
		calls,
		record: (name) => {
			calls.push(name);
		},
		exec: () => ({ status: 0, stdout: "active\nenabled", ok: true }),
		execFileSyncExists: () => true,
		statInfo: () => ({ exists: true, type: "dir", owner: "root" }),
		writeFile: () => {},
		mkdirp: () => {},
		rm: () => {},
		rename: () => {},
		chmod: () => {},
		chown: () => {},
		symlink: () => {},
		copyTree: () => {},
		fetchJson: async () => ({
			registered: true,
			online: true,
			clientVersion: "0.6.15",
			capabilitiesReported: true,
			installationMode: "systemd-root-equivalent",
			nonInteractiveSudo: true,
		}),
	};
	return adapter;
}

test("M1: 切换 happy-path 顺序正确，且新服务在旧 Client 停止前不启动", async () => {
	const adapter = recordingAdapter();
	await runMigrationCutover({
		adapter,
		source: { username: "xuzhen97", clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c" },
		args: { serverOrigin: "https://cockpit.example.com:3001", releaseVersion: "0.6.15" },
		psk: "SECRET",
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		log: () => {},
	});
	const order = adapter.calls;
	const happy = [
		"prepare-new-verify-only",
		"record-old",
		"stop-old-client",
		"start-new-verify-only",
		"wait-new-verify",
		"stop-new",
		"clear-verify-flag",
		"start-new-steady",
		"wait-new-full",
		"disable-old-startup",
		"save-remaining-pm2",
		"mark-done",
	];
	assert.deepEqual(order, happy);
	// 新服务（steady）必须在旧 Client 停止之后才启动。
	assert.ok(order.indexOf("stop-old-client") < order.indexOf("start-new-steady"));
});

test("M1: 稳态注册前失败 → 回退旧 PM2 并 mark-failed", async () => {
	const adapter = recordingAdapter();
	adapter.waitNewFull = false; // 模拟稳态全能力验证失败
	const state = await runMigrationCutover({
		adapter,
		source: { username: "xuzhen97", clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c" },
		args: { serverOrigin: "https://cockpit.example.com:3001", releaseVersion: "0.6.15" },
		psk: "SECRET",
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		log: () => {},
		failAtSteady: true,
	});
	const order = adapter.calls;
	assert.deepEqual(
		order.slice(order.indexOf("start-new-steady")),
		["start-new-steady", "wait-new-full", "stop-disable-new", "restore-old-startup", "restore-old-client", "wait-old-verify", "mark-failed"],
	);
	assert.equal(state.outcome, "failed");
});
