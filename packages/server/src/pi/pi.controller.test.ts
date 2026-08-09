import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { PiAgentState, PiSessionJobSnapshot } from "@vcpdeck/shared";
import { PiController } from "./pi.controller.js";

const cwdRef = { rootDir: "D:\\", relativePath: "repo" };
const idleAgentState: PiAgentState = {
	status: "idle",
	streaming: false,
	prompting: false,
	compacting: false,
	thinkingLevel: "medium",
	queuedMessages: { steering: [], followUp: [] },
};
const waitingAgentState: PiAgentState = {
	...idleAgentState,
	status: "waiting_for_extension_input",
	waitingForExtensionInput: true,
};
const idleSnapshot: PiSessionJobSnapshot = {
	jobId: "s1",
	sessionId: "s1",
	status: "idle",
	runId: null,
	ownerName: "User",
	isOwner: true,
};

const actor = {
	identityId: "user-1",
	displayName: "User",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "req-1",
} as const;

function makeController(
	overrides: Partial<
		Record<"requests" | "events" | "runs" | "clients", unknown>
	> = {},
) {
	const requests = {
		request: vi.fn(async (_lease: { clientId: string; socketId: string }, _req: { action: string }) => ({
			ok: true,
			data: {},
		})),
		bindEmitter: vi.fn(),
		...((overrides.requests as object) ?? {}),
	};
	const events = {
		publish: vi.fn(async () => {}),
		stream: vi.fn(() => ({ subscribe: () => () => {} })),
		...((overrides.events as object) ?? {}),
	};
	const runs = {
		ensureSession: vi.fn(async () => {}),
		snapshot: vi.fn(async () => idleSnapshot),
		startRun: vi.fn(async () => ({ jobId: "s1", runId: "run-1" })),
		accept: vi.fn(async () => true),
		finishRun: vi.fn(async () => true),
		completeSession: vi.fn(async () => true),
		reconcileOpen: vi.fn(async () => true),
		markRunDisconnected: vi.fn(async () => true),
		beginDelete: vi.fn(async () => ({ deleteToken: "delete-1", previousStatus: "idle", existingReservation: false })),
		rollbackDelete: vi.fn(async () => true),
		commitDelete: vi.fn(async () => true),
		resume: vi.fn(async () => true),
		assertSessionOwner: vi.fn(async () => {}),
		assertCurrentRunOwner: vi.fn(async () => {}),
		assertIdleMutation: vi.fn(async () => {}),
		listActiveByClient: vi.fn(async () => []),
		withReconciledClient: vi.fn(async (clientId: string, operation: (lease: { clientId: string; socketId: string }) => Promise<unknown>) =>
			operation({ clientId, socketId: "socket-1" })),
		...((overrides.runs as object) ?? {}),
	};
	const clients = {
		listOnline: vi.fn(async () => [
			{
				clientId: "c1",
				capabilities: ["pi.probe", "agent.pi"],
				capabilityDetails: { pi: { available: true, sessionJobProtocolVersion: 1 } },
			},
		]),
		...((overrides.clients as object) ?? {}),
	};
	const attachments = {
		createPromptUploads: vi.fn(async () => []),
		completePromptUpload: vi.fn(),
		deleteAttachment: vi.fn(async () => {}),
		prepareHistoryUpload: vi.fn(),
		completeHistoryUpload: vi.fn(),
	};
	const controller = new PiController(
		requests as never,
		events as never,
		runs as never,
		clients as never,
		attachments as never,
	);
	return { controller, requests, events, runs, clients, attachments };
}

describe("PiController", () => {
	it("capability 返回 Client 的 Pi 状态", async () => {
		const { controller } = makeController();
		const result = await controller.capability("c1");
		expect(result).toMatchObject({ available: true });
	});

	it("旧 Client 返回 PI_CLIENT_UNSUPPORTED", async () => {
		const { controller, clients } = makeController();
		(clients.listOnline as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ clientId: "c1", capabilities: ["exec"], capabilityDetails: {} },
		]);
		const result = await controller.capability("c1");
		expect(result).toMatchObject({ code: "PI_CLIENT_UNSUPPORTED" });
	});

	it("newSession 创建同 ID Session Job", async () => {
		const { controller, requests, runs } = makeController();
		requests.request.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } });

		await expect(controller.newSession("c1", cwdRef, actor)).resolves.toEqual({
			sessionId: "s1",
			jobId: "s1",
		});
		expect(runs.ensureSession).toHaveBeenCalledWith(actor, {
			clientId: "c1",
			sessionId: "s1",
		});
	});

	it("open 验证 Session、补建 Job、原子对账并返回双权威状态", async () => {
		const activeSnapshot = { ...idleSnapshot, status: "running" as const, runId: "run-1" };
		const { controller, requests, runs } = makeController({
			runs: { snapshot: vi.fn().mockResolvedValueOnce(activeSnapshot).mockResolvedValueOnce(activeSnapshot) },
		});
		requests.request
			.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } })
			.mockResolvedValueOnce({ ok: true, data: waitingAgentState });

		await expect(controller.openSession("c1", "s1", cwdRef, actor)).resolves.toEqual({
			job: activeSnapshot,
			agentState: waitingAgentState,
		});
		expect(runs.ensureSession).toHaveBeenCalledWith(actor, { clientId: "c1", sessionId: "s1" });
		expect(runs.reconcileOpen).toHaveBeenCalledWith("s1", "run-1", waitingAgentState);
		expect(requests.request).toHaveBeenLastCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "agent.state", jobId: "s1", runId: "run-1" }),
		);
	});

	it("没有活动 run 的 open 使用只读 agent.state", async () => {
		const { controller, requests, runs } = makeController();
		requests.request
			.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } })
			.mockResolvedValueOnce({ ok: true, data: idleAgentState });

		await controller.openSession("c1", "s1", cwdRef, actor);
		expect(runs.reconcileOpen).not.toHaveBeenCalled();
		expect(requests.request).toHaveBeenLastCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "agent.state", sessionId: "s1", runId: undefined }),
		);
	});

	it("complete running 先权威 abort 再完成 matching run", async () => {
		const activeSnapshot = { ...idleSnapshot, status: "running" as const, runId: "run-1" };
		const doneSnapshot = { ...idleSnapshot, status: "done" as const };
		const { controller, requests, runs } = makeController({
			runs: { snapshot: vi.fn().mockResolvedValueOnce(activeSnapshot).mockResolvedValueOnce(doneSnapshot) },
		});

		await expect(controller.completeSession("c1", "s1", { runId: "run-1" }, actor))
			.resolves.toEqual(doneSnapshot);
		expect(requests.request).toHaveBeenCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "agent.abort", jobId: "s1", runId: "run-1" }),
		);
		expect(runs.completeSession).toHaveBeenCalledWith("s1", "run-1");
	});

	it("error complete 不请求 Client 并直接完成", async () => {
		const snapshot = { ...idleSnapshot, status: "error" as const };
		const done = { ...idleSnapshot, status: "done" as const };
		const { controller, requests, runs } = makeController({
			runs: { snapshot: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(done) },
		});
		await expect(controller.completeSession("c1", "s1", {}, actor)).resolves.toEqual(done);
		expect(requests.request).not.toHaveBeenCalled();
		expect(runs.completeSession).toHaveBeenCalledWith("s1", undefined);
	});

	it("disconnected complete 不请求 Client", async () => {
		const snapshot = { ...idleSnapshot, status: "disconnected" as const, runId: "run-1" };
		const { controller, requests } = makeController({
			runs: { snapshot: vi.fn().mockResolvedValue(snapshot), completeSession: vi.fn(async () => true) },
		});
		await controller.completeSession("c1", "s1", { runId: "run-1" }, actor);
		expect(requests.request).not.toHaveBeenCalled();
	});

	it("complete 延迟 abort 时新 run 抢先则稳定冲突且不 abort 新 run", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const first = { ...idleSnapshot, status: "running" as const, runId: "run-1" };
		const next = { ...idleSnapshot, status: "pending" as const, runId: "run-2" };
		const { controller, requests } = makeController({
			requests: { request: vi.fn(async (_lease, request: { action: string }) => {
				if (request.action === "agent.abort") await gate;
				return { ok: true, data: {} };
			}) },
			runs: {
				snapshot: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next),
				completeSession: vi.fn(async () => false),
			},
		});
		const completion = controller.completeSession("c1", "s1", { runId: "run-1" }, actor);
		await vi.waitFor(() => expect(requests.request).toHaveBeenCalledOnce());
		release();
		await expect(completion).rejects.toMatchObject({
			response: { code: "PI_CONTROL_FORBIDDEN" },
		});
		expect(requests.request).toHaveBeenCalledTimes(1);
		expect(requests.request).toHaveBeenCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "agent.abort", runId: "run-1" }),
		);
	});

	it("delete 成功/不存在 commit，执行前拒绝直接 rollback", async () => {
		const { controller, requests, runs } = makeController();
		requests.request
			.mockResolvedValueOnce({ ok: true, data: { ok: true } })
			.mockResolvedValueOnce({ ok: false, error: { code: "PI_SESSION_NOT_FOUND", message: "gone" } } as never)
			.mockResolvedValueOnce({ ok: false, error: { code: "PI_PROJECT_NOT_ALLOWED", message: "denied" } } as never);

		const remove = () => Reflect.apply(controller.deleteSession, controller, ["c1", "s1", cwdRef, actor]);
		await expect(remove()).resolves.toEqual({ ok: true });
		await expect(remove()).resolves.toEqual({ ok: true });
		await expect(remove()).rejects.toMatchObject({ response: { code: "PI_PROJECT_NOT_ALLOWED" } });
		expect(runs.beginDelete).toHaveBeenCalledTimes(3);
		expect(runs.commitDelete).toHaveBeenCalledTimes(2);
		expect(runs.rollbackDelete).toHaveBeenCalledTimes(1);
	});

	it.each([
		["exists", { ok: true, data: { sessionId: "s1" } }, "rollbackDelete"],
		["gone", { ok: false, error: { code: "PI_SESSION_NOT_FOUND", message: "gone" } }, "commitDelete"],
	] as const)("delete 不确定错误经 session.get 确认 %s", async (_name, confirmation, transition) => {
		const { controller, requests, runs } = makeController();
		requests.request
			.mockResolvedValueOnce({ ok: false, error: { code: "PI_WORKER_EXITED", message: "died" } } as never)
			.mockResolvedValueOnce(confirmation as never);
		const operation = Reflect.apply(controller.deleteSession, controller, ["c1", "s1", cwdRef, actor]);
		if (transition === "commitDelete") await expect(operation).resolves.toEqual({ ok: true });
		else await expect(operation).rejects.toMatchObject({ response: { code: "PI_WORKER_EXITED" } });
		expect(requests.request).toHaveBeenLastCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "session.get", sessionId: "s1", cwdRef }),
		);
		expect(runs[transition]).toHaveBeenCalledWith("s1", "delete-1");
	});

	it("delete 确认超时保留 reservation", async () => {
		const timeout = Object.assign(new Error("timeout"), { code: "PI_REQUEST_TIMEOUT" });
		const { controller, requests, runs } = makeController();
		requests.request
			.mockResolvedValueOnce({ ok: false, error: { code: "PI_WORKER_EXITED", message: "died" } } as never)
			.mockRejectedValueOnce(timeout);
		await expect(Reflect.apply(controller.deleteSession, controller, ["c1", "s1", cwdRef, actor]))
			.rejects.toMatchObject({ response: { code: "PI_REQUEST_TIMEOUT" } });
		expect(runs.rollbackDelete).not.toHaveBeenCalled();
		expect(runs.commitDelete).not.toHaveBeenCalled();
	});

	it.each(["PI_REQUEST_TIMEOUT", "PI_CLIENT_DISCONNECTED"])(
		"delete %s 保留 reservation 供重试",
		async (code) => {
			const failure = Object.assign(new Error(code), { code });
			const { controller, runs } = makeController({
				requests: { request: vi.fn(async () => { throw failure; }) },
			});
			await expect(Reflect.apply(controller.deleteSession, controller, ["c1", "s1", cwdRef, actor])).rejects.toMatchObject({
				response: { code },
			});
			expect(runs.rollbackDelete).not.toHaveBeenCalled();
			expect(runs.commitDelete).not.toHaveBeenCalled();
		},
	);

	it("delete 未取得 reservation 不请求 Client", async () => {
		const busy = Object.assign(new Error("busy"), { code: "PI_PROJECT_BUSY" });
		const { controller, requests } = makeController({
			runs: { beginDelete: vi.fn(async () => { throw busy; }) },
		});
		await expect(Reflect.apply(controller.deleteSession, controller, ["c1", "s1", cwdRef, actor])).rejects.toMatchObject({
			response: { code: "PI_PROJECT_BUSY" },
		});
		expect(requests.request).not.toHaveBeenCalled();
	});

	it("sessions.list 转发 cwdRef", async () => {
		const { controller, requests } = makeController();
		await controller.sessions("c1", "D:\\", "repo");
		expect(requests.request).toHaveBeenCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({
				action: "sessions.list",
				cwdRef: { rootDir: "D:\\", relativePath: "repo" },
			}),
		);
	});

	it("prompt 在单一 generation lease 内 resolve、建 Job 并 dispatch", async () => {
		const { controller, requests, events, runs } = makeController();
		requests.request.mockImplementation(
			async (_lease: { clientId: string; socketId: string }, req: { action: string }) => {
				if (req.action === "project.resolve")
					return { ok: true, data: { projectKey: "k".repeat(64) } };
				return { ok: true, data: { accepted: true } };
			},
		);
		const result = await controller.prompt(
			"c1",
			"s1",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				type: "prompt",
				submissionId: "sub-1",
				prompt: "hello",
			},
			actor,
		);

		expect(runs.withReconciledClient).toHaveBeenCalledTimes(1);
		expect(runs.startRun).toHaveBeenCalledWith(
			actor,
			expect.objectContaining({
				clientId: "c1",
				sessionId: "s1",
				projectKey: "k".repeat(64),
			}),
		);
		expect(events.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "s1",
				event: expect.objectContaining({
					type: "run_created",
					submissionId: "sub-1",
					runId: "run-1",
				}),
			}),
		);
		expect(result).toEqual({ jobId: "s1", runId: "run-1", sessionId: "s1" });
	});

	it("pending generation 映射为稳定 PI_STATE_PENDING HTTP 错误且不创建 Job", async () => {
		const pending = Object.assign(
			new Error("Pi client state reconciliation is pending"),
			{ code: "PI_STATE_PENDING" },
		);
		const { controller, requests, runs } = makeController({
			runs: {
				withReconciledClient: vi.fn(async () => { throw pending; }),
			},
		});

		await expect(controller.prompt(
			"c1",
			"s1",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				type: "prompt",
				submissionId: "sub-1",
				prompt: "hello",
			},
			actor,
		)).rejects.toMatchObject({
			response: {
				code: "PI_STATE_PENDING",
				message: "Pi client state reconciliation is pending",
			},
		});
		expect(requests.request).not.toHaveBeenCalled();
		expect(runs.startRun).not.toHaveBeenCalled();
	});

	it("非 Pi code 保持基础设施错误，不映射为暴露 message 的 400", async () => {
		const prismaError = Object.assign(new Error("secret unique constraint details"), {
			code: "P2002",
		});
		const { controller } = makeController({
			runs: {
				withReconciledClient: vi.fn(async () => { throw prismaError; }),
			},
		});

		let caught: unknown;
		try {
			await controller.sessions("c1", "D:\\", "repo");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(prismaError);
		expect(caught).not.toBeInstanceOf(BadRequestException);
		expect((caught as { response?: unknown }).response).toBeUndefined();
	});

	it("project mutation 在同一 lease 内 resolve、锁检查并请求", async () => {
		const { controller, requests, runs } = makeController();
		requests.request.mockImplementation(
			async (_lease: { clientId: string; socketId: string }, req: { action: string }) =>
				req.action === "project.resolve"
					? { ok: true, data: { projectKey: "k".repeat(64) } }
					: { ok: true, data: {} },
		);

		await controller.setThinking("c1", "s1", {
			rootDir: "D:\\",
			relativePath: "repo",
			level: "high",
		}, actor);

		expect(runs.withReconciledClient).toHaveBeenCalledTimes(1);
		expect(runs.assertIdleMutation).toHaveBeenCalledWith("c1", "k".repeat(64));
		expect(requests.request).toHaveBeenNthCalledWith(
			1,
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "project.resolve" }),
		);
		expect(requests.request).toHaveBeenNthCalledWith(
			2,
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "thinking.set" }),
		);
	});

	it.each(["success", "error", "timeout", "disconnect"])(
		"pending complete 后 dispatch %s 仍补发同 run abort",
		async (outcome) => {
			const { controller, requests } = makeController({
				runs: { snapshot: vi.fn(async () => ({ ...idleSnapshot, status: "done", runId: null })) },
			});
			requests.request.mockImplementation((async (_lease: unknown, request: { action: string }) => {
				if (request.action === "project.resolve") return { ok: true, data: { projectKey: "k".repeat(64) } };
				if (request.action === "agent.abort") return { ok: true, data: {} };
				if (outcome === "success") return { ok: true, data: { accepted: true } };
				if (outcome === "error") return { ok: false, error: { code: "PI_WORKER_EXITED", message: "died" } };
				throw Object.assign(new Error(outcome), {
					code: outcome === "timeout" ? "PI_REQUEST_TIMEOUT" : "PI_CLIENT_DISCONNECTED",
				});
			}) as never);
			const operation = controller.prompt("c1", "s1", {
				rootDir: "D:\\", relativePath: "repo", type: "prompt",
				submissionId: "sub-1", prompt: "hello",
			}, actor);
			await expect(operation).rejects.toMatchObject({
				response: { code: "PI_CONTROL_FORBIDDEN" },
			});
			expect(requests.request).toHaveBeenCalledWith(
				{ clientId: "c1", socketId: "socket-1" },
				expect.objectContaining({ action: "agent.abort", jobId: "s1", runId: "run-1" }),
			);
		},
	);

	it("new/fork/clone 建 Job 失败重试一次并按 lease 补偿删除", async () => {
		const dbError = new Error("db down");
		for (const kind of ["fork", "clone"] as const) {
			const { controller, requests, runs } = makeController({
				runs: { ensureSession: vi.fn(async () => { throw dbError; }) },
			});
			requests.request.mockImplementation(async (_lease, request: { action: string }) => {
				if (request.action === "project.resolve") return { ok: true, data: { projectKey: "k".repeat(64) } };
				if (request.action === `session.${kind}`) return { ok: true, data: { sessionId: `${kind}-1` } };
				return { ok: true, data: {} };
			});
			const operation = kind === "fork"
				? Reflect.apply(controller.forkSession, controller, ["c1", "s1", { ...cwdRef, messageId: "m1" }, actor])
				: Reflect.apply(controller.cloneSession, controller, ["c1", "s1", cwdRef, actor]);
			await expect(operation).rejects.toBe(dbError);
			expect(runs.ensureSession).toHaveBeenCalledTimes(2);
			expect(requests.request).toHaveBeenCalledWith(
				{ clientId: "c1", socketId: "socket-1" },
				expect.objectContaining({ action: "session.delete", sessionId: `${kind}-1` }),
			);
		}
	});

	it("fixed Owner mutation 在任何 Client request 前拒绝非 Owner", async () => {
		const forbidden = Object.assign(new Error("forbidden"), { code: "PI_CONTROL_FORBIDDEN" });
		const { controller, requests } = makeController({
			runs: { assertSessionOwner: vi.fn(async () => { throw forbidden; }) },
		});
		const operations = [
			() => Reflect.apply(controller.renameSession, controller, ["c1", "s1", { ...cwdRef, name: "n" }, actor]),
			() => Reflect.apply(controller.forkSession, controller, ["c1", "s1", { ...cwdRef, messageId: "m1" }, actor]),
			() => Reflect.apply(controller.cloneSession, controller, ["c1", "s1", cwdRef, actor]),
			() => Reflect.apply(controller.navigateSession, controller, ["c1", "s1", { ...cwdRef, targetId: "m1" }, actor]),
			() => Reflect.apply(controller.setModel, controller, ["c1", "s1", { ...cwdRef, provider: "p", modelId: "m" }, actor]),
			() => Reflect.apply(controller.setThinking, controller, ["c1", "s1", { ...cwdRef, level: "high" }, actor]),
		];
		for (const operation of operations) {
			await expect(operation()).rejects.toMatchObject({ response: { code: "PI_CONTROL_FORBIDDEN" } });
		}
		expect(requests.request).not.toHaveBeenCalled();
	});

	it.each([
		["active", { ...idleAgentState, status: "running", streaming: true }, "accept"],
		["not-started", idleAgentState, "finishRun"],
	] as const)("prompt dispatch timeout 后按权威 %s state 对账", async (_name, state, transition) => {
		const timeout = Object.assign(new Error("timeout"), { code: "PI_REQUEST_TIMEOUT" });
		const { controller, requests, runs } = makeController();
		requests.request.mockImplementation((async (_lease: unknown, request: { action: string }) => {
			if (request.action === "project.resolve") return { ok: true, data: { projectKey: "k".repeat(64) } };
			if (request.action === "agent.prompt") throw timeout;
			if (request.action === "agent.state") return { ok: true, data: state };
			return { ok: true, data: {} };
		}) as never);
		await expect(controller.prompt("c1", "s1", {
			...cwdRef, type: "prompt", submissionId: "sub-1", prompt: "hello",
		}, actor)).rejects.toMatchObject({ response: { code: "PI_REQUEST_TIMEOUT" } });
		expect(requests.request).toHaveBeenCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({ action: "agent.state", jobId: "s1", runId: "run-1" }),
		);
		expect(runs[transition]).toHaveBeenCalledWith("s1", "run-1");
		if (transition === "accept") expect(runs.reconcileOpen).toHaveBeenCalledWith("s1", "run-1", state);
	});

	it("prompt dispatch disconnect 将 matching run CAS 为 disconnected", async () => {
		const disconnected = Object.assign(new Error("disconnected"), { code: "PI_CLIENT_DISCONNECTED" });
		const { controller, requests, runs } = makeController();
		requests.request.mockImplementation((async (_lease: unknown, request: { action: string }) => {
			if (request.action === "project.resolve") return { ok: true, data: { projectKey: "k".repeat(64) } };
			throw disconnected;
		}) as never);
		await expect(controller.prompt("c1", "s1", {
			...cwdRef, type: "prompt", submissionId: "sub-1", prompt: "hello",
		}, actor)).rejects.toMatchObject({ response: { code: "PI_CLIENT_DISCONNECTED" } });
		expect(runs.markRunDisconnected).toHaveBeenCalledWith("s1", "run-1");
	});

	it("prompt 请求失败时 matching run 回 idle", async () => {
		const { controller, requests, runs } = makeController();
		requests.request.mockImplementation((async (
			_lease: { clientId: string; socketId: string },
			req: { action: string },
		) => {
			if (req.action === "project.resolve")
				return { ok: true, data: { projectKey: "k".repeat(64) } };
			return {
				ok: false,
				error: { code: "PI_WORKER_EXITED", message: "died" },
			};
		}) as never);
		await expect(
			controller.prompt(
				"c1",
				"s1",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					type: "prompt",
					submissionId: "sub-1",
					prompt: "hello",
				},
				actor,
			),
		).rejects.toBeInstanceOf(BadRequestException);
		expect(runs.finishRun).toHaveBeenCalledWith("s1", "run-1");
	});

	it.each([
		["steer", (controller: PiController, body: unknown) => Reflect.apply(controller.steer, controller, ["c1", "s1", body, actor])],
		["follow-up", (controller: PiController, body: unknown) => Reflect.apply(controller.followUp, controller, ["c1", "s1", body, actor])],
		["abort", (controller: PiController, body: unknown) => Reflect.apply(controller.abort, controller, ["c1", "s1", body, actor])],
		["compact", (controller: PiController, body: unknown) => Reflect.apply(controller.compact, controller, ["c1", "s1", body, actor])],
		["abort-compact", (controller: PiController, body: unknown) => Reflect.apply(controller.abortCompact, controller, ["c1", "s1", body, actor])],
		["extension-response", (controller: PiController, body: unknown) => Reflect.apply(controller.extensionResponse, controller, ["c1", "s1", body, actor])],
	] as const)("%s 严格校验 run-scoped body", async (_name, invoke) => {
		for (const body of [null, [], { runId: "" }, { runId: "x".repeat(257) }]) {
			const { controller, requests } = makeController();
			await expect(invoke(controller, body)).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
			expect(requests.request).not.toHaveBeenCalled();
		}
	});

	it.each([
		["steer", (controller: PiController) => controller.steer("c1", "s1", { runId: "run-1", message: "go" }, actor)],
		["follow-up", (controller: PiController) => controller.followUp("c1", "s1", { runId: "run-1", message: "go" }, actor)],
		["abort", (controller: PiController) => controller.abort("c1", "s1", { runId: "run-1" }, actor)],
		["compact", (controller: PiController) => controller.compact("c1", "s1", { runId: "run-1" }, actor)],
		["abort-compact", (controller: PiController) => controller.abortCompact("c1", "s1", { runId: "run-1" }, actor)],
		["extension-response", (controller: PiController) => controller.extensionResponse("c1", "s1", { runId: "run-1", requestId: "ui-1" }, actor)],
		["model", (controller: PiController) => controller.setModel("c1", "s1", { ...cwdRef, provider: "p", modelId: "m" }, actor)],
		["thinking", (controller: PiController) => controller.setThinking("c1", "s1", { ...cwdRef, level: "high" }, actor)],
	] as const)("旧 Client 调用 %s 返回 PI_CLIENT_UNSUPPORTED", async (_name, invoke) => {
		const { controller, clients, requests } = makeController();
		clients.listOnline.mockResolvedValue([{ clientId: "c1", capabilities: ["agent.pi"], capabilityDetails: { pi: { available: true } } }] as never);
		await expect(invoke(controller)).rejects.toMatchObject({ response: { code: "PI_CLIENT_UNSUPPORTED" } });
		expect(requests.request).not.toHaveBeenCalled();
	});

	it("非法 body 返回 400", async () => {
		const { controller } = makeController();
		await expect(
			controller.prompt(
				"c1",
				"s1",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					type: "steer", // 错误 type
					submissionId: "s",
					prompt: "x",
				},
				actor,
			),
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it("steer 先校验 Owner", async () => {
		const { controller, runs } = makeController();
		(runs.assertCurrentRunOwner as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error("forbidden"), { code: "PI_CONTROL_FORBIDDEN" }),
		);
		await expect(
			controller.steer("c1", "s1", { runId: "run-1", message: "go" }, actor),
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it("活动回合时 model.set 拒绝（assertIdle 失败）", async () => {
		const { controller, requests, runs } = makeController();
		requests.request.mockResolvedValue({
			ok: true,
			data: { projectKey: "k".repeat(64) },
		});
		(runs.assertIdleMutation as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error("busy"), { code: "PI_PROJECT_BUSY" }),
		);
		await expect(
			controller.setModel("c1", "s1", {
				rootDir: "D:\\",
				relativePath: "repo",
				provider: "p",
				modelId: "m",
			}, actor),
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it("thinking.set 校验 SDK 原生 level 并转发 cwd/session", async () => {
		const { controller, requests, runs } = makeController();
		requests.request.mockResolvedValue({
			ok: true,
			data: { projectKey: "k".repeat(64) },
		});

		await controller.setThinking("c1", "s1", {
			rootDir: "D:\\",
			relativePath: "repo",
			level: "high",
		}, actor);

		expect(runs.assertIdleMutation).toHaveBeenCalledWith("c1", "k".repeat(64));
		expect(requests.request).toHaveBeenLastCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({
				action: "thinking.set",
				sessionId: "s1",
				cwdRef: { rootDir: "D:\\", relativePath: "repo" },
				payload: { level: "high" },
			}),
		);
	});

	it("thinking.set 拒绝 auto 和未知 level", async () => {
		const { controller } = makeController();
		await expect(
			controller.setThinking("c1", "s1", {
				rootDir: "D:\\",
				relativePath: "repo",
				level: "auto",
			}, actor),
		).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
	});

	it("SSE stream 不要求 Owner", async () => {
		const { controller, events } = makeController();
		controller.stream("c1", "s1");
		expect(events.stream).toHaveBeenCalledWith("c1", "s1");
	});

	it("running 返回活动回合列表", async () => {
		const { controller, runs } = makeController();
		(runs.listActiveByClient as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ jobId: "j1", runId: "j1", sessionId: "s1", status: "running" },
		]);
		const result = await controller.running("c1");
		expect(result).toEqual([
			{ jobId: "j1", runId: "j1", sessionId: "s1", status: "running" },
		]);
	});
});
