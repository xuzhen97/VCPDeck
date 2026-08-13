/* VCPDeck 终端端到端冒烟（Windows）：server + client + /app socket + 真实 node-pty */
const { io } = require("socket.io-client");

const BASE = process.env.VCPDECK_BASE || "http://localhost:3001";
const USER = "admin";
const PASS = process.env.VCPDECK_SMOKE_PASSWORD || "smoke123";

async function main() {
	// 1. 登录拿 cookie
	const login = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: USER, password: PASS }),
	});
	const loginText = await login.text();
	if (!login.ok) {
		console.error("login failed:", login.status, loginText);
		process.exit(1);
	}
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
	if (!cookie) {
		console.error("no session cookie");
		process.exit(1);
	}
	console.log("login ok, cookie:", cookie.slice(0, 24) + "...");

	const headers = { Cookie: cookie };

	// 2. 等待 client 在线并列出 Shell
	let shells = null;
	for (let i = 0; i < 20; i++) {
		try {
			const r = await fetch(`${BASE}/api/clients/smoke-client/terminals/shells`, { headers });
			if (r.ok) {
				shells = await r.json();
				break;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	if (!shells || !Array.isArray(shells) || shells.length === 0) {
		console.error("no shells (client offline or terminal unsupported)");
		process.exit(1);
	}
	console.log("shells:", shells.map((s) => `${s.id}${s.isDefault ? "*" : ""}`).join(", "));

	// 3. 创建会话
	const create = await fetch(`${BASE}/api/clients/smoke-client/terminals`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({ shellId: shells[0].id, cols: 120, rows: 30 }),
	});
	const created = await create.json();
	if (!create.ok) {
		console.error("create failed:", create.status, JSON.stringify(created));
		process.exit(1);
	}
	console.log("created session:", created.sessionId, created.status);

	// 4. attach（/app socket + cookie）
	const socket = io(`${BASE}/app`, { withCredentials: true, extraHeaders: { Cookie: cookie } });
	const outputs = [];
	const states = [];
	socket.on("terminal:output", (chunk) => outputs.push(chunk));
	socket.on("terminal:snapshot", (m) => console.log("snapshot seq:", m.snapshotSeq, "size:", m.snapshot.length));
	socket.on("terminal:session-state", (m) => states.push(m));
	socket.on("error", (e) => console.error("app error:", e));
	await new Promise((resolve) => socket.on("connect", resolve));

	const attached = await emitAck(socket, "terminal:attach", { sessionId: created.sessionId });
	if (!attached.ok) {
		console.error("attach failed:", JSON.stringify(attached));
		process.exit(1);
	}
	console.log("attached:", attached.data.mode, "attachment:", attached.data.attachmentId.slice(0, 12));

	// 5. 输入命令并等待回显（Shell 启动需要时间）
	await new Promise((r) => setTimeout(r, 1500));
	const input = `echo VCPDECK_SMOKE_${Date.now()}\r`;
	await emitAck(socket, "terminal:input", {
		sessionId: created.sessionId,
		attachmentId: attached.data.attachmentId,
		data: input,
	});
	await new Promise((r) => setTimeout(r, 3500));
	const echoed = outputs.some((o) => o.data.includes("VCPDECK_SMOKE_"));
	console.log("input echo received:", echoed);

	// 6. resize
	const resized = await emitAck(socket, "terminal:resize", {
		sessionId: created.sessionId,
		attachmentId: attached.data.attachmentId,
		cols: 100,
		rows: 40,
	});
	console.log("resize ok:", resized.ok);

	// 7. 关闭（REST DELETE）
	const del = await fetch(`${BASE}/api/clients/smoke-client/terminals/${created.sessionId}`, {
		method: "DELETE",
		headers,
	});
	const deleted = await del.json();
	console.log("closed:", deleted.status);

	// 8. 审计
	const audit = await fetch(
		`${BASE}/api/clients/smoke-client/terminals/${created.sessionId}/audit?page=1&pageSize=20`,
		{ headers },
	);
	const auditJson = await audit.json();
	console.log(
		"audit events:",
		auditJson.data.map((a) => a.event).join(","),
		"total:", auditJson.total,
	);

	socket.disconnect();
	if (!echoed) process.exit(1);
	console.log("SMOKE_OK");
}

function emitAck(socket, event, payload) {
	return new Promise((resolve) => {
		socket.emit(event, payload, (result) => resolve(result));
	});
}

main().catch((e) => {
	console.error("smoke failed:", e.message);
	process.exit(1);
});
