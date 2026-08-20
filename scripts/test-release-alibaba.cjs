#!/usr/bin/env node
/**
 * VCPDeck 发布构件经阿里云盘直连自更新的一键集成测试（ADR-0016）。
 *
 * 直接运行：
 *   node scripts/test-release-alibaba.cjs
 *
 * 脚本自动完成：依赖检查、基线打包、Server/Client 安装与启动、临时 DB、
 * 阿里云盘配置、目标版本打包、构件上传、302 直链验证、Server/Client
 * 自更新、云端测试对象删除、Launcher 停止和临时目录清理。
 *
 * 仅在必要时暂停：
 *   1. 未设置 ALIBABA_CLIENT_ID 时输入 clientId；
 *   2. 浏览器 OAuth 授权后粘贴 code 或完整回调 URL；
 *   3. 3001 端口被其他进程占用时，请用户自行停止该进程（脚本绝不误杀）。
 *
 * 可选环境变量：
 *   ALIBABA_CLIENT_ID / ALIBABA_CLIENT_SECRET / ALIBABA_OPENAPI_BASE
 *   VCPDECK_E2E_BASE_VERSION（默认 0.1.17）
 *   VCPDECK_E2E_TARGET_VERSION（默认 0.1.18）
 */

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const {
	appendFileSync,
	createReadStream,
	existsSync,
	readFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { once } = require("node:events");
const net = require("node:net");
const { platform: nodePlatform, tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const readline = require("node:readline");

const ROOT = resolve(__dirname, "..");
const BASE = "http://127.0.0.1:3001";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = randomBytes(24).toString("hex");
const PSK = randomBytes(32).toString("hex");
const BASE_VERSION = readVersion("VCPDECK_E2E_BASE_VERSION", "0.1.17");
const TARGET_VERSION = readVersion("VCPDECK_E2E_TARGET_VERSION", "0.1.18");
const TEST_CLIENT_ID = `alibaba-e2e-${nodePlatform()}-${Date.now()}`;
const OPENAPI_BASE =
	process.env.ALIBABA_OPENAPI_BASE || "https://openapi.alipan.com";
const OUTPUT_REL = `.tmp/alibaba-release-e2e-${process.pid}/dist-release`;
const OUTPUT_DIR = join(ROOT, OUTPUT_REL);

let cookie = "";
let serverLauncher = null;
let clientLauncher = null;
let serverAppDir = null;
let clientAppDir = null;
let cleanupPromise = null;
const uploadedKeys = new Set();
const results = [];

function readVersion(name, fallback) {
	const value = process.env[name] || fallback;
	if (!/^\d+\.\d+\.\d+$/.test(value)) {
		throw new Error(`${name} 应为 x.y.z，实际 ${value}`);
	}
	return value;
}

function pass(name, detail) {
	results.push({ status: "PASS", name, detail: detail || "" });
	console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `: ${detail}` : ""}`);
}

function warn(name, detail) {
	results.push({ status: "WARN", name, detail: detail || "" });
	console.log(`  \x1b[33m⚠\x1b[0m ${name}${detail ? `: ${detail}` : ""}`);
}

function fail(name, detail) {
	results.push({ status: "FAIL", name, detail: detail || "" });
	console.log(`  \x1b[31m✗\x1b[0m ${name}: ${detail}`);
}

function step(label) {
	console.log(`\n── ${label} ──`);
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function ask(question, timeoutMs = 0) {
	if (!process.stdin.isTTY) {
		throw new Error(`当前不是交互终端，无法等待输入：${question.trim()}`);
	}
	return new Promise((resolveAnswer, rejectAnswer) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		let timer = null;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				rl.close();
				rejectAnswer(new Error("等待人工输入超时"));
			}, timeoutMs);
		}
		rl.question(question, (answer) => {
			if (timer) clearTimeout(timer);
			rl.close();
			resolveAnswer(answer.trim());
		});
	});
}

function parseAuthorizationCode(input) {
	const trimmed = String(input || "").trim();
	const match = trimmed.match(/[?&]code=([^&]+)/);
	return match ? decodeURIComponent(match[1]) : trimmed;
}

function isExternalHttpsRedirect(location) {
	try {
		const target = new URL(location);
		return target.protocol === "https:" && target.origin !== new URL(BASE).origin;
	} catch {
		return false;
	}
}

function runSelfCheck() {
	assert.notEqual(BASE_VERSION, TARGET_VERSION, "基线与目标版本不能相同");
	assert.equal(parseAuthorizationCode("abc"), "abc");
	assert.equal(
		parseAuthorizationCode("https://example.test/callback?code=a%2Bb&state=s"),
		"a+b",
	);
	assert.equal(isExternalHttpsRedirect("https://download.example/file"), true);
	assert.equal(
		isExternalHttpsRedirect(`${BASE}/api/releases/1.0.0/file`),
		false,
	);
	console.log("test-release-alibaba.cjs self-check: OK");
}

async function api(method, path, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (opts.json !== undefined) headers["content-type"] = "application/json";
	if (!opts.noCookie && cookie) headers.cookie = cookie;
	const init = {
		method,
		headers,
		redirect: opts.redirect || "manual",
	};
	if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
	if (opts.body !== undefined) {
		init.body = opts.body;
		init.duplex = "half";
	}
	const response = await fetch(`${BASE}${path}`, init);
	const setCookie = response.headers.get("set-cookie");
	if (setCookie) {
		const match = setCookie.match(/vcpdeck_session=([^;]+)/);
		if (match) cookie = `vcpdeck_session=${match[1]}`;
	}
	return response;
}

async function apiJson(method, path, opts = {}) {
	const response = await api(method, path, opts);
	const text = await response.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body, headers: response.headers };
}

async function login() {
	cookie = "";
	const response = await apiJson("POST", "/api/auth/login", {
		json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
		noCookie: true,
	});
	if (
		(response.status !== 200 && response.status !== 201) ||
		!response.body?.identity?.isAdmin
	) {
		throw new Error(`管理员登录失败: HTTP ${response.status}`);
	}
}

function isPortOpen(port) {
	return new Promise((resolveOpen) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		const finish = (open) => {
			socket.destroy();
			resolveOpen(open);
		};
		socket.setTimeout(1000, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function ensurePortFree() {
	if (!(await isPortOpen(3001))) return;
	step("需要你介入：3001 端口被占用");
	console.log(
		"  请停止当前 dev/生产 Server；脚本不会杀死非本次测试创建的进程。",
	);
	await ask("  停止后按 Enter 继续（10 分钟超时）: ", 10 * 60_000);
	if (await isPortOpen(3001)) {
		throw new Error("3001 端口仍被占用");
	}
}

function runPnpm(args, label) {
	console.log(`  [exec] ${label}`);
	if (nodePlatform() === "win32") {
		execFileSync(
			process.env.ComSpec || "C:/Windows/System32/cmd.exe",
			["/d", "/s", "/c", "pnpm", ...args],
			{ cwd: ROOT, stdio: "inherit", env: { ...process.env } },
		);
		return;
	}
	execFileSync("pnpm", args, {
		cwd: ROOT,
		stdio: "inherit",
		env: { ...process.env },
	});
}

function packageVersion(version) {
	const versionFiles = [
		join(ROOT, "packages", "shared", "package.json"),
		join(ROOT, "packages", "sdk", "package.json"),
		join(ROOT, "packages", "cli", "package.json"),
		join(ROOT, "packages", "shared", "src", "version.ts"),
		join(ROOT, "pnpm-lock.yaml"),
		join(ROOT, "skills", "vcpdeck", "vcpdeck.cjs"),
	];
	const originals = new Map(
		versionFiles.map((path) => [
			path,
			existsSync(path) ? readFileSync(path, "utf8") : undefined,
		]),
	);
	try {
		runPnpm(
			["release", `--version=${version}`, `--output=${OUTPUT_REL}`],
			`打包 ${version}`,
		);
		for (const platform of ["win-x64", "linux-x64"]) {
			const path = archivePath(version, platform);
			if (!existsSync(path)) throw new Error(`打包后缺少 ${path}`);
		}
	} finally {
		for (const [path, content] of originals) {
			if (content === undefined) rmSync(path, { force: true });
			else writeFileSync(path, content);
		}
	}
}

function archivePath(version, platform) {
	return join(OUTPUT_DIR, `vcpdeck-${version}-${platform}.zip`);
}

function installArtifact(artifact, zipPath, appDir, extraArgs) {
	execFileSync(
		process.execPath,
		[
			join(ROOT, "scripts", "install.cjs"),
			`--artifact=${artifact}`,
			`--zip=${zipPath}`,
			`--app-dir=${appDir}`,
			`--psk=${PSK}`,
			"--force",
			...extraArgs,
		],
		{ cwd: ROOT, stdio: "inherit", env: { ...process.env } },
	);
}

function startLauncher(appDir, tag, extraEnv = {}) {
	const launcherPath = join(appDir, "dist", "main.js");
	const envPath = join(appDir, "launcher.env");
	if (!existsSync(launcherPath) || !existsSync(envPath)) {
		throw new Error(`${tag} 安装不完整：缺 Launcher 或 launcher.env`);
	}
	const child = spawn(
		process.execPath,
		[`--env-file=${envPath}`, launcherPath],
		{
			cwd: appDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...extraEnv },
		},
	);
	child.stdout.on("data", (chunk) => {
		process.stdout.write(`[launcher:${tag}] ${chunk}`);
	});
	child.stderr.on("data", (chunk) => {
		process.stderr.write(`[launcher:${tag}:err] ${chunk}`);
	});
	return child;
}

async function stopLauncher(child, tag) {
	if (!child || child.exitCode !== null) return;
	if (nodePlatform() === "win32") {
		try {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
				stdio: "ignore",
				timeout: 15_000,
			});
			return;
		} catch {
			// 回退到普通信号
		}
	}
	try {
		child.kill("SIGTERM");
		await Promise.race([once(child, "exit"), sleep(15_000)]);
	} catch {
		// 进程可能已退出
	}
	if (child.exitCode === null) {
		warn(`${tag} 未在 15 秒内退出`, "发送 SIGKILL");
		try {
			child.kill("SIGKILL");
		} catch {
			// 忽略
		}
	}
}

async function waitForServer(timeoutMs = 90_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// pi-lens-ignore: typescript.react.security.react-insecure-request.react-insecure-request
			const response = await fetch(`${BASE}/api/health`);
			if (response.ok && (await response.json())?.ok) return;
		} catch {
			// Server 启动/重启窗口
		}
		await sleep(1000);
	}
	throw new Error("Server 在超时时间内未就绪");
}

async function waitForServerVersion(version, timeoutMs = 15 * 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// pi-lens-ignore: typescript.react.security.react-insecure-request.react-insecure-request
			const response = await fetch(`${BASE}/api/status`);
			if (response.ok && (await response.json())?.serverVersion === version)
				return;
		} catch {
			// Server 自更新重启窗口
		}
		await sleep(2000);
	}
	throw new Error(`Server 未在 ${timeoutMs / 1000}s 内切换到 ${version}`);
}

async function waitForClient(version, timeoutMs = 15 * 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await apiJson("GET", "/api/clients");
			if (response.status === 401) {
				await login();
				continue;
			}
			const client = Array.isArray(response.body)
				? response.body.find((item) => item.clientId === TEST_CLIENT_ID)
				: null;
			if (client?.online && client.clientVersion === version) return client;
		} catch {
			// Server/Client 重启窗口
		}
		await sleep(2000);
	}
	throw new Error(`Client ${TEST_CLIENT_ID} 未在超时内切换到 ${version}`);
}

async function waitForReleaseDone(timeoutMs = 15 * 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await apiJson("GET", "/api/releases");
			if (response.status === 401) {
				await login();
				continue;
			}
			const release = Array.isArray(response.body?.data)
				? response.body.data.find((item) => item.version === TARGET_VERSION)
				: null;
			if (release?.status === "done") return release;
			if (release?.status === "failed") {
				throw new Error(`Release failed: ${release.errorMessage || "无原因"}`);
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Release failed:")) {
				throw error;
			}
		}
		await sleep(2000);
	}
	throw new Error(`Release 未在 ${timeoutMs / 1000}s 内进入 done`);
}

function sha256File(path) {
	return new Promise((resolveHash, rejectHash) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("error", rejectHash)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolveHash(hash.digest("hex")));
	});
}

function rememberUploadedKeys(release) {
	for (const archive of Object.values(release?.archives || {})) {
		if (archive?.storage?.provider === "alibaba" && archive.storage.key) {
			uploadedKeys.add(archive.storage.key);
		}
	}
}

async function uploadArchive(platform) {
	const path = archivePath(TARGET_VERSION, platform);
	const sha256 = await sha256File(path);
	const response = await api(
		"POST",
		`/api/releases/upload?version=${TARGET_VERSION}&platform=${platform}&sha256=${sha256}`,
		{
			headers: { "content-type": "application/zip" },
			body: createReadStream(path),
		},
	);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`上传 ${platform} 失败: HTTP ${response.status} ${text}`);
	}
	if (!text) return null;
	try {
		const release = JSON.parse(text).release ?? null;
		rememberUploadedKeys(release);
		return release;
	} catch {
		throw new Error(`上传 ${platform} 响应不是合法 JSON`);
	}
}

async function findTargetRelease() {
	const response = await apiJson("GET", "/api/releases");
	if (response.status !== 200 || !Array.isArray(response.body?.data)) {
		throw new Error(`Release 列表失败: HTTP ${response.status}`);
	}
	const release = response.body.data.find(
		(item) => item.version === TARGET_VERSION,
	);
	if (!release) throw new Error(`未找到 Release ${TARGET_VERSION}`);
	return release;
}

function openBrowser(url) {
	try {
		let command;
		if (nodePlatform() === "win32") {
			command = ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
		} else if (nodePlatform() === "darwin") {
			command = ["open", [url]];
		} else {
			command = ["xdg-open", [url]];
		}
		const child = spawn(command[0], command[1], {
			stdio: "ignore",
			detached: true,
		});
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// 仍会打印 URL，用户可手工打开
	}
}

async function configureAlibaba() {
	step("需要你介入：阿里云盘 OAuth 授权");
	let clientId = process.env.ALIBABA_CLIENT_ID || "";
	if (!clientId) {
		console.log("  请在阿里云盘开发者中心创建应用，redirect_uri 设置为 oob。");
		clientId = await ask("  粘贴 clientId: ");
	}
	if (!clientId) throw new Error("clientId 不能为空");

	const config = {
		clientId,
		openapiBase: OPENAPI_BASE,
		transferFolder: process.env.ALIBABA_TRANSFER_FOLDER || "VCPDeckTransfers",
	};
	if (process.env.ALIBABA_CLIENT_SECRET) {
		config.clientSecret = process.env.ALIBABA_CLIENT_SECRET;
	}
	const saved = await apiJson("PUT", "/api/aliyundrive/config", {
		json: config,
	});
	if (saved.status !== 200 && saved.status !== 201) {
		throw new Error(`保存阿里云盘配置失败: HTTP ${saved.status}`);
	}

	const started = await apiJson("POST", "/api/aliyundrive/oauth/start");
	if (
		(started.status !== 200 && started.status !== 201) ||
		!started.body?.state
	) {
		throw new Error(`启动 OAuth 失败: HTTP ${started.status}`);
	}
	const authorizationUrl = started.body.authorizationUrl;
	console.log("\n  浏览器将自动打开授权页；若未打开，请复制下面的 URL：\n");
	console.log(`  ${authorizationUrl}\n`);
	openBrowser(authorizationUrl);
	const input = await ask(
		"  授权后粘贴 code 或完整回调 URL（10 分钟超时）: ",
		10 * 60_000,
	);
	const code = parseAuthorizationCode(input);
	if (!code) throw new Error("OAuth code 不能为空");

	const completed = await apiJson("POST", "/api/aliyundrive/oauth/complete", {
		json: { state: started.body.state, code },
	});
	if (completed.status !== 200 && completed.status !== 201) {
		throw new Error(`OAuth 完成失败: HTTP ${completed.status}`);
	}

	const verified = await apiJson("POST", "/api/aliyundrive/verify");
	if (!verified.body?.valid || !verified.body?.driveId) {
		throw new Error(
			`阿里云盘授权验证失败: ${verified.body?.reason || "unknown"}`,
		);
	}
	const switched = await apiJson("PUT", "/api/storage/config", {
		json: { kind: "alibaba" },
	});
	if (switched.body?.kind !== "alibaba") {
		throw new Error("Storage 后端未切换到 alibaba");
	}
	pass("阿里云盘授权并切换成功", `driveId=${verified.body.driveId}`);
}

async function verifyFirstArchive() {
	const release = await findTargetRelease();
	const archive = release.archives?.["win-x64"];
	if (
		archive?.storage?.provider !== "alibaba" ||
		archive.storage.mode !== "direct" ||
		!archive.storage.key
	) {
		throw new Error("win-x64 archive 未记录 alibaba direct storage");
	}
	uploadedKeys.add(archive.storage.key);
	const response = await fetch(
		`${BASE}/api/releases/${TARGET_VERSION}/file?platform=win-x64`,
		{ redirect: "manual" },
	);
	const location = response.headers.get("location") || "";
	if (response.status !== 302 || !isExternalHttpsRedirect(location)) {
		throw new Error(
			`下载入口应 302 到外部 HTTPS 直链，实际 HTTP ${response.status}`,
		);
	}
	let hostname = "external-storage";
	try {
		hostname = new URL(location).hostname;
	} catch {
		// isExternalHttpsRedirect 已做过 URL 校验，仅保留防御式兜底
	}
	pass("首个平台构件转存与 302 直链验证通过", hostname);
}

async function verifyAllArchivesDirect() {
	const release = await findTargetRelease();
	for (const platform of ["win-x64", "linux-x64"]) {
		const storage = release.archives?.[platform]?.storage;
		if (
			storage?.provider !== "alibaba" ||
			storage.mode !== "direct" ||
			!storage.key
		) {
			throw new Error(`${platform} archive 未记录 alibaba direct storage`);
		}
		uploadedKeys.add(storage.key);
	}
	pass("两个平台 archive 均为 alibaba direct");
}

async function collectUploadedKeys() {
	try {
		const release = await findTargetRelease();
		rememberUploadedKeys(release);
	} catch {
		// 上传中途失败时列表可能不可用
	}
}

async function deleteUploadedObjects() {
	if (uploadedKeys.size === 0) return;
	try {
		await waitForServer(30_000);
		await login();
		for (const key of uploadedKeys) {
			const response = await api(
				"DELETE",
				`/api/storage/${encodeURIComponent(key)}`,
			);
			if (!response.ok) {
				warn("阿里云盘测试对象删除失败", `HTTP ${response.status}`);
			}
		}
		pass("阿里云盘测试对象已删除", `${uploadedKeys.size} 个`);
	} catch (error) {
		warn(
			"无法自动删除阿里云盘测试对象",
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function runTest() {
	if (BASE_VERSION === TARGET_VERSION) {
		throw new Error("基线版本与目标版本不能相同");
	}
	console.log("\n╔══════════════════════════════════════════╗");
	console.log("║  VCPDeck 阿里云盘一键自更新集成测试    ║");
	console.log("╚══════════════════════════════════════════╝\n");
	console.log(`  基线 ${BASE_VERSION} → 目标 ${TARGET_VERSION}`);
	console.log("  只会停止本脚本创建的进程；不会杀死已有 Server。\n");

	await ensurePortFree();
	if (!existsSync(join(ROOT, "node_modules", ".pnpm"))) {
		runPnpm(["install"], "安装 workspace 依赖");
	}

	serverAppDir = mkdtempSync(join(tmpdir(), "vcpdeck-alibaba-server-"));
	clientAppDir = mkdtempSync(join(tmpdir(), "vcpdeck-alibaba-client-"));
	mkdirSync(OUTPUT_DIR, { recursive: true });

	step(`1. 打包基线版本 ${BASE_VERSION}`);
	packageVersion(BASE_VERSION);
	pass("基线构件打包完成");

	step("2. 安装并启动临时 Server");
	const serverDb = join(serverAppDir, "server.db").replace(/\\/g, "/");
	const releasesDir = join(serverAppDir, "releases");
	installArtifact(
		"server",
		archivePath(
			BASE_VERSION,
			nodePlatform() === "win32" ? "win-x64" : "linux-x64",
		),
		serverAppDir,
		[
			`--admin-password=${ADMIN_PASSWORD}`,
			`--db-url=file:${serverDb}`,
			`--releases-dir=${releasesDir}`,
		],
	);
	appendFileSync(
		join(serverAppDir, "launcher.env"),
		"VCPDECK_COOKIE_SECURE=false\n",
	);
	serverLauncher = startLauncher(serverAppDir, "server");
	await waitForServer();
	await login();
	pass("临时 Server 已启动", serverAppDir);

	step("3. 配置同一临时 DB 的阿里云盘授权");
	await configureAlibaba();

	step("4. 安装并启动临时 Client");
	installArtifact(
		"client",
		archivePath(
			BASE_VERSION,
			nodePlatform() === "win32" ? "win-x64" : "linux-x64",
		),
		clientAppDir,
		[`--server-url=${BASE}`, `--client-id=${TEST_CLIENT_ID}`],
	);
	clientLauncher = startLauncher(clientAppDir, "client");
	await waitForClient(BASE_VERSION);
	pass("临时 Client 已连接", `version=${BASE_VERSION}`);

	step(`5. 打包目标版本 ${TARGET_VERSION}`);
	packageVersion(TARGET_VERSION);
	pass("目标构件打包完成");

	step("6. 上传首个平台并验证阿里云盘直连（尚不触发更新）");
	await uploadArchive("win-x64");
	await verifyFirstArchive();

	step("7. 上传第二个平台，自动触发 Server → Client 更新");
	await uploadArchive("linux-x64");
	await verifyAllArchivesDirect();
	pass("两个平台构件已转存阿里云盘");

	for (const platform of ["win-x64", "linux-x64"]) {
		const localArchive = join(
			releasesDir,
			`vcpdeck-${TARGET_VERSION}-${platform}.zip`,
		);
		if (existsSync(localArchive)) {
			throw new Error(
				`VCPDECK_RELEASES_DIR 出现 ${platform} 目标 zip，未走外部直连存储`,
			);
		}
	}
	pass("Local Release 目录未保存两个目标 zip");

	step("8. 等待 Server 自更新");
	await waitForServerVersion(TARGET_VERSION);
	pass("Server 自更新完成", TARGET_VERSION);

	step("9. 等待 Client 自更新");
	await login();
	await waitForClient(TARGET_VERSION);
	pass("Client 自更新完成", TARGET_VERSION);

	step("10. 验证 Release 终态");
	const release = await waitForReleaseDone();
	const failedClients = Object.entries(release.clientStates || {})
		.filter(([, value]) => value.state === "failed")
		.map(([clientId]) => clientId);
	if (failedClients.length > 0) {
		throw new Error(`存在失败 Client: ${failedClients.join(", ")}`);
	}
	pass("Release done 且无失败 Client");
}

function printReport() {
	console.log("\n=== 集成测试报告 ===\n");
	const passed = results.filter((item) => item.status === "PASS").length;
	const failed = results.filter((item) => item.status === "FAIL").length;
	const warned = results.filter((item) => item.status === "WARN").length;
	for (const item of results) {
		let icon = "\x1b[31m✗\x1b[0m";
		if (item.status === "PASS") icon = "\x1b[32m✓\x1b[0m";
		else if (item.status === "WARN") icon = "\x1b[33m⚠\x1b[0m";
		console.log(
			`  ${icon} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`,
		);
	}
	console.log(
		`\n  ${passed}/${results.length} passed, ${failed} failed, ${warned} warnings\n`,
	);
	if (failed === 0) {
		console.log("✅ ADR-0016 阿里云盘直连分发自更新链路验证通过");
	}
}

async function cleanup() {
	if (cleanupPromise) return cleanupPromise;
	cleanupPromise = (async () => {
		await collectUploadedKeys();
		await deleteUploadedObjects();
		step("清理本次测试创建的进程和临时目录");
		await stopLauncher(clientLauncher, "Client Launcher");
		await stopLauncher(serverLauncher, "Server Launcher");
		for (const dir of [
			clientAppDir,
			serverAppDir,
			join(ROOT, ".tmp", `alibaba-release-e2e-${process.pid}`),
		]) {
			if (!dir) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch (error) {
				warn("临时目录清理失败", `${dir}: ${error.message}`);
			}
		}
	})();
	return cleanupPromise;
}

async function main() {
	try {
		await runTest();
	} catch (error) {
		fail("集成测试失败", error instanceof Error ? error.message : String(error));
	} finally {
		await cleanup();
	}
	printReport();
	process.exitCode = results.some((item) => item.status === "FAIL") ? 1 : 0;
}

function handleSignal(signal) {
	warn(`收到 ${signal}`, "停止本次测试并清理");
	void cleanup().finally(() => {
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

if (process.argv.includes("--self-check")) {
	runSelfCheck();
} else if (process.argv.includes("--help")) {
	console.log("用法: node scripts/test-release-alibaba.cjs [--self-check]");
} else {
	void main();
}
