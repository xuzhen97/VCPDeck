// 会话宿主真链路 e2e（手动运行，不进 CI）。
//
// 用法：先起 Server（本脚本会在必要时自行起 server dev），然后
//   node scripts/dev-session-host-e2e.mjs
//
// 断言三段 ADR-0046/0047 关键语义：
//   ① 实例启动上报后 DB=running
//   ② 宿主自报停止后 DB=stopped
//   ③ 杀掉宿主后再次上报只能是 unknown（绝不能是 stopped）
//
// 说明：使用 packages/server/prisma/dev.db（gitignored）；结束时清理自己造的实例行与审计行，
// 并删掉宿主控制文件。宿主启动命令使用无害进程（不需要真 Pi/DSH）。
// dev 真链路三段断言（时序修正版）：触发重注册后用轮询等目标状态，而不是单次读取。
import { execFileSync, spawn } from "node:child_process";
import { readFile, rm, utimes } from "node:fs/promises";
import { createRequire } from "node:module";

const REPO = "D:/VCPHub/VCPDeck";
const PNPM = "C:/nvm4w/nodejs/node_modules/corepack/dist/pnpm.js";
const CONTROL = "C:/ProgramData/VCPDeck/session-host/run/control.json";
const HEALTH = "http://localhost:3001/api/health";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverRequire = createRequire(`${REPO}/packages/server/package.json`);
const { PrismaLibSql } = serverRequire("@prisma/adapter-libsql");
const { PrismaClient } = serverRequire("./generated/client/index.js");
const prisma = new PrismaClient({
	adapter: new PrismaLibSql({ url: "file:///D:/VCPHub/VCPDeck/packages/server/prisma/dev.db" }, {}),
});

const control = async () => {
	const raw = await readFile(CONTROL, "utf8").catch(() => null);
	return raw ? JSON.parse(raw) : null;
};
const api = async (route, body) => {
	const c = await control();
	const res = await fetch(`http://127.0.0.1:${c.port}${route}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: await res.json().catch(() => null) };
};
const rowOf = (id) => prisma.sessionHostInstance.findFirst({ where: { instanceId: id } });
/** 触发 Client 重连（tsx watch 重起 server）→ 重发 SESSION_HOST_STATE，然后轮询目标状态。 */
const expectState = async (id, want, timeoutMs = 120000) => {
	await utimes(`${REPO}/packages/server/src/main.ts`, new Date(), new Date());
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = await rowOf(id);
		if (row?.state === want) return `✓ ${want}`;
		await sleep(1000);
	}
	const row = await rowOf(id);
	return `✗ 期望 ${want}，实际 ${row ? row.state : "(未登记)"}`;
};

const children = [];
try {
	const health = await fetch(HEALTH).catch(() => null);
	if (health?.status !== 200) {
		const server = spawn(process.execPath, [PNPM, "--filter", "@vcpdeck/server", "dev"], { cwd: REPO, stdio: "ignore" });
		children.push(server);
		for (let i = 0; i < 150; i += 1) {
			const res = await fetch(HEALTH).catch(() => null);
			if (res?.status === 200) break;
			await sleep(1000);
		}
	}
	console.log("server healthy:", (await fetch(HEALTH).catch(() => null))?.status === 200);

	await rm(CONTROL, { force: true });
	const client = spawn(process.execPath, ["scripts/dev-client.cjs"], {
		cwd: REPO,
		env: {
			...process.env,
			VCPDECK_SESSION_HOST_COMMANDS: JSON.stringify({ pi: { file: process.execPath, args: ["-e", "process.stdin.resume();"] } }),
			VCPDECK_APP_DIR: `${REPO}/.tmp/devapp`,
		},
		stdio: "ignore",
	});
	children.push(client);
	for (let i = 0; i < 120; i += 1) {
		if ((await control()) !== null) break;
		await sleep(1000);
	}
	console.log("宿主就绪:", (await control()) !== null);

	const a = (await api("/start", { operationId: "e2e-a", kind: "pi", cwd: REPO })).json?.instanceId;
	console.log(`① 实例A 启动 (${String(a).slice(0, 8)}…) →`, await expectState(a, "running"));

	const stopped = await api("/stop", { instanceId: a });
	console.log(`② 实例A 停止 (exited=${stopped.json?.exited}) →`, await expectState(a, "stopped"));

	const b = (await api("/start", { operationId: "e2e-b", kind: "pi", cwd: REPO })).json?.instanceId;
	console.log(`③ 实例B 启动 (${String(b).slice(0, 8)}…) →`, await expectState(b, "running"));

	const port = (await control()).port;
	const line = execFileSync("netstat", ["-ano"], { encoding: "utf8" })
		.split("\n")
		.find((l) => l.includes(`127.0.0.1:${port}`) && l.includes("LISTENING"));
	const pid = line?.trim().split(/\s+/).pop();
	if (pid) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
	console.log(`④ 杀掉宿主 PID=${pid} 后再上报 →`, await expectState(b, "unknown"));

	const audits = await prisma.sessionHostAuditEvent.findMany({ orderBy: { createdAt: "asc" } });
	console.log("审计:", audits.map((x) => `${x.event}${x.reason ? `(${x.reason})` : ""}`).join(",") || "(无)");
	const clientId = (await rowOf(a))?.clientId ?? (await rowOf(b))?.clientId;
	if (clientId) {
		await prisma.sessionHostAuditEvent.deleteMany({ where: { clientId } });
		await prisma.sessionHostInstance.deleteMany({ where: { clientId } });
	}
	console.log("清理后实例行:", await prisma.sessionHostInstance.count());
} finally {
	await prisma.$disconnect();
	for (const child of children) {
		try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
	}
	await rm(CONTROL, { force: true });
}
process.exit(0);
