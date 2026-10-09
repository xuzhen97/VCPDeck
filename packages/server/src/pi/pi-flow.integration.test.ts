import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	PiEvent,
	PiRequest,
	PiResponse,
	PiStateReport,
} from "@vcpdeck/shared";
import type { Socket } from "socket.io";
import { ClientGateway } from "../events/client.gateway.js";
import { PiController } from "./pi.controller.js";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiAttachmentService } from "./pi-attachment.service.js";
import { PiRunService } from "./pi-run.service.js";
import { PiSessionService } from "./pi-session.service.js";

const actor = {
	identityId: "user-1",
	displayName: "User",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "req-1",
} as const;

const PROJECT_KEY = "a".repeat(64);
const PROMPT_SENTINEL = "SENTINEL_PROMPT_9f2a";
const URL_SENTINEL = "SENTINEL_SIGNED_URL_7c11";
const THINKING_SENTINEL = "SENTINEL_THINKING_3d4e";
const TOOL_SENTINEL = "SENTINEL_TOOL_RESULT_5b8f";
const EXTENSION_SENTINEL = "SENTINEL_EXTENSION_INPUT_c621";
const ERROR_SENTINEL = "SENTINEL_PROMPT_ERROR_d18c";
const SENSITIVE_SENTINELS = [
	PROMPT_SENTINEL,
	URL_SENTINEL,
	THINKING_SENTINEL,
	TOOL_SENTINEL,
	EXTENSION_SENTINEL,
	ERROR_SENTINEL,
];

function matches(value: unknown, condition: unknown): boolean {
	if (condition === null) return value === null || value === undefined;
	if (typeof condition === "object" && !Array.isArray(condition)) {
		const { in: values } = condition as { in?: unknown[] };
		if (values) return values.includes(value);
	}
	return value === condition;
}

/** 记录全部写调用的最小内存 Prisma，用于状态与敏感正文断言。 */
function makePrismaMemory() {
	const jobs: Array<Record<string, unknown>> = [];
	const calls: unknown[] = [];
	const job = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			calls.push(args);
			if (jobs.some((candidate) => candidate.id === args.data.id))
				throw { code: "P2002" };
			const created = {
				payload: "{}",
				progress: null,
				result: null,
				errorCode: null,
				errorMessage: null,
				startedAt: null,
				finishedAt: null,
				toolExecutionModeOverride: null,
				runExecutionMode: null,
				...args.data,
			};
			jobs.push(created);
			return created;
		}),
		findUnique: vi.fn(
			async (args: { where: { id: string } }) =>
				jobs.find((candidate) => candidate.id === args.where.id) ?? null,
		),
		findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			jobs.filter((candidate) =>
				Object.entries(args?.where ?? {}).every(([key, value]) =>
					matches(candidate[key], value),
				),
			),
		),
		update: vi.fn(
			async (args: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				calls.push(args);
				const candidate = jobs.find((item) => item.id === args.where.id);
				if (!candidate) throw new Error("not found");
				Object.assign(candidate, args.data);
				return candidate;
			},
		),
		updateMany: vi.fn(
			async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				calls.push(args);
				let count = 0;
				for (const candidate of jobs) {
					if (
						Object.entries(args.where).every(([key, value]) =>
							matches(candidate[key], value),
						)
					) {
						Object.assign(candidate, args.data);
						count += 1;
					}
				}
				return { count };
			},
		),
	};
	const files: Array<Record<string, unknown>> = [];
	const file = {
		findUnique: vi.fn(
			async (args: { where: { id: string } }) =>
				files.find((candidate) => candidate.id === args.where.id) ?? null,
		),
	};
	// ADR-0041:会话/执行/审计独立于 Job。
	const sessions: Array<Record<string, unknown>> = [];
	const agentRuns: Array<Record<string, unknown>> = [];
	const audits: Array<Record<string, unknown>> = [];
	const agentSession = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			calls.push(args);
			if (sessions.some((candidate) => candidate.id === args.data.id)) throw { code: "P2002" };
			const created = {
				status: "available",
				activeRunId: null,
				executionModeNeedsConfirmation: false,
				deleteToken: null,
				deletePreviousStatus: null,
				...args.data,
			};
			sessions.push(created);
			return created;
		}),
		findUnique: vi.fn(async (args: { where: { id: string } }) =>
			sessions.find((candidate) => candidate.id === args.where.id) ?? null),
		findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			sessions.filter((candidate) =>
				Object.entries(args?.where ?? {}).every(([key, value]) => matches(candidate[key], value)),
			)),
		update: vi.fn(async () => {
			throw new Error("agentSession.update is forbidden; use updateMany CAS");
		}),
		updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
			calls.push(args);
			let count = 0;
			for (const candidate of sessions) {
				if (Object.entries(args.where).every(([key, value]) => matches(candidate[key], value))) {
					Object.assign(candidate, args.data);
					count += 1;
				}
			}
			return { count };
		}),
	};
	const agentRun = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			calls.push(args);
			const created = { createdAt: new Date(), ...args.data };
			agentRuns.push(created);
			return created;
		}),
		findUnique: vi.fn(async (args: { where: { id: string } }) =>
			agentRuns.find((candidate) => candidate.id === args.where.id) ?? null),
		findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			agentRuns.filter((candidate) =>
				Object.entries(args?.where ?? {}).every(([key, value]) => matches(candidate[key], value)),
			)),
		count: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			agentRuns.filter((candidate) =>
				Object.entries(args?.where ?? {}).every(([key, value]) => matches(candidate[key], value)),
			).length),
		update: vi.fn(async () => {
			throw new Error("agentRun.update is forbidden; use updateMany CAS");
		}),
		updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
			calls.push(args);
			let count = 0;
			for (const candidate of agentRuns) {
				if (Object.entries(args.where).every(([key, value]) => matches(candidate[key], value))) {
					Object.assign(candidate, args.data);
					count += 1;
				}
			}
			return { count };
		}),
	};
	const agentAuditEvent = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			calls.push(args);
			audits.push({ createdAt: new Date(), ...args.data });
			return args.data;
		}),
		findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			audits.filter((candidate) =>
				Object.entries(args?.where ?? {}).every(([key, value]) => matches(candidate[key], value)),
			)),
		count: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			audits.filter((candidate) =>
				Object.entries(args?.where ?? {}).every(([key, value]) => matches(candidate[key], value)),
			).length),
	};
	const scoped = () => ({ job, file, agentSession, agentRun, agentAuditEvent });
	const prisma = {
		...scoped(),
		$transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
			const snapshot = {
				sessions: structuredClone(sessions),
				agentRuns: structuredClone(agentRuns),
				audits: structuredClone(audits),
			};
			try {
				return await fn(scoped());
			} catch (error) {
				sessions.splice(0, sessions.length, ...snapshot.sessions);
				agentRuns.splice(0, agentRuns.length, ...snapshot.agentRuns);
				audits.splice(0, audits.length, ...snapshot.audits);
				throw error;
			}
		},
	};
	return {
		...prisma,
		job,
		jobs,
		calls,
		file,
		files,
		agentSession,
		agentRun,
		agentAuditEvent,
		sessions,
		agentRuns,
		audits,
	};
}

function makeSocket(id: string): Socket {
	return {
		id,
		data: {},
		join: vi.fn(),
		emit: vi.fn(),
	} as unknown as Socket;
}

function registration(clientId = "c1") {
	return {
		clientId,
		hostname: "host",
		os: "win32",
		cpuModel: "cpu",
		totalMemMB: 1024,
		clientVersion: "1",
		capabilities: ["agent.pi"],
		capabilityDetails: {
			pi: {
				available: true as const,
				sdkVersion: "1",
				nodeVersion: "22.18.0",
				shellKind: "path" as const,
				sessionProtocolVersion: 4,
			},
		},
	};
}

function report(runs: PiStateReport["runs"] = []): PiStateReport {
	return { clientId: "c1", runs, runtimeRevision: null, configState: "pending" };
}

function makeLoopback() {
	const prisma = makePrismaMemory();
	/** prompt 附件的 File 行：用真实 PiAttachmentService 校验，而不是重写一遍规则。 */
	const attachmentFiles = prisma.files;
	const attachments = new PiAttachmentService(
		{ createPending: vi.fn(), delete: vi.fn() } as never,
		{
			createDownloadToken: vi.fn(async (key: string) => ({
				url: `/api/storage/download/${key}?sig=x`,
				expiresAt: Date.now() + 600_000,
			})),
		} as never,
		prisma as never,
	);
	const runtimeSource = {
		assertReady: vi.fn(),
		effectiveExecutionMode: vi.fn(async () => "supervised"),
	};
	const runs = new PiRunService(prisma as never, runtimeSource as never);
	const sessions = new PiSessionService(prisma as never, runtimeSource as never);
	const requests = new PiRequestBroker();
	const events = new PiEventBroker(requests, runs);
	const sockets = new Map<string, Socket>();
	const requestHandlers = new Map<string, (request: PiRequest) => void>();
	const clientService = {
		register: vi.fn(async () => {}),
		markOfflineBySocketId: vi.fn(async () => {}),
		bindSocket: vi.fn(async () => {}),
		listOnline: vi.fn(async () => [
			{
				clientId: "c1",
				capabilities: ["agent.pi"],
				capabilityDetails: {
					pi: { available: true, sessionProtocolVersion: 4 },
				},
			},
		]),
	};
	const jobService = {
		markDisconnected: vi.fn(async () => {}),
		markDone: vi.fn(async () => null),
	};
	const fileService = { confirmUpload: vi.fn() };
	const frpService = {
		markInactiveByClientId: vi.fn(async () => {}),
		updateStatus: vi.fn(async () => {}),
	};
	const terminalService = {
		handleClientResponse: vi.fn(async () => {}),
		handleClientOutput: vi.fn(async () => {}),
		handleClientExit: vi.fn(async () => {}),
		handleClientState: vi.fn(async () => ({
			acceptedSessionIds: [],
			closeSessionIds: [],
		})),
		handleClientDisconnect: vi.fn(async () => {}),
		handleClientRegistered: vi.fn(async () => {}),
	};
	const terminalBroker = {
		bindEmitter: vi.fn(),
		disconnect: vi.fn(),
		resolve: vi.fn(),
	};
	const gateway = new ClientGateway(
		clientService as never,
		jobService as never,
		fileService as never,
		frpService as never,
		requests,
		events,
		runs,
		terminalService as never,
		terminalBroker as never,
		{
			onClientRegistered: vi.fn(),
			onUpdateReady: vi.fn(),
			onUpdateFailed: vi.fn(),
		} as never,
		{ bindEmitters: vi.fn() } as never,
		undefined,
		undefined,
		{ bindSender: vi.fn(), onClientRegistered: vi.fn(), onDisconnected: vi.fn(), assertCompatible: vi.fn(), assertReady: vi.fn(), applyAck: vi.fn(), onState: vi.fn() } as never,
	);
	gateway.server = {
		emit: vi.fn(),
		to: vi.fn((socketId: string) => ({
			emit: (_event: string, request: PiRequest) =>
				requestHandlers.get(socketId)?.(request),
		})),
	} as never;
	gateway.afterInit();

	const controller = new PiController(
		requests,
		events,
		runs,
		sessions,
		clientService as never,
		attachments,
		{ assertCompatible: vi.fn(), assertReady: vi.fn() } as never,
	);

	const addSocket = (id: string) => {
		const socket = makeSocket(id);
		sockets.set(id, socket);
		return socket;
	};
	const respond = async (socket: Socket, response: PiResponse) => {
		await gateway.handlePiResponse(socket, response);
	};
	const autoRespond = (
		socket: Socket,
		state: Record<string, unknown> = idleState(),
	) => {
		requestHandlers.set(socket.id, (request) => {
			const data =
				request.action === "project.resolve"
					? { projectKey: PROJECT_KEY }
					: request.action === "agent.state"
						? state
						: { accepted: true };
			queueMicrotask(
				() =>
					void respond(socket, {
						requestId: request.requestId,
						ok: true,
						data,
					}),
			);
		});
	};
	const register = async (socket: Socket) => {
		await gateway.handleRegister(socket, registration());
	};
	const reconcile = async (socket: Socket, stateReport = report()) => {
		const result = await gateway.handlePiState(socket, stateReport);
		return result as unknown;
	};
	/** 会话控制面行(含 activeRunId);Run 状态用 currentRun 读取。 */
	const current = (sessionId: string) =>
		prisma.sessions.find((row) => row.id === sessionId)!;
	const currentRun = (runId: string) =>
		prisma.agentRuns.find((row) => row.id === runId)!;

	return {
		prisma,
		runs,
		sessions,
		requests,
		events,
		gateway,
		controller,
		jobService,
		attachmentFiles,
		requestHandlers,
		addSocket,
		respond,
		autoRespond,
		register,
		reconcile,
		current,
		currentRun,
	};
}

function idleState() {
	return {
		status: "idle",
		streaming: false,
		prompting: false,
		compacting: false,
		thinkingLevel: "off",
		queuedMessages: { steering: [], followUp: [] },
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("Pi Gateway loopback 集成", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("REGISTER→PI_STATE 后，Gateway 事件驱动 waiting→running→idle settlement", async () => {
		vi.useFakeTimers();
		const loop = makeLoopback();
		const socket = loop.addSocket("socket-1");
		loop.autoRespond(socket);
		await loop.register(socket);
		await expect(
			loop.controller.sessions("c1", "D:\\", "repo"),
		).rejects.toMatchObject({
			response: { code: "PI_STATE_PENDING" },
		});
		expect(await loop.reconcile(socket)).toEqual({
			acceptedRunIds: [],
			closedRunIds: [],
			reportAgain: false,
		});

		await loop.sessions.ensureSession(actor, {
			clientId: "c1",
			sessionId: "session-1",
		});
		const run = await loop.runs.startRun(actor, {
			clientId: "c1",
			sessionId: "session-1",
			projectKey: PROJECT_KEY,
			kind: "prompt",
		});
		await loop.runs.accept(run.sessionId, run.runId);
		const base = {
			clientId: "c1",
			sessionId: "session-1",
			runId: run.runId,
		};
		await loop.gateway.handlePiEvent(socket, {
			...base,
			event: {
				type: "extension_request",
				sessionId: "session-1",
				ui: { requestId: "ui-1", extensionId: "ext", kind: "confirm" },
			},
		} as PiEvent);
		expect(loop.currentRun(run.runId).status).toBe("waiting_input");
		await loop.gateway.handlePiEvent(socket, {
			...base,
			event: {
				type: "extension_resolved",
				sessionId: "session-1",
				requestId: "ui-1",
				reason: "answered",
				hasPending: false,
			},
		} as PiEvent);
		expect(loop.currentRun(run.runId).status).toBe("running");
		await loop.gateway.handlePiEvent(socket, {
			...base,
			event: { type: "agent_settled", sessionId: "session-1" },
		} as PiEvent);
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();
		// 自动结算为成功终局并释放会话指针;会话本身仍可用。
		expect(loop.currentRun(run.runId).status).toBe("succeeded");
		expect(loop.current("session-1")).toMatchObject({ activeRunId: null });
		expect(loop.current("session-1").status).toBe("available");
	});

	it("run-1/run-2 settlement 交错与 complete race 保持当前 run/done", async () => {
		vi.useFakeTimers();
		const loop = makeLoopback();
		const socket = loop.addSocket("socket-1");
		loop.autoRespond(socket);
		await loop.register(socket);
		await loop.reconcile(socket);
		await loop.sessions.ensureSession(actor, {
			clientId: "c1",
			sessionId: "session-1",
		});

		const run1 = await loop.runs.startRun(actor, {
			clientId: "c1",
			sessionId: "session-1",
			projectKey: PROJECT_KEY,
			kind: "prompt",
		});
		await loop.runs.accept(run1.sessionId, run1.runId);
		await loop.gateway.handlePiEvent(socket, {
			clientId: "c1",
			sessionId: "session-1",
			runId: run1.runId,
			event: { type: "agent_settled", sessionId: "session-1" },
		} as PiEvent);
		await loop.runs.settleRun(run1.sessionId, run1.runId, { status: "succeeded" });
		const run2 = await loop.runs.startRun(actor, {
			clientId: "c1",
			sessionId: "session-1",
			projectKey: PROJECT_KEY,
			kind: "prompt",
		});
		await loop.runs.accept(run2.sessionId, run2.runId);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(loop.current("session-1")).toMatchObject({ activeRunId: run2.runId });
		expect(loop.currentRun(run1.runId).status).toBe("succeeded");
		expect(loop.currentRun(run2.runId).status).toBe("running");

		await loop.gateway.handlePiEvent(socket, {
			clientId: "c1",
			sessionId: "session-1",
			runId: run2.runId,
			event: { type: "agent_settled", sessionId: "session-1" },
		} as PiEvent);
		await loop.runs.settleRun("session-1", run2.runId, { status: "succeeded" });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(loop.currentRun(run2.runId).status).toBe("succeeded");
		expect(loop.current("session-1")).toMatchObject({ activeRunId: null });
	});

	it("projectKey 冲突要求二次 PI_STATE；prompt_error sentinel 不持久化", async () => {
		const loop = makeLoopback();
		const socket = loop.addSocket("socket-1");
		await loop.sessions.ensureSession(actor, {
			clientId: "c1",
			sessionId: "session-1",
		});
		await loop.sessions.ensureSession(actor, {
			clientId: "c1",
			sessionId: "session-2",
		});
		const run1 = await loop.runs.startRun(actor, {
			clientId: "c1",
			sessionId: "session-1",
			projectKey: "1".repeat(64),
			kind: "prompt",
		});
		const run2 = await loop.runs.startRun(actor, {
			clientId: "c1",
			sessionId: "session-2",
			projectKey: "2".repeat(64),
			kind: "prompt",
		});
		await loop.runs.accept(run1.sessionId, run1.runId);
		await loop.runs.accept(run2.sessionId, run2.runId);
		await loop.register(socket);
		expect(
			await loop.reconcile(
				socket,
				report([
					{
						sessionId: "session-1",
						runId: run1.runId,
						status: "running",
						projectKey: PROJECT_KEY,
					},
					{
						sessionId: "session-2",
						runId: run2.runId,
						status: "running",
						projectKey: PROJECT_KEY,
					},
				]),
			),
		).toEqual({
			acceptedRunIds: [],
			closedRunIds: [run1.runId, run2.runId],
			reportAgain: true,
		});
		await expect(
			loop.controller.sessions("c1", "D:\\", "repo"),
		).rejects.toMatchObject({
			response: { code: "PI_STATE_PENDING" },
		});
		expect(await loop.reconcile(socket)).toEqual({
			acceptedRunIds: [],
			closedRunIds: [],
			reportAgain: false,
		});

		loop.autoRespond(socket);
		const run3 = await loop.controller.prompt(
			"c1",
			"session-3",
			{
				rootDir: `D:\\${URL_SENTINEL}`,
				relativePath: "repo",
				type: "prompt",
				submissionId: "submission-sensitive",
				prompt: PROMPT_SENTINEL,
			},
			actor,
		);
		const events = [
			{
				type: "message_update",
				sessionId: "session-3",
				text: PROMPT_SENTINEL,
			},
			{
				type: "thinking_progress",
				sessionId: "session-3",
				text: `${THINKING_SENTINEL} ${URL_SENTINEL}`,
			},
			{
				type: "message_update",
				sessionId: "session-3",
				text: TOOL_SENTINEL,
				role: "tool_result",
			},
			{
				type: "extension_request",
				sessionId: "session-3",
				ui: {
					requestId: "ui-sensitive",
					extensionId: "ext",
					kind: "input",
					message: EXTENSION_SENTINEL,
				},
			},
			{
				type: "prompt_error",
				sessionId: "session-3",
				code: "PI_WORKER_EXITED",
				message: ERROR_SENTINEL,
			},
		] as const;
		for (const event of events) {
			await loop.gateway.handlePiEvent(socket, {
				clientId: "c1",
				sessionId: "session-3",
				runId: run3.runId,
				event,
			} as PiEvent);
		}
		const session = loop.current("session-3");
		const failedRun = loop.currentRun(run3.runId);
		// 失败摘要只保留安全错误码,不含外部错误正文。
		expect(failedRun).toMatchObject({ status: "failed", errorCode: "PI_WORKER_EXITED" });
		expect(session).not.toHaveProperty("errorMessage");
		const persisted = JSON.stringify({
			calls: loop.prisma.calls,
			session,
			failedRun,
		});
		for (const sentinel of SENSITIVE_SENTINELS) {
			expect(persisted).not.toContain(sentinel);
		}
	});

	it.each([
		[
			"active",
			{ ...idleState(), status: "running", streaming: true },
			"running",
		],
		["not-started", idleState(), "idle"],
	] as const)(
		"prompt timeout 但 Worker %s 时按权威 state 收敛",
		async (_name, state, expectedStatus) => {
			vi.useFakeTimers();
			const loop = makeLoopback();
			const socket = loop.addSocket("socket-1");
			await loop.register(socket);
			await loop.reconcile(socket);
			loop.requestHandlers.set(socket.id, (request) => {
				if (request.action === "project.resolve") {
					queueMicrotask(
						() =>
							void loop.respond(socket, {
								requestId: request.requestId,
								ok: true,
								data: { projectKey: PROJECT_KEY },
							}),
					);
				} else if (request.action === "agent.state") {
					queueMicrotask(
						() =>
							void loop.respond(socket, {
								requestId: request.requestId,
								ok: true,
								data: state,
							}),
					);
				}
			});

			const prompt = loop.controller.prompt(
				"c1",
				"session-timeout",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					type: "prompt",
					submissionId: "submission-timeout",
					prompt: PROMPT_SENTINEL,
				},
				actor,
			);
			const outcome = expect(prompt).rejects.toMatchObject({
				response: { code: "PI_REQUEST_TIMEOUT" },
			});
			await flush();
			await vi.advanceTimersByTimeAsync(15_000);
			await outcome;
			const session = loop.current("session-timeout");
			if (expectedStatus === "running") {
				expect(loop.currentRun(session.activeRunId as string).status).toBe("running");
			} else {
				expect(session.activeRunId).toBeNull();
			}
		},
	);

	it("REST lease 跨 await 阻塞 REGISTER，且新旧 socket 响应/断线隔离", async () => {
		const loop = makeLoopback();
		const oldSocket = loop.addSocket("socket-1");
		const newSocket = loop.addSocket("socket-2");
		await loop.register(oldSocket);
		await loop.reconcile(oldSocket);
		await loop.sessions.ensureSession(actor, { clientId: "c1", sessionId: "session-legacy" });
		const emitted: PiRequest[] = [];
		loop.requestHandlers.set(oldSocket.id, (request) => emitted.push(request));

		const prompt = loop.controller.prompt(
			"c1",
			"session-legacy",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				type: "prompt",
				submissionId: "submission-1",
				prompt: PROMPT_SENTINEL,
			},
			actor,
		);
		await flush();
		expect(emitted[0]?.action).toBe("project.resolve");
		const nextRegister = loop.register(newSocket);
		await flush();
		expect(newSocket.data.clientId).toBe("c1");
		expect(newSocket.emit as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
			"ack",
			expect.anything(),
		);

		const resolveRequest = emitted[0]!;
		await loop.respond(newSocket, {
			requestId: resolveRequest.requestId,
			ok: true,
			data: { projectKey: "f".repeat(64) },
		});
		await flush();
		expect(emitted).toHaveLength(1);
		await loop.respond(oldSocket, {
			requestId: resolveRequest.requestId,
			ok: true,
			data: { projectKey: PROJECT_KEY },
		});
		await flush();
		await vi.waitFor(() => expect(emitted[1]?.action).toBe("agent.prompt"));
		expect(emitted[1]?.payload?.executionMode).toBe("supervised");
		const promptRequest = emitted[1]!;
		await loop.respond(newSocket, {
			requestId: promptRequest.requestId,
			ok: true,
			data: { accepted: false },
		});
		await flush();
		await loop.respond(oldSocket, {
			requestId: promptRequest.requestId,
			ok: true,
			data: { accepted: true },
		});
		await expect(prompt).resolves.toMatchObject({
			sessionId: "session-legacy",
		});
		await nextRegister;
		expect(newSocket.emit).toHaveBeenCalledWith("ack", { event: "register" });
		await loop.reconcile(newSocket);

		const beforeDisconnect = structuredClone(loop.prisma.sessions[0]);
		await loop.gateway.handleDisconnect(oldSocket);
		expect(loop.jobService.markDisconnected).not.toHaveBeenCalled();
		expect(loop.prisma.sessions[0]).toEqual(beforeDisconnect);
	});

	it("纯图片 prompt 通过真实附件校验下发服务端描述符，无内容请求不创建 Run", async () => {
		const loop = makeLoopback();
		const socket = loop.addSocket("socket-1");
		await loop.register(socket);
		await loop.reconcile(socket);
		loop.attachmentFiles.push({
			id: "f1",
			key: "k1",
			clientId: "c1",
			filename: "a.png",
			mimeType: "image/png",
			size: 1024,
			sha256: "sha-1",
			status: "completed",
			purpose: "pi_prompt",
			expiresAt: new Date(Date.now() + 60_000),
			storageKind: "local",
			createdAt: new Date(),
		});
		const emitted: PiRequest[] = [];
		loop.requestHandlers.set(socket.id, (request) => {
			emitted.push(request);
			const data =
				request.action === "project.resolve"
					? { projectKey: PROJECT_KEY }
					: { accepted: true };
			queueMicrotask(
				() =>
					void loop.respond(socket, {
						requestId: request.requestId,
						ok: true,
						data,
					}),
			);
		});
		const image = {
			fileId: "f1",
			sha256: "sha-1",
			size: 1024,
			mimeType: "image/png",
			url: "https://evil.test/forged",
			expiresAt: Date.now() + 60_000,
		};
		const jobsBefore = loop.prisma.jobs.length;

		await loop.controller.prompt(
			"c1",
			"session-image",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				type: "prompt",
				submissionId: "submission-image",
				prompt: "",
				images: [image],
			},
			actor,
		);

		const dispatched = emitted.find(
			(request) => request.action === "agent.prompt",
		);
		expect(dispatched?.payload).toMatchObject({
			prompt: "",
			attachments: [
				{
					fileId: "f1",
					sha256: "sha-1",
					size: 1024,
					mimeType: "image/png",
				},
			],
		});
		expect(JSON.stringify(emitted)).not.toContain("evil.test");
		// ADR-0041:接纳 Run 不再写 Job,改为独立 AgentRun 行。
		expect(loop.prisma.agentRuns.length).toBe(jobsBefore + 1);
		expect(loop.prisma.jobs.length).toBe(jobsBefore);

		// 无内容与无效引用都必须在创建 Run 之前被拒。
		const jobsAfterValid = loop.prisma.agentRuns.length;
		await expect(
			loop.controller.prompt(
				"c1",
				"session-empty",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					type: "prompt",
					submissionId: "submission-empty",
					prompt: "   ",
				},
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
		await expect(
			loop.controller.prompt(
				"c1",
				"session-stale",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					type: "prompt",
					submissionId: "submission-stale",
					prompt: "",
					images: [{ ...image, fileId: "missing" }],
				},
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_IMAGE_INVALID" } });
		expect(loop.prisma.agentRuns.length).toBe(jobsAfterValid);
	});
});

describe("Pi Gateway 扩展命令 loopback(ADR-0040 决策 2)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("executeCommand 接纳 Run → 下发命令 → 项目互斥 → 结算 → 未注册命令拒绝与恢复", async () => {
		// 外层 describe 的 afterEach 会 useRealTimers，故必须在测试体内启用。
		vi.useFakeTimers();
		const loop = makeLoopback();
		const socket = loop.addSocket("socket-1");
		loop.requestHandlers.set(socket.id, (request) => {
			emitted.push(request);
			const data =
				request.action === "project.resolve"
					? { projectKey: PROJECT_KEY }
					: request.action === "agent.state"
						// 结算检查会查询权威 state:回环返回空闲,让 Run 能收敛。
						? idleState()
						: request.action === "agent.command" && request.payload?.name === "nope"
						? // 未注册命令由 Client 以结果数据返回(transport ok),由 Server 映射 400
							{
								ok: false,
								error: {
									code: "PI_EXTENSION_COMMAND_NOT_FOUND",
									message: "Unknown Pi command: nope",
								},
							}
						: { accepted: true };
			queueMicrotask(
				() =>
					void loop.respond(socket, {
						requestId: request.requestId,
						ok: true,
						data,
					}),
			);
		});

		await loop.register(socket);
		await loop.reconcile(socket);
		const emitted: PiRequest[] = [];

		// 1) 已注册命令:接纳 Run 并下发 agent.command。
		const acceptedRun = (await loop.controller.executeCommand(
			"c1",
			"session-cmd",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				submissionId: "sub-cmd-1",
				name: "review",
				args: "src/pi",
			},
			actor,
		)) as { runId: string; sessionId: string };
		expect(acceptedRun).toMatchObject({ sessionId: "session-cmd" });
		const dispatched = emitted.find(
			(request) => request.action === "agent.command",
		);
		expect(dispatched?.payload).toMatchObject({ name: "review", args: "src/pi" });
		// Run 由 Server 接纳:调用方无法自带 runId 绕过互斥。
		expect(dispatched?.runId).toBeTruthy();
		expect(loop.current("session-cmd")).toBeDefined();

		// 2) 项目互斥:Run 活跃期间,下一条命令必须被拒。
		await expect(
			loop.controller.executeCommand(
				"c1",
				"session-cmd",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					submissionId: "sub-cmd-busy",
					name: "review",
				},
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_PROJECT_BUSY" } });
		// 被互斥拒绝的请求不得下发到 Client。
		expect(
			emitted.filter((r) => r.action === "agent.command"),
		).toHaveLength(1);

		// 3) 结算:Client 上报 agent_settled 驱动 Run 收敛。
		await loop.gateway.handlePiEvent(socket, {
			clientId: "c1",
			sessionId: "session-cmd",
			runId: acceptedRun.runId,
			event: { type: "agent_settled", sessionId: "session-cmd" },
		} as PiEvent);
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();
		expect(loop.currentRun(acceptedRun.runId).status).toBe("succeeded");
		expect(loop.current("session-cmd")).toMatchObject({ activeRunId: null });

		// 4) 未注册命令:能到达 Client 并被拒绝,翻成 400 且 Run 即时结算。
		await expect(
			loop.controller.executeCommand(
				"c1",
				"session-cmd",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					submissionId: "sub-cmd-4",
					name: "nope",
				},
				actor,
			),
		).rejects.toMatchObject({
			response: { code: "PI_EXTENSION_COMMAND_NOT_FOUND" },
		});
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();
		// 被拒绝的一轮以失败终局结算,会话指针释放,可再次执行。
		expect(loop.current("session-cmd")).toMatchObject({ activeRunId: null });
		expect(
			loop.prisma.agentRuns.some((row) => row.status === "failed"),
		).toBe(true);

		// 5) 拒绝结算后可再次执行。
		await expect(
			loop.controller.executeCommand(
				"c1",
				"session-cmd",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					submissionId: "sub-cmd-5",
					name: "review",
				},
				actor,
			),
		).resolves.toMatchObject({ sessionId: "session-cmd" });

		expect(
			emitted.filter((r) => r.action === "agent.command"),
		).toHaveLength(3);
	});
});
