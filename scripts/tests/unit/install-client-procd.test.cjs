/**
 * Task 7/修复：procd 安装编排、发布包解析与布局门禁测试（ADR-0065）。
 *
 * 目标：证明易失路径、非 root owner、符号链接、容量不足和世界可写祖先都会在
 * 任何写盘动作之前被拒绝；安装顺序与幂等 reconcile 可观测；发布包与运行时锁
 * 只接受 Client-only musl 形态。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validatePersistentPath } = require("../../client-procd-layout.cjs");
const {
	acceptsInstalledClient,
	buildEnvContent,
	normalizeOrigin,
	parseOsRelease,
	parseRuntimeLock,
	readStagingManifest,
	runInstall,
	validatePlatform,
	validatePsk,
} = require("../../install-client-procd.cjs");

const stateAncestors = [
	{ path: "/opt/vcpdeck", uid: 0, mode: 0o755 },
	{ path: "/opt", uid: 0, mode: 0o755 },
	{ path: "/", uid: 0, mode: 0o755 },
];

const stateFacts = {
	path: "/opt/vcpdeck/state",
	fsType: "ext4",
	uid: 0,
	symlink: false,
	availableBytes: 1000,
	ancestors: stateAncestors,
};

test("布局校验：拒绝 tmpfs、非 root owner、符号链接与容量不足", () => {
	assert.doesNotThrow(() => validatePersistentPath(stateFacts, 500));
	assert.throws(() => validatePersistentPath({ ...stateFacts, fsType: "tmpfs" }, 500), /PROCD_UNSAFE_LAYOUT/);
	assert.throws(() => validatePersistentPath({ ...stateFacts, uid: 1000 }, 500), /PROCD_UNSAFE_LAYOUT/);
	assert.throws(() => validatePersistentPath({ ...stateFacts, symlink: true }, 500), /PROCD_UNSAFE_LAYOUT/);
	assert.throws(() => validatePersistentPath(stateFacts, 1001), /PROCD_UNSAFE_LAYOUT/);
});

test("布局校验：只接受三个批准路径，拒绝 /tmp 与 /var 易失目录", () => {
	for (const path of ["/opt/vcpdeck/client", "/opt/vcpdeck/state", "/etc/vcpdeck"]) {
		assert.doesNotThrow(() => validatePersistentPath({ ...stateFacts, path }, 500), path);
	}
	for (const path of ["/tmp/vcpdeck", "/var/lib/vcpdeck-client", "/opt/other"]) {
		assert.throws(() => validatePersistentPath({ ...stateFacts, path }, 500), /PROCD_UNSAFE_LAYOUT/);
	}
});

test("布局校验：容量必须是安全整数，未知文件系统一律拒绝", () => {
	assert.throws(
		() => validatePersistentPath({ ...stateFacts, availableBytes: Number.NaN }, 500),
		/PROCD_UNSAFE_LAYOUT/,
	);
	assert.throws(() => validatePersistentPath({ ...stateFacts, fsType: "fuse.sshfs" }, 500), /PROCD_UNSAFE_LAYOUT/);
	assert.throws(() => validatePersistentPath(stateFacts, -1), /PROCD_UNSAFE_LAYOUT/);
});

test("布局校验：overlay 目标要求 upperdir 落在持久介质", () => {
	const overlay = { ...stateFacts, fsType: "overlay" };
	assert.throws(() => validatePersistentPath(overlay, 500), /PROCD_UNSAFE_LAYOUT/);
	assert.throws(
		() => validatePersistentPath({ ...overlay, upperFsType: "tmpfs" }, 500),
		/PROCD_UNSAFE_LAYOUT/,
	);
	assert.throws(
		() => validatePersistentPath({ ...overlay, upperFsType: "overlay" }, 500),
		/PROCD_UNSAFE_LAYOUT/,
	);
	assert.doesNotThrow(() => validatePersistentPath({ ...overlay, upperFsType: "ext4" }, 500));
});

test("布局校验：祖先世界可写、组可写、非 root 拥有或缺祖先链时拒绝", () => {
	const ok = { ...stateFacts, ancestors: stateAncestors };
	assert.doesNotThrow(() => validatePersistentPath(ok, 500));
	assert.throws(
		() =>
			validatePersistentPath(
				{ ...ok, ancestors: [{ path: "/opt", uid: 0, mode: 0o777 }] },
				500,
			),
		/PROCD_UNSAFE_LAYOUT/,
	);
	assert.throws(
		() =>
			validatePersistentPath(
				{ ...ok, ancestors: [{ path: "/opt", uid: 1000, mode: 0o755 }] },
				500,
			),
		/PROCD_UNSAFE_LAYOUT/,
	);
	assert.throws(
		() => validatePersistentPath({ ...ok, ancestors: [{ path: "/", uid: 0, mode: 0o775 }] }, 500),
		/PROCD_UNSAFE_LAYOUT/,
	);
	assert.throws(
		() => validatePersistentPath({ ...ok, ancestors: [] }, 500),
		/PROCD_UNSAFE_LAYOUT/,
	);
	assert.throws(
		() =>
			validatePersistentPath(
				{ ...ok, ancestors: [{ path: "/opt", uid: 0, mode: 0o755 }] },
				500,
			),
		/PROCD_UNSAFE_LAYOUT/,
	);
});

const platformFacts = {
	id: "istoreos",
	versionId: "24.10.8",
	arch: "x86_64",
	libc: "musl",
	init: "procd",
	euid: 0,
};

test("平台门禁：只接受 iStoreOS 24.10 x86_64 musl procd", () => {
	assert.doesNotThrow(() => validatePlatform(platformFacts));
	for (const [patch, value] of [
		["id", "openwrt"],
		["versionId", "23.05.5"],
		["arch", "aarch64"],
		["libc", "glibc"],
		["init", "systemd"],
	]) {
		assert.throws(
			() => validatePlatform({ ...platformFacts, [patch]: value }),
			/PROCD_PLATFORM_UNSUPPORTED/,
			patch,
		);
	}
	assert.throws(() => validatePlatform({ ...platformFacts, euid: 1000 }), /PROCD_ROOT_REQUIRED/);
});

test("解析 os-release 时保留带引号与空格的字段", () => {
	const parsed = parseOsRelease(
		'ID=istoreos\nVERSION_ID="24.10.2"\nPRETTY_NAME="iStoreOS 24.10 x"',
	);
	assert.equal(parsed.ID, "istoreos");
	assert.equal(parsed.VERSION_ID, "24.10.2");
	assert.equal(parsed.PRETTY_NAME, "iStoreOS 24.10 x");
});

test("Server Origin 与 PSK 只接受明确形态", () => {
	assert.equal(normalizeOrigin("https://deck.example.com/"), "https://deck.example.com");
	assert.equal(normalizeOrigin("http://127.0.0.1:3001/api"), "http://127.0.0.1:3001");
	assert.equal(normalizeOrigin("ftp://deck.example.com"), null);
	assert.equal(normalizeOrigin(""), null);
	assert.equal(validatePsk("a".repeat(64)), true);
	assert.equal(validatePsk("short-psk"), true);
	assert.equal(validatePsk("a".repeat(63)), true);
	assert.equal(validatePsk(""), false);
	assert.equal(validatePsk("bad psk"), false);
	assert.equal(validatePsk("a".repeat(513)), false);
});

/** 在临时目录里写出一个最小可用的发布包 manifest。 */
function stagingWith(manifest) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcpdeck-procd-"));
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
	return dir;
}

const validManifest = {
	version: "1.2.3",
	launcher: { dir: "launcher", entry: "dist/main.js" },
	artifacts: { client: { dir: "client", entry: "dist/index.js" } },
};

test("发布包解析：接受 Client-only 包，拒绝缺字段、坏版本与含 Server 构件", () => {
	const dir = stagingWith(validManifest);
	assert.equal(readStagingManifest(dir).version, "1.2.3");
	for (const manifest of [
		{ ...validManifest, version: "1.2" },
		{ version: "1.2.3", artifacts: validManifest.artifacts },
		{ ...validManifest, artifacts: { ...validManifest.artifacts, server: { dir: "server" } } },
	]) {
		assert.throws(() => readStagingManifest(stagingWith(manifest)), /PROCD_ARCHIVE_INVALID/);
	}
	assert.throws(() => readStagingManifest(path.join(dir, "missing")), /PROCD_ARCHIVE_INVALID/);
});

test("运行时锁文件：只接受批准构建站点的 Node 24 musl 归档", () => {
	const lock = {
		schema: 1,
		platform: "linux-x64-musl",
		role: "client",
		runtime: {
			version: "24.22.3",
			url: "https://unofficial-builds.nodejs.org/download/release/v24.22.3/node-v24.22.3-linux-x64-musl.tar.gz",
			sha256: "a".repeat(64),
		},
	};
	assert.equal(parseRuntimeLock(JSON.stringify(lock)).version, "24.22.3");
	for (const broken of [
		{ ...lock, platform: "linux-x64" },
		{ ...lock, schema: 2 },
		{ ...lock, runtime: { ...lock.runtime, version: "20.20.2" } },
		{ ...lock, runtime: { ...lock.runtime, url: "http://unofficial-builds.nodejs.org/x" } },
		{ ...lock, runtime: { ...lock.runtime, url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.gz" } },
		{ ...lock, runtime: { ...lock.runtime, sha256: "xyz" } },
	]) {
		assert.throws(() => parseRuntimeLock(JSON.stringify(broken)), /PROCD_RUNTIME_LOCK_INVALID/);
	}
	assert.throws(() => parseRuntimeLock("{"), /PROCD_RUNTIME_LOCK_INVALID/);
});

test("launcher.env：固定 8 键，Server/PSK 落盘且标明 procd-root", () => {
	const psk = "b".repeat(64);
	const appDir = path.join("/opt/vcpdeck/client", "launcher");
	const stateDir = "/opt/vcpdeck/state";
	const content = buildEnvContent({
		serverOrigin: "https://deck.example.com",
		psk,
		clientId: "8f0a1e1c-0000-4000-8000-000000000000",
	});
	const lines = content.trim().split("\n");
	assert.ok(lines.includes(`VCPDECK_APP_DIR=${appDir}`));
	assert.ok(lines.includes(`VCPDECK_CLIENT_DATA_DIR=${stateDir}`));
	assert.ok(lines.includes("VCPDECK_ARTIFACT=client"));
	assert.ok(lines.includes("VCPDECK_SERVER=https://deck.example.com"));
	assert.ok(lines.includes(`VCPDECK_PSK=${psk}`));
	assert.ok(lines.includes("VCPDECK_CLIENT_ID=8f0a1e1c-0000-4000-8000-000000000000"));
	assert.ok(lines.includes("VCPDECK_INSTALLATION_MODE=procd-root"));
	assert.equal(lines.filter((line) => line.startsWith("#")).length, 1);
});

/** 记录调用的 fake adapter，证明校验失败时零副作用。 */
function fakeAdapter(overrides = {}) {
	const calls = [];
	const adapter = {
		readPlatformFacts: () => platformFacts,
		readPathFacts: (path) => ({ ...stateFacts, path }),
		ensureDir: async (path) => void calls.push(`ensureDir:${path}`),
		installPayload: async (options) => void calls.push(`installPayload:${options.version}`),
		provisionRuntime: async (options) => void calls.push(`provisionRuntime:${path.basename(options.archivePath)}`),
		activateVersion: async (version) => void calls.push(`activateVersion:${version}`),
		writeEnvFile: async () => void calls.push("writeEnvFile"),
		runtimeReady: async () => true,
		inspectInstall: async () => ({
			installed: false,
			serviceMatches: false,
			envContent: null,
			currentVersion: null,
		}),
		writeServiceFile: async () => void calls.push("writeServiceFile"),
		enableService: async () => void calls.push("enableService"),
		stopService: async () => void calls.push("stopService"),
		startService: async () => void calls.push("startService"),
		verifyClient: async () => void calls.push("verifyClient"),
		...overrides,
	};
	return { adapter, calls };
}

function installOptions(overrides = {}) {
	return {
		stagingDir: stagingWith(validManifest),
		serverOrigin: "https://deck.example.com",
		psk: "c".repeat(64),
		lockPath: "/tmp/lock.json",
		archivePath: "/tmp/node-v24.22.3-linux-x64-musl.tar.gz",
		requiredBytes: 500,
		...overrides,
	};
}

test("安装：布局不安全时拒绝，且不写服务文件、不启停服务", async () => {
	const { adapter, calls } = fakeAdapter({
		readPathFacts: (path) => ({ ...stateFacts, path, fsType: "tmpfs" }),
	});
	await assert.rejects(() => runInstall(adapter, installOptions()), /PROCD_UNSAFE_LAYOUT/);
	assert.deepEqual(calls, []);
});

test("安装：非法 origin/PSK 在任何写盘前拒绝", async () => {
	const { adapter, calls } = fakeAdapter();
	await assert.rejects(
		() => runInstall(adapter, installOptions({ serverOrigin: "ftp://x" })),
		/PROCD_SERVER_ORIGIN_INVALID/,
	);
	await assert.rejects(
		() => runInstall(adapter, installOptions({ psk: "bad psk" })),
		/PROCD_PSK_INVALID/,
	);
	assert.deepEqual(calls, []);
});

test("安装：成功路径按 payload → 运行时 → env → 服务 → 启停 → 验证", async () => {
	const { adapter, calls } = fakeAdapter();
	const result = await runInstall(adapter, installOptions());
	const appDir = path.join("/opt/vcpdeck/client", "launcher");
	assert.deepEqual(result, { version: "1.2.3", reconciled: false });
	assert.deepEqual(calls, [
		"ensureDir:/opt/vcpdeck/client",
		"ensureDir:/opt/vcpdeck/state",
		"ensureDir:/etc/vcpdeck",
		"ensureDir:/opt/vcpdeck/state/home",
		`ensureDir:${appDir}`,
		`ensureDir:${path.join(appDir, "apps")}`,
		`ensureDir:${path.join(appDir, "node")}`,
		`ensureDir:${path.join(appDir, "runtime")}`,
		`ensureDir:${path.join(appDir, "runtime", "linux-x64-musl")}`,
		"installPayload:1.2.3",
		"provisionRuntime:node-v24.22.3-linux-x64-musl.tar.gz",
		"writeEnvFile",
		"writeServiceFile",
		"enableService",
		"stopService",
		"activateVersion:1.2.3",
		"startService",
		"verifyClient",
	]);
});

test("安装：Launcher 自带 musl Node 未就位时拒绝写服务并拒绝启动", async () => {
	const { adapter, calls } = fakeAdapter({
		runtimeReady: async () => {
			calls.push("runtimeReady");
			return false;
		},
	});
	await assert.rejects(
		() => runInstall(adapter, installOptions()),
		/PROCD_RUNTIME_MISSING/,
	);
	assert.equal(calls.includes("writeServiceFile"), false);
	assert.equal(calls.includes("startService"), false);
});

test("安装：同版本同服务时只做 reconcile，不重建 payload，但仍按新凭据重写 env", async () => {
	const { adapter, calls } = fakeAdapter({
		inspectInstall: async () => {
			calls.push("inspectInstall");
			return {
				installed: true,
				serviceMatches: true,
				envContent: buildEnvContent({
					serverOrigin: "https://deck.example.com",
					psk: "c".repeat(64),
				}),
				currentVersion: "1.2.3",
			};
		},
	});
	const result = await runInstall(adapter, installOptions());
	const appDir = path.join("/opt/vcpdeck/client", "launcher");
	assert.deepEqual(result, { version: "1.2.3", reconciled: true });
	assert.deepEqual(calls, [
		"ensureDir:/opt/vcpdeck/client",
		"ensureDir:/opt/vcpdeck/state",
		"ensureDir:/etc/vcpdeck",
		"ensureDir:/opt/vcpdeck/state/home",
		`ensureDir:${appDir}`,
		`ensureDir:${path.join(appDir, "apps")}`,
		`ensureDir:${path.join(appDir, "node")}`,
		`ensureDir:${path.join(appDir, "runtime")}`,
		`ensureDir:${path.join(appDir, "runtime", "linux-x64-musl")}`,
		"inspectInstall",
		"enableService",
		"verifyClient",
	]);
});

test("安装：停服后仍在运行时报 PROCD_STOP_UNCONVERGED，且不启动新进程", async () => {
	const { adapter, calls } = fakeAdapter({
		serviceRunning: async () => {
			calls.push("serviceRunning");
			return true;
		},
	});
	await assert.rejects(
		() => runInstall(adapter, installOptions()),
		/PROCD_STOP_UNCONVERGED/,
	);
	assert.ok(calls.includes("stopService"));
	assert.ok(!calls.includes("startService"));
	assert.ok(!calls.includes("verifyClient"));
});

test("安装：服务文件写入失败时不启用、不启停服务", async () => {
	const { adapter, calls } = fakeAdapter({
		writeServiceFile: async () => {
			calls.push("writeServiceFile");
			throw new Error("PROCD_SERVICE_WRITE_FAILED");
		},
	});
	await assert.rejects(() => runInstall(adapter, installOptions()), /PROCD_SERVICE_WRITE_FAILED/);
	assert.equal(calls.includes("enableService"), false);
	assert.equal(calls.includes("startService"), false);
});

test("安装：停止旧服务失败时不启动新服务，旧进程保持原样", async () => {
	const { adapter, calls } = fakeAdapter({
		stopService: async () => {
			calls.push("stopService");
			throw new Error("PROCD_STOP_FAILED");
		},
	});
	await assert.rejects(() => runInstall(adapter, installOptions()), (error) => {
		assert.match(error.message, /PROCD_STOP_FAILED/);
		assert.doesNotMatch(error.message, /psk|token|https?:\/\//i);
		return true;
	});
	assert.equal(calls.includes("startService"), false);
	assert.equal(calls.includes("verifyClient"), false);
});

test("安装：Server/PSK 轮换或服务未运行时重写 env 并重启，而不是只做 reconcile", async () => {
	const { adapter, calls } = fakeAdapter({
		inspectInstall: async () => {
			calls.push("inspectInstall");
			return {
				installed: true,
				serviceMatches: true,
				envContent: buildEnvContent({
					serverOrigin: "https://old.example.com",
					psk: "d".repeat(64),
				}),
				currentVersion: "1.2.3",
			};
		},
	});
	const result = await runInstall(adapter, installOptions());
	assert.deepEqual(result, { version: "1.2.3", reconciled: false });
	assert.ok(calls.includes("installPayload:1.2.3"));
	assert.ok(calls.indexOf("stopService") < calls.indexOf("activateVersion:1.2.3"));
});

test("安装：大写 PSK 原样写入 launcher.env（Server 按字符串精确比较）", async () => {
	let written = null;
	const { adapter } = fakeAdapter({
		writeEnvFile: async (options) => {
			written = options.psk;
		},
	});
	await runInstall(adapter, installOptions({ psk: "A".repeat(64) }));
	assert.equal(written, "A".repeat(64));
});

test("安装：显式 clientId 会传给在线验收", async () => {
	let seen = null;
	const { adapter } = fakeAdapter({
		verifyClient: async (options) => {
			seen = options;
		},
	});
	await runInstall(adapter, installOptions({ clientId: "8f0a1e1c-0000-4000-8000-000000000000" }));
	assert.equal(seen.clientId, "8f0a1e1c-0000-4000-8000-000000000000");
});

test("安装：reconcile 验收失败时重启一次再验收", async () => {
	let verifyCount = 0;
	const { adapter, calls } = fakeAdapter({
		inspectInstall: async () => ({
			installed: true,
			serviceMatches: true,
			envContent: buildEnvContent({
				serverOrigin: "https://deck.example.com",
				psk: "c".repeat(64),
			}),
			currentVersion: "1.2.3",
		}),
		// 第一次验收失败后 stopService 生效，服务不再运行。
		serviceRunning: async () => verifyCount === 0,
		verifyClient: async () => {
			verifyCount += 1;
			calls.push(`verifyClient:${verifyCount}`);
			if (verifyCount === 1) throw new Error("PROCD_VERIFICATION_FAILED");
		},
	});
	const result = await runInstall(adapter, installOptions());
	assert.deepEqual(result, { version: "1.2.3", reconciled: true });
	assert.equal(verifyCount, 2);
	assert.ok(calls.includes("stopService"));
	assert.ok(calls.includes("startService"));
	assert.ok(!calls.includes("installPayload:1.2.3"));
});

test("安装：服务已停止时不把 reconcile 当作成功", async () => {
	const { adapter, calls } = fakeAdapter({
		inspectInstall: async () => ({
			installed: true,
			serviceMatches: true,
			envContent: buildEnvContent({
				serverOrigin: "https://deck.example.com",
				psk: "c".repeat(64),
			}),
			currentVersion: "1.2.3",
		}),
		serviceRunning: async () => false,
	});
	const result = await runInstall(adapter, installOptions());
	assert.deepEqual(result, { version: "1.2.3", reconciled: false });
	assert.ok(calls.indexOf("startService") < calls.indexOf("verifyClient"));
});

test("在线验收：只有同身份上线、版本、能力与 procd-root 全部成立才算安装成功", () => {
	const ok = {
		registered: true,
		online: true,
		clientVersion: "1.2.3",
		capabilitiesReported: true,
		installationMode: "procd-root",
	};
	assert.equal(acceptsInstalledClient(ok, "1.2.3"), true);
	const mutations = [
		["registered", false],
		["online", false],
		["clientVersion", "1.2.4"],
		["capabilitiesReported", false],
		["installationMode", "systemd-root-equivalent"],
	];
	for (const [key, value] of mutations) {
		assert.equal(
			acceptsInstalledClient({ ...ok, [key]: value }, "1.2.3"),
			false,
			`${key}=${String(value)} 不应通过验收`,
		);
	}
	assert.equal(acceptsInstalledClient(null, "1.2.3"), false);
	assert.equal(
		acceptsInstalledClient({ registered: "true", online: true }, "1.2.3"),
		false,
		"字符串真值不得冒充布尔 true",
	);
});
