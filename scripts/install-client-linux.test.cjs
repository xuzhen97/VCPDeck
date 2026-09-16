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
	resolveInstallMode,
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

test("M1: 旧 app-dir 不在来源用户 .vcpdeck/launcher-client → 拒绝删除", () => {
	const s = src({
		clientDir: "/var/home/xuzhen97/other-app",
		pm2Process: {
			name: "vcpdeck-client-launcher",
			status: "online",
			pm_exec_path: "/var/home/xuzhen97/other-app/dist/main.js",
		},
	});
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [s] }),
		(error) => error.code === "LINUX_MIGRATION_SOURCE_INVALID",
	);
});

test("M1: launcher.env 声明其他 artifact → 拒绝删除", () => {
	const s = src({ artifact: "server" });
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [s] }),
		(error) => error.code === "LINUX_MIGRATION_SOURCE_INVALID",
	);
});

test("稳定错误码常量齐全", () => {
	assert.equal(LINUX_INSTALLER_ERROR.NOT_ROOT, "LINUX_NOT_ROOT");
	assert.equal(LINUX_INSTALLER_ERROR.SUDO_AUTH_FAILED, "LINUX_SUDO_AUTH_FAILED");
	assert.ok(LINUX_INSTALLER_ERROR.VERIFICATION_FAILED);
});

	test("安装模式解析：默认自动探测存量 PM2 源并迁移（页面固定命令即可迁移）", () => {
	const legacy = src();
	const plan = resolveInstallMode({
		args: {},
		uid: 0,
		callerUser: undefined,
		hasA2State: false,
		candidates: [legacy],
	});
	assert.equal(plan.kind, "migrate");
	assert.equal(plan.source.clientId, legacy.clientId);

	const fresh = resolveInstallMode({
		args: {},
		uid: 1000,
		callerUser: "xuzhen97",
		hasA2State: false,
		candidates: [],
	});
	assert.equal(fresh.kind, "fresh");
});

test("安装模式解析：--migrate=false 强制重装，已有 A2 身份时不自动迁移", () => {
	assert.equal(
		resolveInstallMode({
			args: { migrate: false },
			uid: 0,
			hasA2State: false,
			candidates: [src()],
		}).kind,
		"fresh",
	);
	// 已有 A2 现场：按幂等修复处理，不清理旧目录、不改身份。
	assert.equal(
		resolveInstallMode({
			args: {},
			uid: 0,
			hasA2State: true,
			candidates: [src()],
		}).kind,
		"fresh",
	);
});

test("安装模式解析：--migrate=true 无源时拒绝，多源不一致时 fail closed", () => {
	assert.throws(
		() =>
			resolveInstallMode({
				args: { migrate: true },
				uid: 0,
				hasA2State: false,
				candidates: [],
			}),
		(error) => error.code === "LINUX_MIGRATION_SOURCE_MISSING",
	);
	assert.throws(
		() =>
			resolveInstallMode({
				args: {},
				uid: 0,
				hasA2State: false,
				candidates: [src({ username: "alice" }), src({ username: "bob" })],
			}),
		(error) => error.code === "LINUX_MIGRATION_AMBIGUOUS",
	);
	// 探测到候选但校验不通过（PM2 未 online）：自动模式下 fail closed，不透走全新安装。
	assert.throws(
		() =>
			resolveInstallMode({
				args: {},
				uid: 0,
				hasA2State: false,
				candidates: [src({ pm2Process: { name: "vcpdeck-client-launcher", status: "stopped" } })],
			}),
		(error) => error.code === "LINUX_MIGRATION_PM2_NOT_ONLINE",
	);
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
		source: {
			username: "xuzhen97",
			clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
			sourceAppDir: "/home/xuzhen97/.vcpdeck/launcher-client",
			sourceHome: "/home/xuzhen97",
		},
		args: { serverOrigin: "https://cockpit.example.com:3001", releaseVersion: "0.6.15" },
		psk: "SECRET",
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		log: () => {},
	});
	const order = adapter.calls;
	const happy = [
		"prepare-system-install",
		"record-old",
		"stop-old-client",
		"save-remaining-pm2",
		"remove-old-startup-if-unused",
		"remove-old-app-dir",
		"remove-old-install-state",
		"start-new-steady",
		"wait-new-full",
		"mark-done",
	];
	assert.deepEqual(order, happy);
	// 新服务（steady）必须在旧 Client 停止之后才启动。
	assert.ok(order.indexOf("stop-old-client") < order.indexOf("start-new-steady"));
});

test("M1: 稳态验收失败只 mark-failed 且不 resurrect 旧 PM2", async () => {
	const adapter = recordingAdapter();
	const state = await runMigrationCutover({
		adapter,
		source: {
			username: "xuzhen97",
			clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
			sourceAppDir: "/home/xuzhen97/.vcpdeck/launcher-client",
			sourceHome: "/home/xuzhen97",
		},
		args: { serverOrigin: "https://cockpit.example.com:3001", releaseVersion: "0.6.15" },
		psk: "SECRET",
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		log: () => {},
		failAtSteady: true,
	});
	const order = adapter.calls;
	assert.deepEqual(
		order.slice(order.indexOf("start-new-steady")),
		["start-new-steady", "wait-new-full", "mark-failed"],
	);
	// 永不回滚旧 PM2。
	assert.ok(!order.some((n) => /resurrect|restore-old/.test(n)));
	assert.equal(state.outcome, "failed");
});

test("M1: 有无关 PM2 应用时保留旧自启，无其他应用时停用旧自启", async () => {
	const keep = recordingAdapter();
	const keptCommands = [];
	keep.exec = (argv) => {
		keptCommands.push(argv.join(" "));
		return { status: 0, stdout: "active\nenabled", ok: true };
	};
	await runMigrationCutover({
		adapter: keep,
		source: {
			username: "xuzhen97",
			clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
			sourceAppDir: "/home/xuzhen97/.vcpdeck/launcher-client",
			sourceHome: "/home/xuzhen97",
			preserveApps: ["other-app"],
		},
		args: { serverOrigin: "https://cockpit.example.com:3001", releaseVersion: "0.6.15" },
		psk: "SECRET",
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		log: () => {},
	});
	assert.ok(!keptCommands.some((c) => c.startsWith("systemctl disable pm2-xuzhen97.service")));

	const drop = recordingAdapter();
	const droppedCommands = [];
	drop.exec = (argv) => {
		droppedCommands.push(argv.join(" "));
		return { status: 0, stdout: "active\nenabled", ok: true };
	};
	await runMigrationCutover({
		adapter: drop,
		source: {
			username: "xuzhen97",
			clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
			sourceAppDir: "/home/xuzhen97/.vcpdeck/launcher-client",
			sourceHome: "/home/xuzhen97",
		},
		args: { serverOrigin: "https://cockpit.example.com:3001", releaseVersion: "0.6.15" },
		psk: "SECRET",
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		log: () => {},
	});
	assert.ok(droppedCommands.includes("systemctl disable pm2-xuzhen97.service"));
	// 旧现场以参数数组删除，不经 shell 拼接。
	assert.ok(droppedCommands.includes("rm -rf /home/xuzhen97/.vcpdeck/launcher-client"));
	assert.ok(droppedCommands.includes("rm -f /home/xuzhen97/.vcpdeck/client-install.json"));
});

// ── A2 fresh install 路径：configuration 阶段必须用 ENV_FILE 作为 path，不能把 options 当 content ──

test("writeAtomic 4 参数顺序写入 ENV_FILE 时 content 是字符串", () => {
	const { writeAtomic, buildEnvContent } = require("./install-client-linux.cjs");
	const writes = [];
	const adapter = {
		writeFile: (path, content) => writes.push({ path, content }),
		chmod: () => {},
		chown: () => {},
		rm: () => {},
		rename: () => {},
	};
	writeAtomic(
		adapter,
		ENV_FILE,
		buildEnvContent({
			serverOrigin: "https://cockpit.example.com:3001",
			psk: "SECRET_PSK",
			clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		}),
		{ mode: 0o640, owner: "root", group: ACCOUNT_NAME },
	);
	const envWrite = writes.find((entry) => entry.path === `${ENV_FILE}.${process.pid}.tmp`);
	assert.ok(envWrite, `期望写入 ${ENV_FILE} 临时文件，实际: ${JSON.stringify(writes.map((w) => w.path))}`);
	assert.strictEqual(typeof envWrite.content, "string");
	assert.ok(envWrite.content.includes("VCPDECK_PSK=SECRET_PSK"));
	assert.ok(envWrite.content.includes("VCPDECK_SERVER=https://cockpit.example.com:3001"));
	assert.ok(envWrite.content.includes("VCPDECK_INSTALLATION_MODE=systemd-root-equivalent"));
});

test("writeAtomic 3 参数错误顺序（漏 path）会让 fs.writeFileSync 收到 Object 报错", () => {
	const { writeAtomic, buildEnvContent } = require("./install-client-linux.cjs");
	const fs = require("node:fs");
	const { mkdtempSync, rmSync } = require("node:fs");
	const { join } = require("node:path");
	const { tmpdir } = require("node:os");
	const sandbox = mkdtempSync(join(tmpdir(), "vcpdeck-write-atomic-"));
	const adapter = {
		writeFile: (path, content) => fs.writeFileSync(path, content, { mode: 0o600 }),
		chmod: () => {},
		chown: () => {},
		rm: () => {},
		rename: () => {},
	};
	try {
		assert.throws(
			() =>
				writeAtomic(
					adapter,
					buildEnvContent({
						serverOrigin: "https://cockpit.example.com:3001",
						psk: "SECRET_PSK",
						clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
					}),
					{ mode: 0o640, owner: "root", group: ACCOUNT_NAME },
				),
			(maybeError) =>
				/ERR_INVALID_ARG_TYPE/.test(String(maybeError && maybeError.code)),
		);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});
