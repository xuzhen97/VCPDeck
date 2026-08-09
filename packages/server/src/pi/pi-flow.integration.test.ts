import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiEvent, PiRequest, PiResponse, PiStateReport } from "@vcpdeck/shared";
import type { Socket } from "socket.io";
import { ClientGateway } from "../events/client.gateway.js";
import { PiController } from "./pi.controller.js";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";

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
	if (condition && typeof condition === "object" && !Array.isArray(condition)) {
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
			if (jobs.some((candidate) => candidate.id === args.data.id)) throw { code: "P2002" };
			const created = {
				payload: "{}",
				progress: null,
				result: null,
				errorCode: null,
				errorMessage: null,
				startedAt: null,
				finishedAt: null,
				...args.data,
			};
			jobs.push(created);
			return created;
		}),
		findUnique: vi.fn(async (args: { where: { id: string } }) =>
			jobs.find((candidate) => candidate.id === args.where.id) ?? null),
		findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			jobs.filter((candidate) => Object.entries(args?.where ?? {}).every(
				([key, value]) => matches(candidate[key], value),
			))),
		update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
			calls.push(args);
			const candidate = jobs.find((item) => item.id === args.where.id);
			if (!candidate) throw new Error("not found");
			Object.assign(candidate, args.data);
			return candidate;
		}),
		updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
			calls.push(args);
			let count = 0;
			for (const candidate of jobs) {
				if (Object.entries(args.where).every(([key, value]) => matches(candidate[key], value))) {
					Object.assign(candidate, args.data);
					count += 1;
				}
			}
			return { count };
		}),
	};
	return { job, jobs, calls };
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
				sessionJobProtocolVersion: 1,
			},
		},
	};
}

function report(runs: PiStateReport["runs"] = []): PiStateReport {
	return { clientId: "c1", runs };
}

function makeLoopback() {
	const prisma = makePrismaMemory();
	const runs = new PiRunService(prisma as never);
	const requests = new PiRequestBroker();
	const events = new PiEventBroker(requests, runs);
	const sockets = new Map<string, Socket>();
	const requestHandlers = new Map<string, (request: PiRequest) => void>();
	const clientService = {
		register: vi.fn(async () => {}),
		markOfflineBySocketId: vi.fn(async () => {}),
		listOnline: vi.fn(async () => [{
			clientId: "c1",
			capabilities: ["agent.pi"],
			capabilityDetails: { pi: { available: true } },
		}]),
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
	const gateway = new ClientGateway(
		clientService as never,
		jobService as never,
		fileService as never,
		frpService as never,
		requests,
		events,
		runs,
	);
	gateway.server = {
		emit: vi.fn(),
		to: vi.fn((socketId: string) => ({
			emit: (_event: string, request: PiRequest) => requestHandlers.get(socketId)?.(request),
		})),
	} as never;
	gateway.afterInit();

	const controller = new PiController(
		requests,
		events,
		runs,
		clientService as never,
		{
			createPromptUploads: vi.fn(),
			completePromptUpload: vi.fn(),
			deleteAttachment: vi.fn(),
		} as never,
	);

	const addSocket = (id: string) => {
		const socket = makeSocket(id);
		sockets.set(id, socket);
		return socket;
	};
	const respond = async (socket: Socket, response: PiResponse) => {
		await gateway.handlePiResponse(socket, response);
	};
	const autoRespond = (socket: Socket, state: Record<string, unknown> = idleState()) => {
		requestHandlers.set(socket.id, (request) => {
			const data = request.action === "project.resolve"
				? { projectKey: PROJECT_KEY }
				: request.action === "agent.state"
					? state
					: { accepted: true };
			queueMicrotask(() => void respond(socket, { requestId: request.requestId, ok: true, data }));
		});
	};
	const register = async (socket: Socket) => {
		await gateway.handleRegister(socket, registration(), vi.fn());
	};
	const reconcile = async (socket: Socket, stateReport = report()) => {
		let ack: unknown;
		await gateway.handlePiState(socket, stateReport, (value) => { ack = value; });
		return ack;
	};
	const current = (jobId: string) => prisma.jobs.find((job) => job.id === jobId)!;

	return {
		prisma,
		runs,
		requests,
		events,
		gateway,
		controller,
		jobService,
		requestHandlers,
		addSocket,
		respond,
		autoRespond,
		register,
		reconcile,
		current,
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
		await expect(loop.controller.sessions("c1", "D:\\", "repo")).rejects.toMatchObject({
			response: { code: "PI_STATE_PENDING" },
		});
		expect(await loop.reconcile(socket)).toEqual({
			acceptedRunIds: [], closedRunIds: [], reportAgain: false,
		});

		await loop.runs.ensureSession(actor, { clientId: "c1", sessionId: "session-1" });
		const run = await loop.runs.startRun(actor, {
			clientId: "c1", sessionId: "session-1", projectKey: PROJECT_KEY,
		});
		await loop.runs.accept(run.jobId, run.runId);
		const base = { clientId: "c1", sessionId: "session-1", jobId: "session-1", runId: run.runId };
		await loop.gateway.handlePiEvent(socket, {
			...base,
			event: {
				type: "extension_request",
				sessionId: "session-1",
				ui: { requestId: "ui-1", extensionId: "ext", kind: "confirm" },
			},
		} as PiEvent);
		expect(loop.current("session-1").status).toBe("waiting_input");
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
		expect(loop.current("session-1").status).toBe("running");
		await loop.gateway.handlePiEvent(socket, {
			...base,
			event: { type: "agent_settled", sessionId: "session-1" },
		} as PiEvent);
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();
		expect(loop.current("session-1")).toMatchObject({ status: "idle", payload: "{}" });
	});

	it("run-1/run-2 settlement 交错与 complete race 保持当前 run/done", async () => {
		vi.useFakeTimers();
		const loop = makeLoopback();
		const socket = loop.addSocket("socket-1");
		loop.autoRespond(socket);
		await loop.register(socket);
		await loop.reconcile(socket);
		await loop.runs.ensureSession(actor, { clientId: "c1", sessionId: "session-1" });

		const run1 = await loop.runs.startRun(actor, {
			clientId: "c1", sessionId: "session-1", projectKey: PROJECT_KEY,
		});
		await loop.runs.accept(run1.jobId, run1.runId);
		await loop.gateway.handlePiEvent(socket, {
			clientId: "c1", sessionId: "session-1", jobId: "session-1", runId: run1.runId,
			event: { type: "agent_settled", sessionId: "session-1" },
		} as PiEvent);
		await loop.runs.finishRun(run1.jobId, run1.runId);
		const run2 = await loop.runs.startRun(actor, {
			clientId: "c1", sessionId: "session-1", projectKey: PROJECT_KEY,
		});
		await loop.runs.accept(run2.jobId, run2.runId);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(loop.current("session-1")).toMatchObject({
			status: "running", payload: JSON.stringify({ runId: run2.runId }),
		});

		await loop.gateway.handlePiEvent(socket, {
			clientId: "c1", sessionId: "session-1", jobId: "session-1", runId: run2.runId,
			event: { type: "agent_settled", sessionId: "session-1" },
		} as PiEvent);
		await loop.runs.completeSession("session-1", run2.runId);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(loop.current("session-1")).toMatchObject({ status: "done", payload: "{}" });
	});

	it("projectKey 冲突要求二次 PI_STATE；prompt_error sentinel 不持久化", async () => {
		const loop = makeLoopback();
		const socket = loop.addSocket("socket-1");
		await loop.runs.ensureSession(actor, { clientId: "c1", sessionId: "session-1" });
		await loop.runs.ensureSession(actor, { clientId: "c1", sessionId: "session-2" });
		const run1 = await loop.runs.startRun(actor, {
			clientId: "c1", sessionId: "session-1", projectKey: "1".repeat(64),
		});
		const run2 = await loop.runs.startRun(actor, {
			clientId: "c1", sessionId: "session-2", projectKey: "2".repeat(64),
		});
		await loop.runs.accept(run1.jobId, run1.runId);
		await loop.runs.accept(run2.jobId, run2.runId);
		await loop.register(socket);
		expect(await loop.reconcile(socket, report([
			{ jobId: "session-1", sessionId: "session-1", runId: run1.runId, status: "running", projectKey: PROJECT_KEY },
			{ jobId: "session-2", sessionId: "session-2", runId: run2.runId, status: "running", projectKey: PROJECT_KEY },
		]))).toEqual({
			acceptedRunIds: [],
			closedRunIds: [run1.runId, run2.runId],
			reportAgain: true,
		});
		await expect(loop.controller.sessions("c1", "D:\\", "repo")).rejects.toMatchObject({
			response: { code: "PI_STATE_PENDING" },
		});
		expect(await loop.reconcile(socket)).toEqual({
			acceptedRunIds: [], closedRunIds: [], reportAgain: false,
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
				clientId: "c1", sessionId: "session-3", jobId: run3.jobId, runId: run3.runId,
				event,
			} as PiEvent);
		}
		const job = loop.current(run3.jobId);
		expect(job).toMatchObject({
			errorMessage: null,
			progress: null,
			result: null,
		});
		const persisted = JSON.stringify({ calls: loop.prisma.calls, job });
		for (const sentinel of SENSITIVE_SENTINELS) {
			expect(persisted).not.toContain(sentinel);
		}
	});

	it("REST lease 跨 await 阻塞 REGISTER，且新旧 socket 响应/断线隔离", async () => {
		const loop = makeLoopback();
		const oldSocket = loop.addSocket("socket-1");
		const newSocket = loop.addSocket("socket-2");
		await loop.register(oldSocket);
		await loop.reconcile(oldSocket);
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
		expect((newSocket.emit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith(
			"ack", expect.anything(),
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
		expect(emitted[1]?.action).toBe("agent.prompt");
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
		await expect(prompt).resolves.toMatchObject({ sessionId: "session-legacy" });
		await nextRegister;
		expect(newSocket.emit).toHaveBeenCalledWith("ack", { event: "register" });
		await loop.reconcile(newSocket);

		const beforeDisconnect = { ...loop.prisma.jobs[0] };
		await loop.gateway.handleDisconnect(oldSocket);
		expect(loop.jobService.markDisconnected).not.toHaveBeenCalled();
		expect(loop.prisma.jobs[0]).toEqual(beforeDisconnect);
	});
});
