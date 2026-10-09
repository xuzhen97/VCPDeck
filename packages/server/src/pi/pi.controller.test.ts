import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { PiAgentState, PiSessionSnapshot } from "@vcpdeck/shared";
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
const idleSnapshot: PiSessionSnapshot = {
	sessionId: "s1",
	status: "available",
	activeRun: null,
	executionModeOverride: null,
	effectiveExecutionMode: null,
	executionModeNeedsConfirmation: false,
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
		Record<"requests" | "events" | "runs" | "sessions" | "clients" | "attachments", unknown>
	> = {},
) {
	const requests = {
		request: vi.fn(
			async (
				_lease: { clientId: string; socketId: string },
				_req: { action: string },
			) => ({
				ok: true,
				data: {},
			}),
		),
		bindEmitter: vi.fn(),
		...((overrides.requests as object) ?? {}),
	};
	const events = {
		publish: vi.fn(async () => {}),
		stream: vi.fn(() => ({ subscribe: () => () => {} })),
		...((overrides.events as object) ?? {}),
	};
	const runs = {
		startRun: vi.fn(async () => ({
			sessionId: "s1",
			runId: "run-1",
			executionMode: "supervised",
			restoredFromArchive: false,
		})),
		accept: vi.fn(async () => true),
		settleRun: vi.fn(async () => true),
		reconcileOpen: vi.fn(async () => true),
		markRunDisconnected: vi.fn(async () => true),
		waitForInput: vi.fn(async () => true),
		resume: vi.fn(async () => true),
		assertIdleMutation: vi.fn(async () => {}),
		listActiveRuns: vi.fn(async () => []),
		scheduleSettlement: vi.fn(async () => {}),
		cancelSettlement: vi.fn(() => {}),
		withReconciledClient: vi.fn(
			async (
				clientId: string,
				operation: (lease: {
					clientId: string;
					socketId: string;
				}) => Promise<unknown>,
			) => operation({ clientId, socketId: "socket-1" }),
		),
		...((overrides.runs as object) ?? {}),
	};
	// ADR-0041:会话控制面在独立 PiSessionService,不再由 PiRunService 承担。
	const sessions = {
		ensureSession: vi.fn(async () => {}),
		snapshot: vi.fn(async () => idleSnapshot),
		setExecutionMode: vi.fn(async () => ({
			...idleSnapshot,
			executionModeOverride: "automatic",
			effectiveExecutionMode: "automatic",
		})),
		setArchived: vi.fn(async () => ({ ...idleSnapshot, status: "archived" })),
		beginDelete: vi.fn(async () => ({
			deleteToken: "delete-1",
			previousStatus: "available",
			existingReservation: false,
		})),
		rollbackDelete: vi.fn(async () => true),
		commitDelete: vi.fn(async () => true),
		assertSessionOwner: vi.fn(async () => {}),
		requireClientSession: vi.fn(async () => {}),
		controlStatusFor: vi.fn(async () => new Map()),
		recordAudit: vi.fn(async () => {}),
		runInfo: vi.fn(async () => ({ runId: "run-1", sessionId: "s1" })),
		listRuns: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
		listAudit: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
		...((overrides.sessions as object) ?? {}),
	};
	const clients = {
		listOnline: vi.fn(async () => [
			{
				clientId: "c1",
				capabilities: ["agent.pi"],
				capabilityDetails: {
					pi: { available: true, sessionProtocolVersion: 4 },
				},
			},
		]),
		...((overrides.clients as object) ?? {}),
	};	const attachments = {
		createPromptUploads: vi.fn(async () => []),
		completePromptUpload: vi.fn(),
		deleteAttachment: vi.fn(async () => {}),
		prepareHistoryUpload: vi.fn(),
		completeHistoryUpload: vi.fn(),
		/** 默认视引用为已校验的规范描述符；单个用例可覆盖为拒绝。 */
		validatePromptRefs: vi.fn(async (_clientId: string, refs: unknown) =>
			(Array.isArray(refs) ? refs : []).map((item) => {
				const ref = item as {
					fileId?: string;
					sha256?: string;
					size?: number;
					mimeType?: string;
				};
				return {
					fileId: ref.fileId ?? "f1",
					sha256: ref.sha256 ?? "sha",
					size: ref.size ?? 42,
					mimeType: ref.mimeType ?? "image/png",
					url: "/api/storage/download/canonical",
				};
			}),
		),
		...((overrides.attachments as object) ?? {}),
	};
	const runtime = {
		assertCompatible: vi.fn(),
		assertReady: vi.fn(),
		status: vi.fn(() => ({
			clientId: "c1", specId: null, desiredRuntimeRevision: null,
			activeRuntimeRevision: null, configState: "pending", reasonCode: null,
			piSdkVersion: null, runtimeSpecProtocolVersion: null, unavailableModels: [],
		})),
	};
	const controller = new PiController(
		requests as never,
		events as never,
		runs as never,
		sessions as never,
		clients as never,
		attachments as never,
		runtime as never,
	);
	return { controller, requests, events, runs, sessions, clients, attachments };
}

describe("PiController", () => {
	it("capability 返回 Client 的 Pi 状态", async () => {
		const { controller, sessions} = makeController();
		const result = await controller.capability("c1");
		expect(result).toMatchObject({ available: true });
	});

	it("旧 Client 返回 PI_CLIENT_UNSUPPORTED", async () => {
		const { controller, clients, sessions} = makeController();
		(clients.listOnline as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ clientId: "c1", capabilities: ["exec"], capabilityDetails: {} },
		]);
		const result = await controller.capability("c1");
		expect(result).toMatchObject({ code: "PI_CLIENT_UNSUPPORTED" });
	});

	it("execution mode 仅接受严格请求、确认 cwd 所属与 idle owner 并保存清除操作", async () => {
		const { controller, requests, runs, sessions} = makeController();
		requests.request.mockImplementation(async (_lease, req: { action: string }) => {
			if (req.action === "project.resolve") return { ok: true, data: { projectKey: "p".repeat(64) } };
			if (req.action === "session.get") return { ok: true, data: { info: { id: "s1" } } };
			return { ok: true, data: {} };
		});

		await expect(controller.setExecutionMode("c1", "s1", { ...cwdRef, mode: "automatic" }, actor))
			.resolves.toMatchObject({ executionModeOverride: "automatic", effectiveExecutionMode: "automatic" });
		expect(runs.assertIdleMutation).toHaveBeenCalledWith("c1", "p".repeat(64));
		expect(sessions.setExecutionMode).toHaveBeenCalledWith(actor, { clientId: "c1", sessionId: "s1", mode: "automatic" });

		await controller.setExecutionMode("c1", "s1", { ...cwdRef, mode: null }, actor);
		expect(sessions.setExecutionMode).toHaveBeenLastCalledWith(actor, { clientId: "c1", sessionId: "s1", mode: null });
	});

	it.each([
		[{ ...cwdRef, mode: "unsafe" }, "PI_PROTOCOL_INVALID"],
		[{ ...cwdRef, mode: "auto", extra: true }, "PI_PROTOCOL_INVALID"],
		[{ rootDir: cwdRef.rootDir, mode: "auto" }, "PI_PROTOCOL_INVALID"],
	])("execution mode rejects malformed request %#", async (body, code) => {
		const { controller, requests, runs, sessions} = makeController();
		await expect(controller.setExecutionMode("c1", "s1", body, actor)).rejects.toMatchObject({ response: { code } });
		expect(requests.request).not.toHaveBeenCalled();
		expect(sessions.setExecutionMode).not.toHaveBeenCalled();
	});

	it("execution mode 拒绝错误项目中的 Session、非 owner 与运行中项目", async () => {
		const wrongSession = makeController({ requests: { request: vi.fn(async () => ({ ok: true, data: { info: { id: "other" } } })) } });
		await expect(wrongSession.controller.setExecutionMode("c1", "s1", { ...cwdRef, mode: "automatic" }, actor))
			.rejects.toMatchObject({ response: { code: "PI_SESSION_NOT_FOUND" } });

		const observer = makeController({ sessions: { snapshot: vi.fn(async () => ({ ...idleSnapshot, isOwner: false })) } });
		observer.requests.request.mockImplementation(async (_lease, req: { action: string }) => req.action === "session.get"
			? { ok: true, data: { info: { id: "s1" } } } : { ok: true, data: { projectKey: "p".repeat(64) } });
		await expect(observer.controller.setExecutionMode("c1", "s1", { ...cwdRef, mode: "automatic" }, actor))
			.rejects.toMatchObject({ response: { code: "PI_CONTROL_FORBIDDEN" } });

		const busy = makeController({ runs: { assertIdleMutation: vi.fn(async () => { throw Object.assign(new Error("busy"), { code: "PI_PROJECT_BUSY" }); }) } });
		busy.requests.request.mockResolvedValue({ ok: true, data: { projectKey: "p".repeat(64) } });
		await expect(busy.controller.setExecutionMode("c1", "s1", { ...cwdRef, mode: "automatic" }, actor))
			.rejects.toMatchObject({ response: { code: "PI_PROJECT_BUSY" } });
		expect(busy.sessions.setExecutionMode).not.toHaveBeenCalled();
	});

	it("execution mode 在没有 Runtime service 时 fail closed", async () => {
		const { runs, clients, sessions} = makeController();
		const withoutRuntime = new PiController(
			{ request: vi.fn(async () => ({ ok: true, data: {} })), bindEmitter: vi.fn() } as never,
			{ publish: vi.fn(), stream: vi.fn() } as never,
			runs as never,
			sessions as never,
			clients as never,
			{} as never,
			undefined,
		);
		await expect(withoutRuntime.setExecutionMode("c1", "s1", { ...cwdRef, mode: "automatic" }, actor)).rejects.toMatchObject({ response: { code: "PI_CLIENT_UNSUPPORTED" } });
	});

	it("models 直通返回 Client 的模型数组（不按 envelope 取 .models）", async () => {
		const { controller, requests, sessions} = makeController();
		const models = [{ provider: "axonhub", modelId: "mimo-v2.6-flash" }];
		requests.request.mockResolvedValueOnce({ ok: true, data: models });

		await expect(
			controller.models("c1", cwdRef.rootDir, cwdRef.relativePath),
		).resolves.toEqual(models);
		expect(requests.request).toHaveBeenCalledWith(
			expect.objectContaining({ clientId: "c1" }),
			expect.objectContaining({
				action: "models.list",
				cwdRef: { rootDir: cwdRef.rootDir, relativePath: cwdRef.relativePath },
			}),
		);
	});

	it("newSession 创建同 ID Session Job", async () => {
		const { controller, requests, runs, sessions} = makeController();
		requests.request.mockResolvedValueOnce({
			ok: true,
			data: { sessionId: "s1" },
		});

		await expect(controller.newSession("c1", cwdRef, actor)).resolves.toEqual({
			sessionId: "s1",
		});
		expect(sessions.ensureSession).toHaveBeenCalledWith(actor, {
			clientId: "c1",
			sessionId: "s1",
			event: "created",
		});
	});

	it("open 验证 Session、补建 Job、原子对账并返回双权威状态", async () => {
		const activeSnapshot = {
			...idleSnapshot,
			activeRun: {
				runId: "run-1",
				sessionId: "s1",
				status: "running" as const,
				kind: "prompt" as const,
				executionMode: "supervised" as const,
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: null,
				startedAt: null,
				finishedAt: null,
				errorCode: null,
			},
		};
		const { controller, requests, runs, sessions } = makeController({
			sessions: {
				snapshot: vi
					.fn()
					.mockResolvedValueOnce(activeSnapshot)
					.mockResolvedValueOnce(activeSnapshot),
			},
		});
		requests.request
			.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } })
			.mockResolvedValueOnce({ ok: true, data: waitingAgentState });

		await expect(
			controller.openSession("c1", "s1", cwdRef, actor),
		).resolves.toEqual({
			snapshot: activeSnapshot,
			agentState: waitingAgentState,
		});
		expect(sessions.ensureSession).toHaveBeenCalledWith(actor, {
			clientId: "c1",
			sessionId: "s1",
		});
		expect(runs.reconcileOpen).toHaveBeenCalledWith(
			"s1",
			"run-1",
			waitingAgentState,
		);
		expect(requests.request).toHaveBeenLastCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({
				action: "agent.state",
				runId: "run-1",
			}),
		);
	});

	it("没有活动 run 的 open 使用只读 agent.state", async () => {
		const { controller, requests, sessions} = makeController();
		requests.request
			.mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } })
			.mockResolvedValueOnce({ ok: true, data: idleAgentState });

		const sessionOpen = await controller.openSession("c1", "s1", cwdRef, actor);
		expect(sessionOpen.snapshot).toEqual(idleSnapshot);
		expect(requests.request).toHaveBeenLastCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({
				action: "agent.state",
				sessionId: "s1",
				runId: undefined,
			}),
		);
	});

	it("旧完成入口被明确拒绝且不改动任何状态(ADR-0041)", async () => {
		const { controller, requests, runs, sessions } = makeController();
		await expect(
			Reflect.apply(controller.completeSession, controller, ["c1", "s1"]),
		).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
		expect(requests.request).not.toHaveBeenCalled();
		expect(runs.settleRun).not.toHaveBeenCalled();
		expect(sessions.recordAudit).not.toHaveBeenCalled();
	});


	it("delete 成功/不存在 commit，执行前拒绝直接 rollback", async () => {
		const { controller, requests, runs, sessions} = makeController();
		requests.request
			.mockResolvedValueOnce({ ok: true, data: { ok: true } })
			.mockResolvedValueOnce({
				ok: false,
				error: { code: "PI_SESSION_NOT_FOUND", message: "gone" },
			} as never)
			.mockResolvedValueOnce({
				ok: false,
				error: { code: "PI_PROJECT_NOT_ALLOWED", message: "denied" },
			} as never);

		const remove = () =>
			Reflect.apply(controller.deleteSession, controller, [
				"c1",
				"s1",
				cwdRef,
				actor,
			]);
		await expect(remove()).resolves.toEqual({ ok: true });
		await expect(remove()).resolves.toEqual({ ok: true });
		await expect(remove()).rejects.toMatchObject({
			response: { code: "PI_PROJECT_NOT_ALLOWED" },
		});
		expect(sessions.beginDelete).toHaveBeenCalledTimes(3);
		expect(sessions.commitDelete).toHaveBeenCalledTimes(2);
		expect(sessions.rollbackDelete).toHaveBeenCalledTimes(1);
	});

	it.each([
		["exists", { ok: true, data: { sessionId: "s1" } }, "rollbackDelete"],
		[
			"gone",
			{ ok: false, error: { code: "PI_SESSION_NOT_FOUND", message: "gone" } },
			"commitDelete",
		],
	] as const)("delete 不确定错误经 session.get 确认 %s", async (_name, confirmation, transition) => {
		const { controller, requests, runs, sessions} = makeController();
		requests.request
			.mockResolvedValueOnce({
				ok: false,
				error: { code: "PI_WORKER_EXITED", message: "died" },
			} as never)
			.mockResolvedValueOnce(confirmation as never);
		const operation = Reflect.apply(controller.deleteSession, controller, [
			"c1",
			"s1",
			cwdRef,
			actor,
		]);
		if (transition === "commitDelete")
			await expect(operation).resolves.toEqual({ ok: true });
		else
			await expect(operation).rejects.toMatchObject({
				response: { code: "PI_WORKER_EXITED" },
			});
		expect(requests.request).toHaveBeenLastCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({
				action: "session.get",
				sessionId: "s1",
				cwdRef,
			}),
		);
		expect((sessions as Record<string, ReturnType<typeof vi.fn>>)[transition]).toHaveBeenCalledWith("s1", "delete-1", expect.objectContaining({ actor }));
	});

	it("delete 确认超时保留 reservation", async () => {
		const timeout = Object.assign(new Error("timeout"), {
			code: "PI_REQUEST_TIMEOUT",
		});
		const { controller, requests, runs, sessions} = makeController();
		requests.request
			.mockResolvedValueOnce({
				ok: false,
				error: { code: "PI_WORKER_EXITED", message: "died" },
			} as never)
			.mockRejectedValueOnce(timeout);
		await expect(
			Reflect.apply(controller.deleteSession, controller, [
				"c1",
				"s1",
				cwdRef,
				actor,
			]),
		).rejects.toMatchObject({ response: { code: "PI_REQUEST_TIMEOUT" } });
		expect(sessions.rollbackDelete).not.toHaveBeenCalled();
		expect(sessions.commitDelete).not.toHaveBeenCalled();
	});

	it.each([
		"PI_REQUEST_TIMEOUT",
		"PI_CLIENT_DISCONNECTED",
	])("delete %s 保留 reservation 供重试", async (code) => {
		const failure = Object.assign(new Error(code), { code });
		const { controller, runs, sessions} = makeController({
			requests: {
				request: vi.fn(async () => {
					throw failure;
				}),
			},
		});
		await expect(
			Reflect.apply(controller.deleteSession, controller, [
				"c1",
				"s1",
				cwdRef,
				actor,
			]),
		).rejects.toMatchObject({
			response: { code },
		});
		expect(sessions.rollbackDelete).not.toHaveBeenCalled();
		expect(sessions.commitDelete).not.toHaveBeenCalled();
	});

	it("delete 未取得 reservation 不请求 Client", async () => {
		const busy = Object.assign(new Error("busy"), { code: "PI_PROJECT_BUSY" });
		const { controller, requests, sessions } = makeController({
			sessions: {
				beginDelete: vi.fn(async () => {
					throw busy;
				}),
			},
		});
		await expect(
			Reflect.apply(controller.deleteSession, controller, [
				"c1",
				"s1",
				cwdRef,
				actor,
			]),
		).rejects.toMatchObject({
			response: { code: "PI_PROJECT_BUSY" },
		});
		expect(requests.request).not.toHaveBeenCalled();
	});

	it("sessions.list 转发 cwdRef", async () => {
		const { controller, requests, sessions } = makeController();
		requests.request.mockResolvedValueOnce({ ok: true, data: { sessions: [] } });
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
		const { controller, requests, events, runs, sessions} = makeController();
		requests.request.mockImplementation(
			async (
				_lease: { clientId: string; socketId: string },
				req: { action: string },
			) => {
				if (req.action === "project.resolve")
					return { ok: true, data: { projectKey: "k".repeat(64) } };
				return { ok: true, data: { accepted: true } };
			},
		);
		const runWithMode = {
			sessionId: "s1",
			runId: "run-1",
			executionMode: "automatic" as const,
			restoredFromArchive: false,
		};
		runs.startRun = vi.fn(async () => runWithMode);
		await controller.prompt(
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
				event: expect.objectContaining({
					type: "run_created",
					submissionId: "sub-1",
					runId: "run-1",
				}),
			}),
		);
		expect(requests.request).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "agent.prompt",
				payload: expect.objectContaining({ executionMode: "automatic" }),
			}),
		);
	});

	it("pending generation 映射为稳定 PI_STATE_PENDING HTTP 错误且不创建 Job", async () => {
		const pending = Object.assign(
			new Error("Pi client state reconciliation is pending"),
			{ code: "PI_STATE_PENDING" },
		);
		const { controller, requests, runs, sessions} = makeController({
			runs: {
				withReconciledClient: vi.fn(async () => {
					throw pending;
				}),
			},
		});

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
		).rejects.toMatchObject({
			response: {
				code: "PI_STATE_PENDING",
				message: "Pi client state reconciliation is pending",
			},
		});
		expect(requests.request).not.toHaveBeenCalled();
		expect(runs.startRun).not.toHaveBeenCalled();
	});

	it("非 Pi code 保持基础设施错误，不映射为暴露 message 的 400", async () => {
		const prismaError = Object.assign(
			new Error("secret unique constraint details"),
			{
				code: "P2002",
			},
		);
		const { controller, sessions} = makeController({
			runs: {
				withReconciledClient: vi.fn(async () => {
					throw prismaError;
				}),
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
		const { controller, requests, runs, sessions} = makeController();
		requests.request.mockImplementation(
			async (
				_lease: { clientId: string; socketId: string },
				req: { action: string },
			) =>
				req.action === "project.resolve"
					? { ok: true, data: { projectKey: "k".repeat(64) } }
					: { ok: true, data: {} },
		);

		await controller.setThinking(
			"c1",
			"s1",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				level: "high",
			},
			actor,
		);

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

	it.each([
		["success", "accept"],
		["error", "settle"],
		["disconnect", "disconnect"],
	] as const)("dispatch %s 时按独立 Run 语义收敛且不补发 abort", async (outcome, expectation) => {
		const { controller, requests, runs, sessions } = makeController();
		requests.request.mockImplementation((async (
			_lease: unknown,
			request: { action: string },
		) => {
			if (request.action === "project.resolve")
				return { ok: true, data: { projectKey: "k".repeat(64) } };
			if (outcome === "success") return { ok: true, data: { accepted: true } };
			if (outcome === "error")
				return { ok: false, error: { code: "PI_WORKER_EXITED", message: "died" } };
			throw Object.assign(new Error("disconnect"), { code: "PI_CLIENT_DISCONNECTED" });
		}) as never);
		const operation = controller.prompt(
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
		if (outcome === "success") {
			await expect(operation).resolves.toMatchObject({ sessionId: "s1", runId: "run-1" });
		} else {
			await expect(operation).rejects.toBeInstanceOf(BadRequestException);
		}
		// 解耦后不再有"会话在派发期间完成"的补偿 abort:状态由 Run 收敛表达。
		expect(requests.request).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "agent.abort" }),
		);
		if (expectation === "accept") expect(runs.accept).toHaveBeenCalledWith("s1", "run-1");
		if (expectation === "settle")
			expect(runs.settleRun).toHaveBeenCalledWith(
				"s1",
				"run-1",
				expect.objectContaining({ status: "failed" }),
			);
		if (expectation === "disconnect") expect(runs.markRunDisconnected).toHaveBeenCalledWith("s1", "run-1");
		void sessions;
	});

	it("new/fork/clone 建 Job 失败重试一次并按 lease 补偿删除", async () => {
		const dbError = new Error("db down");
		for (const kind of ["fork", "clone"] as const) {
			const { controller, requests, runs, sessions } = makeController({
				sessions: {
					ensureSession: vi.fn(async () => {
						throw dbError;
					}),
				},
			});
			requests.request.mockImplementation(
				async (_lease, request: { action: string }) => {
					if (request.action === "project.resolve")
						return { ok: true, data: { projectKey: "k".repeat(64) } };
					if (request.action === `session.${kind}`)
						return { ok: true, data: { sessionId: `${kind}-1` } };
					return { ok: true, data: {} };
				},
			);
			const operation =
				kind === "fork"
					? Reflect.apply(controller.forkSession, controller, [
							"c1",
							"s1",
							{ ...cwdRef, messageId: "m1" },
							actor,
						])
					: Reflect.apply(controller.cloneSession, controller, [
							"c1",
							"s1",
							cwdRef,
							actor,
						]);
			await expect(operation).rejects.toBe(dbError);
			expect(sessions.ensureSession).toHaveBeenCalledTimes(2);
			expect(requests.request).toHaveBeenCalledWith(
				{ clientId: "c1", socketId: "socket-1" },
				expect.objectContaining({
					action: "session.delete",
					sessionId: `${kind}-1`,
				}),
			);
		}
	});

	it("rename/delete 在 owner 检查前调用 ensureSession，为未打开的会话补 Job 记录", async () => {
		const { controller, runs, sessions} = makeController();
		await controller.renameSession(
			"c1",
			"s1",
			{ rootDir: "D:\\", relativePath: "repo", name: "new" },
			actor,
		);
		expect(sessions.ensureSession).toHaveBeenCalledWith(actor, {
			clientId: "c1",
			sessionId: "s1",
		});
		expect(sessions.assertSessionOwner).toHaveBeenCalledWith(
			"s1",
			actor.identityId,
		);

		await controller.deleteSession(
			"c1",
			"s1",
			{ rootDir: "D:\\", relativePath: "repo" },
			actor,
		);
		// delete 路径也会调 ensureSession（为 beginDelete 补 Job）
		expect(sessions.ensureSession).toHaveBeenCalledTimes(2);
		expect(sessions.beginDelete).toHaveBeenCalledWith("s1", actor.identityId, {
			actor,
		});
	});

	it("renamed 审计在远端确认后写 ok,失败时不宣称成功", async () => {
		const { controller, sessions } = makeController();
		await controller.renameSession(
			"c1",
			"s1",
			{ rootDir: "D:\\", relativePath: "repo", name: "new" },
			actor,
		);
		const events = (sessions.recordAudit as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => call[0] as { event: string; result: string });
		expect(events).toEqual([
			expect.objectContaining({ event: "renamed", result: "requested" }),
			expect.objectContaining({ event: "renamed", result: "ok" }),
		]);
	});

	it("rename 被 Client 明确拒绝时写 renamed/failed 并保留错误码", async () => {
		const { controller, sessions, requests } = makeController({
			requests: {
				request: vi.fn(async () => ({
					ok: false,
					error: { code: "PI_PROJECT_BUSY", message: "busy" },
				})),
			},
		});
		await expect(
			controller.renameSession(
				"c1",
				"s1",
				{ rootDir: "D:\\", relativePath: "repo", name: "new" },
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_PROJECT_BUSY" } });
		expect(requests.request).toHaveBeenCalled();
		const events = (sessions.recordAudit as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => call[0] as { event: string; result: string; errorCode?: string });
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "renamed",
				result: "failed",
				errorCode: "PI_PROJECT_BUSY",
			}),
		);
		expect(events.some((event) => event.result === "ok")).toBe(false);
	});

	it("fixed Owner mutation 在任何 Client request 前拒绝非 Owner", async () => {
		const forbidden = Object.assign(new Error("forbidden"), {
			code: "PI_CONTROL_FORBIDDEN",
		});
		const { controller, requests, sessions } = makeController({
			sessions: {
				assertSessionOwner: vi.fn(async () => {
					throw forbidden;
				}),
			},
		});
		const operations = [
			() =>
				Reflect.apply(controller.renameSession, controller, [
					"c1",
					"s1",
					{ ...cwdRef, name: "n" },
					actor,
				]),
			() =>
				Reflect.apply(controller.forkSession, controller, [
					"c1",
					"s1",
					{ ...cwdRef, messageId: "m1" },
					actor,
				]),
			() =>
				Reflect.apply(controller.cloneSession, controller, [
					"c1",
					"s1",
					cwdRef,
					actor,
				]),
			() =>
				Reflect.apply(controller.navigateSession, controller, [
					"c1",
					"s1",
					{ ...cwdRef, targetId: "m1" },
					actor,
				]),
			() =>
				Reflect.apply(controller.setModel, controller, [
					"c1",
					"s1",
					{ ...cwdRef, provider: "p", modelId: "m" },
					actor,
				]),
			() =>
				Reflect.apply(controller.setThinking, controller, [
					"c1",
					"s1",
					{ ...cwdRef, level: "high" },
					actor,
				]),
		];
		for (const operation of operations) {
			await expect(operation()).rejects.toMatchObject({
				response: { code: "PI_CONTROL_FORBIDDEN" },
			});
		}
		expect(requests.request).not.toHaveBeenCalled();
	});

	it.each([
		[
			"active",
			{ ...idleAgentState, status: "running", streaming: true },
			"accept",
		],
		["not-started", idleAgentState, "settleRun"],
		[
			"pending-extension",
			{
				...idleAgentState,
				pendingExtension: {
					requestId: "u1",
					extensionId: "e",
					kind: "confirm",
					message: "trust?",
				},
			},
			"accept",
		],
	] as const)("prompt dispatch timeout 后按权威 %s state 对账", async (_name, state, transition) => {
		const timeout = Object.assign(new Error("timeout"), {
			code: "PI_REQUEST_TIMEOUT",
		});
		const { controller, requests, runs, sessions} = makeController();
		requests.request.mockImplementation((async (
			_lease: unknown,
			request: { action: string },
		) => {
			if (request.action === "project.resolve")
				return { ok: true, data: { projectKey: "k".repeat(64) } };
			if (request.action === "agent.prompt") throw timeout;
			if (request.action === "agent.state") return { ok: true, data: state };
			return { ok: true, data: {} };
		}) as never);
		await expect(
			controller.prompt(
				"c1",
				"s1",
				{
					...cwdRef,
					type: "prompt",
					submissionId: "sub-1",
					prompt: "hello",
				},
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_REQUEST_TIMEOUT" } });
		expect(requests.request).toHaveBeenCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({
				action: "agent.state",
				runId: "run-1",
			}),
		);
		if (transition === "settleRun") {
			expect(runs.settleRun).toHaveBeenCalledWith("s1", "run-1", { status: "succeeded" });
		} else {
			expect(runs.accept).toHaveBeenCalledWith("s1", "run-1");
		}
		if (transition === "accept") {
			expect(runs.settleRun).not.toHaveBeenCalled();
			expect(runs.reconcileOpen).toHaveBeenCalledWith("s1", "run-1", state);
		}
	});

	it("extension-response 成功后不再乐观 resume（状态只由 matching extension_resolved 驱动）", async () => {
		const { controller, requests, runs, sessions } = makeController({
			sessions: {
				snapshot: vi.fn(async () => ({
					...idleSnapshot,
					activeRun: {
						runId: "run-1",
						sessionId: "s1",
						status: "running",
						kind: "prompt",
						executionMode: "supervised",
						actorName: "User",
						source: "web",
						createdAt: "2026-10-08T00:00:00.000Z",
						acceptedAt: null,
						startedAt: null,
						finishedAt: null,
						errorCode: null,
					},
				})),
			},
		});
		await expect(
			controller.extensionResponse(
				"c1",
				"s1",
				{ runId: "run-1", requestId: "unknown-ui" },
				actor,
			),
		).resolves.toEqual({ ok: true });
		expect(requests.request).toHaveBeenCalledWith(
			{ clientId: "c1", socketId: "socket-1" },
			expect.objectContaining({
				action: "extension.respond",
				sessionId: "s1",
				runId: "run-1",
				payload: { requestId: "unknown-ui" },
			}),
		);
		expect(runs.resume).not.toHaveBeenCalled();
	});

	describe("扩展命令与 UI 快照的只读投影", () => {
		it("commands 转发 agent.commands 并返回绑定运行时的清单", async () => {
			const { controller, requests, sessions} = makeController();
			requests.request.mockResolvedValue({
				ok: true,
				data: {
					runtimeInstanceId: "spec-1",
					runtimeRevision: "rev-1",
					commands: [{ name: "fixture_ok", description: "就绪探针" }],
				},
			} as never);

			await expect(controller.extensionCommands("c1", "s1", "D:\\", "repo")).resolves.toEqual({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				commands: [{ name: "fixture_ok", description: "就绪探针" }],
			});
			expect(requests.request).toHaveBeenCalledWith(
				{ clientId: "c1", socketId: "socket-1" },
				expect.objectContaining({ action: "agent.commands", sessionId: "s1" }),
			);
		});

		it("commands 上游夹带本地来源路径时按 502 拒绝，不透传", async () => {
			// Client 若回传 sourceInfo（含本地路径），这里必须拒绝而不是原样转发。
			const { controller, requests, sessions} = makeController();
			requests.request.mockResolvedValue({
				ok: true,
				data: {
					runtimeInstanceId: "spec-1",
					runtimeRevision: "rev-1",
					commands: [
						{ name: "x", description: "y", sourceInfo: { path: "C:\\secret" } },
					],
				},
			} as never);

			await expect(controller.extensionCommands("c1", "s1", "D:\\", "repo")).rejects.toMatchObject(
				{ response: { code: "PI_PROTOCOL_INVALID" } },
			);
		});

		it("extension-ui 转发 extension.ui.get 并返回严格快照", async () => {
			const { controller, requests, sessions} = makeController();
			requests.request.mockResolvedValue({
				ok: true,
				data: {
					runtimeInstanceId: "spec-1",
					runtimeRevision: "rev-1",
					sequence: 3,
					title: "构建中",
					statuses: [{ key: "k", text: "1" }],
					widgets: [{ key: "w", lines: ["a"], placement: "belowEditor" }],
				},
			} as never);

			const snapshot = await controller.extensionUiSnapshot("c1", "s1", "D:\\", "repo");
			expect(snapshot).toMatchObject({ sequence: 3, title: "构建中" });
			expect(snapshot.widgets).toHaveLength(1);
			expect(requests.request).toHaveBeenCalledWith(
				{ clientId: "c1", socketId: "socket-1" },
				expect.objectContaining({ action: "extension.ui.get", sessionId: "s1" }),
			);
		});

		it("extension-ui 上游快照畸形时按 502 拒绝", async () => {
			const { controller, requests, sessions} = makeController();
			requests.request.mockResolvedValue({
				ok: true,
				data: { sequence: -1, statuses: "nope" },
			} as never);

			await expect(controller.extensionUiSnapshot("c1", "s1", "D:\\", "repo")).rejects.toMatchObject(
				{ response: { code: "PI_PROTOCOL_INVALID" } },
			);
		});
	});

	describe("executeCommand（扩展命令）", () => {
		const CMD_CWD = { rootDir: "D:\\", relativePath: "repo" };

		/** 让 project.resolve 与 Run 接纳走通，其余动作按测试指定。 */
		function withProject(
			handler: (action: string) => { ok: true; data: unknown },
		) {
			return (async (_lease: unknown, request: { action: string }) => {
				if (request.action === "project.resolve") {
					return { ok: true, data: { projectKey: "k".repeat(64) } };
				}
				return handler(request.action);
			}) as never;
		}

		it("缺 cwd 或 name 时按 PI_PROTOCOL_INVALID 拒绝，不发任何请求", async () => {
			for (const body of [
				null,
				{},
				{ ...CMD_CWD },
				{ ...CMD_CWD, name: "" },
				{ ...CMD_CWD, name: 42 },
				{ rootDir: "D:\\", name: "x" },
			] as unknown[]) {
				const { controller, requests, runs, sessions} = makeController();
				await expect(
					controller.executeCommand(
						"c1",
						"s1",
						body as { rootDir?: string; relativePath?: string; name?: string },
						actor,
					),
				).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
				expect(requests.request).not.toHaveBeenCalled();
				expect(runs.startRun).not.toHaveBeenCalled();
			}
		});

		it("命令由 Server 接纳 Run（不收调用方自带 runId），再以 agent.command 转发", async () => {
			const { controller, requests, runs, sessions} = makeController();
			requests.request.mockImplementation(
				withProject((action) =>
					action === "agent.command"
						? { ok: true, data: { accepted: true } }
						: { ok: true, data: {} },
				),
			);

			await expect(
				controller.executeCommand(
					"c1",
					"s1",
					{ ...CMD_CWD, submissionId: "sub-1", name: "fixture_ok", args: "a b" },
					actor,
				),
			).resolves.toMatchObject({ runId: "run-1", sessionId: "s1" });

			// Run 由 Server 接纳，调用方无法绕过项目互斥与结算。
			expect(runs.startRun).toHaveBeenCalledWith(actor, {
				clientId: "c1",
				sessionId: "s1",
				projectKey: "k".repeat(64),
				kind: "command",
			});
			expect(runs.accept).toHaveBeenCalledWith("s1", "run-1");
			expect(requests.request).toHaveBeenCalledWith(
				{ clientId: "c1", socketId: "socket-1" },
				expect.objectContaining({
					action: "agent.command",
					sessionId: "s1",
					runId: "run-1",
					payload: { name: "fixture_ok", args: "a b" },
				}),
			);
		});

		it("未注册命令：Client 以 { ok: false } 返回时必翻成 400，绝不静默 200", async () => {
			// 真实 SDK 下命令未命中不会 reject，只回一个失败对象；
			// 若原样透传，调用方会看到 HTTP 200 却什么都没发生（静默失败）。
			const { controller, requests, runs, sessions} = makeController();
			requests.request.mockImplementation(
				withProject((action) =>
					action === "agent.command"
						? {
								ok: true,
								data: {
									ok: false,
									error: {
										code: "PI_EXTENSION_COMMAND_NOT_FOUND",
										message: "Unknown Pi command: nope",
									},
								},
							}
						: { ok: true, data: {} },
				),
			);

			await expect(
				controller.executeCommand(
					"c1",
					"s1",
					{ ...CMD_CWD, name: "nope" },
					actor,
				),
			).rejects.toMatchObject({
				response: { code: "PI_EXTENSION_COMMAND_NOT_FOUND" },
			});
			// 被拒绝的动作必须结算掉 Run，不得留下悬挂。
			expect(runs.settleRun).toHaveBeenCalledWith("s1", "run-1", expect.objectContaining({ status: "failed" }));
			expect(runs.accept).not.toHaveBeenCalled();
		});

		it("缺 args 时补空串，不把 undefined 透传给 Client", async () => {
			const { controller, requests, sessions} = makeController();
			requests.request.mockImplementation(
				withProject((action) =>
					action === "agent.command"
						? { ok: true, data: { accepted: true } }
						: { ok: true, data: {} },
				),
			);
			await controller.executeCommand(
				"c1",
				"s1",
				{ ...CMD_CWD, name: "fixture_ok" },
				actor,
			);
			expect(requests.request).toHaveBeenCalledWith(
				{ clientId: "c1", socketId: "socket-1" },
				expect.objectContaining({
					payload: { name: "fixture_ok", args: "" },
				}),
			);
		});
	});

	it("prompt dispatch disconnect 将 matching run CAS 为 disconnected", async () => {
		const disconnected = Object.assign(new Error("disconnected"), {
			code: "PI_CLIENT_DISCONNECTED",
		});
		const { controller, requests, runs, sessions} = makeController();
		requests.request.mockImplementation((async (
			_lease: unknown,
			request: { action: string },
		) => {
			if (request.action === "project.resolve")
				return { ok: true, data: { projectKey: "k".repeat(64) } };
			throw disconnected;
		}) as never);
		await expect(
			controller.prompt(
				"c1",
				"s1",
				{
					...cwdRef,
					type: "prompt",
					submissionId: "sub-1",
					prompt: "hello",
				},
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_CLIENT_DISCONNECTED" } });
		expect(runs.markRunDisconnected).toHaveBeenCalledWith("s1", "run-1");
	});

	it("prompt 请求失败时 matching run 回 idle", async () => {
		const { controller, requests, runs, sessions} = makeController();
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
		expect(runs.settleRun).toHaveBeenCalledWith("s1", "run-1", expect.objectContaining({ status: "failed" }));
	});

	it.each([
		[
			"steer",
			(controller: PiController, body: unknown) =>
				Reflect.apply(controller.steer, controller, ["c1", "s1", body, actor]),
		],
		[
			"follow-up",
			(controller: PiController, body: unknown) =>
				Reflect.apply(controller.followUp, controller, [
					"c1",
					"s1",
					body,
					actor,
				]),
		],
		[
			"abort",
			(controller: PiController, body: unknown) =>
				Reflect.apply(controller.abort, controller, ["c1", "s1", body, actor]),
		],
		[
			"compact",
			(controller: PiController, body: unknown) =>
				Reflect.apply(controller.compact, controller, [
					"c1",
					"s1",
					body,
					actor,
				]),
		],
		[
			"abort-compact",
			(controller: PiController, body: unknown) =>
				Reflect.apply(controller.abortCompact, controller, [
					"c1",
					"s1",
					body,
					actor,
				]),
		],
		[
			"extension-response",
			(controller: PiController, body: unknown) =>
				Reflect.apply(controller.extensionResponse, controller, [
					"c1",
					"s1",
					body,
					actor,
				]),
		],
	] as const)("%s 严格校验 run-scoped body", async (_name, invoke) => {
		for (const body of [null, [], { runId: "" }, { runId: "x".repeat(257) }]) {
			const { controller, requests, sessions} = makeController();
			await expect(invoke(controller, body)).rejects.toMatchObject({
				response: { code: "PI_PROTOCOL_INVALID" },
			});
			expect(requests.request).not.toHaveBeenCalled();
		}
	});

	it.each([
		[
			"steer",
			(controller: PiController) =>
				controller.steer("c1", "s1", { runId: "run-1", message: "go" }, actor),
		],
		[
			"follow-up",
			(controller: PiController) =>
				controller.followUp(
					"c1",
					"s1",
					{ runId: "run-1", message: "go" },
					actor,
				),
		],
		[
			"abort",
			(controller: PiController) =>
				controller.abort("c1", "s1", { runId: "run-1" }, actor),
		],
		[
			"compact",
			(controller: PiController) =>
				controller.compact("c1", "s1", { runId: "run-1" }, actor),
		],
		[
			"abort-compact",
			(controller: PiController) =>
				controller.abortCompact("c1", "s1", { runId: "run-1" }, actor),
		],
		[
			"extension-response",
			(controller: PiController) =>
				controller.extensionResponse(
					"c1",
					"s1",
					{ runId: "run-1", requestId: "ui-1" },
					actor,
				),
		],
		[
			"model",
			(controller: PiController) =>
				controller.setModel(
					"c1",
					"s1",
					{ ...cwdRef, provider: "p", modelId: "m" },
					actor,
				),
		],
		[
			"thinking",
			(controller: PiController) =>
				controller.setThinking("c1", "s1", { ...cwdRef, level: "high" }, actor),
		],
	] as const)("旧 Client 调用 %s 返回 PI_CLIENT_UNSUPPORTED", async (_name, invoke) => {
		const { controller, clients, requests, sessions} = makeController();
		clients.listOnline.mockResolvedValue([
			{
				clientId: "c1",
				capabilities: ["agent.pi"],
				capabilityDetails: { pi: { available: true } },
			},
		] as never);
		await expect(invoke(controller)).rejects.toMatchObject({
			response: { code: "PI_CLIENT_UNSUPPORTED" },
		});
		expect(requests.request).not.toHaveBeenCalled();
	});

	it("非法 body 返回 400", async () => {
		const { controller, sessions} = makeController();
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
		const { controller, runs, sessions} = makeController();
		(sessions.snapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error("forbidden"), { code: "PI_CONTROL_FORBIDDEN" }),
		);
		await expect(
			controller.steer("c1", "s1", { runId: "run-1", message: "go" }, actor),
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it("活动回合时 model.set 拒绝（assertIdle 失败）", async () => {
		const { controller, requests, runs, sessions} = makeController();
		requests.request.mockResolvedValue({
			ok: true,
			data: { projectKey: "k".repeat(64) },
		});
		(runs.assertIdleMutation as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error("busy"), { code: "PI_PROJECT_BUSY" }),
		);
		await expect(
			controller.setModel(
				"c1",
				"s1",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					provider: "p",
					modelId: "m",
				},
				actor,
			),
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it("thinking.set 校验 SDK 原生 level 并转发 cwd/session", async () => {
		const { controller, requests, runs, sessions} = makeController();
		requests.request.mockResolvedValue({
			ok: true,
			data: { projectKey: "k".repeat(64) },
		});

		await controller.setThinking(
			"c1",
			"s1",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				level: "high",
			},
			actor,
		);

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
		const { controller, sessions} = makeController();
		await expect(
			controller.setThinking(
				"c1",
				"s1",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					level: "auto",
				},
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
	});

	it("SSE stream 不要求 Owner", async () => {
		const { controller, events, sessions} = makeController();
		controller.stream("c1", "s1");
		expect(events.stream).toHaveBeenCalledWith("c1", "s1");
	});

	it("running 返回活动回合列表", async () => {
		const { controller, runs, sessions} = makeController();
		(runs.listActiveRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ jobId: "j1", runId: "j1", sessionId: "s1", status: "running" },
		]);
		const result = await controller.running("c1");
		expect(result).toEqual([
			{ jobId: "j1", runId: "j1", sessionId: "s1", status: "running" },
		]);
	});
});

describe("Pi 显式导入路由（list / preview / run）", () => {
	const validList = {
		sourceRoot: "/home/u/.pi/agent/sessions",
		sessions: [
			{
				sourceName: "a.jsonl",
				sourceLabel: "dir/a.jsonl",
				startedAt: "2026-09-01T00:00:00.000Z",
				entryCount: 2,
				cwd: "/proj/a",
				imported: false,
				cwdNotAllowed: false,
				unreadable: false,
			},
		],
	};

	it("list：转发 action 并严格解析 Client 响应", async () => {
		const { controller, requests, sessions} = makeController();
		requests.request.mockResolvedValueOnce({
			requestId: "r1",
			ok: true,
			data: validList,
		} as never);

		await expect(controller.listImportable("c1")).resolves.toEqual(validList);
		expect(requests.request).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "session.import.list" }),
		);
	});

	it("list：未知字段的上游响应按 502 拒绝（不回显上游数据）", async () => {
		const { controller, requests, sessions} = makeController();
		requests.request.mockResolvedValueOnce({
			requestId: "r2",
			ok: true,
			data: {
				sourceRoot: "/x",
				sessions: [{ sourceName: "a.jsonl", body: "leak" }],
			},
		} as never);

		const rejected = (await controller.listImportable("c1").catch((error: unknown) => error)) as {
			status: number;
			getResponse: () => { code: string };
		};
		expect(rejected.status).toBe(502);
		expect(rejected.getResponse()).toMatchObject({ code: "PI_PROTOCOL_INVALID" });
		expect(JSON.stringify(rejected)).not.toContain("leak");
	});

	it("preview：转发 payload；sourceName 非法在 envelope 层 400", async () => {
		const { controller, requests, sessions} = makeController();
		requests.request.mockResolvedValueOnce({
			requestId: "r3",
			ok: true,
			data: { sourceName: "a.jsonl", previewText: "hi", truncated: false },
		} as never);

		await expect(controller.previewImportable("c1", "a.jsonl")).resolves.toEqual({
			sourceName: "a.jsonl",
			previewText: "hi",
			truncated: false,
		});
		expect(requests.request).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "session.import.preview",
				payload: { sourceName: "a.jsonl" },
			}),
		);

		const invalid = (await controller
			.previewImportable("c1", "../etc/passwd")
			.catch((error: unknown) => error)) as {
			status: number;
			getResponse: () => { code: string };
		};
		expect(invalid.status).toBe(400);
		expect(invalid.getResponse()).toMatchObject({ code: "PI_PROTOCOL_INVALID" });
	});

	it("导入成功的会话登记控制面并写 imported 审计;rejected 不登记", async () => {
		const { controller, requests, sessions } = makeController();
		requests.request.mockResolvedValueOnce({
			requestId: "r",
			ok: true,
			data: {
				results: [
					{ sourceName: "a.jsonl", status: "imported", sessionId: "s-1" },
					{ sourceName: "b.jsonl", status: "alreadyImported", sessionId: "s-2" },
					{
						sourceName: "c.jsonl",
						status: "rejected",
						reasonCode: "PI_PROJECT_NOT_ALLOWED",
					},
				],
			},
		} as never);

		await controller.importSessions(
			"c1",
			{ sourceNames: ["a.jsonl", "b.jsonl", "c.jsonl"] },
			actor,
		);

		// 已在 VCPDeck 内的副本同样自愈登记:审计只在真实创建时落库。
		expect(sessions.ensureSession).toHaveBeenCalledWith(actor, {
			clientId: "c1",
			sessionId: "s-1",
			event: "imported",
		});
		expect(sessions.ensureSession).toHaveBeenCalledWith(actor, {
			clientId: "c1",
			sessionId: "s-2",
			event: "imported",
		});
		expect(sessions.ensureSession).toHaveBeenCalledTimes(2);
	});

	it("旧 Client 未上报 sessionId 时导入照常成功(不登记、不报错)", async () => {
		const { controller, requests, sessions } = makeController();
		requests.request.mockResolvedValueOnce({
			requestId: "r",
			ok: true,
			data: { results: [{ sourceName: "a.jsonl", status: "imported" }] },
		} as never);

		await expect(
			controller.importSessions("c1", { sourceNames: ["a.jsonl"] }, actor),
		).resolves.toEqual({
			results: [{ sourceName: "a.jsonl", status: "imported" }],
		});
		expect(sessions.ensureSession).not.toHaveBeenCalled();
	});

	it("run：转发 sourceNames；非法 body 在 envelope 层 400", async () => {
		const { controller, requests, sessions} = makeController();
		requests.request.mockResolvedValueOnce({
			requestId: "r4",
			ok: true,
			data: { results: [{ sourceName: "a.jsonl", status: "imported" }] },
		} as never);

		await expect(
			controller.importSessions("c1", { sourceNames: ["a.jsonl"] }, actor),
		).resolves.toEqual({
			results: [{ sourceName: "a.jsonl", status: "imported" }],
		});
		expect(requests.request).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "session.import.run",
				payload: { sourceNames: ["a.jsonl"] },
			}),
		);

		const badBody = (await controller
			.importSessions("c1", { sourceNames: ["a/b.jsonl"] }, actor)
			.catch((error: unknown) => error)) as {
			status: number;
			getResponse: () => { code: string };
		};
		expect(badBody.status).toBe(400);
		expect(badBody.getResponse()).toMatchObject({ code: "PI_PROTOCOL_INVALID" });
	});

	it("未就绪（Client 侧 ok:false）按 400 + 稳定码映射", async () => {
		const { controller, requests, sessions} = makeController();
		requests.request.mockResolvedValueOnce({
			requestId: "r5",
			ok: false,
			error: { code: "PI_CONFIG_UNAVAILABLE", message: "Pi 配置不可用或尚未就绪" },
		} as never);

		const notReady = (await controller
			.listImportable("c1")
			.catch((error: unknown) => error)) as {
			status: number;
			getResponse: () => { code: string };
		};
		expect(notReady.status).toBe(400);
		expect(notReady.getResponse()).toMatchObject({ code: "PI_CONFIG_UNAVAILABLE" });
	});

	it("纯图片 prompt：空文本加有效图片可接纳 Run 并下发服务端签发的描述符", async () => {
		const { controller, requests, runs, attachments, sessions} = makeController();
		requests.request.mockImplementation(async (_lease, req: { action: string }) =>
			req.action === "project.resolve"
				? { ok: true, data: { projectKey: "k".repeat(64) } }
				: { ok: true, data: { accepted: true } },
		);
		const image = {
			fileId: "f1",
			sha256: "sha",
			size: 42,
			mimeType: "image/png",
			url: "https://evil.test/forged",
		};

		await controller.prompt(
			"c1",
			"s1",
			{
				rootDir: "D:\\",
				relativePath: "repo",
				type: "prompt",
				submissionId: "sub-1",
				prompt: "",
				images: [image],
			},
			actor,
		);

		expect(attachments.validatePromptRefs).toHaveBeenCalledWith("c1", [image]);
		expect(runs.startRun).toHaveBeenCalled();
		expect(requests.request).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "agent.prompt",
				payload: expect.objectContaining({
					prompt: "",
					attachments: [
						expect.objectContaining({
							fileId: "f1",
							url: "/api/storage/download/canonical",
						}),
					],
				}),
			}),
		);
		expect(JSON.stringify(requests.request.mock.calls)).not.toContain("evil.test");
	});

	it.each([
		["空文本且无图片", { prompt: "" }],
		["空白文本且空图片数组", { prompt: "  ", images: [] }],
		["缺 prompt 字段", { images: [{ fileId: "f1" }] }],
	])("%s 拒绝且不创建 Run", async (_name, body) => {
		const { controller, requests, runs, events, sessions} = makeController();
		await expect(
			controller.prompt(
				"c1",
				"s1",
				{ rootDir: "D:\\", relativePath: "repo", type: "prompt", submissionId: "sub-1", ...body },
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
		expect(requests.request).not.toHaveBeenCalled();
		expect(runs.startRun).not.toHaveBeenCalled();
		expect(events.publish).not.toHaveBeenCalled();
	});

	it("非法/过期图片引用在创建 Run 前拒绝", async () => {
		const attachments = {
			validatePromptRefs: vi.fn(async () => {
				throw Object.assign(new Error("Attachment not found"), {
					code: "PI_IMAGE_INVALID",
				});
			}),
		};
		const { controller, requests, runs, events, sessions} = makeController({ attachments });
		await expect(
			controller.prompt(
				"c1",
				"s1",
				{
					rootDir: "D:\\",
					relativePath: "repo",
					type: "prompt",
					submissionId: "sub-1",
					prompt: "",
					images: [{ fileId: "stale" }],
				},
				actor,
			),
		).rejects.toMatchObject({ response: { code: "PI_IMAGE_INVALID" } });
		expect(requests.request).not.toHaveBeenCalled();
		expect(runs.startRun).not.toHaveBeenCalled();
		expect(events.publish).not.toHaveBeenCalled();
	});
});
