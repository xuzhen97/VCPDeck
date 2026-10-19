import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let pendingPrompt = null;
let permissionRequestId = null;
let permissionResolve = null;

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
	send({ jsonrpc: "2.0", method, params });
}

rl.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}

	// 对 Agent 发起的 permission request 的响应（没有 method）
	if (message.id !== undefined && message.method === undefined) {
		if (permissionResolve && message.id === permissionRequestId) {
			const outcome = message.result?.outcome;
			permissionResolve(
				outcome?.outcome === "selected" ? "selected" : "cancelled",
			);
			permissionResolve = null;
			permissionRequestId = null;
		}
		return;
	}

	if (message.method === "initialize") {
		respond(message.id, {
			protocolVersion: 1,
			agentCapabilities: { loadSession: false },
			agentInfo: { name: "fake-agent", version: "1.0.0" },
		});
		return;
	}
	if (message.method === "session/new") {
		respond(message.id, { sessionId: "s1" });
		return;
	}
	if (message.method === "session/resume") {
		if (message.params?.sessionId === "missing-session") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32602, message: "Invalid params: unknown session" },
			});
			return;
		}
		respond(message.id, {});
		return;
	}
	if (message.method === "session/close") {
		respond(message.id, {});
		return;
	}
	if (message.method === "session/cancel") {
		if (pendingPrompt !== null) {
			respond(pendingPrompt, { stopReason: "cancelled" });
			pendingPrompt = null;
		}
		if (permissionResolve) {
			permissionResolve("cancelled");
			permissionResolve = null;
		}
		return;
	}
	if (message.method !== "session/prompt") return;

	const text = (message.params.prompt ?? [])
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
	if (text.includes("slow")) {
		pendingPrompt = message.id;
		return;
	}
	if (text.includes("unknown")) {
		notify("session/update", {
			sessionId: "s1",
			update: { sessionUpdate: "future_variant" },
		});
	}
	notify("session/update", {
		sessionId: "s1",
		update: {
			sessionUpdate: "agent_message_chunk",
			messageId: "m1",
			content: { type: "text", text: "working" },
		},
	});
	permissionRequestId = 9000 + Math.floor(Math.random() * 1000);
	permissionResolve = (outcome) => {
		if (outcome === "cancelled") {
			respond(message.id, { stopReason: "cancelled" });
			return;
		}
		notify("session/update", {
			sessionId: "s1",
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "Run",
				kind: "execute",
				status: "pending",
			},
		});
		respond(message.id, { stopReason: "end_turn" });
	};
	send({
		jsonrpc: "2.0",
		id: permissionRequestId,
		method: "session/request_permission",
		params: {
			sessionId: "s1",
			toolCall: { toolCallId: "call-1", title: "Run" },
			options: [
				{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
				{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
			],
		},
	});
});
