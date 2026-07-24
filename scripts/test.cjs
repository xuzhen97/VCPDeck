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

// ── Test state ──
let clientSocket;
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
			execSync(`kill -9 ${pid}`, {
				stdio: "ignore",
				timeout: 3000,
				shell: true,
			});
		}
	} catch {
		// already dead
	}
}

// ── Exec command/script 测试 ──

async function testExecCommandLegacy(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: { clientId, type: "exec", payload: { command: "echo hello-world" }, timeout: 10000 },
	});
	if (res.status !== 201) return fail("exec command legacy", `status ${res.status}`);
	const body = await res.json();
	if (!body.jobId) return fail("exec command legacy", "no jobId");
	await sleep(1500);
	pass("exec command legacy", `jobId=${body.jobId}`);
}

async function testExecCommandExplicit(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: { clientId, type: "exec", payload: { mode: "command", command: "echo explicit-cmd" }, timeout: 10000 },
	});
	if (res.status !== 201) return fail("exec command explicit", `status ${res.status}`);
	const body = await res.json();
	await sleep(1500);
	pass("exec command explicit", `jobId=${body.jobId}`);
}

async function testExecScriptNode(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { mode: "script", executable: process.execPath, args: ["-"], script: 'console.log("hello-via-stdin")', timeout: 10000 },
		},
	});
	if (res.status !== 201) return fail("exec script node", `status ${res.status}`);
	const body = await res.json();
	await sleep(1500);
	pass("exec script node", `jobId=${body.jobId}`);
}

async function testExecScriptNodeUnicode(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: {
				mode: "script", executable: process.execPath, args: ["-"],
				script: 'console.log("\u4f60\u597d \ud83c\udf89"); console.log(\'single\\\'s q\');',
				timeout: 10000,
			},
		},
	});
	if (res.status !== 201) return fail("exec script node unicode", `status ${res.status}`);
	await sleep(1500);
	pass("exec script node unicode", `jobId=${(await res.json()).jobId}`);
}

async function testExecScriptEmptyArgsAndScript(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { mode: "script", executable: process.execPath, args: [], script: "", timeout: 10000 },
		},
	});
	if (res.status !== 201) return fail("exec script empty args/script", `status ${res.status}`);
	await sleep(1500);
	pass("exec script empty args/script", `jobId=${(await res.json()).jobId}`);
}

async function testExecInvalidPayloadMixed(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { mode: "command", command: "x", executable: "python" },
			timeout: 10000,
		},
	});
	if (res.status === 400) return pass("exec invalid mixed payload", "400 as expected");
	fail("exec invalid mixed payload", `expected 400, got ${res.status}`);
}

async function testExecInvalidPayloadBadTimeout(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { command: "echo ok" },
			timeout: -5,
		},
	});
	if (res.status === 400) return pass("exec invalid bad timeout", "400 as expected");
	fail("exec invalid bad timeout", `expected 400, got ${res.status}`);
}

async function testExecSpawnFailed(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { mode: "script", executable: "no-such-interpreter-xyz", args: ["-"], script: "1", timeout: 5000 },
		},
	});
	if (res.status !== 201) return fail("exec spawn failed create", `status ${res.status}`);
	const body = await res.json();
	// 等待 dispatch 发出，然后模拟客户端错误
	await sleep(500);
	clientSocket.emit(Events.JOB_DONE, {
		jobId: body.jobId,
		type: "exec",
		error: { code: "EXEC_SPAWN_FAILED", message: "ENOENT" },
	});
	await sleep(500);
	const check = await api("GET", `/api/jobs/${body.jobId}`);
	const j = await check.json();
	if (j.status === "error" && j.errorCode === "EXEC_SPAWN_FAILED") return pass("exec spawn failed", j.errorCode);
	fail("exec spawn failed", `status=${j.status} errorCode=${j.errorCode}`);
}

async function testExecCommandCwd(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { mode: "command", command: isWin ? "cd" : "pwd", cwd: os.tmpdir(), timeout: 10000 },
		},
	});
	if (res.status !== 201) return fail("exec command cwd", `status ${res.status}`);
	await sleep(1500);
	pass("exec command cwd", "accepted");
}

async function testExecCancel(clientId) {
	// 先填满并发槽：创建 3 个 Job 且 mock client 不处理，它们持续 running
	// 这样后续 Job 进入 pending，cancel 可在服务端直接完成
	await api("POST", "/api/jobs", { json: { clientId, type: "exec", payload: { command: "echo" }, timeout: 60000 } });
	await api("POST", "/api/jobs", { json: { clientId, type: "exec", payload: { command: "echo" }, timeout: 60000 } });
	await api("POST", "/api/jobs", { json: { clientId, type: "exec", payload: { command: "echo" }, timeout: 60000 } });

	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { mode: "script", executable: process.execPath, args: ["-"], script: "setTimeout(()=>{},30000)", timeout: 20000 },
		},
	});
	if (res.status !== 201) return fail("exec cancel create", `status ${res.status}`);
	const body = await res.json();
	await sleep(500);
	const cancelRes = await api("POST", `/api/jobs/${body.jobId}/cancel`);
	if (cancelRes.status !== 201) return fail("exec cancel request", `status ${cancelRes.status}`);
	pass("exec cancel", "cancel request accepted");
}

async function testExecScriptQuotes(clientId) {
	const res = await api("POST", "/api/jobs", {
		json: {
			clientId, type: "exec",
			payload: { mode: "script", executable: process.execPath, args: ["-"], script: 'console.log("a\\"b\\"c"); console.log(\'d\\\\e\');', timeout: 10000 },
		},
	});
	if (res.status !== 201) return fail("exec script quotes", `status ${res.status}`);
	await sleep(1500);
	pass("exec script quotes", `jobId=${(await res.json()).jobId}`);
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
	_serverProcess = spawn("pnpm", ["start"], {
		cwd: serverDir,
		stdio: ["ignore", "pipe", "pipe"],
		shell: true,
		env: {
			...process.env,
			VCPDECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
			VCPDECK_FRONTEND_ORIGIN: "http://localhost:5173",
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
		if (_serverProcess?.pid) killTree(_serverProcess.pid);
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
		if (Array.isArray(body)) {
			pass("GET /api/jobs returns array", `length=${body.length}`);
		} else {
			fail("GET /api/jobs returns array", JSON.stringify(body));
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
				totalDiskMB: 10240,
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
			if (clients.length > 0) {
				const c = clients[0];
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
			const realClientId = clients[0]?.clientId;
			if (!realClientId) throw new Error("No clientId from API");

			// Register listener BEFORE creating the job
			const dispatchPromise = new Promise((resolve) => {
				const timer = setTimeout(() => resolve(null), 5000);
				clientSocket.on(Events.JOB_DISPATCH, (data) => {
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

				const { body: jobs } = await apiJson("GET", "/api/jobs");
				const ourJob = jobs.find((j) => j.jobId === dispatchReceived.jobId);
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
			const realClientId = clients[0]?.clientId;
			if (!realClientId) throw new Error("No clientId from API");

			// Register cancel listener first
			const cancelPromise = new Promise((resolve) => {
				const timer = setTimeout(() => resolve(null), 5000);
				clientSocket.on(Events.JOB_CANCEL, (data) => {
					clearTimeout(timer);
					resolve(data);
				});
			});

			// Register dispatch listener for this job
			const dispatchPromise2 = new Promise((resolve) => {
				const timer = setTimeout(() => resolve(null), 5000);
				clientSocket.on(Events.JOB_DISPATCH, (data) => {
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

				const { body: jobs } = await apiJson("GET", "/api/jobs");
				const ourJob = jobs.find((j) => j.jobId === cancelReceived.jobId);
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
			const c = clients[0];
			const before = c.lastHeartbeatAt;

			clientSocket.emit(Events.HEARTBEAT, {
				clientId: c.clientId,
				cpuPercent: 15,
				memPercent: 60,
				diskPercent: 40,
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


	// ── Exec command/script tests ──
	console.log("\n--- Exec Command/Script ---");

	const { body: _clients } = await apiJson("GET", "/api/clients");
	const execClientId = _clients[0]?.clientId;
	if (!execClientId) {
		fail("exec client lookup", "no online client");
	} else {
		await testExecCommandLegacy(execClientId);
		await testExecCommandExplicit(execClientId);
		await testExecCommandCwd(execClientId);
		await testExecScriptNode(execClientId);
		await testExecScriptNodeUnicode(execClientId);
		await testExecScriptQuotes(execClientId);
		await testExecScriptEmptyArgsAndScript(execClientId);
		await testExecInvalidPayloadMixed(execClientId);
		await testExecInvalidPayloadBadTimeout(execClientId);
		await testExecSpawnFailed(execClientId);
		await testExecCancel(execClientId);
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
	.then(() => {
		if (clientSocket) clientSocket.disconnect();
		if (_serverProcess?.pid) killTree(_serverProcess.pid);
		_serverProcess = null;
		killPort();
		process.exit(_exitCode);
	});
