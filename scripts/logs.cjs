/**
 * VCPDeck 实时 job 日志查看器
 *
 * 用法：
 *   node scripts/logs.cjs [jobId]
 *
 * 不带 jobId 显示所有 job 的实时输出，带 jobId 只显示指定 job。
 */

const path = require("node:path");

const clientDir = path.resolve(__dirname, "..", "packages/client");
const { io } = require(
	path.join(clientDir, "node_modules", "socket.io-client"),
);
const { Events } = require(
	path.join(clientDir, "node_modules", "@vcpdeck", "shared"),
);

const SERVER = process.env.VCPDECK_SERVER || "http://localhost:3001";
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";
const filterJobId = process.argv[2];

const socket = io(SERVER, { auth: { psk: PSK } });

socket.on("connect", () => {
	console.log(`[logs] connected to ${SERVER}`);
	if (filterJobId) {
		console.log(`[logs] watching job: ${filterJobId}`);
	} else {
		console.log("[logs] watching all jobs");
	}
	console.log("[logs] waiting for output...\n");
});

socket.on(Events.JOB_STDOUT, (data) => {
	if (!filterJobId || data.jobId === filterJobId) {
		process.stdout.write(data.text);
	}
});

socket.on(Events.JOB_STDERR, (data) => {
	if (!filterJobId || data.jobId === filterJobId) {
		process.stderr.write(data.text);
	}
});

socket.on(Events.JOB_UPDATE, (data) => {
	if (!filterJobId || data.jobId === filterJobId) {
		const ex = data.exitCode != null ? ` exitCode=${data.exitCode}` : "";
		console.log(
			`\n[job:${data.jobId.slice(0, 8)}] status=${data.status}${ex}\n`,
		);
	}
});

socket.on("disconnect", () => {
	console.log("[logs] disconnected");
	process.exit(0);
});

socket.on("connect_error", (err) => {
	console.error("[logs] connection error:", err.message);
	process.exit(1);
});
