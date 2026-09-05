#!/usr/bin/env node
/**
 * VCPDeckBridge VCPToolBox 集成 E2E 测试
 * 在完全隔离环境中验证全部 22 个插件动作、分享生命周期 + 错误矩阵
 */
'use strict';

const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
	createIntegrationTestDb,
	initializeIntegrationTestDb,
	cleanupIntegrationTestDb,
} = require("./integration-test-db.cjs");

// ── 常量 ──
const VCP_TOOLBOX = process.env.VCP_TOOLBOX_PATH || "D:/VCPHub/VCPToolBox";
const root = path.resolve(__dirname, "..");
const serverDir = path.join(root, "packages/server");
const clientDir = path.join(root, "packages/client");
const pluginDir = path.join(root, "plugins/vcpdeck");

const SERVER_PORT = 3001;
const ADMIN_PASSWORD = "vcp-plugin-test-admin-pw";
const PSK = "vcp-plugin-e2e-psk";
const FRPS_TOKEN = "vcp-plugin-e2e-frps-token";
const CLIENT_ID = "vcp-plugin-e2e-client";

const isWin = os.platform() === "win32";
const frpDir = isWin ? "win-x64" : "linux-x64";
const frpsExe = isWin ? "frps.exe" : "frps";
const frpcExe = isWin ? "frpc.exe" : "frpc";
const PLUGIN_TIMEOUT_MS = 300000;

// ── 状态 ──
let _serverProc, _clientProc, _frpsProc, _echoServer;
let _dbCtx, _token = { id: null, value: null };
let _pluginManager, _savedPlugin;
let _sandboxDir, _frpsPorts;
let _passed = 0, _failures = [];

// ── 工具函数 ──
function pass(name, detail = "") { _passed++; console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`); }
function fail(name, detail) { _failures.push({ name, detail }); console.log(`  FAIL  ${name}  ${detail}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomPort() { return 10000 + Math.floor(Math.random() * 50000); }
async function getFreePort() {
	for (let i = 0; i < 100; i++) {
		const p = randomPort();
		const free = await new Promise((r) => {
			const s = net.createServer();
			s.once("error", () => r(false));
			s.once("listening", () => { s.close(); r(true); });
			s.listen(p, "127.0.0.1");
		});
		if (free) return p;
	}
	throw new Error("No free port found");
}

function killTree(pid) {
	if (!pid) return;
	try {
		if (os.platform() === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
		else execSync(`kill -9 -${pid}`, { stdio: "ignore" });
	} catch { /* already dead */ }
}

function resolveFrpBinary(name) {
	const candidates = [
		path.join(root, "packages/server/dist/frp", frpDir, name),
		path.join(root, "packages/client/dist/frp", frpDir, name),
		path.join(root, "frp", name),
	];
	for (const c of candidates) if (fs.existsSync(c)) return c;
	return null;
}

// ── VCPToolBox 真实解析器 ──
function getToolCallParser() {
	return require(path.join(VCP_TOOLBOX, "modules/vcpLoop/toolCallParser.js"));
}

function toolBlock(command, args = {}) {
	const fields = { maid: "VCPDeckE2E", tool_name: "VCPDeckBridge", command, ...args };
	return `<<<[TOOL_REQUEST]>>>\n${Object.entries(fields)
		.map(([k, v]) => `${k}:「始」${v}「末」`)
		.join(",\n")}\n<<<[END_TOOL_REQUEST]>>>`;
}

function parseToolBlock(parser, text) {
	const block = parser.extractNextToolBlock(text);
	if (!block) throw new Error("Failed to extract tool block");
	const call = parser.parseBlock(block.blockContent);
	if (call.name !== "VCPDeckBridge") throw new Error(`Wrong tool name: ${call.name}`);
	return call;
}

// ── Server API ──
let BASE = "";
let _adminCookie = "";

async function apiJson(method, apiPath, body) {
	const opts = { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${_token.value}`, Cookie: _adminCookie } };
	if (body) opts.body = JSON.stringify(body);
	const res = await fetch(`${BASE}${apiPath}`, opts);
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function loginAsAdmin() {
	const res = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
	});
	if (!res.ok) throw new Error(`Login failed: ${res.status}`);
	const setCookie = res.headers.get("set-cookie");
	if (setCookie) _adminCookie = setCookie.split(";")[0]; // vcpdeck_session=...
}

async function createToken(label) {
	const res = await fetch(`${BASE}/api/auth/tokens`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: _adminCookie },
		body: JSON.stringify({ label }),
	});
	if (!res.ok) throw new Error(`Create token failed: ${res.status} ${await res.text().catch(() => "")}`);
	return res.json();
}

// ── 进程启动 ──
async function startFrps() {
	const frpsPath = resolveFrpBinary(frpsExe);
	if (!frpsPath) { fail("frps binary", "not found"); process.exit(1); }

	const bindPort = await getFreePort();
	const dashPort = await getFreePort();
	const remotePort = await getFreePort();
	_frpsPorts = { bindPort, dashPort, remotePort };

	const tomlPath = path.join(_sandboxDir, "frps-test.toml");
	fs.writeFileSync(tomlPath, [
		`bindPort = ${bindPort}`,
		`auth.method = "token"`,
		`auth.token = "${FRPS_TOKEN}"`,
		`webServer.addr = "0.0.0.0"`,
		`webServer.port = ${dashPort}`,
		`webServer.user = "admin"`,
		`webServer.password = "admin"`,
		`allowPorts = [{ start = ${remotePort - 100}, end = ${remotePort + 100} }]`,
		`vhostHTTPPort = ${await getFreePort()}`,
		`log.to = "${path.join(_sandboxDir, "frps.log").replace(/\\/g, "/")}"`,
		`log.level = "info"`,
		`log.maxDays = 1`,
	].join("\n"));

	_frpsProc = spawn(frpsPath, ["-c", tomlPath], { cwd: _sandboxDir, stdio: "ignore", detached: true });
	for (let i = 0; i < 30; i++) {
		try {
			const auth = Buffer.from("admin:admin").toString("base64");
			const res = await fetch(`http://127.0.0.1:${dashPort}/api/serverinfo`, {
				headers: { Authorization: `Basic ${auth}` },
				signal: AbortSignal.timeout(2000),
			});
			if (res.ok) return;
		} catch { /* not ready */ }
		await sleep(1000);
	}
	throw new Error("FRPS not ready after 30s");
}

async function startServer() {
	return new Promise((resolve, reject) => {
		_serverProc = spawn("node", ["dist/main.js"], {
			cwd: serverDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				DATABASE_URL: _dbCtx.databaseUrl,
				VCPDECK_PSK: PSK,
				VCPDECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
				VCPDECK_FRONTEND_ORIGIN: `http://localhost:${SERVER_PORT}`,
				FRPS_BIND_PORT: String(_frpsPorts.bindPort),
				FRPS_TOKEN,
				FRP_DASHBOARD_HOST: "127.0.0.1",
				FRP_DASHBOARD_PORT: String(_frpsPorts.dashPort),
				FRP_DASHBOARD_USER: "admin",
				FRP_DASHBOARD_PASSWORD: "admin",
				FRP_PUBLIC_HOST: "127.0.0.1",
				FRP_PORT_RANGE_START: String(_frpsPorts.remotePort - 100),
				FRP_PORT_RANGE_END: String(_frpsPorts.remotePort + 100),
			},
		});
		let buf = "";
		const onText = (d) => {
			const t = d.toString();
			buf += t;
			if (buf.length > 1000000) buf = buf.slice(-500000);
			if (t.includes("listening on")) resolve();
		};
		_serverProc.stdout?.on("data", onText);
		_serverProc.stderr?.on("data", onText);
		_serverProc.on("error", reject);
		setTimeout(() => reject(new Error("Server start timeout")), 30000);
	});
}

async function startClient() {
	const frpcPath = path.join(root, "packages/client/dist/frp", frpDir, frpcExe);
	return new Promise((resolve, reject) => {
		_clientProc = spawn("node", ["dist/index.js"], {
			cwd: clientDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				VCPDECK_CLIENT_ID: CLIENT_ID,
				VCPDECK_SERVER: `http://localhost:${SERVER_PORT}`,
				VCPDECK_PSK: PSK,
				VCPDECK_FRPC_PATH: frpcPath,
				VCPDECK_FRPC_WORK_DIR: path.join(_sandboxDir, "frpc-work").replace(/\\/g, "/"),
			},
		});
		let started = false;
		const onData = (chunk) => {
			const t = chunk.toString();
			if (!started && (t.includes("connected as") || t.includes("registered"))) { started = true; resolve(); }
		};
		_clientProc.stdout?.on("data", onData);
		_clientProc.stderr?.on("data", onData);
		_clientProc.on("error", reject);
		_clientProc.on("exit", (code) => { if (!started) reject(new Error(`Client exited: ${code}`)); });
		setTimeout(() => { if (!started) reject(new Error("Client start timeout")); }, 20000);
	});
}

// ── VCPToolBox 插件调用（忠实复刻 Plugin.js::executePlugin 的 stdio 同步分支） ──
let _sandboxPluginDir;

function setupPluginSandbox() {
	_sandboxPluginDir = path.join(_sandboxDir, "plugin");
	fs.mkdirSync(_sandboxPluginDir, { recursive: true });
	fs.copyFileSync(path.join(pluginDir, "index.cjs"), path.join(_sandboxPluginDir, "index.cjs"));
	fs.copyFileSync(path.join(pluginDir, "plugin-manifest.json"), path.join(_sandboxPluginDir, "plugin-manifest.json"));
}

/**
 * 复刻 VCPToolBox Plugin.js::executePlugin 的 synchronous/stdio 分支：
 * 1. 用 entryPoint.command 启动子进程（cwd=basePath）
 * 2. 将 JSON.stringify(args) 写入 stdin 并关闭
 * 3. 等待进程退出，读取完整 stdout
 * 4. JSON.parse(stdout.trim())
 * 5. 成功 {status:"success",result:{content}} → 返回 result 对象
 *    失败 {status:"error",error} → 抛出 Error
 */
function spawnPlugin(args) {
	return new Promise((resolve, reject) => {
		const manifest = JSON.parse(fs.readFileSync(path.join(_sandboxPluginDir, "plugin-manifest.json"), "utf8"));
		const entry = manifest.entryPoint?.command || "node index.cjs";
		const [cmd, ...scriptArgs] = entry.split(/\s+/);
		const spawnCmd = cmd === "node" ? process.execPath : cmd;
		const scriptPath = scriptArgs[0] ? path.join(_sandboxPluginDir, scriptArgs[0]) : null;
		const spawnArgs = scriptPath ? [scriptPath, ...scriptArgs.slice(1)] : scriptArgs;

		const env = {
			...process.env,
			...(manifest.pluginSpecificEnvConfig || {}),
			SERVER_URL: `http://localhost:${SERVER_PORT}`,
			API_TOKEN: _token.value || "",
			REQUEST_TIMEOUT_MS: String(PLUGIN_TIMEOUT_MS),
			PUBLIC_SHARE_BASE_URL: "",
		};

		const child = spawn(spawnCmd, spawnArgs, {
			cwd: _sandboxPluginDir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: PLUGIN_TIMEOUT_MS,
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => { stdout += d; });
		child.stderr?.on("data", (d) => { stderr += d; });
		child.stdin?.end(JSON.stringify(args));

		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Plugin process timeout (${PLUGIN_TIMEOUT_MS}ms)`));
		}, PLUGIN_TIMEOUT_MS);

		child.on("error", (err) => { clearTimeout(timer); reject(err); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && !stdout.trim()) {
				reject(new Error(`Plugin exited with code ${code}: ${stderr.slice(0, 200)}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim());
				if (parsed.status === "error") {
					const err = new Error(parsed.error || "plugin error");
					err.pluginError = true;
					err.result = parsed.result;
					reject(err);
				} else {
					resolve(parsed.result || parsed);
				}
			} catch (e) {
				reject(new Error(`Plugin stdout parse failed: ${e.message}. stdout: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

// ── 通过 VCPToolBox 真实 ToolCallParser 调用插件 ──
const parser = getToolCallParser();

async function invoke(command, args = {}) {
	const call = parseToolBlock(parser, toolBlock(command, args));
	return spawnPlugin(call.args);
}

function startEchoServer() {
	return new Promise((resolve) => {
		_echoServer = net.createServer((sock) => { sock.on("data", (d) => sock.write(d)); });
		_echoServer.listen(0, "127.0.0.1", () => resolve());
	});
}

// ── 清理 ──
async function cleanup() {
	try {
		if (_token.id && _token.value) {
			try { await fetch(`${BASE}/api/auth/tokens/${_token.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${_token.value}` } }); } catch { /* */ }
		}
		_echoServer?.close();
		killTree(_clientProc?.pid);
		killTree(_serverProc?.pid);
		killTree(_frpsProc?.pid);
		await sleep(1000);
		if (_dbCtx) cleanupIntegrationTestDb(_dbCtx);
		if (_sandboxDir) fs.rmSync(_sandboxDir, { recursive: true, force: true });
	} catch (e) { console.log(`  [cleanup] ${e.message}`); }
}

// ── 主流程 ──
async function main() {
	console.log("\n=== VCPDeckBridge VCPToolBox E2E ===\n");

	const runId = randomUUID().slice(0, 8);
	_sandboxDir = path.join(root, ".tmp/vcp-plugin-e2e", runId);
	fs.mkdirSync(_sandboxDir, { recursive: true });

	// 隔离 DB
	_dbCtx = createIntegrationTestDb();
	initializeIntegrationTestDb(_dbCtx, serverDir);
	pass("isolated DB", _dbCtx.databaseUrl);

	// FRPS
	console.log("\n--- FRPS ---");
	await startFrps();
	pass("frps started", `bind=${_frpsPorts.bindPort} dash=${_frpsPorts.dashPort}`);

	// Server
	console.log("\n--- Server ---");
	BASE = `http://localhost:${SERVER_PORT}`;
	await startServer();
	pass("Server started", BASE);

	// 登录 + Token
	await loginAsAdmin();
	const tokenData = await createToken(`vcp-plugin-e2e-${runId}`);
	_token = { id: tokenData.id, value: tokenData.token };
	pass("token created", `id=${tokenData.id}`);

	// Client
	console.log("\n--- Client ---");
	await startClient();
	pass("Client started", CLIENT_ID);

	let clientOnline = false;
	for (let i = 0; i < 20; i++) {
		const { body } = await apiJson("GET", "/api/clients");
		if (body?.some?.((c) => c.clientId === CLIENT_ID && c.online)) { clientOnline = true; break; }
		await sleep(1000);
	}
	if (!clientOnline) {
		fail("Client online", "not online after 20s");
		await cleanup();
		process.exit(1);
	}
	pass("Client online", CLIENT_ID);

	// 设置 VCPToolBox 插件沙箱
	console.log("\n--- VCPToolBox Plugin Sandbox ---");
	setupPluginSandbox();
	pass("VCPDeckBridge sandbox ready", _sandboxPluginDir);

	// 启动 echo server 用于 FRP 测试
	await startEchoServer();
	const echoPort = _echoServer.address().port;
	pass("echo server started", `port=${echoPort}`);

	// ── 22 个插件命令 + 分享生命周期 E2E ──
	console.log("\n--- 22 Plugin Commands + Share Lifecycle E2E ---");
	let jobId = null, longJobId = null, mappingId = null;
	const ROOT_DIR = "D:\\"; // Client 工作目录在 D:\
	const relDir = `.tmp/vcp-plugin-e2e/${runId}`;
	const filePath = `${relDir}/test-file.txt`;
	const mvTarget = `${relDir}/moved-file.txt`;

	try {
		// 1. ListClients
		try {
			const r = await invoke("ListClients");
			const content = r.result?.content?.[0]?.text ?? r.content?.[0]?.text;
			const found = JSON.parse(content).some?.((c) => c.clientId === CLIENT_ID);
			found ? pass("1. ListClients", "found test client") : fail("1. ListClients", "client not found");
		} catch (e) { fail("1. ListClients", e.message); }

		// 2. ListRoots
		try {
			const r = await invoke("ListRoots", { clientId: CLIENT_ID });
			const content = r.result?.content?.[0]?.text ?? r.content?.[0]?.text;
			const roots = JSON.parse(content);
			pass("2. ListRoots", `roots=${JSON.stringify(roots).slice(0, 60)}`);
		} catch (e) { fail("2. ListRoots", e.message); }

		// 3. RunShellJob (marker)
		try {
			const r = await invoke("RunShellJob", { clientId: CLIENT_ID, shellCommand: "node -e \"console.log('vcp-plugin-e2e-marker')\"" });
			const content = r.result?.content?.[0]?.text ?? r.content?.[0]?.text;
			jobId = JSON.parse(content).jobId;
			pass("3. RunShellJob", `jobId=${jobId}`);
		} catch (e) { fail("3. RunShellJob", e.message); }

		// 4. GetJob (poll)
		if (jobId) {
			let done = false;
			for (let i = 0; i < 30; i++) {
				try {
					const r = await invoke("GetJob", { jobId });
					const s = JSON.parse(r.result?.content?.[0]?.text ?? r.content?.[0]?.text).status;
					if (s === "done" || s === "failed") { done = true; break; }
				} catch { /* */ }
				await sleep(1000);
			}
			done ? pass("4. GetJob", `job ${jobId} done`) : fail("4. GetJob", `job ${jobId} not done after 30s`);
		}

		// 5. GetJobOutput
		if (jobId) {
			try {
				const r = await invoke("GetJobOutput", { jobId });
				const content = r.result?.content?.[0]?.text ?? r.content?.[0]?.text ?? "";
				content.includes("vcp-plugin-e2e-marker")
					? pass("5. GetJobOutput", "marker found")
					: fail("5. GetJobOutput", `marker not found in: ${content.slice(0, 60)}`);
			} catch (e) { fail("5. GetJobOutput", e.message); }
		}

		// 6. ListJobs
		try {
			const r = await invoke("ListJobs", { clientId: CLIENT_ID });
			const total = JSON.parse(r.result?.content?.[0]?.text ?? r.content?.[0]?.text).total;
			pass("6. ListJobs", `total=${total}`);
		} catch (e) { fail("6. ListJobs", e.message); }

		// 7. RunShellJob (long) → 8. CancelJob → 9. GetJob(cancelled)
		try {
			const r = await invoke("RunShellJob", { clientId: CLIENT_ID, shellCommand: "node -e \"setTimeout(()=>{},60000)\"", timeout: "120" });
			longJobId = JSON.parse(r.result?.content?.[0]?.text ?? r.content?.[0]?.text).jobId;
			pass("7. RunShellJob(long)", `jobId=${longJobId}`);
		} catch (e) { fail("7. RunShellJob(long)", e.message); }

		if (longJobId) {
			try { await invoke("CancelJob", { jobId: longJobId }); pass("8. CancelJob", longJobId); }
			catch (e) { fail("8. CancelJob", e.message); }

			let gotResponse = false, jobStatus = "";
			for (let i = 0; i < 60; i++) {
				try {
					const r2 = await invoke("GetJob", { jobId: longJobId });
					const text2 = r2.result?.content?.[0]?.text ?? r2.content?.[0]?.text ?? "";
					const job = JSON.parse(text2);
					jobStatus = job.status || job.state || "";
					gotResponse = true;
					if (["cancelled", "done", "failed", "cancelling"].includes(jobStatus)) break;
				} catch { /* */ }
				await sleep(1000);
			}
			if (gotResponse) pass("9. GetJob(cancelled)", `${longJobId} status=${jobStatus}`);
			else fail("9. GetJob(cancelled)", "no response after 60s");
		}

		// 10-16. File operations（显式 rootDir 避免多根歧义）
		try { await invoke("MakeDirectory", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: relDir }); pass("10. MakeDirectory", relDir); }
		catch (e) { fail("10. MakeDirectory", e.message); }

		try { await invoke("WriteFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: filePath, content: `vcp-plugin-e2e-${runId}` }); pass("11. WriteFile", filePath); }
		catch (e) { fail("11. WriteFile", e.message); }

		try {
			const r = await invoke("ReadFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: filePath });
			const content = r.result?.content?.[0]?.text ?? r.content?.[0]?.text;
			(content || "").includes(`vcp-plugin-e2e-${runId}`) ? pass("12. ReadFile", "content ok") : fail("12. ReadFile", `mismatch: ${(content || "").slice(0, 60)}`);
		} catch (e) { fail("12. ReadFile", e.message); }

		try { await invoke("StatFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: filePath }); pass("13. StatFile", filePath); }
		catch (e) { fail("13. StatFile", e.message); }

		try { await invoke("ListDirectory", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: relDir }); pass("14. ListDirectory", relDir); }
		catch (e) { fail("14. ListDirectory", e.message); }

		try { await invoke("MoveFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, source: filePath, target: mvTarget }); pass("15. MoveFile", `${filePath} → ${mvTarget}`); }
		catch (e) { fail("15. MoveFile", e.message); }

		try { await invoke("DeleteFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: mvTarget }); pass("16. DeleteFile", mvTarget); }
		catch (e) { fail("16. DeleteFile", e.message); }

		// 17. DownloadFile + 18. public text download + 19-20. public image redirects
		const downloadFilePath = `${relDir}/download.txt`;
		const downloadContent = `vcp-plugin-download-${runId}`;
		let downloadShareUrl = "";
		try {
			await invoke("WriteFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: downloadFilePath, content: downloadContent });
			const r = await invoke("DownloadFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: downloadFilePath });
			const text = r.result?.content?.[0]?.text ?? r.content?.[0]?.text ?? "";
			downloadShareUrl = text.match(/<((?:https?:\/\/)[^>]+)>/)?.[1] || "";
			if (!downloadShareUrl) throw new Error(`missing share URL: ${text.slice(0, 120)}`);
			pass("17. DownloadFile", "share created");

			const publicResponse = await fetch(downloadShareUrl, { redirect: "manual" });
			const location = publicResponse.headers.get("location");
			if (publicResponse.status !== 302 || !location) throw new Error(`expected 302, got ${publicResponse.status}`);
			const downloaded = await fetch(new URL(location, downloadShareUrl));
			const body = await downloaded.text();
			if (!downloaded.ok || body !== downloadContent) throw new Error(`download body mismatch: ${body.slice(0, 80)}`);
			if (publicResponse.headers.get("cache-control") !== "private, no-store" || publicResponse.headers.get("referrer-policy") !== "no-referrer") {
				throw new Error("public redirect security headers missing");
			}
			pass("18. public text download", "302 followed without auth");
		} catch (e) { fail("17-18. DownloadFile/public text", e.message); }

		const pngPath = `${relDir}/preview.png`;
		const pngContent = `synthetic-png-${runId}`;
		try {
			await invoke("WriteFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: pngPath, content: pngContent });
			const r = await invoke("DownloadFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: pngPath });
			const text = r.result?.content?.[0]?.text ?? r.content?.[0]?.text ?? "";
			const url = text.match(/<((?:https?:\/\/)[^>]+)>/)?.[1] || "";
			const response = await fetch(url, { redirect: "manual" });
			const location = response.headers.get("location");
			if (response.status !== 302 || !location) throw new Error(`expected 302, got ${response.status}`);
			const downloaded = await fetch(new URL(location, url));
			const body = await downloaded.text();
			if (!downloaded.ok || body !== pngContent) {
				throw new Error(`PNG response mismatch: ${downloaded.status} ${downloaded.headers.get("content-type")}`);
			}
			pass("19. public PNG preview", "302 followed to current provider");
		} catch (e) { fail("19. public PNG preview", e.message); }

		const svgPath = `${relDir}/preview.svg`;
		const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><text x="1" y="12">${runId}</text></svg>`;
		try {
			await invoke("WriteFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: svgPath, content: svgContent });
			const r = await invoke("DownloadFile", { clientId: CLIENT_ID, rootDir: ROOT_DIR, path: svgPath });
			const items = r.result?.content ?? r.content ?? [];
			const text = items[0]?.text ?? "";
			const url = text.match(/<((?:https?:\/\/)[^>]+)>/)?.[1] || "";
			const response = await fetch(url, { redirect: "manual" });
			const location = response.headers.get("location");
			if (response.status !== 302 || !location || !items.some((item) => item.type === "image_url" && item.image_url?.url === url)) {
				throw new Error(`SVG redirect mismatch: ${response.status}`);
			}
			const downloaded = await fetch(new URL(location, url));
			const body = await downloaded.text();
			if (!downloaded.ok || body !== svgContent) throw new Error(`SVG response mismatch: ${downloaded.status}`);
			pass("20. public SVG preview", "image_url and 302 to current provider");
		} catch (e) { fail("20. public SVG preview", e.message); }

		// 21. GetStorageStatus
		try { await invoke("GetStorageStatus"); pass("21. GetStorageStatus"); }
		catch (e) { fail("21. GetStorageStatus", e.message); }

		// 22. ListReleases
		try { await invoke("ListReleases"); pass("22. ListReleases"); }
		catch (e) { fail("22. ListReleases", e.message); }

		// 23-27. FRP actions are included in VCP_COMMANDS and exercised here.
		try {
			const r = await invoke("ListFrpInstances");
			const total = JSON.parse(r.result?.content?.[0]?.text ?? r.content?.[0]?.text).total;
			pass("23. ListFrpInstances", `total=${total}`);
		} catch (e) { fail("23. ListFrpInstances", e.message); }

		try {
			const r = await invoke("ListFrpMappings", { clientId: CLIENT_ID });
			const mappings = JSON.parse(r.result?.content?.[0]?.text ?? r.content?.[0]?.text);
			if (!Array.isArray(mappings.data)) throw new Error("mapping list payload missing data");
			pass("24. ListFrpMappings", `total=${mappings.total}`);
		} catch (e) { fail("24. ListFrpMappings", e.message); }

		try {
			const r = await invoke("CreateFrpMapping", {
				clientId: CLIENT_ID,
				localPort: String(echoPort),
				remotePort: String(_frpsPorts.remotePort),
				type: "tcp",
			});
			const m = JSON.parse(r.result?.content?.[0]?.text ?? r.content?.[0]?.text);
			mappingId = m.id || m.mappingId;
			pass("25. CreateFrpMapping", `id=${mappingId} status=${m.status}`);
		} catch (e) { fail("25. CreateFrpMapping", e.message); }

		if (mappingId) {
			let gotResp2 = false, mStatus = "";
			for (let i = 0; i < 60; i++) {
				try {
					const r3 = await invoke("GetFrpMapping", { mappingId });
					const text3 = r3.result?.content?.[0]?.text ?? r3.content?.[0]?.text ?? "";
					const m = JSON.parse(text3);
					mStatus = m.status || "";
					gotResp2 = true;
					if (["active", "deleted", "stopped"].includes(mStatus)) break;
				} catch { /* */ }
				await sleep(1000);
			}
			if (gotResp2) pass("26. GetFrpMapping", `status=${mStatus}`);
			else fail("26. GetFrpMapping", "no response after 60s");

			try { await invoke("DeleteFrpMapping", { mappingId }); pass("27. DeleteFrpMapping", mappingId); }
			catch (e) { fail("27. DeleteFrpMapping", e.message); }
		}

		// Share lifecycle: management output stays metadata-only, active shares block raw-key deletion.
		if (downloadShareUrl) {
			try {
				const shares = await apiJson("GET", "/api/storage/shares?page=1&pageSize=100");
				const shareBody = JSON.stringify(shares.body || {});
				if (shareBody.includes("tokenHash") || shareBody.includes("sharePath")) throw new Error("share metadata leaks token material");
				const share = shares.body?.data?.find((item) => item.filename === "download.txt" && item.status === "active");
				if (!share?.id || !share.fileId) throw new Error("active download share not found");
				const jobs = await apiJson("GET", `/api/jobs?clientId=${encodeURIComponent(CLIENT_ID)}&page=1&pageSize=100`);
				const exportJob = jobs.body?.data?.find((job) => job.type === "file.export" && job.result?.fileId === share.fileId);
				const key = exportJob?.result?.key;
				if (typeof key !== "string" || !key) throw new Error("export storage key not found for deletion check");
				const rawKeyPath = key.split("/").map(encodeURIComponent).join("/");
				const blocked = await apiJson("DELETE", `/api/storage/raw/${rawKeyPath}`);
				if (blocked.status !== 409 || blocked.body?.code !== "FILE_HAS_ACTIVE_SHARES") throw new Error(`expected active-share deletion lock, got ${blocked.status} ${JSON.stringify(blocked.body)}`);
				pass("28. active share deletion lock", "409 FILE_HAS_ACTIVE_SHARES");

				const revoked = await apiJson("DELETE", `/api/storage/shares/${encodeURIComponent(share.id)}`);
				if (revoked.status !== 200 || revoked.body?.status !== "revoked") throw new Error(`revoke failed: ${revoked.status} ${JSON.stringify(revoked.body)}`);
				const unavailable = await fetch(downloadShareUrl, { redirect: "manual" });
				if (unavailable.status !== 410) throw new Error(`expected revoked share 410, got ${unavailable.status}`);
				const deleted = await apiJson("DELETE", `/api/storage/raw/${rawKeyPath}`);
				if (deleted.status !== 200) throw new Error(`delete after revoke failed: ${deleted.status}`);
				pass("29. revoke then delete", "public access 410 and File deleted");
			} catch (e) { fail("28-29. share lifecycle", e.message); }
		}

		// ── 错误矩阵 ──
		console.log("\n--- Error Matrix ---");

		const errorCases = [
			{ name: "missing shellCommand", invoke: () => invoke("RunShellJob", { clientId: CLIENT_ID }) },
			{ name: "non-existent client", invoke: () => invoke("ListRoots", { clientId: "no-such-client" }) },
			{ name: "unknown command", invoke: () => invoke("UnknownAction") },
			{ name: "non-existent job", invoke: () => invoke("GetJob", { jobId: "no-such-job" }) },
		];

		for (const { name, invoke: invokeFn } of errorCases) {
			try {
				await invokeFn();
				fail(`Error: ${name}`, "should have thrown");
			} catch (e) {
				const msg = e.message || JSON.stringify(e);
				if (!msg.includes(_token.value) && !msg.includes("\tat "))
					pass(`Error: ${name}`, msg.slice(0, 80));
				else
					fail(`Error: ${name}`, `leaks token or stack: ${msg.slice(0, 80)}`);
			}
		}

	} finally {
		await cleanup();
	}

	console.log(`\n=== Results: ${_passed} passed, ${_failures.length} failed ===`);
	if (_failures.length > 0) {
		console.log("\nFailures:");
		for (const f of _failures) console.log(`  - ${f.name}: ${f.detail}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error(`FATAL: ${e.message}`);
	cleanup().then(() => process.exit(1));
});
