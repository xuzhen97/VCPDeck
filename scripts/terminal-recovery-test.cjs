const { io } = require("socket.io-client");
(async () => {
	const login = await fetch("http://localhost:3001/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "admin", password: "smoke123" }),
	});
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
	const headers = { Cookie: cookie, "Content-Type": "application/json" };
	const create = await fetch("http://localhost:3001/api/clients/smoke-client/terminals", {
		method: "POST",
		headers,
		body: JSON.stringify({ shellId: "cmd", cols: 100, rows: 30 }),
	});
	const created = await create.json();

	function connect() {
		const socket = io("http://localhost:3001/app", { withCredentials: true, extraHeaders: { Cookie: cookie } });
		return new Promise((res) => socket.on("connect", () => res(socket)));
	}
	function emitAck(socket, event, payload) {
		return new Promise((res) => socket.emit(event, payload, res));
	}

	// 第一次连接：attach + 输入
	let socket = await connect();
	const attached1 = await emitAck(socket, "terminal:attach", { sessionId: created.sessionId });
	console.log("first attach:", attached1.ok, attached1.data?.mode);
	await new Promise((r) => setTimeout(r, 1500));
	await emitAck(socket, "terminal:input", {
		sessionId: created.sessionId,
		attachmentId: attached1.data.attachmentId,
		data: "echo RECOVERY_MARKER_42\r",
	});
	await new Promise((r) => setTimeout(r, 2000));
	socket.disconnect();
	console.log("disconnected (simulating refresh)");

	// 第二次连接：带 token 重连恢复
	await new Promise((r) => setTimeout(r, 500));
	socket = await connect();
	let snapshots = [];
	socket.on("terminal:snapshot", (m) => snapshots.push(m));
	const attached2 = await emitAck(socket, "terminal:attach", {
		sessionId: created.sessionId,
		reconnectToken: attached1.data.reconnectToken,
	});
	console.log("re-attach:", attached2.ok, attached2.data?.mode, "same attachment:", attached2.data?.attachmentId === attached1.data.attachmentId);
	await new Promise((r) => setTimeout(r, 800));
	const snap = snapshots[0];
	console.log("snapshot recovered, size:", snap?.snapshot.length, "contains marker:", snap?.snapshot.includes("RECOVERY_MARKER_42"));
	// 先注册输出监听，再输入验证 PTY 仍存活
	const outputs = [];
	socket.on("terminal:output", (c) => outputs.push(c));
	await emitAck(socket, "terminal:input", {
		sessionId: created.sessionId,
		attachmentId: attached2.data.attachmentId,
		data: "echo AFTER_RECOVERY_99\r",
	});
	await new Promise((r) => setTimeout(r, 2500));
	const alive = outputs.some((o) => o.data.includes("AFTER_RECOVERY_99"));
	console.log("PTY alive after recovery:", alive);
	socket.disconnect();
	process.exit(alive ? 0 : 1);
})();
