import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@vcpdeck/shared";
import { Events, TerminalLimits } from "@vcpdeck/shared";
import { ClientGateway } from "../events/client.gateway.js";
import { TerminalService } from "./terminal.service.js";
import { TerminalRequestBroker } from "./terminal-request-broker.js";
import { makeMemoryPrisma, makeFakeClient } from "./integration-helpers.js";

const ACTOR: ActorContext = {
	identityId: "user-1",
	displayName: "Admin",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "req-1",
};

// ── 回路 harness：真实 gateway + service + broker，fake client（模拟 PTY 桥） ──
function makeHarness() {
	const memory = makeMemoryPrisma();
	const broker = new TerminalRequestBroker();
	const service = TerminalService.withDeps({
		prisma: memory.prisma as never,
		broker,
		audit: memory.audit as never,
	});
	const browserEmits: Array<{
		socketId: string;
		event: string;
		payload: unknown;
	}> = [];
	service.bindBrowserEmitter((socketId, event, payload) =>
		browserEmits.push({ socketId, event, payload }),
	);

	const fakeClient = makeFakeClient();
	fakeClient.setOnOutput((sessionId, data) => {
		const pty = fakeClient.ptys.get(sessionId);
		pty!.seq += 1;
		void service.handleClientOutput("c1", { sessionId, seq: pty!.seq, data });
	});

	const gateway = new ClientGateway(
		{
			register: vi.fn(async () => {}),
			getClientIdBySocketId: vi.fn(async () => "c1"),
			markOfflineBySocketId: vi.fn(async () => {}),
		} as never,
		{
			markDisconnected: vi.fn(async () => {}),
			markDone: vi.fn(async () => null),
		} as never,
		{ confirmUpload: vi.fn() } as never,
		{
			markInactiveByClientId: vi.fn(async () => {}),
			updateStatus: vi.fn(),
		} as never,
		{
			bindEmitter: vi.fn(),
			request: vi.fn(),
			resolve: vi.fn(),
			disconnect: vi.fn(),
		} as never,
		{ publish: vi.fn(), stream: vi.fn() } as never,
		{
			markReconcilePending: vi.fn(async () => {}),
			reconcileGeneration: vi.fn(async () => ({
				acceptedRunIds: [],
				closedRunIds: [],
				reportAgain: false,
			})),
			withReconciledSocket: vi.fn(
				async (_c: string, _s: string, op: () => Promise<void>) => op(),
			),
			disconnectGeneration: vi.fn(async () => true),
		} as never,
		service as never,
		broker as never,
		{
			onClientRegistered: vi.fn(),
			onUpdateReady: vi.fn(),
			onUpdateFailed: vi.fn(),
		} as never,
		{ bindEmitters: vi.fn() } as never,
	);
	gateway.afterInit();
	// 覆盖 terminal broker emitter → fake client（模拟 /client socket 发送）
	broker.bindEmitter((socketId, request) => {
		void fakeClient.broker
			.request({ clientId: "c1", socketId }, request)
			.then((response) => {
				void gateway.handleTerminalResponse(
					{ id: socketId, data: { clientId: "c1" } } as never,
					response as never,
				);
			});
	});
	return { memory, service, broker, gateway, fakeClient, browserEmits };
}

async function registerClient(h: ReturnType<typeof makeHarness>) {
	await h.gateway.handleRegister(
		{ id: "client-sock-1", data: {}, join: vi.fn(), emit: vi.fn() } as never,
		{
			clientId: "c1",
			hostname: "host",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "1",
			capabilities: ["terminal.pty"],
			capabilityDetails: {},
		},
	);
	h.memory.clients.set("c1", {
		id: "c1",
		socketId: "client-sock-1",
		online: true,
	});
	h.fakeClient.bindClientSocket("client-sock-1");
	// Client 注册后上报状态对账
	await h.service.handleClientState("c1", "client-sock-1", {
		clientId: "c1",
		generationId: "g1",
		sessions: [],
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("终端端到端回路", () => {
	it("创建 → attach → 输入 → PTY 回显 → 浏览器收到 snapshot + output", async () => {
		const h = makeHarness();
		await registerClient(h);
		const created = await h.service.createSession(
			"c1",
			{ shellId: "bash", cols: 100, rows: 40 },
			ACTOR,
		);
		expect(created.status).toBe("detached");
		expect(h.memory.sessions.get(created.sessionId)?.shellId).toBe("bash");

		const attached = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "browser-1",
		});
		expect(attached.mode).toBe("operator");
		await h.service.whenAttachSettled(created.sessionId);
		const snap = h.browserEmits.find(
			(e) => e.event === Events.TERMINAL_SNAPSHOT,
		);
		expect(snap?.payload).toMatchObject({
			sessionId: created.sessionId,
			snapshot: `SNAP:${created.sessionId}`,
		});

		await h.service.browserInput({
			socketId: "browser-1",
			sessionId: created.sessionId,
			attachmentId: attached.attachmentId,
			data: "ls\r",
		});
		expect(h.fakeClient.receivedInput).toEqual([
			{ sessionId: created.sessionId, data: "ls\r" },
		]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const outputs = h.browserEmits.filter(
			(e) => e.event === Events.TERMINAL_OUTPUT,
		);
		expect(outputs.map((o) => (o.payload as { data: string }).data)).toEqual([
			"echo:ls\r",
		]);
		expect(outputs[0]?.payload).toMatchObject({ seq: 1 });
	});

	it("第二浏览器只读：伪造 input 被拒绝且不达 Client", async () => {
		const h = makeHarness();
		await registerClient(h);
		const created = await h.service.createSession(
			"c1",
			{ shellId: "bash", cols: 80, rows: 24 },
			ACTOR,
		);
		await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "b1",
		});
		const viewer = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: { ...ACTOR, identityId: "id2" },
			socketId: "b2",
		});
		await expect(
			h.service.browserInput({
				socketId: "b2",
				sessionId: created.sessionId,
				attachmentId: viewer.attachmentId,
				data: "rm -rf /",
			}),
		).rejects.toMatchObject({ code: "TERMINAL_READ_ONLY" });
		expect(h.fakeClient.receivedInput).toHaveLength(0);
	});

	it("同一 socket 重复 attach：旧 attachment 被取代，新 attach 仍为 operator", async () => {
		const h = makeHarness();
		await registerClient(h);
		const created = await h.service.createSession(
			"c1",
			{ shellId: "bash", cols: 80, rows: 24 },
			ACTOR,
		);
		const first = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "b1",
		});
		// StrictMode 双挂载：同一 socket 再次 attach
		const second = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "b1",
		});
		expect(second.mode).toBe("operator");
		// 旧 attachment 已失效：输入被拒绝；新 attachment 可写
		await expect(
			h.service.browserInput({
				socketId: "b1",
				sessionId: created.sessionId,
				attachmentId: first.attachmentId,
				data: "x\r",
			}),
		).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
		await h.service.browserInput({
			socketId: "b1",
			sessionId: created.sessionId,
			attachmentId: second.attachmentId,
			data: "ls\r",
		});
		expect(h.fakeClient.receivedInput).toHaveLength(1);
	});

	it("operator 断开后 token 重绑恢复操作权", async () => {
		const h = makeHarness();
		await registerClient(h);
		const created = await h.service.createSession(
			"c1",
			{ shellId: "bash", cols: 80, rows: 24 },
			ACTOR,
		);
		const first = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "b1",
		});
		await h.service.detachBrowserSocket("b1");
		const rebind = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "b2",
			reconnectToken: first.reconnectToken,
		});
		expect(rebind.mode).toBe("operator");
		await h.service.browserInput({
			socketId: "b2",
			sessionId: created.sessionId,
			attachmentId: rebind.attachmentId,
			data: "pwd\r",
		});
		expect(h.fakeClient.receivedInput).toHaveLength(1);
	});

	it("保护期后 viewer 接管成功", async () => {
		const h = makeHarness();
		await registerClient(h);
		const created = await h.service.createSession(
			"c1",
			{ shellId: "bash", cols: 80, rows: 24 },
			ACTOR,
		);
		await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "b1",
		});
		await h.service.detachBrowserSocket("b1");
		const viewer = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: { ...ACTOR, identityId: "id2" },
			socketId: "b2",
		});
		await expect(
			h.service.browserTakeover({
				socketId: "b2",
				sessionId: created.sessionId,
				attachmentId: viewer.attachmentId,
			}),
		).rejects.toMatchObject({ code: "TERMINAL_CONTROL_PROTECTED" });
		// 拨快服务时钟（30 秒保护期）
		const svc = h.service as unknown as { now: () => number };
		const originalNow = svc.now;
		let clock = Date.now();
		svc.now = () => clock;
		clock += TerminalLimits.reconnectGraceMs + 1;
		const winner = await h.service.browserTakeover({
			socketId: "b2",
			sessionId: created.sessionId,
			attachmentId: viewer.attachmentId,
		});
		expect(winner.mode).toBe("operator");
		svc.now = originalNow;
	});

	it("Client 重启对账：旧会话 interrupted，孤儿 closeSessionIds", async () => {
		const h = makeHarness();
		await registerClient(h);
		const created = await h.service.createSession(
			"c1",
			{ shellId: "bash", cols: 80, rows: 24 },
			ACTOR,
		);
		const ack = await h.service.handleClientState("c1", "client-sock-2", {
			clientId: "c1",
			generationId: "g2",
			sessions: [],
		});
		expect(ack.acceptedSessionIds).toEqual([]);
		expect(h.memory.sessions.get(created.sessionId)?.status).toBe(
			"interrupted",
		);
		expect(h.memory.sessions.get(created.sessionId)?.endReason).toBe(
			"TERMINAL_CLIENT_RESTARTED",
		);
		const ack2 = await h.service.handleClientState("c1", "client-sock-2", {
			clientId: "c1",
			generationId: "g2",
			sessions: [
				{
					sessionId: "ts_orphan",
					shellId: "bash",
					status: "active",
					cols: 80,
					rows: 24,
					lastSeq: 0,
				},
			],
		});
		expect(ack2.closeSessionIds).toEqual(["ts_orphan"]);
	});

	it("安全 canary：输入/路径/token 不进入 DB 与审计", async () => {
		const h = makeHarness();
		await registerClient(h);
		const created = await h.service.createSession(
			"c1",
			{ shellId: "bash", cols: 80, rows: 24 },
			ACTOR,
		);
		const attached = await h.service.attachBrowser({
			sessionId: created.sessionId,
			actor: ACTOR,
			socketId: "b1",
		});
		await h.service.browserInput({
			socketId: "b1",
			sessionId: created.sessionId,
			attachmentId: attached.attachmentId,
			data: "SECRET_INPUT_7f3a",
		});
		const dbJson = JSON.stringify([...h.memory.sessions.values()]);
		expect(dbJson).not.toContain("SECRET_INPUT_7f3a");
		expect(dbJson).not.toContain("/home/");
		expect(dbJson).not.toContain(attached.reconnectToken);
		expect(JSON.stringify(h.memory.audits)).not.toContain("SECRET_INPUT_7f3a");
		expect(JSON.stringify(h.memory.audits)).not.toContain(
			attached.reconnectToken,
		);
	});
});
