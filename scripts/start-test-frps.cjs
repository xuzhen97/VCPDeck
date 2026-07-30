#!/usr/bin/env node
/**
 * 本地 frps 测试实例启动脚本
 *
 * 一键启动一个带 Dashboard 的 frps 实例用于开发测试。
 *
 * 用法：
 *   node scripts/start-test-frps.cjs                    # 默认端口
 *   node scripts/start-test-frps.cjs --port=17000       # 自定义 bindPort
 *   node scripts/start-test-frps.cjs --dashboard-port=17500
 *   node scripts/start-test-frps.cjs --token=my-token
 *   node scripts/start-test-frps.cjs --clean            # 退出时清理临时文件
 *   node scripts/start-test-frps.cjs --bg               # 后台静默运行
 *
 * 环境变量覆盖：
 *   FRPS_BIN=packages/server/dist/frp/win-x64/frps.exe
 *   FRPS_PORT=17000
 *   FRPS_TOKEN=my-token
 *   FRPS_DASHBOARD_PORT=17500
 *
 * 停止：Ctrl+C 或 kill 进程。
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// ── Parse args ──
const args = process.argv.slice(2);
const parseArg = (name, fallback) => {
	const arg = args.find((a) => a.startsWith(`${name}=`));
	return arg
		? arg.split("=")[1]
		: process.env[name.replace(/^--/, "").toUpperCase().replace(/-/g, "_")] ||
			fallback;
};

const isWin = os.platform() === "win32";
const platform = `${os.platform().replace("win32", "win")}-${os.arch()}`;

// ── Config ──
const BIND_PORT = parseInt(parseArg("--port", "17000"), 10);
const DASHBOARD_PORT = parseInt(parseArg("--dashboard-port", "17500"), 10);
const TOKEN = parseArg("--token", "test-frp-token");
const CLEAN = args.includes("--clean");
const BG = args.includes("--bg");

const ROOT = path.resolve(__dirname, "..");
const FRPS_BIN =
	process.env.FRPS_BIN ||
	path.join(ROOT, "packages", "server", "dist", "frp", platform, isWin ? "frps.exe" : "frps");
const TMP_DIR = path.join(ROOT, ".tmp", "test-frps");
const CONFIG_PATH = path.join(TMP_DIR, "frps.toml");
const LOG_PATH = path.join(TMP_DIR, "frps.log");

// ── Generate frps.toml（key 格式对应 frp v0.61+） ──
function writeConfig() {
	fs.mkdirSync(TMP_DIR, { recursive: true });

	const lines = [
		`bindPort = ${BIND_PORT}`,
		``,
		`auth.method = "token"`,
		`auth.token = "${TOKEN}"`,
		``,
		`webServer.addr = "0.0.0.0"`,
		`webServer.port = ${DASHBOARD_PORT}`,
		`webServer.user = "admin"`,
		`webServer.password = "admin"`,
		``,
		`log.to = "${LOG_PATH.replace(/\\/g, "/")}"`,
		`log.level = "info"`,
		`log.maxDays = 1`,
		``,
	];

	fs.writeFileSync(CONFIG_PATH, lines.join("\n"), "utf-8");
	console.log(`  config: ${CONFIG_PATH}`);
}

// ── Validate binary ──
if (!fs.existsSync(FRPS_BIN)) {
	console.error(`[start-test-frps] 找不到 frps 二进制: ${FRPS_BIN}`);
	console.error("  请先运行: node scripts/download-frp.ts");
	process.exit(1);
}

// ── Start frps ──
writeConfig();

const frps = spawn(FRPS_BIN, ["-c", CONFIG_PATH], {
	cwd: TMP_DIR,
	stdio: BG ? "ignore" : "inherit",
});

frps.on("error", (err) => {
	console.error(`[start-test-frps] 启动失败: ${err.message}`);
	process.exit(1);
});

frps.on("exit", (code) => {
	if (code !== null && CLEAN) {
		try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
	}
});

// ── Print info ──
const info = [
	"",
	"┌──────────────────────────────────────────────┐",
	"│          FRPS 测试实例已启动                 │",
	"├──────────────────────────────────────────────┤",
	`│  bindPort:      ${String(BIND_PORT).padEnd(30)}│`,
	`│  auth.token:    ${TOKEN.padEnd(30)}│`,
	`│  Dashboard:     http://127.0.0.1:${String(DASHBOARD_PORT).padEnd(19)}│`,
	`│  Dashboard 登录: admin / admin               │`,
	`│  log:           ${LOG_PATH.padEnd(30)}│`,
	"├──────────────────────────────────────────────┤",
	`│  配合 VCPDeck 测试:                          │`,
	`│  POST /api/frp/instances -d '{...}'          │`,
	`│  POST /api/frp/instances/:id/probe           │`,
	"├──────────────────────────────────────────────┤",
	"│  停止: Ctrl+C                                │",
	"└──────────────────────────────────────────────┘",
	"",
].join("\n");

console.log(info);

// ── Cleanup on exit ──
if (CLEAN) {
	const cleanup = () => {
		console.log("\n  [start-test-frps] 正在清理...");
		frps.kill("SIGTERM");
		setTimeout(() => {
			try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
			process.exit(0);
		}, 500);
	};
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
}

// ── 后台模式 ──
if (BG) {
	console.log(`  PID: ${frps.pid}`);
	console.log(`  frps 已在后台运行。`);
}

// ── 前台模式提示 ──
if (!BG) {
	setTimeout(() => {
		console.log("\n  输入 Ctrl+C 停止 frps");
	}, 100);
}
