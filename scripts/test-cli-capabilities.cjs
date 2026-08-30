/**
 * VCPDeck CLI 能力端到端集成测试
 *
 * 用法：
 *   pnpm build          # 先构建 server/client/cli
 *   node scripts/test-cli-capabilities.cjs
 *
 * 复用一键测试机制：隔离数据库启动真实 Server（3001 端口）+ 真实 Client，
 * 然后通过 CLI 构建产物（packages/cli/dist/index.js）逐域验证：
 *   clients / jobs（含失败输出闭环）/ files 全套（含 Storage 直传往返）/
 *   frp 只读查询 / storage status / terminal 生命周期 / pi 查询（有 capability 时）
 *
 * 隔离约定（不污染全局）：
 *   - CLI 假 HOME 指向 <repo>/.tmp/cli-e2e/home（配置与凭据引用均在此）
 *   - 本地传输文件位于 <repo>/.tmp/cli-e2e/local/
 *   - 远端测试文件位于授权根下 .tmp/cli-e2e/work/，结束后删除
 *   - 数据库为临时隔离库，结束自动清理
 *
 * 注意：执行前不要让开发 Server 占用 3001 端口。
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
	createIntegrationTestDb,
	initializeIntegrationTestDb,
	cleanupIntegrationTestDb,
} = require("./integration-test-db.cjs");

const isWin = os.platform() === "win32";

// ── Resolve paths ──
const root = path.resolve(__dirname, "..");
const serverDir = path.join(root, "packages", "server");
const clientDir = path.join(root, "packages", "client");
const CLI_ENTRY = path.join(root, "packages", "cli", "dist", "index.js");

// ── Constants ──
const BASE = "http://localhost:3001";
const ADMIN_PASSWORD = "test123";
const REAL_CLIENT_ID = "cli-e2e-client";
// 所有临时物统一放在仓库 .tmp 下
const SANDBOX = path.join(root, ".tmp", "cli-e2e");
const FAKE_HOME = path.join(SANDBOX, "home");
const LOCAL_DIR = path.join(SANDBOX, "local");
// 远端相对路径（相对授权根）
const REMOTE_BASE = ".tmp/cli-e2e/work";

const testDatabase = createIntegrationTestDb();

// ── Test state ──
let _serverProcess = null;
let _realClientProcess = null;
let cookie = "";
let clientId = "";
let testRoot = ""; // 授权根（如 D:\ 或 /）
const results = [];

function pass(name, detail) {
	results.push({ name, status: "PASS", detail: detail ?? "" });
	console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
	results.push({ name, status: "FAIL", detail: detail ?? "" });
	console.log(`  ✗ ${name}: ${detail}`);
}

function skip(name, reason) {
	results.push({ name, status: "SKIP", detail: reason ?? "" });
	console.log(`  ⊘ ${name}: ${reason}`);
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── REST helpers（与 test.cjs 同模式，用于 CLI 无法覆盖的服务端断言） ──
async function api(method, apiPath, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	// noCookie 仅表示不发送既有会话；Set-Cookie 始终捕获（与 test.cjs 同语义）
	if (!opts.noCookie && cookie) headers.Cookie = cookie;
	const payload = opts.body ?? opts.json;
	if (payload) headers["Content-Type"] = "application/json";
	const res = await fetch(`${BASE}${apiPath}`, {
		method,
		headers,
		body: payload ? JSON.stringify(payload) : undefined,
	});
	{
		const setCookie = res.headers.get("set-cookie");
		if (setCookie) cookie = setCookie.split(";")[0];
	}
	return res;
}

async function apiJson(method, apiPath, opts = {}) {
	const res = await api(method, apiPath, opts);
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { status: res.status, body };
}

// ── 进程管理 ──
function killTree(pid) {
	if (isWin) {
		try {
			execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
		} catch {
			/* ignore */
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* ignore */
			}
		}
	}
}

function execFileSync(cmd, args) {
	const { execFileSync: ef } = require("node:child_process");
	return ef(cmd, args, { stdio: "ignore" });
}

function killPort() {
	try {
		if (isWin) {
			const { execSync } = require("node:child_process");
			const out = execSync(
				'netstat -ano | findstr ":3001" | findstr "LISTENING"',
				{ encoding: "utf8" },
			);
			const pids = new Set(
				out
					.split("\n")
					.map((l) => l.trim().split(/\s+/).pop())
					.filter((p) => /^\d+$/.test(p)),
			);
			for (const pid of pids) killTree(Number(pid));
		} else {
			const { execSync } = require("node:child_process");
			const out = execSync("lsof -ti:3001 || true", { encoding: "utf8" });
			for (const pid of out.split("\n").filter(Boolean)) {
				killTree(Number(pid));
			}
		}
	} catch {
		/* port free */
	}
}

function stopRealClient() {
	if (_realClientProcess?.pid) {
		killTree(_realClientProcess.pid);
		_realClientProcess = null;
	}
}

function stopServer() {
	if (_serverProcess?.pid) {
		killTree(_serverProcess.pid);
		_serverProcess = null;
	}
}

function startRealClient() {
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			VCPDECK_CLIENT_ID: REAL_CLIENT_ID,
			VCPDECK_SERVER: BASE,
			VCPDECK_PSK: "vcpdeck-dev-psk",
		};
		_realClientProcess = spawn("node", ["dist/index.js"], {
			cwd: clientDir,
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

// ── CLI 调用助手：假 HOME + 凭据环境变量，全部隔离在沙箱 ──
function cli(args) {
	return new Promise((resolve) => {
		const env = {
			...process.env,
			VCPDECK_E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
		};
		if (isWin) env.USERPROFILE = FAKE_HOME;
		else env.HOME = FAKE_HOME;
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
			cwd: FAKE_HOME,
			env,
			encoding: "utf8",
		});
		let out = "";
		let err = "";
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (err += d));
		child.on("error", (e) => resolve({ code: -1, out, err: `${err}${e}` }));
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

/** 从 CLI 输出中提取 JSON（跳过可能的非 JSON 前缀行）。 */
function parseJsonOutput(text) {
	const startIdx = Math.min(
		...["{", "["].map((c) => {
			const i = text.indexOf(c);
			return i === -1 ? Number.MAX_SAFE_INTEGER : i;
		}),
	);
	if (startIdx === Number.MAX_SAFE_INTEGER) return null;
	try {
		return JSON.parse(text.slice(startIdx));
	} catch {
		return null;
	}
}

// ── 沙箱准备 ──
function prepareSandbox() {
	fs.mkdirSync(FAKE_HOME, { recursive: true });
	fs.mkdirSync(path.join(FAKE_HOME, ".vcpdeck", "cli"), { recursive: true });
	fs.mkdirSync(LOCAL_DIR, { recursive: true });
	const config = {
		version: 1,
		defaultEnvironment: "e2e",
		environments: {
			e2e: {
				server: BASE,
				auth: {
					type: "password",
					username: "admin",
					passwordEnv: "VCPDECK_E2E_ADMIN_PASSWORD",
				},
			},
		},
	};
	fs.writeFileSync(
		path.join(FAKE_HOME, ".vcpdeck", "cli", "config.json"),
		JSON.stringify(config, null, 2),
	);
}

function writeLocalFile(name, buffer) {
	const filePath = path.join(LOCAL_DIR, name);
	fs.writeFileSync(filePath, buffer);
	return filePath;
}

function remotePath(rel) {
	return `${REMOTE_BASE}/${rel}`;
}

// ── 测试组 ──

async function testClientsList() {
	console.log("\n--- clients list ---");
	const { code, out } = await cli(["clients", "list", "--json"]);
	const parsed = parseJsonOutput(out);
	if (code !== 0 || !Array.isArray(parsed)) {
		fail("clients list --json", `code=${code}`);
		return false;
	}
	const row = parsed.find(
		(c) => c.clientId === REAL_CLIENT_ID || c.id === REAL_CLIENT_ID,
	);
	if (!row || row.online !== true) {
		fail("clients list 包含在线测试客户端", JSON.stringify(parsed));
		return false;
	}
	clientId = row.id ?? row.clientId;
	pass("clients list 可见真实客户端且在线", clientId);
	return true;
}

async function testJobsLifecycle() {
	console.log("\n--- jobs run/get/list + 失败输出闭环 ---");

	// 1. 成功任务：node -e 打印标记；退出码 + REST 输出端点双重验证
	{
		const { code, out } = await cli([
			"jobs",
			"run",
			clientId,
			"--wait",
			"--wait-timeout=60",
			"--json",
			"--",
			"node",
			"-e",
			"console.log('hello-vcpdeck-e2e')",
		]);
		if (code !== 0) {
			fail("jobs run --wait 成功任务", `code=${code} out=${out.slice(0, 200)} err=${""}`);
			return;
		}
		pass("jobs run --wait 执行成功", "exit=0");
		const jobIdMatch = out.match(/"jobId"\s*:\s*"([a-f0-9-]+)"/i);
		if (jobIdMatch) {
			const { status, body } = await apiJson(
				"GET",
				`/api/jobs/${jobIdMatch[1]}/output`,
			);
			const text = typeof body === "string" ? body : JSON.stringify(body);
			if (status === 200 && text.includes("hello-vcpdeck-e2e")) {
				pass("成功任务 stdout 留痕可查", "hello-vcpdeck-e2e");
			} else {
				fail("成功任务输出端点", `status=${status} body=${text.slice(0, 150)}`);
			}
		} else {
			skip("成功任务输出端点验证", "输出中未解析到 jobId");
		}
	}

	// 2. 失败任务：非零退出码 + stderr 标记 → 验证输出端点留痕
	let failedJobId = "";
	{
		await cli([
			"jobs",
			"run",
			clientId,
			"--wait",
			"--wait-timeout=60",
			"--json",
			"--",
			"node",
			"-e",
			"console.error('boom-marker-e2e');process.exit(3)",
		]);
		const { code, out, err } = await cli([
			"jobs",
			"list",
			"--client=" + clientId,
			"--status=error",
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const rows = Array.isArray(parsed) ? parsed : (parsed?.data ?? []);
		const row =
			rows.find((j) => String(JSON.stringify(j)).includes("process.exit(3)")) ??
			rows[0];
		if (code !== 0 || !row) {
			fail("jobs list 查到失败任务", `code=${code} out=${out.slice(0, 150)} err=${err.slice(0, 150)}`);
			return;
		}
		failedJobId = row.id ?? row.jobId;
		pass("失败任务出现在 jobs list（status=error）", failedJobId);

		const { status, body } = await apiJson(
			"GET",
			`/api/jobs/${failedJobId}/output`,
		);
		const text = typeof body === "string" ? body : JSON.stringify(body);
		if (status === 200 && text.includes("boom-marker-e2e")) {
			pass("失败输出闭环：GET /api/jobs/:id/output 留痕 stderr", "boom-marker-e2e");
		} else {
			fail(
				"失败输出闭环",
				`status=${status} body=${text.slice(0, 200)}`,
			);
		}
	}

	// 3. jobs get
	{
		const { code, out } = await cli(["jobs", "get", failedJobId, "--json"]);
		const parsed = parseJsonOutput(out);
		if (code === 0 && parsed && (parsed.id ?? parsed.jobId) === failedJobId) {
			pass("jobs get 返回任务详情", failedJobId);
		} else {
			fail("jobs get", `code=${code} out=${out.slice(0, 150)}`);
		}
	}
}

async function testFilesCycle() {
	console.log("\n--- files 写操作全周期 ---");
	const rootArg = `--root=${testRoot}`;

	// mkdir
	{
		const { code } = await cli([
			"files",
			"mkdir",
			clientId,
			remotePath("dir-a/nested"),
			rootArg,
			"--json",
		]);
		if (code === 0) pass("files mkdir 递归创建");
		else fail("files mkdir", `code=${code}`);
	}

	// write（含中文多字节内容）
	const content = "vcpdeck e2e 内容 ✓ 中文\nline2\n";
	{
		const input = writeLocalFile("payload.txt", Buffer.from(content, "utf8"));
		const { code, err } = await cli([
			"files",
			"write",
			clientId,
			remotePath("dir-a/hello.txt"),
			rootArg,
			`--input=${input}`,
			"--json",
		]);
		if (code === 0) pass("files write 覆盖写（--input 文件）");
		else fail("files write", `code=${code} ${err.slice(0, 120)}`);
	}

	// read 回读一致
	{
		const { code, out } = await cli([
			"files",
			"read",
			clientId,
			remotePath("dir-a/hello.txt"),
			rootArg,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const text = parsed?.content ?? "";
		if (code === 0 && text === content) {
			pass("files read 内容一致（含中文）");
		} else {
			fail("files read 内容不一致", `code=${code} got=${String(text).slice(0, 80)}`);
		}
	}

	// stat
	{
		const { code, out } = await cli([
			"files",
			"stat",
			clientId,
			remotePath("dir-a/hello.txt"),
			rootArg,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		if (code === 0 && parsed && Number(parsed.size) === Buffer.byteLength(content)) {
			pass("files stat 大小正确", `size=${parsed.size}`);
		} else {
			fail("files stat", `code=${code} out=${out.slice(0, 150)}`);
		}
	}

	// list
	{
		const { code, out } = await cli([
			"files",
			"list",
			clientId,
			remotePath("dir-a"),
			rootArg,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const rows = Array.isArray(parsed)
			? parsed
			: (parsed?.entries ?? parsed?.data ?? []);
		const found = rows.some((e) => String(e.name ?? "").includes("hello.txt"));
		if (code === 0 && found) pass("files list 可见写入文件");
		else fail("files list", `code=${code} out=${out.slice(0, 200)}`);
	}

	// move
	{
		const { code } = await cli([
			"files",
			"move",
			clientId,
			remotePath("dir-a/hello.txt"),
			remotePath("dir-a/nested/moved.txt"),
			rootArg,
			"--json",
		]);
		if (code === 0) pass("files move 重命名成功");
		else fail("files move", `code=${code}`);

		const { code: code2 } = await cli([
			"files",
			"read",
			clientId,
			remotePath("dir-a/nested/moved.txt"),
			rootArg,
			"--json",
		]);
		if (code2 === 0) pass("move 后可读取新路径");
		else fail("move 后读取", `code=${code2}`);
	}

	// delete
	{
		const { code } = await cli([
			"files",
			"delete",
			clientId,
			remotePath("dir-a"),
			rootArg,
			"--recursive",
			"--json",
		]);
		if (code === 0) pass("files delete --recursive 清理目录");
		else fail("files delete", `code=${code}`);

		const { code: code2 } = await cli([
			"files",
			"stat",
			clientId,
			remotePath("dir-a"),
			rootArg,
			"--json",
		]);
		if (code2 !== 0) pass("删除后 stat 报告不存在（fail closed）");
		else fail("删除后仍可 stat", "预期失败但成功了");
	}
}

async function testFileTransferRoundtrip() {
	console.log("\n--- files upload/download 直传往返 ---");
	const rootArg = `--root=${testRoot}`;
	const size = 256 * 1024 + 137; // 非 4K 对齐，覆盖分片边界
	const payload = crypto.randomBytes(size);
	const localUp = writeLocalFile("upload-bin.dat", payload);

	// upload
	{
		const { code, err } = await cli([
			"files",
			"upload",
			clientId,
			localUp,
			remotePath("uploaded.bin"),
			rootArg,
			"--overwrite",
			"--json",
		]);
		if (code === 0) pass("files upload 上传二进制", `${size} bytes`);
		else {
			fail("files upload", `code=${code} ${err.slice(0, 160)}`);
			return;
		}
	}

	// download 回来比对字节
	{
		const localDown = path.join(LOCAL_DIR, "downloaded.bin");
		const { code, err } = await cli([
			"files",
			"download",
			clientId,
			remotePath("uploaded.bin"),
			localDown,
			rootArg,
			"--json",
		]);
		if (code !== 0) {
			fail("files download", `code=${code} ${err.slice(0, 160)}`);
			return;
		}
		const back = fs.readFileSync(localDown);
		if (back.equals(payload)) {
			pass("download 字节级一致", `${back.length} bytes`);
		} else {
			fail("download 内容不一致", `local=${back.length} vs remote=${size}`);
		}
	}

	// 再次 overwrite 上传后大小变化生效
	{
		const small = crypto.randomBytes(1024);
		const localSmall = writeLocalFile("small.bin", small);
		await cli([
			"files",
			"upload",
			clientId,
			localSmall,
			remotePath("uploaded.bin"),
			rootArg,
			"--overwrite",
			"--json",
		]);
		const { code, out } = await cli([
			"files",
			"stat",
			clientId,
			remotePath("uploaded.bin"),
			rootArg,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		if (code === 0 && Number(parsed?.size) === 1024) {
			pass("--overwrite 覆盖上传生效", "size=1024");
		} else {
			fail("--overwrite 上传", `code=${code} size=${parsed?.size}`);
		}
	}

	// 清理远端
	await cli([
		"files",
		"delete",
		clientId,
		remotePath("uploaded.bin"),
		rootArg,
		"--json",
	]);
}

async function testReadonlyQueries() {
	console.log("\n--- frp / storage 只读查询 ---");
	{
		const { code, out } = await cli(["frp", "instances", "--json"]);
		const parsed = parseJsonOutput(out);
		const rows = Array.isArray(parsed) ? parsed : parsed?.data;
		const paginated =
			rows !== undefined &&
			(parsed?.total !== undefined || Array.isArray(parsed));
		if (code === 0 && paginated) {
			pass("frp instances 分页结构正常", `total=${parsed.total ?? rows.length}`);
		} else {
			fail("frp instances", `code=${code} out=${out.slice(0, 150)}`);
		}
	}
	{
		const { code, out } = await cli(["frp", "mappings", "--json"]);
		const parsed = parseJsonOutput(out);
		const rows = Array.isArray(parsed) ? parsed : parsed?.data;
		if (code === 0 && rows !== undefined) {
			pass("frp mappings 查询正常", `rows=${Array.isArray(rows) ? rows.length : "?"}`);
		} else {
			fail("frp mappings", `code=${code} out=${out.slice(0, 150)}`);
		}
	}
	{
		const { code, out } = await cli(["storage", "status", "--json"]);
		const parsed = parseJsonOutput(out);
		if (code === 0 && parsed && typeof parsed === "object") {
			pass("storage status 查询正常");
		} else {
			fail("storage status", `code=${code} out=${out.slice(0, 150)}`);
		}
	}
}

async function testTerminalLifecycle(hasPty) {
	console.log("\n--- terminal 生命周期 ---");
	if (!hasPty) {
		skip("terminal shells/list/close", "客户端无 terminal.pty capability");
		return;
	}
	{
		const { code, out, err } = await cli([
			"terminal",
			"shells",
			clientId,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const shells = Array.isArray(parsed) ? parsed : parsed?.shells;
		if (code === 0 && Array.isArray(shells) && shells.length > 0) {
			pass("terminal shells 探测到 Shell", `${shells.length} 个`);
		} else {
			fail("terminal shells", `code=${code} err=${err.slice(0, 160)}`);
			return;
		}
	}
	{
		const { code, out, err } = await cli([
			"terminal",
			"new",
			clientId,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const newSessionId = parsed?.sessionId;
		if (code !== 0 || !newSessionId) {
			fail("terminal new 创建会话", `code=${code} err=${err.slice(0, 160)}`);
			return;
		}
		pass("terminal new 创建会话并返回 sessionId", newSessionId);
		const closed = await cli([
			"terminal",
			"close",
			clientId,
			newSessionId,
			"--json",
		]);
		if (closed.code === 0) pass("terminal close 关闭新建会话（生命周期闭环）");
		else fail("terminal close 新建会话", `code=${closed.code}`);
	}
	{
		const { code, out } = await cli([
			"terminal",
			"list",
			clientId,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const rows = Array.isArray(parsed) ? parsed : parsed?.sessions;
		if (code === 0 && Array.isArray(rows)) {
			pass("terminal list 会话查询正常", `${rows.length} 个会话`);
		} else {
			fail("terminal list", `code=${code} out=${out.slice(0, 150)}`);
		}
	}
	{
		const { code } = await cli([
			"terminal",
			"close",
			clientId,
			"nonexistent-session-e2e",
			"--json",
		]);
		if (code !== 0) {
			pass("terminal close 不存在会话干净报错（非零退出）");
		} else {
			fail("terminal close 不存在会话", "预期失败但退出码为 0");
		}
	}
}

async function testPiQueries(hasPi) {
	console.log("\n--- pi 查询（models/sessions） ---");
	if (!hasPi) {
		skip("pi models/sessions", "客户端无 agent.pi capability（未安装 pi CLI）");
		return;
	}
	{
		const { code, out, err } = await cli([
			"pi",
			"models",
			clientId,
			`--root=${testRoot}`,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		if (code === 0 && (Array.isArray(parsed) || parsed?.models)) {
			pass("pi models 查询正常");
		} else {
			fail("pi models", `code=${code} err=${err.slice(0, 120)}`);
		}
	}
	{
		const { code, out, err } = await cli([
			"pi",
			"sessions",
			clientId,
			`--root=${testRoot}`,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const rows =
			Array.isArray(parsed) ? parsed : (parsed?.data ?? parsed?.sessions);
		if (code === 0 && rows !== undefined) {
			pass("pi sessions 查询正常", `${Array.isArray(rows) ? rows.length : "?"} 个`);
		} else {
			fail("pi sessions", `code=${code} err=${err.slice(0, 120)}`);
		}
	}
}

async function testErrorPaths() {
	console.log("\n--- 错误路径 ---");
	{
		const rootArg = `--root=${testRoot}`;
		const { code, out, err } = await cli([
			"files",
			"read",
			clientId,
			remotePath("definitely-not-exists-e2e.txt"),
			rootArg,
			"--json",
		]);
		const combined = out + err;
		if (code !== 0 && !/\n\s+at /.test(combined) && combined.length > 0) {
			pass("读取不存在文件：非零退出且无堆栈泄漏");
		} else {
			fail("错误路径", `code=${code} out=${combined.slice(0, 150)}`);
		}
	}
	{
		const { code } = await cli(["clients", "list", "--env=no-such-env-e2e"]);
		if (code !== 0) {
			pass("未知环境名 fail closed");
		} else {
			fail("未知环境名", "预期失败但退出码为 0");
		}
	}
}

// ── 主流程 ──
async function main() {
	console.log("\n=== VCPDeck CLI Capabilities E2E ===\n");

	// 前置检查：构建产物存在
	for (const [label, p] of [
		["server", path.join(serverDir, "dist")],
		["client", path.join(clientDir, "dist")],
		["cli", CLI_ENTRY],
	]) {
		if (!fs.existsSync(p)) {
			console.error(`[setup] 缺少 ${label} 构建产物（${p}），请先运行 pnpm build`);
			done(1);
			return;
		}
	}

	killPort();
	await sleep(1000);

	// 1. 初始化隔离数据库，然后直接启动 Server 构建产物。
	console.log("[setup] Starting server...");
	initializeIntegrationTestDb(testDatabase, serverDir);
	_serverProcess = spawn(process.execPath, ["dist/main.js"], {
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
	_serverProcess.stdout.on("data", (d) => (serverOutput += d.toString()));
	_serverProcess.stderr.on("data", (d) => (serverOutput += d.toString()));

	let serverReady = false;
	for (let i = 0; i < 30; i++) {
		await sleep(1000);
		if (serverOutput.includes("listening on")) {
			serverReady = true;
			break;
		}
	}
	if (!serverReady) {
		console.error("[setup] Server 启动失败");
		console.error(serverOutput.slice(-2000));
		done(1);
		return;
	}
	console.log("  ✓ Server started\n");

	// 2. 登录（供服务端断言用）
	{
		const { status, body } = await apiJson("POST", "/api/auth/login", {
			json: { username: "admin", password: ADMIN_PASSWORD },
			noCookie: true,
		});
		if ((status === 200 || status === 201) && body?.identity?.isAdmin) {
			pass("Admin 登录", "cookie 已建立");
		} else {
			fail("Admin 登录", `status=${status} body=${JSON.stringify(body).slice(0, 200)}`);
			done(1);
			return;
		}
	}

	// 3. 启动真实 Client 并等待注册
	console.log("[setup] Starting real client...");
	try {
		await startRealClient();
		console.log("  ✓ Client started\n");
	} catch (e) {
		fail("Client 启动", String(e));
		done(1);
		return;
	}

	let registered = false;
	for (let i = 0; i < 20; i++) {
		const { status, body } = await apiJson("GET", "/api/clients");
		if (status === 200 && Array.isArray(body)) {
			const row = body.find(
				(c) => c.clientId === REAL_CLIENT_ID || c.id === REAL_CLIENT_ID,
			);
			if (row) {
				registered = true;
				break;
			}
		}
		await sleep(1000);
	}
	if (!registered) {
		fail("Client 注册", "30 秒内未在 Server 注册");
		done(1);
		return;
	}
	pass("Client 已注册", REAL_CLIENT_ID);

	// 4. 准备 CLI 沙箱（假 HOME + 密码环境配置）
	prepareSandbox();

	// 5. clients list 确定 clientId 与能力
	if (!(await testClientsList())) {
		done(1);
		return;
	}

	// 6. 确定授权根：优先选择与仓库同盘符的根；否则取第一个
	{
		const { code, out } = await cli([
			"files",
			"roots",
			clientId,
			"--json",
		]);
		const parsed = parseJsonOutput(out);
		const roots = Array.isArray(parsed)
			? parsed
			: (parsed?.roots ?? []).map((r) => r.path ?? r);
		if (code !== 0 || !Array.isArray(roots) || roots.length === 0) {
			fail("files roots", `code=${code} out=${out.slice(0, 200)}`);
			done(1);
			return;
		}
		const repoDrive = root.slice(0, 2).toLowerCase(); // 如 "d:"
		testRoot =
			roots.find((r) => r.toLowerCase().slice(0, 2) === repoDrive) ?? roots[0];
		pass("授权根确定", testRoot);
	}

	// 7. 客户端能力
	const { body: clientsBody } = await apiJson("GET", "/api/clients");
	const meRow = (clientsBody ?? []).find(
		(c) => (c.id ?? c.clientId) === clientId,
	);
	const caps = meRow?.capabilities ?? [];
	const hasPi = caps.includes("agent.pi");
	const hasPty = caps.includes("terminal.pty");

	// 8. 逐组执行
	await testJobsLifecycle();
	await testFilesCycle();
	await testFileTransferRoundtrip();
	await testReadonlyQueries();
	await testTerminalLifecycle(hasPty);
	await testPiQueries(hasPi);
	await testErrorPaths();

	// 9. 清理远端工作目录（尽力而为）
	await cli([
		"files",
		"delete",
		clientId,
		REMOTE_BASE,
		`--root=${testRoot}`,
		"--recursive",
		"--json",
	]);

	done(0);
}

async function done(exitCode) {
	stopRealClient();
	stopServer();
	await sleep(500);
	killPort();
	try {
		cleanupIntegrationTestDb(testDatabase);
	} catch {
		/* ignore */
	}
	try {
		fs.rmSync(SANDBOX, { recursive: true, force: true });
	} catch {
		/* ignore */
	}

	console.log("\n=== 测试报告 ===");
	const passed = results.filter((r) => r.status === "PASS").length;
	const failed = results.filter((r) => r.status === "FAIL").length;
	const skipped = results.filter((r) => r.status === "SKIP").length;
	for (const r of results) {
		const mark = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "⊘";
		console.log(`${mark} [${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
	}
	console.log(
		`\n总计: ${results.length} | 通过 ${passed} | 失败 ${failed} | 跳过 ${skipped}`,
	);
	process.exit(failed > 0 ? 1 : exitCode);
}

main().catch(async (e) => {
	console.error("[fatal]", e);
	await done(1);
});
