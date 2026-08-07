import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type { MachineRegister, PiCapabilityStatus } from "@vcpdeck/shared";
import { attachPiBridge, type PiBridgeDeps } from "../index.js";
import { createPiSupervisor } from "./supervisor.js";
import type { PiWorkerOutboundMessage } from "./worker-protocol.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let roots: string[] = [];
let seq = 0;

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
	roots = [];
});

function fakeSocket(): {
	socket: Socket;
	emitCalls: Array<{ event: string; args: unknown[] }>;
	listeners: Map<string, Array<(...args: unknown[]) => void>>;
} {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const emitCalls: Array<{ event: string; args: unknown[] }> = [];
	const socket = {
		connected: true,
		on: (event: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(event) ?? [];
			list.push(cb);
			listeners.set(event, list);
			return socket;
		},
		emit: (event: string, ...args: unknown[]) => {
			emitCalls.push({ event, args });
			return socket;
		},
	} as unknown as Socket;
	return { socket, emitCalls, listeners };
}

function makeFakeHandle() {
	const msgListeners: Array<(msg: PiWorkerOutboundMessage) => void> = [];
	const emitMessage = (msg: PiWorkerOutboundMessage) => {
		for (const l of msgListeners) l(msg);
	};
	return {
		handle: {
			send: (msg: { type: "request"; request: { requestId: string } } | unknown) => {
				// 自动应答：收到请求立即 ok
				if (
					typeof msg === "object" &&
					msg !== null &&
					(msg as { type?: string }).type === "request"
				) {
					const requestId = (msg as { request: { requestId: string } }).request.requestId;
					queueMicrotask(() => {
						emitMessage({
							type: "response",
							requestId,
							ok: true,
							data: {},
						});
					});
				}
			},
			onMessage: (l: (msg: PiWorkerOutboundMessage) => void) => {
				msgListeners.push(l);
				return () => {};
			},
			onExit: () => () => {},
			kill: () => {},
		},
		emitMessage,
	};
}

async function makeDeps(overrides: Partial<PiBridgeDeps> = {}) {
	const root = await mkdtemp(join(tmpdir(), `pi-bridge-${++seq}-`));
	await mkdir(join(root, "proj"), { recursive: true });
	roots.push(root);

	const { handle, emitMessage } = makeFakeHandle();
	const supervisor = createPiSupervisor({
		clientId: "c1",
		rootsProvider: async () => [root],
		forkWorker: () => handle,
	});
	const status: PiCapabilityStatus = {
		available: true,
		sdkVersion: "0.84.0",
		nodeVersion: "22.19.0",
		shellKind: "git-bash",
	};
	return {
		emitMessage,
		deps: {
			clientId: "c1",
			supervisor,
			getPiStatus: async () => status,
			getRegister: (piStatus) =>
				({
					clientId: "c1",
					hostname: "host",
					os: "win32",
					cpuModel: "cpu",
					totalMemMB: 1,
					clientVersion: "1",
					capabilities: piStatus?.available
						? ["pi.probe", "agent.pi"]
						: ["pi.probe"],
					...(piStatus ? { capabilityDetails: { pi: piStatus } } : {}),
				}) as MachineRegister,
			getStatusReport: () => ({ clientId: "c1", jobs: [] }),
			...overrides,
		} as PiBridgeDeps,
	};
}

describe("attachPiBridge", () => {
	it("PI_REQUEST 经 parse 后交给 supervisor 并回 PI_RESPONSE", async () => {
		const { socket, emitCalls, listeners } = fakeSocket();
		const { deps } = await makeDeps();
		attachPiBridge(socket, deps);

		fire(listeners, Events.PI_REQUEST, {
			requestId: "r1",
			action: "sessions.list",
			cwdRef: { rootDir: roots[0]!, relativePath: "proj" },
		});
		await vi.waitFor(() => {
			const res = emitCalls.find((c) => c.event === Events.PI_RESPONSE);
			expect(res).toBeDefined();
		});
		const res = emitCalls.find((c) => c.event === Events.PI_RESPONSE)?.args[0] as {
			requestId: string;
			ok: boolean;
		};
		expect(res.requestId).toBe("r1");
		expect(res.ok).toBe(true);
	});

	it("非法 PI_REQUEST 返回 PI_PROTOCOL_INVALID", async () => {
		const { socket, emitCalls, listeners } = fakeSocket();
		const { deps } = await makeDeps();
		attachPiBridge(socket, deps);

		fire(listeners, Events.PI_REQUEST, { action: "agent.unknown" });
		await vi.waitFor(() => {
			const res = emitCalls.find((c) => c.event === Events.PI_RESPONSE);
			expect(res).toBeDefined();
		});
		const res = emitCalls.find((c) => c.event === Events.PI_RESPONSE)?.args[0] as {
			ok: boolean;
			error: { code: string };
		};
		expect(res.ok).toBe(false);
		expect(res.error.code).toBe("PI_PROTOCOL_INVALID");
	});

	it("supervisor 事件经 worker 链路转发为 PI_EVENT", async () => {
		const { socket, emitCalls } = fakeSocket();
		const { deps, emitMessage } = await makeDeps();
		attachPiBridge(socket, deps);

		// 建立活动回合（fake worker 自动响应）
		const result = await deps.supervisor.request({
			requestId: "r2",
			action: "agent.prompt",
			cwdRef: { rootDir: roots[0]!, relativePath: "proj" },
			sessionId: "s1",
			jobId: "j1",
			runId: "j1",
			payload: { prompt: "hi" },
		});
		expect(result).toMatchObject({ ok: true });

		emitMessage({
			type: "event",
			sessionId: "s1",
			jobId: "j1",
			runId: "j1",
			event: { type: "agent_end", sessionId: "s1" },
		});

		const ev = emitCalls.find((c) => c.event === Events.PI_EVENT)?.args[0] as {
			clientId: string;
			event: { type: string };
		};
		expect(ev).toBeDefined();
		expect(ev.clientId).toBe("c1");
		expect(ev.event.type).toBe("agent_end");
	});

	it("REGISTER ack 后发送 STATUS_REPORT 与 PI_STATE，PI_STATE ack 清理 terminal", async () => {
		const { socket, emitCalls } = fakeSocket();
		const { deps, emitMessage } = await makeDeps();
		const bridge = attachPiBridge(socket, deps);

		// 先产生一个 terminal（活动回合 + agent_settled）
		const result = await deps.supervisor.request({
			requestId: "r3",
			action: "agent.prompt",
			cwdRef: { rootDir: roots[0]!, relativePath: "proj" },
			sessionId: "s1",
			jobId: "j1",
			runId: "j1",
			payload: { prompt: "hi" },
		});
		expect(result).toMatchObject({ ok: true });
		emitMessage({
			type: "event",
			sessionId: "s1",
			jobId: "j1",
			runId: "j1",
			event: { type: "agent_settled", sessionId: "s1" },
		});
		expect(deps.supervisor.getStateReport().runs.some((r) => r.jobId === "j1")).toBe(true);

		// 触发注册完成
		await bridge.onConnected();
		const registerCall = emitCalls.find((c) => c.event === Events.REGISTER);
		expect(registerCall).toBeDefined();
		const registerPayload = registerCall?.args[0] as MachineRegister;
		expect(registerPayload.capabilities).toContain("agent.pi");

		// 调用 REGISTER 的 ack callback
		const registerAck = registerCall?.args[1] as () => void;
		registerAck();

		const statusCall = emitCalls.find((c) => c.event === Events.STATUS_REPORT);
		expect(statusCall).toBeDefined();
		const stateCall = emitCalls.find((c) => c.event === Events.PI_STATE);
		expect(stateCall).toBeDefined();
		const statePayload = stateCall?.args[0] as { runs: Array<{ jobId: string }> };
		expect(statePayload.runs.some((r) => r.jobId === "j1")).toBe(true);

		// 调用 PI_STATE 的 ack → terminal 清理
		const stateAck = stateCall?.args[1] as (ack: { acceptedRunIds?: string[] }) => void;
		stateAck({ acceptedRunIds: ["j1"] });
		expect(deps.supervisor.getStateReport().runs.some((r) => r.jobId === "j1")).toBe(false);
	});

	it("旧 Server 'ack' event 也能触发注册后流程", async () => {
		const { socket, emitCalls, listeners } = fakeSocket();
		const { deps } = await makeDeps();
		attachPiBridge(socket, deps);

		fire(listeners, "ack", { event: Events.REGISTER });
		expect(emitCalls.some((c) => c.event === Events.STATUS_REPORT)).toBe(true);
		expect(emitCalls.some((c) => c.event === Events.PI_STATE)).toBe(true);
	});
});

function fire(
	listeners: Map<string, Array<(...args: unknown[]) => void>>,
	event: string,
	...args: unknown[]
) {
	for (const cb of listeners.get(event) ?? []) cb(...args);
}
