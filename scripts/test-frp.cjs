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
const platform = `${os.platform()}-${os.arch()}`;
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
let clientSocket;
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
        stdio: "ignore", timeout: 3000, shell: true,
      });
    }
  } catch { /* nothing */ }
}

function killTree(pid) {
  try {
    if (isWin) {
      execSync(`taskkill /F /T /PID ${pid}`, {
        stdio: "ignore", timeout: 3000, shell: true,
      });
    } else {
      execSync(`pkill -P ${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null`, {
        stdio: "ignore", timeout: 3000, shell: true,
      });
    }
  } catch { /* already dead */ }
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

// ── Wait for JOB_UPDATE ──
function waitForJobUpdate(jobId, timeoutMs = 20000) {
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

function findBinary(dir, name) {
  const p = path.join(dir, name);
  if (fs.existsSync(p)) return p;
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
    `log.to = "${path.join(TMP_DIR, "frps.log").replace(/\\/g, "/")}"`,
    `log.level = "info"`,
    `log.maxDays = 1`,
  ].join("\n");
  fs.writeFileSync(tomlPath, toml);

  _frpsProcess = spawn(frpsPath, ["-c", tomlPath], {
    cwd: TMP_DIR,
    stdio: "pipe",
  });

  _frpsProcess.stderr?.on("data", (d) => {
    // frps logs to stderr
  });
  _frpsProcess.on("exit", (code) => {
    console.log(`  [frps] exited with code ${code}`);
  });
}

async function waitForFrps() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await frpsApi("/api/health");
      if (res.ok) return true;
    } catch { /* not ready */ }
    await sleep(1000);
  }
  return false;
}

// ── Start VCPDeck Server ──
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
  return new Promise((resolve) => {
    const onData = (d) => {
      const text = d.toString();
      if (text.includes("listening on")) {
        _serverProcess.stdout?.off("data", onData);
        _serverProcess.stderr?.off("data", onData);
        resolve();
      }
    };
    _serverProcess.stdout?.on("data", onData);
    _serverProcess.stderr?.on("data", onData);
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
    const onData = (chunk) => {
      const text = chunk.toString();
      if (!started && (text.includes("connected as") || text.includes("registered"))) {
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
    return fail("POST create tcp mapping", `status=${res.status} ${err.slice(0, 200)}`);
  }
  const mapping = await res.json();
  if (!mapping.id || !mapping.publicUrl) {
    return fail("POST create tcp mapping", `missing fields: ${JSON.stringify(mapping)}`);
  }
  if (mapping.status !== "inactive") {
    return fail("POST create tcp mapping", `expected inactive, got ${mapping.status}`);
  }
  pass("POST create tcp mapping", `id=${mapping.id.slice(0, 8)} url=${mapping.publicUrl} status=${mapping.status}`);
  return mapping;
}

async function testWaitActive(mappingId) {
  // The real client should receive frp.create and start frpc
  // Wait for status to become active via job:update
  for (let i = 0; i < 15; i++) {
    const { status, body } = await apiJson("GET", `/api/frp/mappings/${mappingId}`);
    if (status === 200 && body?.status === "active") {
      pass("Mapping becomes active", `id=${mappingId.slice(0, 8)} status=active`);
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
    },
  });
  if (res.status !== 201) {
    const err = await res.text().catch(() => "");
    return fail("POST create http mapping", `status=${res.status} ${err.slice(0, 200)}`);
  }
  const mapping = await res.json();
  if (!mapping.publicUrl || !mapping.publicUrl.startsWith("http://")) {
    return fail("POST create http mapping", `bad url: ${mapping.publicUrl}`);
  }
  pass("POST create http mapping", `id=${mapping.id.slice(0, 8)} url=${mapping.publicUrl}`);
  return mapping;
}

async function testListMappings(clientId, expectedMin) {
  const { status, body } = await apiJson("GET", `/api/frp/mappings?clientId=${clientId}`);
  if (status !== 200 || !Array.isArray(body)) {
    return fail("GET list mappings", `status=${status}`);
  }
  if (body.length < expectedMin) {
    return fail("GET list mappings", `expected >=${expectedMin}, got ${body.length}`);
  }
  pass("GET list mappings", `${body.length} mappings`);
  return body;
}

async function testGetMapping(mappingId) {
  const { status, body } = await apiJson("GET", `/api/frp/mappings/${mappingId}`);
  if (status !== 200 || body.id !== mappingId) {
    return fail("GET single mapping", `status=${status}`);
  }
  pass("GET single mapping", `id=${body.id.slice(0, 8)} name=${body.name} type=${body.proxyType}`);
  return body;
}

async function testDeleteMapping(mappingId) {
  const { status, body } = await apiJson("DELETE", `/api/frp/mappings/${mappingId}`);
  if (status !== 200 || !body?.deleted) {
    return fail("DELETE mapping", `status=${status} body=${JSON.stringify(body)}`);
  }
  pass("DELETE mapping", `id=${mappingId.slice(0, 8)} deleted=true`);

  // Verify it's gone
  const getRes = await apiJson("GET", `/api/frp/mappings/${mappingId}`);
  if (getRes.status === 400) {
    pass("DELETE mapping: verify gone", "404/400 as expected");
  } else {
    fail("DELETE mapping: verify gone", `expected 400, got ${getRes.status}`);
  }
}

async function testFrpsDashboardProxyCheck(proxyType, proxyName) {
  // Wait a bit for frpc to register with frps
  await sleep(3000);
  try {
    const res = await frpsApi(`/api/proxy/${proxyType}/${encodeURIComponent(proxyName)}`);
    if (res.ok) {
      pass(`frps Dashboard: proxy ${proxyName} registered`, `${proxyType} proxy found`);
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
    const res = await frpsApi(`/api/proxy/${proxyType}/${encodeURIComponent(proxyName)}`);
    if (res.status === 404) {
      pass(`frps Dashboard: proxy ${proxyName} removed`, "404 as expected");
      return true;
    }
    fail(`frps Dashboard: proxy ${proxyName}`, `expected 404, got ${res.status}`);
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
        totalDiskMB: 10240,
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
      if (body.message?.includes("FRP") || body.message?.includes("frp") || body.message?.includes("能力")) {
        return pass("No-frp-capability rejection", "400 with clear error");
      }
      return fail("No-frp-capability rejection", `error not about FRP: ${body.message}`);
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
    fail("Missing required fields rejection", `expected 400, got ${res.status}`);
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

  const frpcDir = path.join(root, "packages", "client", "dist", "frp", platform);
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
  const frpClient = clientList.find((c) => c.capabilities?.includes?.("frp") && c.online);
  pass("Client registered with frp", `id=${frpClient.clientId} caps=${frpClient.capabilities.join(",")}`);

  // Connect monitor socket for JOB_UPDATE listening
  clientSocket = io(`${BASE}/client`, { auth: { psk: PSK } });

  // ── Test: TCP mapping ──
  console.log("\n--- Create TCP mapping ---");
  const tcpMapping = await testCreateTcpMapping(frpClient.clientId);
  if (!tcpMapping) { process.exit(1); }
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

  // ── Cleanup ──
  console.log("\n--- Cleanup ---");
  stopRealClient();
  if (_frpsProcess) {
    killTree(_frpsProcess.pid);
    _frpsProcess = null;
  }
  await sleep(1000);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  pass("Cleanup complete", "tmp files removed");

  // ── Report ──
  console.log(`\n=== Test Report ===\n`);
  let passed = 0, failed = 0, skipped = 0;
  for (const r of results) {
    if (r.status === "PASS") passed++;
    if (r.status === "FAIL") failed++;
    if (r.status === "SKIP") skipped++;
    if (r.status !== "PASS") {
      const icon = r.status === "SKIP" ? `-  ${r.name}` : `✗  ${r.name}`;
      console.log(`  ${icon}\n     ${r.detail}`);
    }
  }
  console.log(`\n  ${passed}/${results.length} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) process.exit(1);
}

// ── Entry ──
main().catch((err) => {
  console.error("Test harness error:", err);
  // Cleanup
  stopRealClient();
  if (_frpsProcess) killTree(_frpsProcess.pid);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
