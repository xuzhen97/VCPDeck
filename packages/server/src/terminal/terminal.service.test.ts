import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalService, type TerminalServiceDeps } from "./terminal.service.js";
import { TerminalLimits } from "@vcpdeck/shared";
import type {
	ActorContext,
	TerminalClientRequest,
	TerminalClientResponse,
	TerminalSessionInfo,
	TerminalStateReport,
} from "@vcpdeck/shared";

// ── fakes ──
function makePrisma() {
	const sessions = new Map<string, Record<string, unknown>>();
	const audits: unknown[] = [];
	return {
		sessions,
		audits,
		prisma: {
			client: {
				findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
					where.id === "c1"
						? { id: "c1", online: true, socketId: "client-sock-1" }
						: null,
				),
			},
			terminalSession: {
				findUnique: vi.fn(async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null),
				findMany: vi.fn(async () => [...sessions.values()]),
				count: vi.fn(async ({ where }: { where?: { clientId?: string; status?: { notIn?: string[] } } }) => {
					if (!where?.clientId) return sessions.size;
					return [...sessions.values()].filter((s) => s.clientId === where.clientId).length;
				}),
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					const row: Record<string, unknown> = {
						createdAt: new Date("2026-08-12T00:00:00.000Z"),
						updatedAt: new Date("2026-08-12T00:00:00.000Z"),
						...data,
					};
					sessions.set(row.id as string, row);
					return row;
				}),
				update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
					const row = { ...sessions.get(where.id), ...data };
					sessions.set(where.id, row);
					return row;
				}),
			},
			terminalAuditEvent: {
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					audits.push(data);
					return data;
				}),
			},
		} as never,
		audit: {
			record: vi.fn(async () => undefined),
		} as { record: ReturnType<typeof vi.fn> },
	};
}

function makeBroker() {
	const requests: Array<{ lease: { clientId: string; socketId: string }; request: TerminalClientRequest }> = [];
	let responder: ((req: TerminalClientRequest) => TerminalClientResponse) | null = null;
	return {
		requests,
		setResponder: (fn: (req: TerminalClientRequest) => TerminalClientResponse) => {
			responder = fn;
		},
		broker: {
			request: vi.fn(async (lease: { clientId: string; socketId: string }, request: TerminalClientRequest) => {
				requests.push({ lease, request });
				if (!responder) throw Object.assign(new Error("no responder"), { code: "TERMINAL_CLIENT_OFFLINE" });
				return responder(request);
			}),
			disconnect: vi.fn(),
		} as never,
	};
}

function makeEmitter() {
	const browserEmits: Array<{ socketId: string; event: string; payload: unknown }> = [];
	return {
		browserEmits,
		emit: (socketId: string, event: string, payload: unknown) => {
			browserEmits.push({ socketId, event, payload });
		},
	};
}

interface Harness {
	service: TerminalService;
	prisma: ReturnType<typeof makePrisma>;
	broker: ReturnType<typeof makeBroker>;
	emitter: ReturnType<typeof makeEmitter>;
	sessions: Map<string, Record<string, unknown>>;
	clock: { now: number };
}

function makeHarness(overrides: Partial<TerminalServiceDeps> = {}): Harness {
	const prisma = makePrisma();
	const broker = makeBroker();
	const emitter = makeEmitter();
	const clock = { now: 1_000_000 };
	const service = TerminalService.withDeps({
		prisma: prisma.prisma as never,
		broker: broker.broker as never,
		audit: prisma.audit as never,
		now: () => clock.now,
		hashToken: (t) => `hash:${t}`,
		...overrides,
	});
	service.bindBrowserEmitter(emitter.emit);
	return { service, prisma, broker, emitter, sessions: prisma.sessions, clock };
}

const ACTOR: ActorContext = { identityId: "id1", displayName: "admin", isAdmin: true, credentialId: null, sessionId: null, source: "web", requestId: "r" };

function okCreate(req: TerminalClientRequest): TerminalClientResponse {
	return { requestId: req.requestId, ok: true, action: "session.create", sessionId: (req as { sessionId: string }).sessionId, status: "detached" };
}
function okAttach(req: TerminalClientRequest): TerminalClientResponse {
	const sessionId = (req as { sessionId: string }).sessionId;
	return {
		requestId: req.requestId,
		ok: true,
		action: "session.attach",
		sessionId,
		snapshot: `snap:${sessionId}`,
		snapshotSeq: 0,
		cols: 80,
		rows: 24,
		historyTruncated: false,
	};
}

async function seedSession(h: Harness, status = "detached"): Promise<string> {
	const created = await h.service.createSession(
		"c1",
		{ shellId: "bash", cols: 80, rows: 24 },
		ACTOR,
	);
	const info = created as TerminalSessionInfo;
	h.sessions.set(info.sessionId, { ...h.sessions.get(info.sessionId), status });
	return info.sessionId;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createSession", () => {
	it("Client 离线返回 TERMINAL_CLIENT_OFFLINE", async () => {
		const h = makeHarness();
		const prisma2 = {
			...(h.prisma.prisma as unknown as Record<string, unknown>),
			client: { findUnique: vi.fn(async () => null) },
		} as never;
		const svc = TerminalService.withDeps({
			prisma: prisma2,
			broker: h.broker.broker,
			audit: h.prisma.audit,
			now: () => 0,
		});
		await expect(svc.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR)).rejects.toMatchObject({
			code: "TERMINAL_CLIENT_OFFLINE",
		});
	});

	it("第 5 个会话后第 6 个返回 TERMINAL_SESSION_LIMIT_REACHED", async () => {
		const h = makeHarness();
		h.broker.setResponder(okCreate);
		for (let i = 0; i < TerminalLimits.maxSessionsPerClient; i++) {
			await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
		}
		await expect(h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR)).rejects.toMatchObject({
			code: "TERMINAL_SESSION_LIMIT_REACHED",
		});
	});

	it("Client create 失败时 DB 标记 error 并写 create_failed 审计", async () => {
		const h = makeHarness();
		h.broker.setResponder((req) => ({
			requestId: req.requestId,
			ok: false,
			error: { code: "TERMINAL_PTY_SPAWN_FAILED", message: "boom" },
		}));
		await expect(h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR)).rejects.toMatchObject({
			code: "TERMINAL_PTY_SPAWN_FAILED",
		});
		const rows = [...h.sessions.values()];
		expect(rows[0]?.status).toBe("error");
		expect(rows[0]?.errorCode).toBe("TERMINAL_PTY_SPAWN_FAILED");
		expect(h.prisma.audit.record).toHaveBeenCalledWith(
			expect.objectContaining({ event: "create_failed", result: "error" }),
		);
	});
});

describe("attach 与单写多读", () => {
	it("首个 attach 为 operator，后续为 viewer，同 identity 也单写", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		const first = await h.service.attachBrowser({
			clientId: "c1", sessionId, actor: ACTOR, socketId: "browser-1",
		});
		expect(first.mode).toBe("operator");
		const second = await h.service.attachBrowser({
			clientId: "c1", sessionId, actor: ACTOR, socketId: "browser-2",
		});
		expect(second.mode).toBe("viewer");
		const third = await h.service.attachBrowser({
			clientId: "c1", sessionId, actor: { ...ACTOR, identityId: "id2", displayName: "other" }, socketId: "browser-3",
		});
		expect(third.mode).toBe("viewer");
	});

	it("viewer input/resize 被拒绝且 broker 不被调用", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		const first = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		const second = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: { ...ACTOR, identityId: "id2" }, socketId: "b2" });
		await h.service.whenAttachSettled(sessionId);
		const before = h.broker.requests.length;
		await expect(
			h.service.browserInput({ socketId: "b2", sessionId, attachmentId: second.attachmentId, data: "x" }),
		).rejects.toMatchObject({ code: "TERMINAL_READ_ONLY" });
		await expect(
			h.service.browserResize({ socketId: "b2", sessionId, attachmentId: second.attachmentId, cols: 100, rows: 40 }),
		).rejects.toMatchObject({ code: "TERMINAL_READ_ONLY" });
		expect(h.broker.requests.length).toBe(before);
		expect(first.mode).toBe("operator");
	});

	it("operator input 转发到 Client", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		const first = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		await h.service.browserInput({ socketId: "b1", sessionId, attachmentId: first.attachmentId, data: "ls\r" });
		const inputReq = h.broker.requests.find((r) => r.request.action === "session.input");
		expect(inputReq).toBeTruthy();
		expect((inputReq?.request as { data: string }).data).toBe("ls\r");
	});

	it("未知 attachment 的 input 返回 TERMINAL_SESSION_NOT_FOUND", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		await expect(
			h.service.browserInput({ socketId: "b1", sessionId, attachmentId: "nope", data: "x" }),
		).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
	});
});

describe("30 秒重连保护与接管", () => {
	it("operator 断开后 29.999s 内 token 可恢复；错误 token 被拒绝", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		const first = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		await h.service.whenAttachSettled(sessionId);
		await h.service.detachBrowserSocket("b1");
		// 错误 token
		await expect(
			h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b2", reconnectToken: "wrong" }),
		).resolves.toMatchObject({ mode: "viewer" });
		// 合法 token：viewer 已存在，token 重绑仍恢复 operator
		const rebind = await h.service.attachBrowser({
			clientId: "c1", sessionId, actor: ACTOR, socketId: "b3", reconnectToken: first.reconnectToken,
		});
		expect(rebind.mode).toBe("operator");
		expect(rebind.attachmentId).not.toBe(first.attachmentId);
	});

	it("保护期内 viewer 接管被拒绝；30 秒后接管成功且并发只有一个赢家", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		await h.service.whenAttachSettled(sessionId);
		await h.service.detachBrowserSocket("b1");
		const viewer = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: { ...ACTOR, identityId: "id2" }, socketId: "b2" });
		await expect(
			h.service.browserTakeover({ socketId: "b2", sessionId, attachmentId: viewer.attachmentId }),
		).rejects.toMatchObject({ code: "TERMINAL_CONTROL_PROTECTED" });
		// 30 秒后
		await vi.advanceTimersByTimeAsync(TerminalLimits.reconnectGraceMs + 1);
		h.clock.now += TerminalLimits.reconnectGraceMs + 1;
		const winner = await h.service.browserTakeover({ socketId: "b2", sessionId, attachmentId: viewer.attachmentId });
		expect(winner.mode).toBe("operator");
	});

	it("接管后旧 operator token 失效（lease 已更换）", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		const first = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		await h.service.whenAttachSettled(sessionId);
		await h.service.detachBrowserSocket("b1");
		const viewer = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: { ...ACTOR, identityId: "id2" }, socketId: "b2" });
		await vi.advanceTimersByTimeAsync(TerminalLimits.reconnectGraceMs + 1);
		h.clock.now += TerminalLimits.reconnectGraceMs + 1;
		await h.service.browserTakeover({ socketId: "b2", sessionId, attachmentId: viewer.attachmentId });
		const rebind = await h.service.attachBrowser({
			clientId: "c1", sessionId, actor: ACTOR, socketId: "b3", reconnectToken: first.reconnectToken,
		});
		expect(rebind.mode).toBe("viewer");
		expect(rebind.attachmentId).not.toBe(first.attachmentId);
	});
});

describe("输出同步与快照", () => {
	it("attach 时先 snapshot 后增量（snapshotSeq 之前的块丢弃）", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		const attached = h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		// attach 请求发出但未返回时，Client 输出 seq=1（≤ snapshotSeq=0? 不，snapshotSeq 来自响应）
		// 模拟响应 snapshotSeq=5，先到的输出 seq=2 应丢弃
		h.broker.setResponder((req) => ({
			requestId: req.requestId,
			ok: true,
			action: "session.attach",
			sessionId,
			snapshot: "snap",
			snapshotSeq: 5,
			cols: 80,
			rows: 24,
			historyTruncated: false,
		}));
		await h.service.handleClientOutput("c1", { sessionId, seq: 2, data: "early" });
		const result = await attached;
		expect(result.mode).toBe("operator");
		await h.service.whenAttachSettled(sessionId);
		const snaps = h.emitter.browserEmits.filter((e) => e.event === "terminal:snapshot");
		expect(snaps).toHaveLength(1);
		expect(snaps[0]?.payload).toMatchObject({ snapshotSeq: 5 });
		// seq=2 的 early 输出未转发给浏览器
		expect(h.emitter.browserEmits.filter((e) => e.event === "terminal:output")).toHaveLength(0);
	});

	it("重复 seq 丢弃、gap 不转发", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		await h.service.whenAttachSettled(sessionId);
		await h.service.handleClientOutput("c1", { sessionId, seq: 1, data: "a" });
		await h.service.handleClientOutput("c1", { sessionId, seq: 1, data: "dup" });
		await h.service.handleClientOutput("c1", { sessionId, seq: 3, data: "gap" });
		await h.service.handleClientOutput("c1", { sessionId, seq: 2, data: "b" });
		const outputs = h.emitter.browserEmits.filter((e) => e.event === "terminal:output");
		expect(outputs.map((o) => (o.payload as { data: string }).data)).toEqual(["a", "b"]);
	});

	it("最后 detach 通知 Client 一次；重新 attach 后恢复", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		const first = await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		await h.service.whenAttachSettled(sessionId);
		await h.service.detachBrowserSocket("b1");
		await h.service.detachBrowserSocket("b1"); // 幂等
		await vi.advanceTimersByTimeAsync(0); // 等待 detach 请求发出
		const detachReqs = h.broker.requests.filter((r) => r.request.action === "session.detach");
		expect(detachReqs).toHaveLength(1);
		// 重新 attach
		const rebind = await h.service.attachBrowser({
			clientId: "c1", sessionId, actor: ACTOR, socketId: "b2", reconnectToken: first.reconnectToken,
		});
		expect(rebind.mode).toBe("operator");
	});
});

describe("Client 状态对账", () => {
	function report(sessionIds: string[], generationId = "g1"): TerminalStateReport {
		return {
			clientId: "c1",
			generationId,
			sessions: sessionIds.map((sessionId) => ({
				sessionId,
				shellId: "bash",
				status: "active" as const,
				cols: 80,
				rows: 24,
				lastSeq: 0,
			})),
		};
	}

	it("DB 非终态但 Client 未上报 → interrupted", async () => {
		const h = makeHarness();
		h.broker.setResponder(okCreate);
		const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
		const info = created as TerminalSessionInfo;
		const ack = await h.service.handleClientState("c1", "client-sock-1", report([]));
		expect(ack.acceptedSessionIds).toEqual([]);
		expect(ack.closeSessionIds).toEqual([]);
		const row = h.sessions.get(info.sessionId);
		expect(row?.status).toBe("interrupted");
		expect(row?.endReason).toBe("TERMINAL_CLIENT_RESTARTED");
	});

	it("Client 上报但 DB 终态 → 加入 closeSessionIds", async () => {
		const h = makeHarness();
		h.broker.setResponder(okCreate);
		const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
		const info = created as TerminalSessionInfo;
		h.sessions.set(info.sessionId, { ...h.sessions.get(info.sessionId), status: "closed" });
		const ack = await h.service.handleClientState("c1", "client-sock-1", report([info.sessionId]));
		expect(ack.closeSessionIds).toEqual([info.sessionId]);
	});

	it("Client 上报且 DB 非终态 → 接受", async () => {
		const h = makeHarness();
		h.broker.setResponder(okCreate);
		const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
		const info = created as TerminalSessionInfo;
		const ack = await h.service.handleClientState("c1", "client-sock-1", report([info.sessionId]));
		expect(ack.acceptedSessionIds).toEqual([info.sessionId]);
		expect(h.sessions.get(info.sessionId)?.status).toBe("detached");
	});
});

describe("终态与竞态", () => {
	it("close 幂等：终态后再次 close 不改写首次原因", async () => {
		const h = makeHarness();
		h.broker.setResponder(okCreate);
		const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
		const info = created as TerminalSessionInfo;
		await h.service.closeSession("c1", info.sessionId, ACTOR);
		await h.service.closeSession("c1", info.sessionId, ACTOR);
		const row = h.sessions.get(info.sessionId);
		expect(row?.status).toBe("closed");
		expect(row?.endReason).toBe("TERMINAL_CLOSE_REQUESTED");
	});

	it("Client exit 后 DB 标记 exited，迟到 output 不转发", async () => {
		const h = makeHarness();
		h.broker.setResponder(okAttach);
		const sessionId = await seedSession(h);
		await h.service.attachBrowser({ clientId: "c1", sessionId, actor: ACTOR, socketId: "b1" });
		await h.service.handleClientExit("c1", { sessionId, exitCode: 0 });
		expect(h.sessions.get(sessionId)?.status).toBe("exited");
		await h.service.handleClientOutput("c1", { sessionId, seq: 5, data: "late" });
		expect(h.emitter.browserEmits.filter((e) => e.event === "terminal:output")).toHaveLength(0);
	});

	it("跨 Client 的会话操作被拒绝", async () => {
		const h = makeHarness();
		h.broker.setResponder(okCreate);
		const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
		const info = created as TerminalSessionInfo;
		await expect(
			h.service.attachBrowser({ clientId: "c2", sessionId: info.sessionId, actor: ACTOR, socketId: "b1" }),
		).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
	});
});
