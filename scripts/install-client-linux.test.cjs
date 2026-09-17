"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
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
	collectMigrationSources,
	scanUserHomes,
	findLegacyClientTraces,
	PM2_RESOLVE_SNIPPET,
	pm2EntryScript,
	pickLegacyClientProcess,
	otherPm2AppNames,
	resolveInstallMode,
	resolveEffectiveOrigin,
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

test("installRuntime 重试时复用已完整 Node，不重复复制目录", async () => {
	const calls = [];
	const adapter = {
		exec: () => ({ status: 0, stdout: "v26.8.1\n", stderr: "" }),
		statInfo: () => ({ exists: true, type: "dir", owner: "root" }),
		execFileSyncExists: () => true,
		mkdirp: () => {},
		chown: () => {},
		chmod: () => {},
		rm: () => calls.push("rm"),
		copyTree: () => calls.push("copy"),
		copyFile: () => calls.push("copyFile"),
		realpath: (path) => path,
		symlink: (target, path) => calls.push(["symlink", target, path]),
	};
	await installRuntime(adapter, { bootstrapNode: "/tmp/node-26.8.1/bin/node" });
	assert.deepEqual(calls, [["symlink", "26.8.1", "/opt/vcpdeck/client/node/current"]]);
});

/** 构造 installRuntime 测试用 adapter：/opt 下视为未安装，除非刚被复制。 */
function runtimeAdapter(calls, versionStdout = "v24.16.0\n") {
	const created = new Set();
	return {
		exec: () => ({ status: 0, stdout: versionStdout, stderr: "" }),
		statInfo: () => ({ exists: false }),
		execFileSyncExists: (path) =>
			!String(path).startsWith("/opt/vcpdeck/client/node/") || created.has(path),
		mkdirp: (path) => calls.push(["mkdirp", path]),
		chown: () => {},
		chmod: () => {},
		rm: (path) => {
			calls.push(["rm", path]);
			created.clear();
		},
		copyTree: (src, dest) => {
			calls.push(["copyTree", src, dest]);
			created.add(`${dest}/bin/node`);
		},
		copyFile: (src, dest) => {
			calls.push(["copyFile", src, dest]);
			created.add(dest);
		},
		realpath: (path) => path,
		symlink: (target, link) => calls.push(["symlink", target, link]),
	};
}

test("installRuntime 版本取自 bootstrap Node 自报，nvm 风格目录不再落到 node/current", async () => {
	const calls = [];
	await installRuntime(runtimeAdapter(calls), {
		bootstrapNode: "/root/.nvm/versions/node/v24.16.0/bin/node",
	});
	assert.deepEqual(calls, [
		["mkdirp", "/opt/vcpdeck/client/node"],
		["copyTree", "/root/.nvm/versions/node/v24.16.0", "/opt/vcpdeck/client/node/24.16.0"],
		["symlink", "24.16.0", "/opt/vcpdeck/client/node/current"],
	]);
});

test("installRuntime 对系统 Node 只复制二进制，不整体复制 /usr", async () => {
	const calls = [];
	await installRuntime(runtimeAdapter(calls), { bootstrapNode: "/usr/bin/node" });
	assert.deepEqual(calls, [
		["mkdirp", "/opt/vcpdeck/client/node"],
		["mkdirp", "/opt/vcpdeck/client/node/24.16.0/bin"],
		["copyFile", "/usr/bin/node", "/opt/vcpdeck/client/node/24.16.0/bin/node"],
		["symlink", "24.16.0", "/opt/vcpdeck/client/node/current"],
	]);
});

test("installRuntime 无法确定 Node 版本时 fail closed，不用 current 当版本目录", async () => {
	const calls = [];
	const adapter = { ...runtimeAdapter(calls, ""), exec: () => ({ status: 1, stdout: "", stderr: "nope" }) };
	await assert.rejects(
		() => installRuntime(adapter, { bootstrapNode: "/usr/bin/node" }),
		/无法确定 bootstrap Node 版本/,
	);
	assert.ok(!calls.some(([op]) => ["copyTree", "copyFile", "symlink"].includes(op)));
});

test("node/current 覆盖既有目录时递归删除，避免 EISDIR", () => {
	const source = readFileSync(__filename.replace(/\.test\.cjs$/, ".cjs"), "utf8");
	assert.match(source, /rmSync\(linkPath, \{ recursive: true, force: true \}\)/);
});

test("旧 root + /opt 布局被识别为迁移源，并保留其他 PM2 应用", () => {
	const jlist = JSON.stringify([
		{ name: "rag-server", pm2_env: { status: "online", pm_exec_path: "/opt/rag-server/server-launcher.cjs" } },
		{
			name: "vcpdeck-client-launcher",
			pm2_env: { status: "online", pm_exec_path: "/opt/vcpdeck/launcher-client/dist/main.js" },
		},
	]);
	const adapter = {
		exec: (argv) =>
			argv[0] === "getent"
				? { status: 0, stdout: "root:x:0:0:root:/root:/bin/bash\n", stderr: "" }
				: { status: 0, stdout: jlist, stderr: "" },
		readFile: (path) => {
			if (path === "/root/.vcpdeck/client-id") return "712a5612-b051-4706-9d2d-b19cdbffaba0\n";
			if (path === "/opt/vcpdeck/launcher-client/launcher.env") {
				return "VCPDECK_ARTIFACT=client\nVCPDECK_SERVER=http://127.0.0.1:3001\n";
			}
			return "";
		},
		statInfo: (path) =>
			path === "/opt/vcpdeck/launcher-client"
				? { exists: true, type: "dir", owner: "root" }
				: { exists: false },
	};
	const candidates = collectMigrationSources(adapter);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].username, "root");
	assert.equal(candidates[0].clientDir, "/opt/vcpdeck/launcher-client");
	assert.equal(candidates[0].sourceHome, "/root");
	assert.equal(candidates[0].pm2Error, null);

	const source = discoverMigrationSource({ uid: 0, candidates });
	assert.equal(source.clientId, "712a5612-b051-4706-9d2d-b19cdbffaba0");
	assert.equal(source.sourceAppDir, "/opt/vcpdeck/launcher-client");
	assert.equal(source.startupUnit, "pm2-root.service");
	assert.equal(source.sourceHome, "/root");
	// 关键：其他 PM2 应用必须被保留，否则迁移会停用 pm2-root.service。
	assert.deepEqual(source.preserveApps, ["rag-server"]);
});

test("PM2 查询失败时不得当成没有旧安装，解析迁移源必须 fail closed", () => {
	const adapter = {
		exec: (argv) =>
			argv[0] === "getent"
				? { status: 0, stdout: "root:x:0:0:root:/root:/bin/bash\n", stderr: "" }
				: { status: 1, stdout: "", stderr: "pm2: command not found" },
		readFile: (path) =>
			path === "/root/.vcpdeck/client-id" ? "712a5612-b051-4706-9d2d-b19cdbffaba0\n" : "VCPDECK_ARTIFACT=client\n",
		statInfo: (path) => ({ exists: path === "/opt/vcpdeck/launcher-client", type: "dir", owner: "root" }),
	};
	const candidates = collectMigrationSources(adapter);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].pm2Process, null);
	assert.match(candidates[0].pm2Error, /PM2 进程列表/);
	assert.deepEqual(candidates[0].otherApps, []);
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates }),
		(error) =>
			error.code === "LINUX_MIGRATION_SOURCE_INVALID" && /无法确认旧 PM2 状态/.test(error.message),
	);
});

test("PM2 解析片段能定位私有安装与 nvm 全局 PM2，并配对同版本 node", (t) => {
	if (spawnSync("sh", ["-c", "exit 0"]).status !== 0) {
		t.skip("本机没有可用的 POSIX sh");
		return;
	}
	const home = mkdtempSync(join(tmpdir(), "pm2-resolve-"));
	const run = () =>
		spawnSync("sh", ["-c", `${PM2_RESOLVE_SNIPPET} printf '%s|%s' "$node" "$pm2"`], {
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		}).stdout;

	const nvmRoot = join(home, ".nvm/versions/node/v24.16.0");
	mkdirSync(join(nvmRoot, "lib/node_modules/pm2/bin"), { recursive: true });
	mkdirSync(join(nvmRoot, "bin"), { recursive: true });
	writeFileSync(join(nvmRoot, "bin/node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	writeFileSync(join(nvmRoot, "lib/node_modules/pm2/bin/pm2"), "", { mode: 0o644 });
	const nvmResolved = run().split("|");
	assert.ok(nvmResolved[1].endsWith(".nvm/versions/node/v24.16.0/lib/node_modules/pm2/bin/pm2"));
	// node 必须从 PM2 同一安装根推导，而不是任意全局 node。
	assert.equal(nvmResolved[0], nvmResolved[1].replace(/lib\/node_modules\/pm2\/bin\/pm2$/, "bin/node"));

	const privNode = join(home, ".vcpdeck/runtime/node/node-v24.16.0/bin/node");
	const privPm2 = join(home, ".vcpdeck/tools/pm2/node_modules/pm2/bin/pm2");
	mkdirSync(dirname(privNode), { recursive: true });
	mkdirSync(dirname(privPm2), { recursive: true });
	writeFileSync(privNode, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	writeFileSync(privPm2, "", { mode: 0o644 });
	const privResolved = run().split("|");
	assert.ok(privResolved[0].endsWith(".vcpdeck/runtime/node/node-v24.16.0/bin/node"));
	assert.ok(privResolved[1].endsWith(".vcpdeck/tools/pm2/node_modules/pm2/bin/pm2"));
});

test("旧 PM2 条目按入口脚本匹配：pm_exec_path 指向 node、脚本在 args", () => {
	const list = [
		{ name: "rag-client", pm2_env: { status: "online", pm_exec_path: "/opt/rag-client/client-launcher.cjs" } },
		{
			// VCP ToolBox 应用注入了 VCPDECK_* 环境，但不是 VCPDeck Launcher，不得被误选。
			name: "vcp-admin",
			pm2_env: {
				status: "online",
				pm_exec_path: "/opt/VCPToolBox/adminServer.js",
				VCPDECK_ARTIFACT: "client",
				VCPDECK_APP_DIR: "/root/.vcpdeck/launcher-client",
			},
		},
		{
			name: "vcpdeck-client-launcher",
			pm2_env: {
				status: "online",
				pm_exec_path: "/root/.nvm/versions/node/v24.14.1/bin/node",
				args: [
					"--env-file=/root/.vcpdeck/launcher-client/launcher.env",
					"/root/.vcpdeck/launcher-client/dist/main.js",
				],
			},
		},
	];
	const matched = pickLegacyClientProcess(list, "/root/.vcpdeck/launcher-client");
	assert.equal(matched.name, "vcpdeck-client-launcher");
	assert.equal(matched.pm_exec_path, "/root/.vcpdeck/launcher-client/dist/main.js");
	// 保留其余应用（含 rag-client 与 VCP ToolBox），否则会停用旧自启。
	assert.deepEqual(otherPm2AppNames(list, matched.name), ["rag-client", "vcp-admin"]);
	// 名称不同但入口指向同目录时也能匹配（如自定义名的旧安装）。
	assert.equal(
		pickLegacyClientProcess(
			[{ name: "my-vcpdeck", pm2_env: { status: "online", pm_exec_path: "/home/u/.vcpdeck/launcher-client/dist/main.js" } }],
			"/home/u/.vcpdeck/launcher-client",
		).name,
		"my-vcpdeck",
	);
	// 多个候选条目一律 fail closed。
	assert.throws(
		() =>
			pickLegacyClientProcess(
				[
					{ name: "vcpdeck-client-launcher", pm2_env: { status: "online", pm_exec_path: "/a/dist/main.js" } },
					{ name: "vcpdeck-client-launcher-2", pm2_env: { status: "online", pm_exec_path: "/b/dist/main.js" } },
				],
				"/b",
			),
		/多个 VCPDeck Client 条目/,
	);
});

test("迁移按探测到的 PM2 名称删除，非法名称 fail closed", () => {
	const candidate = (name) => ({
		username: "root",
		clientId: "712a5612-b051-4706-9d2d-b19cdbffaba0",
		clientDir: "/root/.vcpdeck/launcher-client",
		sourceHome: "/root",
		serverOrigin: null,
		artifact: "client",
		pm2Process: { name, status: "online", pm_exec_path: "/root/.vcpdeck/launcher-client/dist/main.js" },
		otherApps: ["rag-client"],
		releaseActive: false,
	});
	assert.equal(discoverMigrationSource({ uid: 0, candidates: [candidate("vcp-admin")] }).pm2Name, "vcp-admin");
	assert.throws(
		() => discoverMigrationSource({ uid: 0, candidates: [candidate("x; rm -rf /")] }),
		(error) => error.code === "LINUX_MIGRATION_SOURCE_INVALID" && /应用名不合法/.test(error.message),
	);
});

test("探测未识别的旧安装痕迹（含 root 与 /opt 旧布局），避免新建第二身份", () => {
	const adapter = {
		exec: () => ({
			status: 0,
			stdout: "root:x:0:0:root:/root:/bin/bash\nubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n",
			stderr: "",
		}),
		readFile: (path) => (path === "/root/.vcpdeck/client-id" ? "712a5612-b051-4706-9d2d-b19cdbffaba0\n" : ""),
		statInfo: (path) => ({ exists: path === "/opt/vcpdeck/launcher-client" }),
	};
	const traces = findLegacyClientTraces(adapter);
	assert.equal(traces.length, 2);
	assert.match(traces.join(" "), /\/root\/\.vcpdeck\/client-id/);
	assert.match(traces.join(" "), /\/opt\/vcpdeck\/launcher-client/);
	// 干净机器不得误判。
	assert.deepEqual(
		findLegacyClientTraces({ ...adapter, readFile: () => "", statInfo: () => ({ exists: false }) }),
		[],
	);
});

test("scanUserHomes 保留 root 与 /home，且 getent 失败时不静默返回空", () => {
	const homes = scanUserHomes({
		exec: () => ({
			status: 0,
			stdout: "root:x:0:0:root:/root:/bin/bash\nu:x:1:1::/home/u:/bin/sh\nlinux:x:2:2::/home/linux:/bin/sh\n",
			stderr: "",
		}),
	});
	assert.deepEqual(homes, [
		{ username: "root", home: "/root" },
		{ username: "u", home: "/home/u" },
	]);
	assert.throws(() => scanUserHomes({ exec: () => ({ status: 2, stderr: "boom" }) }), /boom/);
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

test("M1: 同一 Server 的 loopback 与公网入口并存时，保留旧 Origin 而不拒绝", () => {
	// 真实场景：旧 launcher.env 是 http://127.0.0.1:3001，操作者从公网入口执行安装命令。
	const s = src({ serverOrigin: "http://127.0.0.1:3001" });
	const source = discoverMigrationSource({ uid: 0, candidates: [s] });
	assert.equal(source.serverOrigin, "http://127.0.0.1:3001");
	assert.equal(
		resolveEffectiveOrigin({
			plan: { kind: "migrate", source },
			args: { serverOrigin: "http://203.0.113.9:3001" },
		}),
		"http://127.0.0.1:3001",
	);
	// 旧配置无 Origin 或全新安装时，才用命令入口。
	assert.equal(
		resolveEffectiveOrigin({
			plan: { kind: "migrate", source: src({ serverOrigin: null }) },
			args: { serverOrigin: "http://203.0.113.9:3001" },
		}),
		"http://203.0.113.9:3001",
	);
	assert.equal(
		resolveEffectiveOrigin({
			plan: { kind: "fresh" },
			args: { serverOrigin: "http://203.0.113.9:3001" },
		}),
		"http://203.0.113.9:3001",
	);
	// 旧配置里是非法值时不得当权威。
	assert.equal(
		resolveEffectiveOrigin({
			plan: { kind: "migrate", source: src({ serverOrigin: "not-an-origin" }) },
			args: { serverOrigin: "http://203.0.113.9:3001" },
		}),
		"http://203.0.113.9:3001",
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

test("安装模式解析：--migrate=false 强制重装；已有 A2 与旧 PM2 并存时恢复迁移", () => {
	assert.equal(
		resolveInstallMode({
			args: { migrate: false },
			uid: 0,
			hasA2State: false,
			candidates: [src()],
		}).kind,
		"fresh",
	);
	// 双实例现场说明迁移未完成：有效旧 PM2 源优先，覆盖错误生成的 A2 身份。
	assert.equal(
		resolveInstallMode({
			args: {},
			uid: 0,
			hasA2State: true,
			candidates: [src()],
		}).kind,
		"migrate",
	);
	// 没有旧候选时才把已有 A2 作为幂等修复，不改身份。
	assert.equal(
		resolveInstallMode({
			args: {},
			uid: 0,
			hasA2State: true,
			candidates: [],
		}).kind,
		"fresh",
	);
});

test("迁移源系统扫描失败时 fail closed，不得降级成 fresh 新身份", () => {
	assert.throws(
		() =>
			collectMigrationSources({
				exec: () => ({ status: 1, stdout: "", stderr: "getent failed" }),
			}),
		/扫描迁移源失败.*getent failed/,
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
