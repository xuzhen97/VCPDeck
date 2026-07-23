/**
 * VCPDeck 端到端集成测试
 *
 * 用法：
 *   node scripts/test.cjs
 *
 * 自动启动 server，连接 mock client，逐个验证所有功能点。
 * 测试完成后自动清理，输出测试报告。
 */

const { spawn } = require("node:child_process");
const path = require("node:path");


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

// ── Test state ──
const BASE = "http://localhost:3001";
const PSK = "vcpdeck-dev-psk";
let clientSocket;
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

function fetchJson(url, opts) {
  return fetch(url, opts).then((r) => r.json());
}

// ── Main ──
async function main() {
  console.log("\n=== VCPDeck Integration Test ===\n");

  // 1. Start server
  console.log("[setup] Starting server...");
  const server = spawn("pnpm", ["start"], {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  let serverOutput = "";
  server.stdout.on("data", (d) => {
    serverOutput += d.toString();
  });
  server.stderr.on("data", (d) => {
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
    server.kill();
    process.exit(1);
  }
  console.log("  ✓ Server started\n");

  // ─────────────────────────────
  // Test: REST endpoints (empty state)
  // ─────────────────────────────
  console.log("--- REST endpoints (empty state) ---");

  try {
    const clients = await fetchJson(`${BASE}/api/clients`);
    if (Array.isArray(clients)) {
      pass("GET /api/clients returns array", `length=${clients.length}`);
    } else {
      fail("GET /api/clients returns array", JSON.stringify(clients));
    }
  } catch (e) {
    fail("GET /api/clients", e.message);
  }

  try {
    const jobs = await fetchJson(`${BASE}/api/jobs`);
    if (Array.isArray(jobs)) {
      pass("GET /api/jobs returns array", `length=${jobs.length}`);
    } else {
      fail("GET /api/jobs returns array", JSON.stringify(jobs));
    }
  } catch (e) {
    fail("GET /api/jobs", e.message);
  }

  // ─────────────────────────────
  // Test: Client connection + register
  // ─────────────────────────────
  console.log("\n--- Client connection ---");

  let clientId = null;
  try {
    clientSocket = io(BASE, { auth: { psk: PSK } });
    await new Promise((resolve, reject) => {
      clientSocket.on("connect", resolve);
      clientSocket.on("connect_error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });
    pass("Socket.IO connects", clientSocket.id);

    // Register
    const hostname = require("node:os").hostname();
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
      const clients = await fetchJson(`${BASE}/api/clients`);
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
      const realClientId = (await fetchJson(`${BASE}/api/clients`))[0]?.clientId;
      if (!realClientId) throw new Error("No clientId from API");

      // Register listener BEFORE creating the job
      const dispatchPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        clientSocket.on(Events.JOB_DISPATCH, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
      });

      const job = await fetchJson(`${BASE}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: realClientId,
          command: "echo hello world",
        }),
      });

      if (!job.jobId) throw new Error("Job not created");
      pass("POST /api/jobs creates job", `jobId=${job.jobId.slice(0, 8)}..., status=${job.status}`);

      const dispatchReceived = await dispatchPromise;

      if (dispatchReceived) {
        pass("Client receives job:dispatch", `command=${dispatchReceived.command}`);

        clientSocket.emit(Events.JOB_STDOUT, { jobId: dispatchReceived.jobId, text: "hello world\n" });
        clientSocket.emit(Events.JOB_DONE, { jobId: dispatchReceived.jobId, exitCode: 0 });

        await sleep(500);

        const jobs = await fetchJson(`${BASE}/api/jobs`);
        const ourJob = jobs.find((j) => j.jobId === dispatchReceived.jobId);
        if (ourJob && ourJob.status === "done") {
          pass("Job completes", `status=${ourJob.status}`);
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
      const realClientId = (await fetchJson(`${BASE}/api/clients`))[0]?.clientId;
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

      const job = await fetchJson(`${BASE}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: realClientId, command: "sleep 60" }),
      });

      if (!job.jobId) throw new Error("Job not created");

      // Wait for dispatch to arrive
      await dispatchPromise2;

      const cancelResult = await fetchJson(`${BASE}/api/jobs/${job.jobId}/cancel`, {
        method: "POST",
      });

      if (cancelResult.status === "cancelling") {
        pass("Cancel request accepted", `status=${cancelResult.status}`);
      } else {
        fail("Cancel request", JSON.stringify(cancelResult));
      }

      const cancelReceived = await cancelPromise;

      if (cancelReceived) {
        pass("Client receives job:cancel", `jobId=${cancelReceived.jobId}`);

        clientSocket.emit(Events.JOB_CANCELLED, { jobId: cancelReceived.jobId });
        await sleep(500);

        const jobs = await fetchJson(`${BASE}/api/jobs`);
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
      const clients = await fetchJson(`${BASE}/api/clients`);
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

      const clients2 = await fetchJson(`${BASE}/api/clients`);
      const c2 = clients2[0];
      if (c2.lastHeartbeatAt && c2.lastHeartbeatAt !== before) {
        pass("Heartbeat updates lastHeartbeatAt", c2.lastHeartbeatAt);
      } else {
        fail("Heartbeat not recorded", `before=${before} after=${c2.lastHeartbeatAt}`);
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
    const res = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "nonexistent-client",
        command: "echo bad",
      }),
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

  // ─────────────────────────────
  // Cleanup
  // ─────────────────────────────
  console.log("\n--- Cleanup ---");
  if (clientSocket) clientSocket.disconnect();
  server.kill("SIGTERM");
  // Force kill after 2s
  const killTimer = setTimeout(() => {
    try { server.kill("SIGKILL"); } catch {}
  }, 2000);
  server.on("close", () => clearTimeout(killTimer));
  console.log("  ✓ Server stopped\n");

  // Global test timeout
  const testTimeout = setTimeout(() => {
    console.error("Test timed out — force exit");
    try { server.kill("SIGKILL"); } catch {}
    process.exit(1);
  }, 45_000);
  // Let main() clear it on success
  const origExit = process.exit;
  process.exit = (code) => {
    clearTimeout(testTimeout);
    origExit(code);
  };

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

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test error:", err.message);
  process.exit(1);
});
