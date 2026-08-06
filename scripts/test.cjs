/**
 * VCPDeck 端到端集成测试
 *
 * 用法：
 *   node scripts/test.cjs
 *
 * 自动启动 server（含 VCPDECK_ADMIN_PASSWORD），连接 mock client，逐个验证。
 * 测试完成后自动清理，输出测试报告。
 */

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const {
	createIntegrationTestDb,
	cleanupIntegrationTestDb,
} = require("./integration-test-db.cjs");

const isWin = os.platform() === "win32";

// ── Resolve paths ──
const root = path.resolve(__dirname, "..");
const serverDir = path.join(root, "packages/server");
const clientDir = path.join(root, "packages/client");

// Use socket.io-client from the client package
const sioClientPath = path.join(clientDir, "node_modules", "socket.io-client");
const { io } = require(sioClientPath);

// Resolve workspace packages from client's node_modules
const sharedPath = path.join(clientDir, "node_modules", "@vcpdeck", "shared");
const { Events } = require(sharedPath);

// ── Constants ──
const BASE = "http://localhost:3001";
const PSK = "vcpdeck-dev-psk";
const ADMIN_PASSWORD = "test123";
const testDatabase = createIntegrationTestDb();

// ── Test state ──
let clientSocket;
let _serverProcess = null;
let cookie = ""; // shared session cookie across REST tests
let cliToken = "";
const results = [];

function pass(name, detail) {
	results.push({ name, status: "PASS", detail: detail ?? "" });
	console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
	results.push({ name, status: "FAIL", detail: detail ?? "" });
	console.log(`  ✗ ${name}: ${detail}`);
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Fetch with cookie support (stores Set-Cookie, sends stored cookie). */
async function api(method, path, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (opts.json) {
		headers["Content-Type"] = "application/json";
	}
	if (opts.bearer) {
		headers["Authorization"] = `Bearer ${opts.bearer}`;
	}
	if (!opts.noCookie && cookie) {
		headers["Cookie"] = cookie;
	}

	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: opts.json ? JSON.stringify(opts.json) : undefined,
		redirect: "manual",
	});

	// Capture Set-Cookie
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

/** HTTP request with raw body (no JSON encoding). */
async function apiRaw(method, path, body, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (opts.bearer) {
		headers["Authorization"] = `Bearer ${opts.bearer}`;
	}
	if (!opts.noCookie && cookie) {
		headers["Cookie"] = cookie;
	}

	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body,
		redirect: "manual",
	});

	const setCookie = res.headers.get("set-cookie");
	if (setCookie) {
		const m = setCookie.match(/vcpdeck_session=([^;]+)/);
		if (m) cookie = `vcpdeck_session=${m[1]}`;
	}

	return res;
}

/** Kill anything on port 3001 from previous runs. */
function killPort() {
	try {
		if (isWin) {
			execSync(
				'powershell -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue).OwningProcess | Stop-Process -Force"',
				{ stdio: "ignore", timeout: 3000 },
			);
		} else {
			execSync("lsof -ti:3001 | xargs kill -9", {
				stdio: "ignore",
				timeout: 3000,
				shell: true,
			});
		}
	} catch {
		// nothing on that port, fine
	}
}

/** Kill a process tree by PID. */
function killTree(pid) {
	try {
		if (isWin) {
			execSync(`taskkill /F /T /PID ${pid}`, {
				stdio: "ignore",
				timeout: 3000,
				shell: true,
			});
		} else {
			// 先杀子进程再杀父进程，避免孤儿
			execSync(`pkill -P ${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null`, {
				stdio: "ignore",
				timeout: 3000,
				shell: true,
			});
		}
	} catch {
		// already dead
	}
}

// ── Real Client 生命周期 ──
let _realClientProcess = null;
const REAL_CLIENT_ID = "exec-test-real-client";

function startRealClient() {
	return new Promise((resolve, reject) => {
		const clientPkg = path.join(root, "packages/client");
		const env = {
			...process.env,
			VCPDECK_CLIENT_ID: REAL_CLIENT_ID,
			VCPDECK_SERVER: "http://localhost:3001",
			VCPDECK_PSK: "vcpdeck-dev-psk",
		};
		_realClientProcess = spawn("node", ["dist/index.js"], {
			cwd: clientPkg,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let started = false;
		const onData = (chunk) => {
			const text = chunk.toString();
			if (
				!started &&
				(text.includes("connected as") || text.includes("registered"))
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
		}, 15000);
	});
}

function stopRealClient() {
	if (_realClientProcess?.pid) {
		killTree(_realClientProcess.pid);
		_realClientProcess = null;
	}
}

// ── 等待 JOB_UPDATE（通过 monitor socket 监听服务端广播） ──
function waitForJobUpdate(jobId, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			clientSocket.off(Events.JOB_UPDATE, handler);
			reject(new Error("waitForJobUpdate timeout"));
		}, timeoutMs);
		const handler = (data) => {
			if (data.jobId === jobId) {
				clearTimeout(timer);
				clientSocket.off(Events.JOB_UPDATE, handler);
				resolve(data);
			}
		};
		clientSocket.on(Events.JOB_UPDATE, handler);
	});
}

// ── Exec command/script 测试（使用真实 Client, 验证 exitCode） ──

async function testExecCommandLegacy(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: { command: "echo hello-world" },
			timeout: 10000,
		},
	});
	if (res.status !== 201) {
		const errBody = await res.text().catch(() => "");
		return fail(
			"exec command legacy",
			`status ${res.status} body=${errBody.slice(0, 200)}`,
		);
	}
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec command legacy", "exitCode=0");
		fail(
			"exec command legacy",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec command legacy", e.message);
	}
}

async function testExecCommandExplicit(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: { mode: "command", command: "echo explicit-cmd" },
			timeout: 10000,
		},
	});
	if (res.status !== 201)
		return fail("exec command explicit", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec command explicit", "exitCode=0");
		fail(
			"exec command explicit",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec command explicit", e.message);
	}
}

async function testExecCommandCwd(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "command",
				command: isWin ? "cd" : "pwd",
				cwd: os.tmpdir(),
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec command cwd", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec command cwd", "exitCode=0");
		fail(
			"exec command cwd",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec command cwd", e.message);
	}
}

async function testExecScriptNode(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: process.execPath,
				args: ["-"],
				script: 'console.log("hello-via-stdin")',
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec script node", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec script node", "exitCode=0");
		fail(
			"exec script node",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec script node", e.message);
	}
}

async function testExecScriptNodeUnicode(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: process.execPath,
				args: ["-"],
				script:
					"console.log(\"\u4f60\u597d \ud83c\udf89\"); console.log('single\\'s q');",
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec script node unicode", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec script node unicode", "exitCode=0");
		fail(
			"exec script node unicode",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec script node unicode", e.message);
	}
}

async function testExecScriptQuotes(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: process.execPath,
				args: ["-"],
				script: 'console.log("a\\"b\\"c"); console.log(\'d\\\\e\');',
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec script quotes", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec script quotes", "exitCode=0");
		fail(
			"exec script quotes",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec script quotes", e.message);
	}
}

async function testExecScriptEmptyArgsAndScript(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: process.execPath,
				args: [],
				script: "",
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec script empty args/script", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec script empty args/script", "exitCode=0");
		fail(
			"exec script empty args/script",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec script empty args/script", e.message);
	}
}

async function testExecInvalidPayloadMixed(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: { mode: "command", command: "x", executable: "python" },
			timeout: 10000,
		},
	});
	if (res.status === 400)
		return pass("exec invalid mixed payload", "400 as expected");
	fail("exec invalid mixed payload", `expected 400, got ${res.status}`);
}

async function testExecInvalidPayloadBadTimeout(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: { command: "echo ok" },
			timeout: -5,
		},
	});
	if (res.status === 400)
		return pass("exec invalid bad timeout", "400 as expected");
	fail("exec invalid bad timeout", `expected 400, got ${res.status}`);
}

async function testExecSpawnFailed(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: "no-such-interpreter-xyz",
				args: ["-"],
				script: "1",
				timeout: 5000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec spawn failed create", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "error" && up.errorCode === "EXEC_SPAWN_FAILED")
			return pass("exec spawn failed", up.errorCode);
		fail("exec spawn failed", `status=${up.status} errorCode=${up.errorCode}`);
	} catch (e) {
		fail("exec spawn failed", e.message);
	}
}

async function testExecScriptNonZeroExit(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: process.execPath,
				args: ["-"],
				script: "process.exit(42)",
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec script non-zero exit", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "error" && up.result?.exitCode === 42)
			return pass("exec script non-zero exit", "exitCode=42 status=error");
		fail(
			"exec script non-zero exit",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec script non-zero exit", e.message);
	}
}

async function testExecScriptCwd(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: process.execPath,
				args: ["-"],
				script: "process.exit(0)",
				cwd: os.tmpdir(),
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec script cwd", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.exitCode === 0)
			return pass("exec script cwd", "exitCode=0");
		fail(
			"exec script cwd",
			`status=${up.status} exitCode=${up.result?.exitCode}`,
		);
	} catch (e) {
		fail("exec script cwd", e.message);
	}
}

async function testExecCancel(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "exec",
			payload: {
				mode: "script",
				executable: process.execPath,
				args: ["-"],
				script: "setTimeout(()=>{},60000)",
				timeout: 60000,
			},
		},
	});
	if (res.status !== 201)
		return fail("exec cancel create", `status ${res.status}`);
	const body = await res.json();
	await sleep(500);
	const cancelRes = await api("POST", `/api/jobs/${body.jobId}/cancel`);
	if (cancelRes.status !== 201)
		return fail("exec cancel request", `status ${cancelRes.status}`);
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "cancelled") return pass("exec cancel", "cancelled");
		if (up.status === "error" && up.errorCode)
			return pass("exec cancel", `cancel\u2192${up.status} ${up.errorCode}`);
		fail("exec cancel", `status=${up.status}`);
	} catch (e) {
		fail("exec cancel", e.message);
	}
}

// ── File ops test helpers ──
async function testFileMkdir(clientId, rootDir, dirName) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.mkdir",
			payload: { path: dirName, rootDir },
			timeout: 10000,
		},
	});
	if (res.status !== 201) return fail("file.mkdir", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done") return pass("file.mkdir", `dir=${dirName}`);
		fail("file.mkdir", `status=${up.status} error=${up.errorCode}`);
	} catch (e) {
		fail("file.mkdir", e.message);
	}
}

async function testFileList(clientId, rootDir, dirName) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.list",
			payload: { path: dirName, rootDir },
			timeout: 10000,
		},
	});
	if (res.status !== 201) return fail("file.list", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.entries)
			return pass("file.list", `${up.result.entries.length} entries`);
		fail("file.list", `status=${up.status} error=${up.errorCode}`);
	} catch (e) {
		fail("file.list", e.message);
	}
	return body.jobId;
}

async function testFileStat(clientId, rootDir, path) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.stat",
			payload: { path, rootDir },
			timeout: 10000,
		},
	});
	if (res.status !== 201) return fail("file.stat", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.name)
			return pass(
				"file.stat",
				`${up.result.name} kind=${up.result.kind} size=${up.result.size}`,
			);
		fail("file.stat", `status=${up.status} error=${up.errorCode}`);
	} catch (e) {
		fail("file.stat", e.message);
	}
}

async function testFileWriteText(clientId, rootDir, filePath, content) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.writeText",
			payload: { path: filePath, rootDir, content },
			timeout: 10000,
		},
	});
	if (res.status !== 201) return fail("file.writeText", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done")
			return pass("file.writeText", `${content.length} bytes`);
		fail("file.writeText", `status=${up.status} error=${up.errorCode}`);
	} catch (e) {
		fail("file.writeText", e.message);
	}
}

async function testFileReadText(clientId, rootDir, filePath, expectedContent) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.readText",
			payload: { path: filePath, rootDir },
			timeout: 10000,
		},
	});
	if (res.status !== 201) return fail("file.readText", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done" && up.result?.content === expectedContent)
			return pass("file.readText", `content matches, ${up.result.size} bytes`);
		fail(
			"file.readText",
			`status=${up.status} error=${up.errorCode} got="${up.result?.content?.slice(0, 40)}"`,
		);
	} catch (e) {
		fail("file.readText", e.message);
	}
}

async function testFileMove(clientId, rootDir, source, destination) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.move",
			payload: { source, destination, rootDir },
			timeout: 10000,
		},
	});
	if (res.status !== 201) return fail("file.move", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done")
			return pass("file.move", `${source} -> ${destination}`);
		fail("file.move", `status=${up.status} error=${up.errorCode}`);
	} catch (e) {
		fail("file.move", e.message);
	}
}

async function testFileDelete(clientId, rootDir, path, recursive) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.delete",
			payload: { path, rootDir, recursive },
			timeout: 10000,
		},
	});
	if (res.status !== 201) return fail("file.delete", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "done")
			return pass("file.delete", `path=${path} recursive=${!!recursive}`);
		fail("file.delete", `status=${up.status} error=${up.errorCode}`);
	} catch (e) {
		fail("file.delete", e.message);
	}
}

async function testFilePathEscape(clientId, rootDir) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.readText",
			payload: { path: "../../../etc/passwd", rootDir },
			timeout: 10000,
		},
	});
	if (res.status !== 201)
		return fail("file path escape", `status ${res.status}`);
	const body = await res.json();
	try {
		const up = await waitForJobUpdate(body.jobId);
		if (up.status === "error" && up.errorCode === "PATH_NOT_ALLOWED")
			return pass("file path escape", "PATH_NOT_ALLOWED");
		fail("file path escape", `status=${up.status} errorCode=${up.errorCode}`);
	} catch (e) {
		fail("file path escape", e.message);
	}
}

async function testFileCapabilityRejection() {
	// 用 mock socket 注册一个只有 exec 能力的 client，尝试创建 file job
	const mockId = "test-no-file-cap-" + Date.now();
	const mockSocket = io(`${BASE}/client`, { auth: { psk: PSK } });
	try {
		await new Promise((resolve, reject) => {
			mockSocket.on("connect", resolve);
			mockSocket.on("connect_error", reject);
			setTimeout(() => reject(new Error("mock connect timeout")), 5000);
		});
		await new Promise((resolve) => {
			mockSocket.emit(Events.REGISTER, {
				clientId: mockId,
				hostname: "test-no-file",
				os: "test",
				cpuModel: "test-cpu",
				totalMemMB: 1024,
				clientVersion: "0.0.0",
				capabilities: ["exec"],
			});
			mockSocket.on("ack", () => resolve());
			setTimeout(resolve, 1000);
		});
		await sleep(500);
		const res = await api("POST", "/api/jobs", {
			json: {
				clientId: mockId,
				type: "file.list",
				payload: { path: ".", rootDir: "/tmp" },
				timeout: 10000,
			},
		});
		if (res.status === 400) {
			const body = await res.json().catch(() => ({}));
			if (body.message?.includes("file.read"))
				return pass("file capability rejection", "400: lacks file.read");
			return fail("file capability rejection", `body=${JSON.stringify(body)}`);
		}
		fail("file capability rejection", `expected 400, got ${res.status}`);
	} catch (e) {
		fail("file capability rejection", e.message);
	} finally {
		mockSocket.disconnect();
	}
}

async function testFileExport(clientId, rootDir, filePath) {
	console.log("\n--- File Export (client -> storage) ---");
	const testContent = `export-test-${Date.now()}`;

	// 1. 先在客户端写文件
	const wkRes = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.writeText",
			payload: { path: filePath, rootDir, content: testContent },
			timeout: 10000,
		},
	});
	if (wkRes.status !== 201)
		return fail("file.export: write prep", `status ${wkRes.status}`);
	const wkBody = await wkRes.json();
	try {
		await waitForJobUpdate(wkBody.jobId);
	} catch (e) {
		return fail("file.export: write prep", e.message);
	}

	// 2. 导出文件
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.export",
			payload: { path: filePath, rootDir },
			timeout: 30000,
		},
	});
	if (res.status !== 201)
		return fail("file.export", `create failed: ${res.status}`);
	const body = await res.json();

	let exportResult = null;
	try {
		const up = await waitForJobUpdate(body.jobId, 30000);
		if (up.status !== "done")
			return fail("file.export", `status=${up.status} error=${up.errorCode}`);
		exportResult = up.result;
	} catch (e) {
		return fail("file.export", e.message);
	}

	if (!exportResult?.key) return fail("file.export", "no key in result");
	pass(
		"file.export",
		`fileId=${(exportResult.fileId || "").slice(0, 8)}... size=${exportResult.size} sha256=${(exportResult.sha256 || "").slice(0, 12)}...`,
	);

	// 3. 通过 Storage 下载验证内容
	const dlRes = await api("POST", "/api/storage/download-token", {
		json: { key: exportResult.key },
	});
	if (dlRes.status !== 200 && dlRes.status !== 201)
		return fail(
			"file.export: download verify",
			`download-token failed: ${dlRes.status}`,
		);
	const dlBody = await dlRes.json();
	const getRes = await fetch(`${BASE}${dlBody.url}`, { redirect: "manual" });
	const downloaded = await getRes.text();
	if (downloaded === testContent)
		pass(
			"file.export: content verify",
			`content matches (${downloaded.length} bytes)`,
		);
	else
		fail(
			"file.export: content verify",
			`expected "${testContent}", got "${downloaded}"`,
		);

	return exportResult;
}

async function testFileImport(
	clientId,
	rootDir,
	targetPath,
	fileId,
	expectedContent,
) {
	console.log("\n--- File Import (storage -> client) ---");

	const res = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.import",
			payload: { targetPath, rootDir, fileId },
			timeout: 30000,
		},
	});
	if (res.status !== 201)
		return fail("file.import", `create failed: ${res.status}`);
	const body = await res.json();

	try {
		const up = await waitForJobUpdate(body.jobId, 30000);
		if (up.status !== "done")
			return fail("file.import", `status=${up.status} error=${up.errorCode}`);
		pass("file.import", `path=${up.result?.path} size=${up.result?.size}`);
	} catch (e) {
		return fail("file.import", e.message);
	}

	// 验证导入后的文件内容
	const rdRes = await api("POST", "/api/jobs", {
		json: {
			clientId,
			type: "file.readText",
			payload: { path: targetPath, rootDir },
			timeout: 10000,
		},
	});
	if (rdRes.status !== 201)
		return fail("file.import: read verify", `create failed: ${rdRes.status}`);
	const rdBody = await rdRes.json();
	try {
		const up = await waitForJobUpdate(rdBody.jobId);
		if (up.status === "done") {
			const got = up.result?.content || "";
			if (
				got === expectedContent ||
				(typeof expectedContent === "string" && got.startsWith(expectedContent))
			)
				return pass("file.import: content verify", "content matches");
			return fail(
				"file.import: content verify",
				`expected prefix "${expectedContent}", got "${got.slice(0, 40)}"`,
			);
		}
		fail("file.import: content verify", `status=${up.status}`);
	} catch (e) {
		fail("file.import: content verify", e.message);
	}
}

// ── Storage test helpers ──
const TEST_FILE_CONTENT = "Hello from VCPDeck storage test!\n";

/** 上传文件并验证 key 一致，返回 { key, uploadUrl, signedDownloadUrl } */
async function storageUploadAndVerify() {
	// 1. 获取上传令牌
	const { status: tokStatus, body: tokenRes } = await apiJson(
		"POST",
		"/api/storage/upload-token",
		{
			json: {
				jobId: "test-storage",
				clientId: "test",
				filename: "storage-test.txt",
				size: TEST_FILE_CONTENT.length,
			},
		},
	);
	if (tokStatus !== 200 && tokStatus !== 201) {
		return fail("Storage upload token", `status ${tokStatus}`);
	}
	const uploadUrl = tokenRes.url;
	if (!uploadUrl || !uploadUrl.startsWith("/api/storage/upload/")) {
		return fail(
			"Storage upload token",
			uploadUrl ? "unexpected URL format" : "missing URL",
		);
	}
	const keyMatch = uploadUrl.match(/\/api\/storage\/upload\/([^?]+)/);
	const keyFromUrl = keyMatch ? keyMatch[1] : null;
	pass("Storage upload token", `key=${keyFromUrl}`);

	// 2. PUT 上传
	const putRes = await apiRaw("PUT", uploadUrl, TEST_FILE_CONTENT, {
		headers: { "Content-Type": "text/plain" },
	});
	const putBody = await putRes.json().catch(() => null);
	if (putRes.status !== 200 || !putBody?.key) {
		return fail(
			"Storage upload",
			`status=${putRes.status} body=${JSON.stringify(putBody)}`,
		);
	}
	if (putBody.key !== keyFromUrl) {
		return fail(
			"Storage upload key match",
			`urlKey=${keyFromUrl} storedKey=${putBody.key}`,
		);
	}
	pass(
		"Storage upload",
		`key=${putBody.key.slice(0, 20)}..., size=${putBody.size}`,
	);

	// 3. 获取下载令牌
	const { status: dlTokStatus, body: dlTokenRes } = await apiJson(
		"POST",
		"/api/storage/download-token",
		{ json: { key: putBody.key } },
	);
	if (dlTokStatus !== 200 && dlTokStatus !== 201) {
		return fail("Storage download token", `status ${dlTokStatus}`);
	}
	const downloadUrl = dlTokenRes.url;
	if (!downloadUrl || !downloadUrl.startsWith("/api/storage/download/")) {
		return fail(
			"Storage download token",
			downloadUrl ? "unexpected URL format" : "missing URL",
		);
	}
	pass("Storage download token", "signed URL issued");

	// 4. GET 下载
	const getRes = await fetch(`${BASE}${downloadUrl}`, { redirect: "manual" });
	const content = await getRes.text();
	if (getRes.status !== 200 || content !== TEST_FILE_CONTENT) {
		return fail(
			"Storage download",
			`status=${getRes.status} contentLen=${content.length} expectedLen=${TEST_FILE_CONTENT.length}`,
		);
	}
	pass("Storage download", `content matches, ${content.length} bytes`);

	return { key: putBody.key, uploadUrl, signedDownloadUrl: downloadUrl };
}

async function verifyStableDownloadRedirect(key) {
	const stablePath = `/api/storage/download-redirect/${encodeURIComponent(key)}`;

	const anonymous = await api("GET", stablePath, { noCookie: true });
	if (anonymous.status === 401) {
		pass("Storage stable download no auth", "401");
	} else {
		fail(
			"Storage stable download no auth",
			`expected 401, got ${anonymous.status}`,
		);
	}

	const cookieRedirect = await api("GET", stablePath, {
		headers: { Range: "bytes=1-" },
	});
	const location = cookieRedirect.headers.get("location") || "";
	const referrerPolicy = cookieRedirect.headers.get("referrer-policy");
	const cacheControl = cookieRedirect.headers.get("cache-control") || "";
	if (
		cookieRedirect.status === 302 &&
		location.startsWith("/api/storage/download/") &&
		referrerPolicy === "no-referrer" &&
		cacheControl.includes("no-store")
	) {
		pass("Storage stable download cookie redirect", "302 + safe headers");
	} else {
		fail(
			"Storage stable download cookie redirect",
			JSON.stringify({
				status: cookieRedirect.status,
				hasLocation: Boolean(location),
				locationKind: location.startsWith("/api/storage/download/")
					? "local-signed"
					: "unexpected",
				referrerPolicy,
				cacheControl,
			}),
		);
	}

	const { status: tokenStatus, body: token } = await apiJson(
		"POST",
		"/api/auth/tokens",
		{ json: { label: "storage-download-redirect" } },
	);
	if ((tokenStatus !== 200 && tokenStatus !== 201) || !token?.token) {
		fail("Storage stable download bearer setup", `status=${tokenStatus}`);
	} else {
		try {
			const bearerRedirect = await api("GET", stablePath, {
				bearer: token.token,
				noCookie: true,
				headers: { Range: "bytes=1-" },
			});
			if (
				bearerRedirect.status === 302 &&
				(bearerRedirect.headers.get("location") || "").startsWith(
					"/api/storage/download/",
				)
			) {
				pass("Storage stable download bearer redirect", "302");
			} else {
				fail(
					"Storage stable download bearer redirect",
					`status=${bearerRedirect.status}`,
				);
			}
		} finally {
			await api("DELETE", `/api/auth/tokens/${token.id}`);
		}
	}

	if (location.startsWith("/api/storage/download/")) {
		const localDownload = await fetch(`${BASE}${location}`);
		const content = await localDownload.text();
		if (localDownload.status === 200 && content === TEST_FILE_CONTENT) {
			pass("Storage stable download local content", "content matches");
		} else {
			fail(
				"Storage stable download local content",
				`status=${localDownload.status} contentLen=${content.length}`,
			);
		}
	}
}

// ── Main ──
let _exitCode = 0;

// 记录 exit code 替代 process.exit，由 finally 统一退出
const done = (code) => {
	_exitCode = code;
};

async function main() {
	console.log("\n=== VCPDeck Integration Test ===\n");

	killPort();
	await sleep(1000);

	// 1. Start server
	console.log("[setup] Starting server...");
	const serverCommand = isWin ? process.env.ComSpec || "cmd.exe" : "pnpm";
	const serverArgs = isWin ? ["/d", "/s", "/c", "pnpm start"] : ["start"];
	_serverProcess = spawn(serverCommand, serverArgs, {
		cwd: serverDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			VCPDECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
			VCPDECK_FRONTEND_ORIGIN: "http://localhost:5173",
			DATABASE_URL: testDatabase.databaseUrl,
		},
	});
	let serverOutput = "";
	_serverProcess.stdout.on("data", (d) => {
		serverOutput += d.toString();
	});
	_serverProcess.stderr.on("data", (d) => {
		serverOutput += d.toString();
	});

	// Wait for server to start
	let serverReady = false;
	for (let i = 0; i < 30; i++) {
		await sleep(1000);
		if (serverOutput.includes("listening on")) {
			serverReady = true;
			break;
		}
	}

	if (!serverReady) {
		console.error("[setup] Server failed to start");
		console.error(serverOutput);
		done(1);
		return;
	}
	console.log("  ✓ Server started\n");

	// ────────────────────────────────────────────
	// AUTH TESTS
	// ────────────────────────────────────────────
	console.log("--- Auth: public endpoints ---");

	// 1. Health (public)
	{
		const res = await api("GET", "/api/health");
		const body = await res.json();
		if (res.status === 200 && body.ok) {
			pass("GET /api/health (public)", "200 OK");
		} else {
			fail("GET /api/health", JSON.stringify({ status: res.status, body }));
		}
	}

	// 2. Login with wrong password
	{
		const { status } = await apiJson("POST", "/api/auth/login", {
			json: { username: "admin", password: "wrong" },
			noCookie: true,
		});
		if (status === 401) {
			pass("Login with wrong password", "401");
		} else {
			fail("Login with wrong password", `status=${status}`);
		}
	}

	// 3. Login as admin
	console.log("\n--- Auth: login ---");
	let adminIdentity = null;
	{
		const { status, body } = await apiJson("POST", "/api/auth/login", {
			json: { username: "admin", password: ADMIN_PASSWORD },
			noCookie: true,
		});
		if (
			(status === 200 || status === 201) &&
			body.identity?.isAdmin &&
			body.identity?.username === "admin"
		) {
			adminIdentity = body.identity;
			pass(
				"Login as admin",
				`id=${body.identity.id.slice(0, 8)}..., isAdmin=true`,
			);
		} else {
			fail("Login as admin", JSON.stringify({ status, body }));
		}
	}

	// 4. GET /api/auth/me
	{
		const { status, body } = await apiJson("GET", "/api/auth/me");
		if (status === 200 && body.id === adminIdentity?.id) {
			pass("GET /api/auth/me with cookie", `username=${body.username}`);
		} else {
			fail("GET /api/auth/me", JSON.stringify({ status, body }));
		}
	}

	// 5. GET /api/clients (no auth / no cookie)
	console.log("\n--- Auth: guard ---");
	{
		const { status } = await apiJson("GET", "/api/clients", { noCookie: true });
		if (status === 401) {
			pass("Rejects unauthenticated request", "401");
		} else {
			fail("Rejects unauthenticated request", `status=${status}`);
		}
	}

	// 6. GET /api/clients (with cookie) — should return empty array
	{
		const { status, body } = await apiJson("GET", "/api/clients");
		if (status === 200 && Array.isArray(body)) {
			pass("GET /api/clients with auth", `200, ${body.length} clients`);
		} else {
			fail("GET /api/clients with auth", JSON.stringify({ status, body }));
		}
	}

	// 7. Create CLI token
	console.log("\n--- Auth: token management ---");
	let tokenId = null;
	{
		const { status, body } = await apiJson("POST", "/api/auth/tokens", {
			json: { label: "test-integration-cli" },
		});
		if (
			(status === 200 || status === 201) &&
			body.token?.startsWith("vcp_") &&
			body.label === "test-integration-cli"
		) {
			cliToken = body.token;
			tokenId = body.id;
			pass("Create CLI token", `token=${body.token.slice(0, 12)}...`);
		} else {
			fail("Create CLI token", JSON.stringify({ status, body }));
		}
	}

	// 8. List tokens
	{
		const { status, body } = await apiJson("GET", "/api/auth/tokens");
		if (status === 200 && Array.isArray(body) && body.length >= 1) {
			pass("List tokens", `${body.length} token(s)`);
		} else {
			fail("List tokens", JSON.stringify({ status, body }));
		}
	}

	// 9. Use Bearer token to call API
	console.log("\n--- Auth: bearer token ---");
	if (cliToken) {
		const res = await api("GET", "/api/clients", {
			bearer: cliToken,
			noCookie: true,
		});
		const body = await res.json();
		if (res.status === 200 && Array.isArray(body)) {
			pass("Bearer token works", "200");
		} else {
			fail("Bearer token works", JSON.stringify({ status: res.status, body }));
		}
	}

	// 10. Revoke token
	{
		const { status } = await apiJson("DELETE", `/api/auth/tokens/${tokenId}`);
		if (status === 200) {
			pass("Revoke token", "200");
		} else {
			fail("Revoke token", `status=${status}`);
		}
	}

	// 11. Use revoked token → 401
	{
		const res = await api("GET", "/api/clients", {
			bearer: cliToken,
			noCookie: true,
		});
		if (res.status === 401) {
			pass("Revoked token rejected", "401");
		} else {
			fail("Revoked token rejected", `status=${res.status}`);
		}
	}

	// 12. Admin creates another identity
	console.log("\n--- Auth: identity management ---");
	let user1Id = null;
	const ts = Date.now();
	{
		const { status, body } = await apiJson("POST", "/api/identities", {
			json: {
				username: `user-${ts}`,
				password: "pass123",
				displayName: "Integration Test User",
			},
		});
		if (
			(status === 200 || status === 201) &&
			body.username === `user-${ts}` &&
			body.isAdmin === false
		) {
			user1Id = body.id;
			pass("Admin creates identity", `username=${body.username}`);
		} else {
			fail("Admin creates identity", JSON.stringify({ status, body }));
		}
	}

	// 13. List identities includes both
	{
		const { status, body } = await apiJson("GET", "/api/identities");
		if (status === 200 && Array.isArray(body) && body.length >= 2) {
			pass("List identities", `${body.length} identities`);
		} else {
			fail("List identities", JSON.stringify({ status, body }));
		}
	}

	// 14. Non-admin cannot list identities
	const userLoginName = `user-${ts}`;
	{
		// Login as the created user
		await api("POST", "/api/auth/login", {
			json: { username: userLoginName, password: "pass123" },
			noCookie: true,
		});
		// Save user1's cookie temporarily
		const user1Cookie = cookie;
		cookie = user1Cookie; // already set by api()

		const { status } = await apiJson("GET", "/api/identities");
		if (status === 403) {
			pass("Non-admin cannot list identities", "403");
		} else {
			fail("Non-admin cannot list identities", `status=${status}`);
		}

		// Restore admin cookie
		await api("POST", "/api/auth/login", {
			json: { username: "admin", password: ADMIN_PASSWORD },
			noCookie: true,
		});
	}

	// 15. Admin disables user2
	{
		const { status } = await apiJson(
			"POST",
			`/api/identities/${user1Id}/disable`,
		);
		if (status === 200 || status === 201) {
			pass("Admin disables identity", `${status}`);
		} else {
			fail("Admin disables identity", `status=${status}`);
		}
	}

	// 16. Disabled user cannot login
	{
		const { status } = await apiJson("POST", "/api/auth/login", {
			json: { username: userLoginName, password: "pass123" },
			noCookie: true,
		});
		if (status === 401) {
			pass("Disabled identity cannot login", `status=${status}`);
		} else {
			fail("Disabled identity cannot login", `status=${status}`);
		}
	}

	// 17. Admin enables user2
	{
		const { status } = await apiJson(
			"POST",
			`/api/identities/${user1Id}/enable`,
		);
		if (status === 200 || status === 201) {
			pass("Admin enables identity", `${status}`);
		} else {
			fail("Admin enables identity", `status=${status}`);
		}
	}

	// 18. Enabled user can login again
	{
		const { status, body } = await apiJson("POST", "/api/auth/login", {
			json: { username: userLoginName, password: "pass123" },
			noCookie: true,
		});
		if (
			(status === 200 || status === 201) &&
			body.identity?.username === userLoginName
		) {
			pass("Enabled identity can login again", `${status}`);
		} else {
			fail(
				"Enabled identity can login again",
				JSON.stringify({ status, body }),
			);
		}
	}

	// ────────────────────────────────────────────
	// ORIGINAL TESTS (adapted for auth + /client namespace)
	// ────────────────────────────────────────────

	// Ensure admin cookie for remaining tests
	await api("POST", "/api/auth/login", {
		json: { username: "admin", password: ADMIN_PASSWORD },
		noCookie: true,
	});

	// ─────────────────────────────
	// Test: REST endpoints (empty state)
	// ─────────────────────────────
	console.log("\n--- REST endpoints (with auth) ---");

	{
		const { body } = await apiJson("GET", "/api/clients");
		if (Array.isArray(body)) {
			pass("GET /api/clients returns array", `length=${body.length}`);
		} else {
			fail("GET /api/clients returns array", JSON.stringify(body));
		}
	}

	{
		const { body } = await apiJson("GET", "/api/jobs");
		const jobs = Array.isArray(body) ? body : body?.data;
		if (Array.isArray(jobs)) {
			pass("GET /api/jobs returns paginated data", `length=${jobs.length}`);
		} else {
			fail("GET /api/jobs returns paginated data", JSON.stringify(body));
		}
	}

	// ─────────────────────────────
	// Test: Client connection + register
	// ─────────────────────────────
	console.log("\n--- Client connection ---");

	let clientId = null;
	try {
		clientSocket = io(`${BASE}/client`, { auth: { psk: PSK } });
		await new Promise((resolve, reject) => {
			clientSocket.on("connect", resolve);
			clientSocket.on("connect_error", reject);
			setTimeout(() => reject(new Error("connect timeout")), 5000);
		});
		pass("Socket.IO connects to /client", clientSocket.id);

		// Register
		const hostname = os.hostname();
		const testClientId = "test-integration-" + Date.now();
		await new Promise((resolve) => {
			clientSocket.emit(Events.REGISTER, {
				clientId: testClientId,
				hostname,
				os: "test",
				cpuModel: "test-cpu",
				totalMemMB: 1024,
				clientVersion: "0.0.0",
				capabilities: ["exec"],
			});
			clientSocket.on("ack", () => resolve());
			setTimeout(resolve, 1000);
		});
		clientId = testClientId;
		pass("Client registers", `id=${testClientId}`);
	} catch (e) {
		fail("Client connection", e.message);
	}

	// ─────────────────────────────
	// Test: GET /api/clients (with registered client)
	// ─────────────────────────────
	console.log("\n--- Client info ---");

	if (clientSocket?.connected) {
		await sleep(500);
		try {
			const { body: clients } = await apiJson("GET", "/api/clients");
			const c = clients.find((item) => item.clientId === clientId);
			if (c) {
				if (c.clientId && c.hostname && c.os) {
					pass("Client info has fields", `hostname=${c.hostname}, os=${c.os}`);
				} else {
					fail("Client info missing fields", JSON.stringify(c));
				}
				if (c.online === true) {
					pass("Client is online", "");
				} else {
					fail("Client should be online", JSON.stringify(c));
				}
			} else {
				fail("No clients found", "");
			}
		} catch (e) {
			fail("GET /api/clients (after register)", e.message);
		}
	}

	// ─────────────────────────────
	// Test: Job creation
	// ─────────────────────────────
	console.log("\n--- Job lifecycle ---");

	if (clientSocket?.connected && clientId) {
		try {
			const { body: clients } = await apiJson("GET", "/api/clients");
			const realClientId = clients.find(
				(item) => item.clientId === clientId,
			)?.clientId;
			if (!realClientId) throw new Error("Registered client not found");

			// Register listener BEFORE creating the job
			const dispatchPromise = new Promise((resolve) => {
				const timer = setTimeout(() => resolve(null), 5000);
				clientSocket.once(Events.JOB_DISPATCH, (data) => {
					clearTimeout(timer);
					resolve(data);
				});
			});

			const { body: job } = await apiJson("POST", "/api/jobs", {
				json: {
					clientId: realClientId,
					type: "exec",
					payload: { command: "echo hello world" },
				},
			});

			if (!job.jobId) throw new Error("Job not created");
			pass(
				"POST /api/jobs creates job",
				`jobId=${job.jobId.slice(0, 8)}..., status=${job.status}`,
			);

			const dispatchReceived = await dispatchPromise;

			if (dispatchReceived) {
				pass(
					"Client receives job:dispatch",
					`type=${dispatchReceived.type}, jobId=${dispatchReceived.jobId.slice(0, 8)}...`,
				);

				clientSocket.emit(Events.JOB_STDOUT, {
					jobId: dispatchReceived.jobId,
					text: "hello world\n",
				});
				clientSocket.emit(Events.JOB_DONE, {
					jobId: dispatchReceived.jobId,
					type: "exec",
					exitCode: 0,
				});

				await sleep(500);

				const { body: jobsResponse } = await apiJson("GET", "/api/jobs");
				const jobs = Array.isArray(jobsResponse)
					? jobsResponse
					: jobsResponse?.data;
				const ourJob = jobs?.find((j) => j.jobId === dispatchReceived.jobId);
				if (ourJob && ourJob.status === "done") {
					pass("Job completes", `status=${ourJob.status}`);

					// Check auth audit fields
					if (
						ourJob.createdByIdentityId === adminIdentity?.id &&
						ourJob.createdByName === "admin" &&
						ourJob.createdVia === "web"
					) {
						pass(
							"Job has auth audit fields",
							`by=${ourJob.createdByName}, via=${ourJob.createdVia}`,
						);
					} else {
						fail("Job auth audit fields", JSON.stringify(ourJob));
					}
				} else {
					fail("Job should be done", JSON.stringify(ourJob));
				}
			} else {
				fail("Client did not receive dispatch", "timeout");
			}
		} catch (e) {
			fail("Job creation/execution", e.message);
		}
	}

	// ─────────────────────────────
	// Test: Job cancel
	// ─────────────────────────────
	console.log("\n--- Job cancel ---");

	if (clientSocket?.connected && clientId) {
		try {
			const { body: clients } = await apiJson("GET", "/api/clients");
			const realClientId = clients.find(
				(item) => item.clientId === clientId,
			)?.clientId;
			if (!realClientId) throw new Error("Registered client not found");

			// Register cancel listener first
			const cancelPromise = new Promise((resolve) => {
				const timer = setTimeout(() => resolve(null), 5000);
				clientSocket.once(Events.JOB_CANCEL, (data) => {
					clearTimeout(timer);
					resolve(data);
				});
			});

			// Register dispatch listener for this job
			const dispatchPromise2 = new Promise((resolve) => {
				const timer = setTimeout(() => resolve(null), 5000);
				clientSocket.once(Events.JOB_DISPATCH, (data) => {
					clearTimeout(timer);
					resolve(data);
				});
			});

			const { body: job } = await apiJson("POST", "/api/jobs", {
				json: {
					clientId: realClientId,
					type: "exec",
					payload: { command: "sleep 60" },
				},
			});

			if (!job.jobId) throw new Error("Job not created");

			// Wait for dispatch to arrive
			await dispatchPromise2;

			const { body: cancelResult } = await apiJson(
				"POST",
				`/api/jobs/${job.jobId}/cancel`,
			);

			if (cancelResult.status === "cancelling") {
				pass("Cancel request accepted", `status=${cancelResult.status}`);
			} else {
				fail("Cancel request", JSON.stringify(cancelResult));
			}

			const cancelReceived = await cancelPromise;

			if (cancelReceived) {
				pass("Client receives job:cancel", `jobId=${cancelReceived.jobId}`);

				clientSocket.emit(Events.JOB_CANCELLED, {
					jobId: cancelReceived.jobId,
				});
				await sleep(500);

				const { body: jobsResponse } = await apiJson("GET", "/api/jobs");
				const jobs = Array.isArray(jobsResponse)
					? jobsResponse
					: jobsResponse?.data;
				const ourJob = jobs?.find((j) => j.jobId === cancelReceived.jobId);
				if (ourJob?.status === "cancelled") {
					pass("Job is cancelled", `status=${ourJob.status}`);
				} else {
					fail("Job should be cancelled", JSON.stringify(ourJob));
				}
			} else {
				fail("Client did not receive cancel", "timeout");
			}
		} catch (e) {
			fail("Job cancel flow", e.message);
		}
	}

	// ─────────────────────────────
	// Test: Heartbeat
	// ─────────────────────────────
	console.log("\n--- Heartbeat ---");

	if (clientSocket?.connected && clientId) {
		try {
			const { body: clients } = await apiJson("GET", "/api/clients");
			const c = clients.find((item) => item.clientId === clientId);
			if (!c) throw new Error("Registered client not found");
			const before = c.lastHeartbeatAt;

			clientSocket.emit(Events.HEARTBEAT, {
				clientId: c.clientId,
				cpuPercent: 15,
				memPercent: 60,
				disks: [],
				runningJobs: [],
				uptime: 120,
			});

			await sleep(500);

			const { body: clients2 } = await apiJson("GET", "/api/clients");
			const c2 = clients2[0];
			if (c2.lastHeartbeatAt && c2.lastHeartbeatAt !== before) {
				pass("Heartbeat updates lastHeartbeatAt", c2.lastHeartbeatAt);
			} else {
				fail(
					"Heartbeat not recorded",
					`before=${before} after=${c2.lastHeartbeatAt}`,
				);
			}
		} catch (e) {
			fail("Heartbeat test", e.message);
		}
	}

	// ─────────────────────────────
	// Test: Reject job for unknown client
	// ─────────────────────────────
	console.log("\n--- Validation ---");

	try {
		const res = await api("POST", "/api/jobs", {
			json: {
				clientId: "nonexistent-client",
				type: "exec",
				payload: { command: "echo bad" },
			},
		});
		const body = await res.json();
		if (res.status === 400 && body.message?.includes("not found")) {
			pass("Rejects job for unknown client", body.message);
		} else {
			fail("Should reject unknown client", JSON.stringify(body));
		}
	} catch (e) {
		fail("Reject unknown client", e.message);
	}

	// ── Exec command/script 测试（真实 Client 执行） ──
	console.log("\n--- Exec Command/Script ---");
	try {
		console.log("  [setup] Starting real client...");
		await startRealClient();
		// 等待 Client 在 Server 完成注册
		let registered = false;
		for (let i = 0; i < 20; i++) {
			const { body: c } = await apiJson("GET", "/api/clients");
			if (c.some((cl) => cl.clientId === REAL_CLIENT_ID && cl.online)) {
				registered = true;
				break;
			}
			await sleep(500);
		}
		if (!registered) {
			throw new Error("Real client not registered with server");
		}
		pass("Real client connected", REAL_CLIENT_ID);

		await testExecCommandLegacy(REAL_CLIENT_ID);
		await testExecCommandExplicit(REAL_CLIENT_ID);
		await testExecCommandCwd(REAL_CLIENT_ID);
		await testExecScriptNode(REAL_CLIENT_ID);
		await testExecScriptNodeUnicode(REAL_CLIENT_ID);
		await testExecScriptQuotes(REAL_CLIENT_ID);
		await testExecScriptEmptyArgsAndScript(REAL_CLIENT_ID);
		await testExecInvalidPayloadMixed(REAL_CLIENT_ID);
		await testExecInvalidPayloadBadTimeout(REAL_CLIENT_ID);
		await testExecSpawnFailed(REAL_CLIENT_ID);
		await testExecScriptNonZeroExit(REAL_CLIENT_ID);
		await testExecScriptCwd(REAL_CLIENT_ID);
		await testExecCancel(REAL_CLIENT_ID);

		// ── File ops 集成测试 ──
		console.log("\n--- File Ops Integration ---");
		const fileTestRoot = os.tmpdir();
		const fileTestDir = "vcpdeck-test-" + Date.now();
		const testFilePath = `${fileTestDir}/hello.txt`;
		const testMovedPath = `${fileTestDir}/hello-renamed.txt`;
		const testContent = "Hello VCPDeck file ops!";

		await testFileMkdir(REAL_CLIENT_ID, fileTestRoot, fileTestDir);
		await testFileList(REAL_CLIENT_ID, fileTestRoot, fileTestDir);
		await testFileStat(REAL_CLIENT_ID, fileTestRoot, fileTestDir);
		await testFileWriteText(
			REAL_CLIENT_ID,
			fileTestRoot,
			testFilePath,
			testContent,
		);
		await testFileReadText(
			REAL_CLIENT_ID,
			fileTestRoot,
			testFilePath,
			testContent,
		);
		await testFileMove(
			REAL_CLIENT_ID,
			fileTestRoot,
			testFilePath,
			testMovedPath,
		);
		await testFileStat(REAL_CLIENT_ID, fileTestRoot, testMovedPath);
		await testFileDelete(REAL_CLIENT_ID, fileTestRoot, fileTestDir, true);

		// 安全测试
		await testFilePathEscape(REAL_CLIENT_ID, fileTestRoot);

		// 能力拒绝测试
		await testFileCapabilityRejection();

		// 文件传输测试（export + import 全链路）—— 先重建测试目录
		await testFileMkdir(REAL_CLIENT_ID, fileTestRoot, fileTestDir);
		const exportPath = `${fileTestDir}/to-export.txt`;
		const exportResult = await testFileExport(
			REAL_CLIENT_ID,
			fileTestRoot,
			exportPath,
		);

		if (exportResult?.fileId) {
			// 删除本地文件后，通过 import 拉回
			await testFileDelete(REAL_CLIENT_ID, fileTestRoot, exportPath, false);
			const importPath = `${fileTestDir}/imported-back.txt`;
			await testFileImport(
				REAL_CLIENT_ID,
				fileTestRoot,
				importPath,
				exportResult.fileId,
				"export-test-",
			);
		}
	} catch (e) {
		fail("Exec test section", e.message);
	} finally {
		stopRealClient();
	}

	// ── Storage 存储系统测试 ──
	console.log("\n--- Storage ---");

	// Ensure admin cookie
	await api("POST", "/api/auth/login", {
		json: { username: "admin", password: ADMIN_PASSWORD },
		noCookie: true,
	});

	// 48. upload-token without auth → 401
	{
		const { status } = await apiJson("POST", "/api/storage/upload-token", {
			json: { jobId: "x", clientId: "x", filename: "x", size: 1 },
			noCookie: true,
		});
		if (status === 401) {
			pass("Storage upload-token no auth", "401");
		} else {
			fail("Storage upload-token no auth", `expected 401, got ${status}`);
		}
	}

	// 49. Full upload → download → delete flow
	let testKey = null;
	try {
		const result = await storageUploadAndVerify();
		if (result?.key) testKey = result.key;
	} catch (e) {
		fail("Storage full flow", e.message);
	}
	if (testKey) {
		await verifyStableDownloadRedirect(testKey);
	}

	// 50. Upload with expired signature → 403
	{
		const { status: tokStatus, body: tokenRes } = await apiJson(
			"POST",
			"/api/storage/upload-token",
			{
				json: {
					jobId: "test-expired",
					clientId: "test",
					filename: "expired.txt",
					size: 5,
					ttlSeconds: 1,
				},
			},
		);
		if (tokStatus === 200 || tokStatus === 201) {
			const expiredUrl = tokenRes.url;
			await sleep(2000); // 等待过期
			const putRes = await apiRaw("PUT", expiredUrl, "hello", {
				headers: { "Content-Type": "text/plain" },
			});
			if (putRes.status === 403) {
				pass("Storage upload expired sig", "403");
			} else {
				fail(
					"Storage upload expired sig",
					`expected 403, got ${putRes.status}`,
				);
			}
		}
	}

	// 51. Upload with tampered signature → 403
	{
		const { status: tokStatus, body: tokenRes } = await apiJson(
			"POST",
			"/api/storage/upload-token",
			{
				json: {
					jobId: "test-bad",
					clientId: "test",
					filename: "bad.txt",
					size: 5,
				},
			},
		);
		if (tokStatus === 200 || tokStatus === 201) {
			const tamperedUrl = tokenRes.url.replace(/sig=([^&]+)/, "sig=deadbeef");
			const putRes = await apiRaw("PUT", tamperedUrl, "hello", {
				headers: { "Content-Type": "text/plain" },
			});
			if (putRes.status === 403) {
				pass("Storage upload bad sig", "403");
			} else {
				fail("Storage upload bad sig", `expected 403, got ${putRes.status}`);
			}
		}
	}

	// 52. DELETE with admin auth → ok
	if (testKey) {
		const { status } = await apiJson("DELETE", `/api/storage/${testKey}`);
		if (status === 200) {
			pass("Storage delete", "200");
		} else {
			fail("Storage delete", `expected 200, got ${status}`);
		}

		// 53. Download deleted file → error
		try {
			const { status: dlTokStatus, body: dlTokenRes } = await apiJson(
				"POST",
				"/api/storage/download-token",
				{ json: { key: testKey } },
			);
			if (dlTokStatus === 200 || dlTokStatus === 201) {
				const getRes = await fetch(`${BASE}${dlTokenRes.url}`, {
					redirect: "manual",
				});
				// 文件已删除，应返回错误
				if (getRes.status >= 400) {
					pass("Storage download deleted file", `status=${getRes.status}`);
				} else {
					fail(
						"Storage download deleted file",
						`expected error, got ${getRes.status}`,
					);
				}
			}
		} catch {
			pass("Storage download deleted file", "error as expected");
		}
	}

	// 54. DELETE without auth → 401
	{
		const { status } = await apiJson("DELETE", `/api/storage/some-key`, {
			noCookie: true,
		});
		if (status === 401) {
			pass("Storage delete no auth", "401");
		} else {
			fail("Storage delete no auth", `expected 401, got ${status}`);
		}
	}

	// 19. Logout
	console.log("\n--- Auth: logout ---");
	{
		const { status } = await apiJson("POST", "/api/auth/logout");
		if (status === 200 || status === 201) {
			cookie = ""; // clear cookie for subsequent tests
			pass("Logout", `${status}`);
		} else {
			fail("Logout", `status=${status}`);
		}
	}

	// 20. After logout, /api/auth/me returns 401
	{
		const { status } = await apiJson("GET", "/api/auth/me");
		if (status === 401) {
			pass("Session invalid after logout", "401");
		} else {
			fail("Session invalid after logout", `status=${status}`);
		}
	}

	// ─────────────────────────────
	// Report
	// ─────────────────────────────
	console.log("=== Test Report ===\n");
	const passed = results.filter((r) => r.status === "PASS").length;
	const failed = results.filter((r) => r.status === "FAIL").length;
	const total = results.length;

	for (const r of results) {
		const icon = r.status === "PASS" ? "✓" : "✗";
		console.log(`  ${icon} ${r.name}`);
		if (r.detail) console.log(`       ${r.detail}`);
	}

	console.log(`\n  ${passed}/${total} passed, ${failed} failed\n`);

	done(failed > 0 ? 1 : 0);
}

// ── Run with guaranteed cleanup ──
main()
	.catch((err) => {
		console.error("Test error:", err.message);
		done(1);
	})
	.finally(() => {
		if (clientSocket) clientSocket.disconnect();
		stopRealClient();
		if (_serverProcess?.pid) killTree(_serverProcess.pid);
		_serverProcess = null;
		killPort();
		try {
			cleanupIntegrationTestDb(testDatabase);
		} catch (error) {
			console.error(
				`Failed to clean integration test database ${testDatabase.directory}:`,
				error.message,
			);
			_exitCode = 1;
		}
		process.exit(_exitCode);
	});
