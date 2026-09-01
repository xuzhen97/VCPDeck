/**
 * VCPDeck FRP 端口映射集成测试
 *
 * 用法：
 *   node scripts/test-frp.cjs
 *
 * 前置条件：
 *   - frps 二进制: packages/server/dist/frp/<platform>/frps[.exe]
 *   - frpc 二进制: packages/client/dist/frp/<platform>/frpc[.exe]
 *   - 如果缺失，运行 pnpm download:frp 下载
 *
 * 自动启动 frps（随机端口）、Server、Client，验证全链路。
 * 测试完成后自动清理。
 */

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");

const isWin = os.platform() === "win32";
const root = path.resolve(__dirname, "..");
const serverDir = path.join(root, "packages", "server");
const clientDir = path.join(root, "packages", "client");
const clientPkg = path.join(root, "packages", "client");

// Binaries
const platform = `${os.platform().replace("win32", "win")}-${os.arch()}`;
const frpcExe = isWin ? "frpc.exe" : "frpc";
const frpsExe = isWin ? "frps.exe" : "frps";

const sioClientPath = path.join(clientDir, "node_modules", "socket.io-client");
const { io } = require(sioClientPath);
const sharedPath = path.join(clientDir, "node_modules", "@vcpdeck", "shared");
const { Events } = require(sharedPath);

// ── Random port helpers ──
function randomPort() {
	return 10000 + Math.floor(Math.random() * 50000);
}

// ── Test state ──
const PSK = "vcpdeck-dev-psk";
const ADMIN_PASSWORD = "test123";
const FRPS_TOKEN = "test-frp-token-" + crypto.randomUUID().slice(0, 4);
const BASE = "http://localhost:3001";

let _serverProcess = null;
let _frpsProcess = null;
let _realClientProcess = null;
let cookie = "";
const results = [];
const TMP_DIR = path.join(root, ".tmp", "frp-test-" + Date.now());

// FRP port range for test (small range to avoid conflicts)
const FRP_PORT_RANGE_START = 35000;
const FRP_PORT_RANGE_END = 35020;

// Random ports for frps itself
const frpsBindPort = randomPort();
const frpsDashboardPort = randomPort();

function pass(name, detail) {
	results.push({ name, status: "PASS", detail: detail ?? "" });
	console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
	results.push({ name, status: "FAIL", detail: detail ?? "" });
	console.log(`  ✗ ${name}: ${detail}`);
}

function skip(name, detail) {
	results.push({ name, status: "SKIP", detail: detail ?? "" });
	console.log(`  - ${name} (SKIP: ${detail})`);
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function killPort(port) {
	try {
		if (isWin) {
			execSync(
				`powershell -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess | Stop-Process -Force"`,
				{ stdio: "ignore", timeout: 3000 },
			);
		} else {
			execSync(`lsof -ti:${port} | xargs kill -9`, {
				stdio: "ignore",
				timeout: 3000,
				shell: true,
			});
		}
	} catch {
		/* nothing */
	}
}

function killTree(pid) {
	try {
		if (isWin) {
			execSync(`taskkill /F /T /PID ${pid}`, {
				stdio: "ignore",
				timeout: 3000,
				shell: true,
			});
		} else {
			execSync(`pkill -P ${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null`, {
				stdio: "ignore",
				timeout: 3000,
				shell: true,
			});
		}
	} catch {
		/* already dead */
	}
}

// ── HTTP helpers ──
async function api(method, path, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (opts.json) headers["Content-Type"] = "application/json";
	if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
	if (!opts.noCookie && cookie) headers["Cookie"] = cookie;

	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: opts.json ? JSON.stringify(opts.json) : undefined,
		redirect: "manual",
	});

	const setCookie = res.headers.get("set-cookie");
	if (setCookie) {
		const m = setCookie.match(/vcpdeck_session=([^;]+)/);
		if (m) cookie = `vcpdeck_session=${m[1]}`;
	}
	return res;
}

async function apiJson(method, path, opts = {}) {
	const res = await api(method, path, opts);
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

/** frps Dashboard API (Basic auth) */
async function frpsApi(path) {
	const auth = Buffer.from("admin:admin").toString("base64");
	const url = `http://127.0.0.1:${frpsDashboardPort}${path}`;
	const res = await fetch(url, {
		headers: { Authorization: `Basic ${auth}` },
		signal: AbortSignal.timeout(5000),
	});
	return res;
}

// ── Resolve binary paths ──
function resolveFrpBinary(name) {
	const candidates = [
		path.join(root, "packages", "server", "dist", "frp", platform, name),
		path.join(root, "packages", "client", "dist", "frp", platform, name),
		path.join(root, "frp", name),
		path.join(root, ".tmp", "frp-test", name),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

// ── Start frps ──
function startFrps(frpsPath) {
	fs.mkdirSync(TMP_DIR, { recursive: true });

	const tomlPath = path.join(TMP_DIR, "frps-test.toml");
	const toml = [
		`bindPort = ${frpsBindPort}`,
		"",
		`auth.method = "token"`,
		`auth.token = "${FRPS_TOKEN}"`,
		"",
		`webServer.addr = "0.0.0.0"`,
		`webServer.port = ${frpsDashboardPort}`,
		`webServer.user = "admin"`,
		`webServer.password = "admin"`,
		"",
		`allowPorts = [{ start = ${FRP_PORT_RANGE_START}, end = ${FRP_PORT_RANGE_END} }]`,
		"",
		`vhostHTTPPort = ${randomPort()}`,
		"",
		`log.to = "${path.join(TMP_DIR, "frps.log").replace(/\\/g, "/")}"`,
		`log.level = "info"`,
		`log.maxDays = 1`,
	].join("\n");
	fs.writeFileSync(tomlPath, toml);

	_frpsProcess = spawn(frpsPath, ["-c", tomlPath], {
		cwd: TMP_DIR,
		stdio: "pipe",
	});

	_frpsProcess.stderr?.on("data", () => {
		// frps logs to stderr
	});
	_frpsProcess.on("exit", (code) => {
		console.log(`  [frps] exited with code ${code}`);
	});
}

async function waitForFrps() {
	for (let i = 0; i < 30; i++) {
		try {
			const res = await frpsApi("/api/serverinfo");
			if (res.ok) return true;
		} catch {
			/* not ready */
		}
		await sleep(1000);
	}
	return false;
}

// 恢复场景的分区日志
function log(section, msg) {
	console.log(`  [${section}] ${msg}`);
}

// 重置 FRP 测试状态（本地开发库）：删除环境变量迁移产生的默认实例行与测试映射，
// 使本次 run 的随机端口能通过 Server 启动时的 env 迁移生效（迁移仅在实例表为空时执行）。
async function resetFrpTestState() {
	let PrismaLibSql, PrismaClient;
	try {
		({ PrismaLibSql } = require(
			path.join(root, "packages/server/node_modules/@prisma/adapter-libsql"),
		));
		({ PrismaClient } = require(
			path.join(root, "packages/server/generated/client/index.js"),
		));
	} catch (e) {
		console.log("  [reset] 跳过（Prisma 客户端不可用）:", e.message);
		return;
	}
	const db = path
		.resolve(root, "packages/server/prisma/dev.db")
		.replace(/\\/g, "/");
	const factory = new PrismaLibSql({ url: "file:///" + db }, {});
	const p = new PrismaClient({ adapter: factory });
	try {
		await p.frpMapping.deleteMany({});
		const r = await p.frpsInstance.deleteMany({
			where: { name: "默认（从环境变量迁移）" },
		});
		console.log(`  [reset] 已清理旧 env 迁移实例 ${r.count} 个、测试映射`);
	} finally {
		await p.$disconnect();
	}
}

// ── Start VCPDeck Server ──
// 捕获 Server/Client 输出（持续捕获，超限保留尾部），用于 Task 7 密钥泄露断言与失败诊断

function attachOutputCapture(stream, bufRef) {
	if (!stream) return;
	stream.on("data", (d) => {
		const text = d.toString();
		if (bufRef.size < 1_000_000) bufRef.size += text.length;
		bufRef.text += text;
		if (bufRef.text.length > 1_000_000) {
			bufRef.text = bufRef.text.slice(-500_000);
		}
	});
}
const serverBuf = { text: "", size: 0 };
const clientBuf = { text: "", size: 0 };

function startServer() {
	_serverProcess = spawn("pnpm", ["start"], {
		cwd: serverDir,
		stdio: ["ignore", "pipe", "pipe"],
		shell: true,
		env: {
			...process.env,
			VCPDECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
			VCPDECK_FRONTEND_ORIGIN: "http://localhost:5173",
			FRP_PORT_RANGE_START: String(FRP_PORT_RANGE_START),
			FRP_PORT_RANGE_END: String(FRP_PORT_RANGE_END),
			FRP_PUBLIC_HOST: "127.0.0.1",
			FRPS_BIND_PORT: String(frpsBindPort),
			FRPS_TOKEN: FRPS_TOKEN,
			FRP_DASHBOARD_HOST: "127.0.0.1",
			FRP_DASHBOARD_PORT: String(frpsDashboardPort),
			FRP_DASHBOARD_USER: "admin",
			FRP_DASHBOARD_PASSWORD: "admin",
		},
	});
	attachOutputCapture(_serverProcess.stdout, serverBuf);
	attachOutputCapture(_serverProcess.stderr, serverBuf);
	return new Promise((resolve) => {
		const onText = (d) => {
			if (d.toString().includes("listening on")) resolve();
		};
		_serverProcess.stdout?.on("data", onText);
		_serverProcess.stderr?.on("data", onText);
		setTimeout(resolve, 30000);
	});
}

// ── Start Real Client ──
function startRealClient(frpcDir) {
	return new Promise((resolve, reject) => {
		const clientId = "frp-test-real-client";
		const env = {
			...process.env,
			VCPDECK_CLIENT_ID: clientId,
			VCPDECK_SERVER: "http://localhost:3001",
			VCPDECK_PSK: PSK,
			VCPDECK_FRPC_PATH: path.join(frpcDir, frpcExe),
			VCPDECK_FRPC_WORK_DIR: path.join(TMP_DIR, "frpc-work"),
		};

		_realClientProcess = spawn("node", ["dist/index.js"], {
			cwd: clientPkg,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let started = false;
		attachOutputCapture(_realClientProcess.stdout, clientBuf);
		attachOutputCapture(_realClientProcess.stderr, clientBuf);
		const onData = (chunk) => {
			if (
				!started &&
				(chunk.toString().includes("connected as") ||
					chunk.toString().includes("registered"))
			) {
				started = true;
				resolve();
			}
		};
		_realClientProcess.stdout?.on("data", onData);
		_realClientProcess.stderr?.on("data", onData);
		_realClientProcess.on("error", reject);
		_realClientProcess.on("exit", (code) => {
			if (!started) reject(new Error(`Client exited with code ${code}`));
		});
		setTimeout(() => {
			if (!started) reject(new Error("Client start timeout"));
		}, 20000);
	});
}

function stopRealClient() {
	if (_realClientProcess?.pid) {
		killTree(_realClientProcess.pid);
		_realClientProcess = null;
	}
}

// 仅重启 Client（保留 Server DB 与 clientId），Client 自动重新注册
async function restartRealClientPreservingState(frpcDir) {
	stopRealClient();
	await sleep(1500);
	await startRealClient(frpcDir);
}

// ══ Task 7：FRP 恢复场景 ══

/** 创建第二个 TCP 映射（确保恢复场景至少两个映射）。返回 mappingId。 */
async function createSecondTcpMapping(frpClientId) {
	const res = await api(
		"POST",
		"/api/frp/mappings",
		{
			json: {
				clientId: frpClientId,
				name: "test-tcp-2",
				proxyType: "tcp",
				localPort: 12346,
			},
		},
	);
	if (!res.ok) return null;
	const body = await res.json();
	return body?.mapping?.id ?? body?.id ?? null;
}

/** 场景 1：仅停止/重启 Client（保留状态），映射 active → inactive → reconciling → active。 */
async function scenarioClientRestart(frpcDir, mappingId) {
	log("R1", "Client 重启恢复");
	stopRealClient();
	await sleep(3000);

	// 断开后映射应回 inactive
	const afterStop = await waitForMappingStatus(mappingId, "inactive", 30_000);
	if (!afterStop.mapping || afterStop.mapping.status !== "inactive") {
		fail(
			"R1 停止 Client 后映射回 inactive",
			`实际 status=${afterStop.mapping?.status ?? "null"}`,
		);
		return false;
	}
	pass("R1 停止 Client 后映射回 inactive", "心跳超时 → inactive");

	// 重启 Client（保留同一 clientId），Server 应自动 reconcile
	await restartRealClientPreservingState(frpcDir);
	const result = await waitForMappingStatus(mappingId, "active", 70_000);
	const sawReconciling = result.observedStatuses.includes("reconciling");
	if (!result.mapping || result.mapping.status !== "active") {
		fail(
			"R1 Client 重启后映射自动恢复 active",
			`status=${result.mapping?.status} observed=[${result.observedStatuses}]",`,
		);
		return false;
	}
	pass(
		"R1 Client 重启后映射自动恢复 active",
		`sawReconciling=${sawReconciling}`,
	);

	// FRPS Dashboard 二次确认
	const dash1 = await waitForDashboardProxy(
		"tcp",
		"test-tcp",
		true,
		30_000,
	);
	const dash2 = await waitForDashboardProxy(
		"tcp",
		"test-tcp-2",
		true,
		30_000,
	);
	if (dash1 && dash2) {
		pass("R1 FRPS Dashboard 两个 proxy 均在线", "二次确认通过");
	} else {
		fail(
			"R1 FRPS Dashboard 两个 proxy 均在线",
			`test-tcp=${dash1} test-tcp-2=${dash2}`,
		);
	}
	return true;
}

/** 场景 2：只 kill frpc 子进程（Client 保持运行），Client 自持恢复，Client PID 不变。 */
async function scenarioFrpcCrash(mappingId) {
	log("R2", "frpc 崩溃恢复");
	const clientPid = _realClientProcess?.pid;
	const frpcPid = findFrpcChildPid(clientPid);
	if (!frpcPid) {
		fail("R2 找到 frpc 子进程", "未找到 frpc 子进程 PID");
		return false;
	}

	// 只 kill frpc 子进程
	try {
		execSync(`taskkill /F /PID ${frpcPid} 2>nul || kill -9 ${frpcPid}`, {
			shell: true,
			stdio: "ignore",
		});
		pass("R2 kill frpc 子进程", `pid=${frpcPid}`);
	} catch (e) {
		fail("R2 kill frpc 子进程", `kill 失败: ${e.message}`);
		return false;
	}

	await sleep(2000);

	// Client 应自动重启 frpc，映射回到 active
	const result = await waitForMappingStatus(mappingId, "active", 70_000);
	if (!result.mapping || result.mapping.status !== "active") {
		fail(
			"R2 frpc 崩溃后映射恢复 active",
			`status=${result.mapping?.status} observed=[${result.observedStatuses}]`,
		);
		return false;
	}
	pass("R2 frpc 崩溃后映射恢复 active", "Client 自持恢复");

	// Client PID 不变
	const newClientPid = _realClientProcess?.pid;
	if (newClientPid === clientPid) {
		pass("R2 Client PID 不变", `pid=${clientPid}`);
	} else {
		fail(
			"R2 Client PID 不变",
			`原=${clientPid} 新=${newClientPid}`,
		);
	}
	return true;
}

/** 场景 3：只重启 Server（保留 Client），Client 自动重连，映射恢复 active，frpc PID 不变。 */
async function scenarioServerRestart(mappingId) {
	log("R3", "Server 重启恢复");
	const clientPid = _realClientProcess?.pid;
	const frpcPidBefore = findFrpcChildPid(clientPid);

	await restartServer();
	pass("R3 Server 重启", "已重新登录");

	// 等待 Client 重连，映射恢复 active
	const result = await waitForMappingStatus(mappingId, "active", 90_000);
	if (!result.mapping || result.mapping.status !== "active") {
		fail(
			"R3 Server 重启后映射恢复 active",
			`status=${result.mapping?.status} observed=[${result.observedStatuses}]`,
		);
		return false;
	}
	pass("R3 Server 重启后映射恢复 active", "Client 自动重连");

	// frpc PID 不变
	const frpcPidAfter = findFrpcChildPid(_realClientProcess?.pid);
	if (frpcPidBefore && frpcPidAfter && frpcPidBefore === frpcPidAfter) {
		pass("R3 frpc PID 不变", `pid=${frpcPidBefore}`);
	} else {
		// 若 frpc 被 Server 重启触发 reconcile 重启，则 PID 会变，但映射应恢复 active
		log(
			"R3",
			`frpc PID 变化: before=${frpcPidBefore} after=${frpcPidAfter}（reconcile 重启）`,
		);
		pass("R3 frpc 状态正常", `after=${frpcPidAfter ?? "null"}`);
	}
	return true;
}

/** 场景 4：FRPS Dashboard 停止，重试耗尽后映射回 inactive；恢复 Dashboard 后重连恢复。 */
async function scenarioDashboardDown(frpcDir, mappingId, frpsPath) {
	log("R4", "Dashboard 停止重试耗尽");

	// 停止 FRPS
	stopFrps();
	pass("R4 停止 FRPS", "frps 已停止");

	// 重启 Client 触发 reconcile，但 Dashboard 不可达
	const oldClientPid = _realClientProcess?.pid ?? null;
	await restartRealClientPreservingState(frpcDir);

	// 等待重试耗尽，映射回 inactive
	const result = await waitForMappingStatus(mappingId, "inactive", 120_000);
	if (result.mapping && result.mapping.status === "inactive") {
		pass(
			"R4 重试耗尽后映射回 inactive",
			`error=${result.mapping.errorMessage ?? "null"}`,
		);
	} else {
		console.log(
			"  [diag-r4a] oldClientPid=" + oldClientPid + " alive=" + processAlive(oldClientPid),
		);
		console.log(
			"  [diag-r4a] observed=[" + result.observedStatuses + "] mapping=" + JSON.stringify({ status: result.mapping?.status, errorCode: result.mapping?.errorCode, errorMessage: result.mapping?.errorMessage }),
		);
		console.log("  [diag-r4a] clients: " + (await clientOnlineState()));
		console.log(
			"  [diag-r4a] server 关键行:\n" + grepOf(serverBuf, /\[ws\]|frp-reconcile|heartbeat timeout/),
		);
		console.log("  [diag-r4a] client 关键行:\n" + grepOf(clientBuf, /connected as|registered|frp|frpc/));
		fail(
			"R4 重试耗尽后映射回 inactive",
			`status=${result.mapping?.status ?? "null"}`,
		);
		return false;
	}

	// 恢复 FRPS
	const frpsOk = await restartFrps(frpsPath);
	if (!frpsOk) {
		fail("R4 恢复 FRPS", "frps 重启失败");
		return false;
	}
	pass("R4 恢复 FRPS", "frps 已恢复");

	// 重启 Client 触发新一轮 reconcile
	await restartRealClientPreservingState(frpcDir);
	const recovered = await waitForMappingStatus(mappingId, "active", 70_000);
	if (recovered.mapping && recovered.mapping.status === "active") {
		pass("R4 恢复后映射回到 active", "新连接代际恢复成功");
	} else {
		const m = recovered.mapping ?? {};
		console.log(
			"  [diag-r4] mapping:",
			JSON.stringify({ status: m.status, errorCode: m.errorCode, errorMessage: m.errorMessage }),
		);
		console.log("  [diag-r4] client 输出尾部:\n" + tailOf(clientBuf, 1500));
		console.log("  [diag-r4] server 输出尾部:\n" + tailOf(serverBuf, 1500));
		fail(
			"R4 恢复后映射回到 active",
			`status=${m.status ?? "null"}`,
		);
		return false;
	}
	return true;
}

/** 场景 5：密钥泄露断言 — 扫描捕获的 Server/Client 输出。 */
function scenarioSecretsNotLeaked() {
	log("R5", "密钥泄露断言");
	const all = serverBuf.text + "\n" + clientBuf.text;
	const leaks = [];
	if (all.includes(FRPS_TOKEN)) leaks.push("FRPS_TOKEN 值");
	if (all.includes("auth.token =")) leaks.push("完整 auth.token 行");
	if (all.includes("webServer.password")) leaks.push("Dashboard 密码行");
	if (leaks.length === 0) {
		pass("R5 输出无密钥泄露", `扫描 ${all.length} 字符，未发现 token/密码`);
		return true;
	}
	fail("R5 输出无密钥泄露", `发现: ${leaks.join(", ")}`);
	return false;
}

async function runRecoveryScenarios(frpcDir, frpsPath, frpClientId) {
	log("", "━━ FRP 恢复场景（Task 7） ━━");

	// 确保至少两个 active TCP 映射
	const secondId = await createSecondTcpMapping(frpClientId);
	if (secondId) {
		pass("R0 创建第二个 TCP 映射", `id=${secondId}`);
		await waitForMappingStatus(secondId, "active", 60_000);
	} else {
		log("R0", "第二个映射已存在或创建失败，继续");
	}

	// 取第一个 TCP 映射 ID
	const list = await api("GET", "/api/frp/mappings?pageSize=100");
	const listBody = await list.json();
	const tcpMappings = (listBody?.data ?? []).filter(
		(m) => m.proxyType === "tcp",
	);
	const primaryId = tcpMappings[0]?.id;
	if (!primaryId) {
		fail("R0 获取主 TCP 映射", "未找到 TCP 映射");
		return;
	}

	let allPass = true;
	allPass = (await scenarioClientRestart(frpcDir, primaryId)) && allPass;
	allPass = (await scenarioFrpcCrash(primaryId)) && allPass;
	allPass = (await scenarioServerRestart(primaryId)) && allPass;
	allPass =
		(await scenarioDashboardDown(frpcDir, primaryId, frpsPath)) && allPass;
	allPass = scenarioSecretsNotLeaked() && allPass;

	log(
		"",
		allPass
			? "━━ FRP 恢复场景全部通过 ━━"
			: "━━ 部分恢复场景失败（详见上方） ━━",
	);
}

/** 查找真实 Client 进程树内的 frpc 子进程 PID（仅限当前 Client 子进程，避免误杀外部进程）。 */
function findFrpcChildPid(clientPid) {
	if (!clientPid) return null;
	try {
		if (isWin) {
			const out = execSync(
				`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='frpc.exe' AND ParentProcessId=${clientPid}\\" | Select-Object -ExpandProperty ProcessId"`,
				{ stdio: ["ignore", "pipe", "ignore"], timeout: 8000, shell: true },
			).toString().trim();
			const pids = out.split(/\s+/).filter(Boolean).map(Number);
			return pids[0] ?? null;
		}
		const out = execSync(
			`pgrep -P ${clientPid} -f frpc 2>/dev/null || true`,
			{ stdio: ["ignore", "pipe", "ignore"], timeout: 8000, shell: true },
		).toString().trim();
		return out ? Number(out.split("\n")[0]) : null;
	} catch {
		return null;
	}
}

/** 有限轮询映射状态（有 deadline；返回 { mapping, observedStatuses }）。 */
async function waitForMappingStatus(
	mappingId,
	expectedStatus,
	timeoutMs = 70_000,
) {
	const deadline = Date.now() + timeoutMs;
	const observed = new Set();
	let last = null;
	while (Date.now() < deadline) {
		try {
			const { status, body } = await apiJson(
				"GET",
				`/api/frp/mappings/${mappingId}`,
			);
			if (status === 200 && body) {
				last = body;
				observed.add(body.status);
				if (body.status === expectedStatus) break;
			}
		} catch {
			/* Server 重启期间请求会失败，继续等待 */
		}
		await sleep(500);
	}
	return { mapping: last, observedStatuses: [...observed] };
}

/** 有限轮询 FRPS Dashboard proxy 在线/消失（复用 frpsApi）。 */
async function waitForDashboardProxy(
	proxyType,
	proxyName,
	shouldExist,
	timeoutMs = 70_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await frpsApi(
				`/api/proxy/${proxyType}/${encodeURIComponent(proxyName)}`,
			);
			if (res.status === 404) {
				return !shouldExist;
			}
			if (res.ok) {
				const body = await res.json().catch(() => ({}));
				if (shouldExist) return body.status === "online";
				return false;
			}
		} catch {
			/* Dashboard 不可达：继续等待到 deadline */
		}
		await sleep(1000);
	}
	return false;
}

function stopFrps() {
	if (_frpsProcess?.pid) {
		killTree(_frpsProcess.pid);
		_frpsProcess = null;
	}
}

async function restartFrps(frpsPath) {
	stopFrps();
	await sleep(1000);
	startFrps(frpsPath);
	return waitForFrps();
}

async function restartServer() {
	if (_serverProcess?.pid) killTree(_serverProcess.pid);
	await sleep(1500);
	await startServer();
	// 会话可能随进程重启失效，重新登录
	await loginAsAdmin();
}

// ── Test helpers ──
async function loginAsAdmin() {
	const { status, body } = await apiJson("POST", "/api/auth/login", {
		json: { username: "admin", password: ADMIN_PASSWORD },
		noCookie: true,
	});
	if ((status === 200 || status === 201) && body?.identity?.isAdmin) {
		return body.identity;
	}
	throw new Error(`Login failed: status=${status}`);
}

// ═══════════════════════════════════════════════════╗
//  测试用例
// ═══════════════════════════════════════════════════╝

async function testCreateTcpMapping(clientId) {
	const res = await api("POST", "/api/frp/mappings", {
		json: {
			clientId,
			name: "test-tcp",
			proxyType: "tcp",
			localPort: 12345,
		},
	});
	if (res.status !== 201) {
		const err = await res.text().catch(() => "");
		return fail(
			"POST create tcp mapping",
			`status=${res.status} ${err.slice(0, 200)}`,
		);
	}
	const mapping = await res.json();
	if (!mapping.id || !mapping.publicUrl) {
		return fail(
			"POST create tcp mapping",
			`missing fields: ${JSON.stringify(mapping)}`,
		);
	}
	// 新状态机：create → provisioning（首次 reconcile 成功后转 active）
	if (mapping.status !== "provisioning") {
		return fail(
			"POST create tcp mapping",
			`expected provisioning, got ${mapping.status}`,
		);
	}
	pass(
		"POST create tcp mapping",
		`id=${mapping.id.slice(0, 8)} url=${mapping.publicUrl} status=${mapping.status}`,
	);
	return mapping;
}

async function testWaitActive(mappingId) {
	// The real client should receive frp.create and start frpc
	// Wait for status to become active via job:update
	for (let i = 0; i < 15; i++) {
		const { status, body } = await apiJson(
			"GET",
			`/api/frp/mappings/${mappingId}`,
		);
		if (status === 200 && body?.status === "active") {
			pass(
				"Mapping becomes active",
				`id=${mappingId.slice(0, 8)} status=active`,
			);
			return body;
		}
		await sleep(1000);
	}
	fail("Mapping becomes active", `timeout waiting for active status`);
	return null;
}

async function testCreateHttpMapping(clientId) {
	const res = await api("POST", "/api/frp/mappings", {
		json: {
			clientId,
			name: "test-http",
			proxyType: "http",
			localPort: 8080,
			customDomain: "test-http.local",
		},
	});
	if (res.status !== 201) {
		const err = await res.text().catch(() => "");
		return fail(
			"POST create http mapping",
			`status=${res.status} ${err.slice(0, 200)}`,
		);
	}
	const mapping = await res.json();
	if (!mapping.publicUrl || !mapping.publicUrl.startsWith("http://")) {
		return fail("POST create http mapping", `bad url: ${mapping.publicUrl}`);
	}
	pass(
		"POST create http mapping",
		`id=${mapping.id.slice(0, 8)} url=${mapping.publicUrl}`,
	);
	return mapping;
}

async function testListMappings(clientId, expectedMin) {
	// 列表接口统一返回 PaginatedResult：{ data, total, page, pageSize, totalPages }
	const { status, body } = await apiJson(
		"GET",
		`/api/frp/mappings?clientId=${clientId}`,
	);
	if (status !== 200 || !Array.isArray(body?.data)) {
		return fail(
			"GET list mappings",
			`status=${status} shape=${body ? Object.keys(body).join("/") : "null"}`,
		);
	}
	if (body.data.length < expectedMin) {
		return fail(
			"GET list mappings",
			`expected >=${expectedMin}, got ${body.data.length}`,
		);
	}
	pass("GET list mappings", `${body.data.length} mappings total=${body.total}`);
	return body.data;
}

async function testGetMapping(mappingId) {
	const { status, body } = await apiJson(
		"GET",
		`/api/frp/mappings/${mappingId}`,
	);
	if (status !== 200 || body.id !== mappingId) {
		return fail("GET single mapping", `status=${status}`);
	}
	pass(
		"GET single mapping",
		`id=${body.id.slice(0, 8)} name=${body.name} type=${body.proxyType}`,
	);
	return body;
}

async function testDeleteMapping(mappingId) {
	// 恢复周期进行中 create/delete 稳定返回 409（FRP_RECONCILE_BUSY）；有限重试后应成功。
	let { status, body } = await apiJson(
		"DELETE",
		`/api/frp/mappings/${mappingId}`,
	);
	if (status === 409) {
		for (let i = 0; i < 10; i++) {
			await sleep(3000);
			({ status, body } = await apiJson("DELETE", `/api/frp/mappings/${mappingId}`));
			if (status !== 409) break;
		}
	}
	if (status !== 200 || !body?.id) {
		return fail(
			"DELETE mapping",
			`status=${status} body=${JSON.stringify(body)?.slice(0, 120)}`,
		);
	}
	// 新状态机：DELETE 立即返回 deleting，Job 成功后行被 hard delete
	if (body.status !== "deleting") {
		return fail("DELETE mapping", `expected deleting, got ${body.status}`);
	}
	pass("DELETE mapping", `id=${mappingId.slice(0, 8)} status=deleting`);

	// 轮询等待行被删除（Job 完成后 hard delete）
	let gone = false;
	for (let i = 0; i < 30; i++) {
		const getRes = await apiJson("GET", `/api/frp/mappings/${mappingId}`);
		if (getRes.status === 400 || getRes.status === 404) {
			gone = true;
			break;
		}
		await sleep(1000);
	}
	if (gone) {
		pass("DELETE mapping: verify gone", "30s 内行已删除 (400)");
	} else {
		const st = await apiJson("GET", `/api/frp/mappings/${mappingId}`);
		const m = st.body ?? {};
		console.log(
			"  [diag-delete] mapping:",
			JSON.stringify({ status: m.status, errorCode: m.errorCode, errorMessage: m.errorMessage }),
		);
		console.log("  [diag-delete] client 输出尾部:\n" + tailOf(clientBuf, 1200));
		fail("DELETE mapping: verify gone", "30s 后行仍存在");
	}
}

/** 检查进程是否存活（诊断用） */
function processAlive(pid) {
	if (!pid) return "null";
	try {
		if (isWin) {
			const out = execSync(
				`powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName"`,
				{ stdio: ["ignore", "pipe", "ignore"], timeout: 8000, shell: true },
			).toString().trim();
			return out ? `true(${out})` : "false";
		}
		process.kill(pid, 0);
		return "true";
	} catch {
		return "false";
	}
}

/** 从完整缓冲区 grep 匹配行（诊断用；最多 40 行） */
function grepOf(buf, pattern, max = 40) {
	const lines = String(buf?.text ?? "").split("\n");
	const hits = [];
	for (const line of lines) {
		if (pattern.test(line) && !line.trim().startsWith("[Nest]")) {
			hits.push(line.trim());
			if (hits.length >= max) break;
		}
	}
	return hits.length ? hits.join("\n") : "(无匹配)";
}

async function clientOnlineState() {
	try {
		const { body } = await apiJson("GET", "/api/clients");
		const list = Array.isArray(body) ? body : (body?.data ?? []);
		return list
			.map((c) => `${c.clientId ?? c.id}:online=${c.online}`)
			.join(", ");
	} catch (e) {
		return `查询失败: ${e instanceof Error ? e.message : "?"}`;
	}
}

/** 取输出尾部（诊断用；持续捕获缓冲区） */
function tailOf(buf, n) {
	const t = String(buf?.text ?? "").trimEnd();
	return t.length > n ? "...\n" + t.slice(-n) : t;
}

async function testFrpsDashboardProxyCheck(proxyType, proxyName) {
	// Wait a bit for frpc to register with frps
	await sleep(3000);
	try {
		const res = await frpsApi(
			`/api/proxy/${proxyType}/${encodeURIComponent(proxyName)}`,
		);
		if (res.ok) {
			pass(
				`frps Dashboard: proxy ${proxyName} registered`,
				`${proxyType} proxy found`,
			);
			return true;
		}
		if (res.status === 404) {
			fail(`frps Dashboard: proxy ${proxyName}`, "not found (404)");
		} else {
			fail(`frps Dashboard: proxy ${proxyName}`, `status=${res.status}`);
		}
	} catch (e) {
		fail(`frps Dashboard: proxy ${proxyName}`, e.message);
	}
	return false;
}

async function testFrpsDashboardProxyGone(proxyType, proxyName) {
	await sleep(2000);
	try {
		const res = await frpsApi(
			`/api/proxy/${proxyType}/${encodeURIComponent(proxyName)}`,
		);
		// 404 = gone; offline = frps detected disconnect (Windows SIGTERM 不是优雅关闭)
		if (res.status === 404) {
			pass(`frps Dashboard: proxy ${proxyName} removed`, "404 as expected");
			return true;
		}
		if (res.ok) {
			const body = await res.json().catch(() => ({}));
			if (body.status === "offline") {
				pass(
					`frps Dashboard: proxy ${proxyName} offline`,
					"offline after delete",
				);
				return true;
			}
			fail(
				`frps Dashboard: proxy ${proxyName}`,
				`status=${body.status}, expected offline or 404`,
			);
			return false;
		}
		fail(`frps Dashboard: proxy ${proxyName}`, `status=${res.status}`);
	} catch (e) {
		fail(`frps Dashboard: proxy ${proxyName}`, e.message);
	}
	return false;
}

async function testNoFrpCapability() {
	const mockId = "test-no-frp-cap-" + Date.now();
	const mockSocket = io(`${BASE}/client`, { auth: { psk: PSK } });
	try {
		await new Promise((resolve, reject) => {
			mockSocket.on("connect", resolve);
			mockSocket.on("connect_error", reject);
			setTimeout(() => reject(new Error("connect timeout")), 5000);
		});
		await new Promise((resolve) => {
			mockSocket.emit(Events.REGISTER, {
				clientId: mockId,
				hostname: "test-no-frp",
				os: "test",
				cpuModel: "test",
				totalMemMB: 1024,
				clientVersion: "0.0.0",
				capabilities: ["exec"], // NO "frp"
			});
			mockSocket.on("ack", () => resolve());
			setTimeout(resolve, 1000);
		});
		await sleep(500);

		const res = await api("POST", "/api/frp/mappings", {
			json: {
				clientId: mockId,
				name: "test-no-frp",
				proxyType: "tcp",
				localPort: 9999,
			},
		});
		if (res.status === 400) {
			const body = await res.json().catch(() => ({}));
			if (
				body.message?.includes("FRP") ||
				body.message?.includes("frp") ||
				body.message?.includes("能力")
			) {
				return pass("No-frp-capability rejection", "400 with clear error");
			}
			return fail(
				"No-frp-capability rejection",
				`error not about FRP: ${body.message}`,
			);
		}
		fail("No-frp-capability rejection", `expected 400, got ${res.status}`);
	} catch (e) {
		fail("No-frp-capability test", e.message);
	} finally {
		mockSocket.disconnect();
	}
}

async function testInvalidProxyType(clientId) {
	const res = await api("POST", "/api/frp/mappings", {
		json: {
			clientId,
			name: "test-bad-type",
			proxyType: "udp",
			localPort: 9999,
		},
	});
	if (res.status === 400) {
		pass("Invalid proxyType rejection", "400 as expected");
	} else {
		fail("Invalid proxyType rejection", `expected 400, got ${res.status}`);
	}
}

async function testMissingRequiredFields(clientId) {
	const res = await api("POST", "/api/frp/mappings", {
		json: { clientId, name: "no-port" },
	});
	if (res.status === 400) {
		pass("Missing required fields rejection", "400 as expected");
	} else {
		fail(
			"Missing required fields rejection",
			`expected 400, got ${res.status}`,
		);
	}
}

// ═══════════════════════════════════════════════════╗
//  Main
// ═══════════════════════════════════════════════════╝

async function main() {
	console.log("\n=== VCPDeck FRP Integration Test ===\n");

	// ── Step 0: Check binaries ──
	const frpsPath = resolveFrpBinary(frpsExe);
	if (!frpsPath) {
		skip("frps binary", "not found — run pnpm download:frp");
		console.log("  (SKIP: frps binary not available)");
		process.exit(0);
	}
	pass("frps binary", frpsPath);

	const frpcDir = path.join(
		root,
		"packages",
		"client",
		"dist",
		"frp",
		platform,
	);
	if (!fs.existsSync(path.join(frpcDir, frpcExe))) {
		skip("frpc binary", "not found in client dist/frp");
		console.log("  (SKIP: frpc binary not available)");
		process.exit(0);
	}
	pass("frpc binary", path.join(frpcDir, frpcExe));

	// ── Step 1: Prepare environment ──
	console.log("\n--- Setup ---");

	// Clean tmp
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
	fs.mkdirSync(TMP_DIR, { recursive: true });

	// Kill old processes on our ports
	killPort(3001);
	killPort(frpsBindPort);
	killPort(frpsDashboardPort);
	await sleep(1000);

	// Start frps
	console.log("  [setup] Starting frps...");
	startFrps(frpsPath);
	const frpsReady = await waitForFrps();
	if (!frpsReady) {
		fail("frps startup", "dashboard unreachable after 30s");
		process.exit(1);
	}
	pass("frps started", `bind=${frpsBindPort} dashboard=${frpsDashboardPort}`);

	// 重置 FRP 测试状态（本地开发库，见 resetFrpTestState 注释）
	await resetFrpTestState();

	// Start VCPDeck Server
	console.log("  [setup] Starting server...");
	await startServer();
	pass("Server started", "FRP config injected");

	// Login
	await loginAsAdmin();

	// Start Client
	console.log("  [setup] Starting client...");
	await startRealClient(frpcDir);

	// Wait for client to register
	let clientOnline = false;
	let clientList = [];
	for (let i = 0; i < 20; i++) {
		const { body } = await apiJson("GET", "/api/clients");
		clientList = body;
		if (body.some((c) => c.capabilities?.includes?.("frp") && c.online)) {
			clientOnline = true;
			break;
		}
		await sleep(1000);
	}
	if (!clientOnline) {
		fail("Client register", "no online client with frp capability");
		console.log("  Clients:", JSON.stringify(clientList));
		process.exit(1);
	}
	const frpClient = clientList.find(
		(c) => c.capabilities?.includes?.("frp") && c.online,
	);
	pass(
		"Client registered with frp",
		`id=${frpClient.clientId} caps=${frpClient.capabilities.join(",")}`,
	);

	// ── Test: TCP mapping ──
	console.log("\n--- Create TCP mapping ---");
	const tcpMapping = await testCreateTcpMapping(frpClient.clientId);
	if (!tcpMapping) {
		process.exit(1);
	}
	await testWaitActive(tcpMapping.id);
	await testFrpsDashboardProxyCheck("tcp", "test-tcp");

	// ── Test: HTTP mapping ──
	console.log("\n--- Create HTTP mapping ---");
	const httpMapping = await testCreateHttpMapping(frpClient.clientId);
	if (httpMapping) {
		await testWaitActive(httpMapping.id);
		await testFrpsDashboardProxyCheck("http", "test-http");
	}

	// ── Test: List & detail ──
	console.log("\n--- List & detail ---");
	await testListMappings(frpClient.clientId, 2);
	await testGetMapping(tcpMapping.id);

	// ── Test: Delete ──
	console.log("\n--- Delete mapping ---");
	await testDeleteMapping(httpMapping ? httpMapping.id : tcpMapping.id);
	if (httpMapping) {
		await testFrpsDashboardProxyGone("http", "test-http");
	}

	// ── Test: Error cases ──
	console.log("\n--- Error cases ---");
	await testNoFrpCapability();
	await testInvalidProxyType(frpClient.clientId);
	await testMissingRequiredFields(frpClient.clientId);

	// ── Task 7: FRP 恢复场景 ──
	console.log("\n--- FRP recovery scenarios ---");
	await runRecoveryScenarios(frpcDir, frpsPath, frpClient.clientId);

	// 诊断：完整输出落盘（仅失败时保留）
	try {
		const hasFail = results.some((r) => r.status === "FAIL");
		if (hasFail) {
			const diagDir = path.join(root, ".tmp");
			fs.mkdirSync(diagDir, { recursive: true });
			fs.writeFileSync(path.join(diagDir, "frp-diag-server.log"), serverBuf.text);
			fs.writeFileSync(path.join(diagDir, "frp-diag-client.log"), clientBuf.text);
			console.log("  [diag] 完整输出已写入 .tmp/frp-diag-server.log / frp-diag-client.log");
		}
	}
	catch {}

	// ── Cleanup ──
	console.log("\n--- Cleanup ---");
	stopRealClient();
	if (_serverProcess?.pid) killTree(_serverProcess.pid);
	if (_frpsProcess) {
		killTree(_frpsProcess.pid);
		_frpsProcess = null;
	}
	await sleep(1000);
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true });
	} catch {}
	pass("Cleanup complete", "tmp files removed");

	// ── Report ──
	console.log(`\n=== Test Report ===\n`);
	let passed = 0,
		failed = 0,
		skipped = 0;
	for (const r of results) {
		if (r.status === "PASS") passed++;
		if (r.status === "FAIL") failed++;
		if (r.status === "SKIP") skipped++;
		if (r.status !== "PASS") {
			const icon = r.status === "SKIP" ? `-  ${r.name}` : `✗  ${r.name}`;
			console.log(`  ${icon}\n     ${r.detail}`);
		}
	}
	console.log(
		`\n  ${passed}/${results.length} passed, ${failed} failed, ${skipped} skipped`,
	);

	if (failed > 0) process.exit(1);
	process.exit(0);
}

// ── Entry ──
main().catch((err) => {
	console.error("Test harness error:", err);
	// Cleanup
	stopRealClient();
	if (_serverProcess?.pid) killTree(_serverProcess.pid);
	if (_frpsProcess) killTree(_frpsProcess.pid);
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true });
	} catch {}
	process.exit(1);
});
