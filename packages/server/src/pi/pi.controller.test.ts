import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { PiController } from "./pi.controller.js";

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
		createRun: vi.fn(async () => ({ jobId: "j1", runId: "j1" })),
		accept: vi.fn(async () => {}),
		fail: vi.fn(async () => {}),
		cancel: vi.fn(async () => {}),
		resume: vi.fn(async () => {}),
		assertOwner: vi.fn(async () => {}),
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
				capabilityDetails: { pi: { available: true } },
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
		expect(runs.createRun).toHaveBeenCalledWith(
			actor,
			expect.objectContaining({
				clientId: "c1",
				sessionId: "s1",
				imageCount: 0,
			}),
		);
		expect(events.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "j1",
				event: expect.objectContaining({
					type: "run_created",
					submissionId: "sub-1",
					runId: "j1",
				}),
			}),
		);
		expect(result).toEqual({ jobId: "j1", runId: "j1", sessionId: "s1" });
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
		expect(runs.createRun).not.toHaveBeenCalled();
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
		});

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

	it("prompt 请求失败时 Job fail", async () => {
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
		expect(runs.fail).toHaveBeenCalledWith("j1", "PI_WORKER_EXITED", "died");
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
		(runs.assertOwner as ReturnType<typeof vi.fn>).mockRejectedValue(
			Object.assign(new Error("forbidden"), { code: "PI_CONTROL_FORBIDDEN" }),
		);
		await expect(
			controller.steer("c1", "s1", { jobId: "j1", message: "go" }, actor),
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
			}),
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
		});

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
			}),
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
