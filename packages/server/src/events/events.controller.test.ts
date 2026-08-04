import { describe, expect, it, vi } from "vitest";
import { EventsController } from "./events.controller.js";

function makeController() {
	const jobService = {
		createUploadSession: vi.fn(),
		completeUploadSession: vi.fn(),
	} as never;
	const clientService = {} as never;
	const gateway = {
		sendDispatch: vi.fn(),
	} as never;
	return {
		controller: new EventsController(jobService, clientService, gateway),
		jobService: jobService as {
			createUploadSession: ReturnType<typeof vi.fn>;
			completeUploadSession: ReturnType<typeof vi.fn>;
		},
		gateway: gateway as { sendDispatch: ReturnType<typeof vi.fn> },
	};
}

describe("EventsController upload sessions", () => {
	it("把创建会话请求交给 JobService", async () => {
		const { controller, jobService } = makeController();
		const body = {
			clientId: "client-1",
			rootDir: "D:\\",
			targetPath: "report.txt",
			filename: "report.txt",
			size: 5,
		};
		const actor = { identityId: "identity-1", source: "web" };
		const expected = {
			jobId: "job-1",
			fileId: "file-1",
			status: "waiting_input",
		};
		jobService.createUploadSession.mockResolvedValue(expected);

		await expect(controller.createUploadSession(body, actor as never)).resolves.toBe(
			expected,
		);
		expect(jobService.createUploadSession).toHaveBeenCalledWith(body, actor);
	});

	it("完成会话时转发 dispatch 但只返回结果", async () => {
		const { controller, jobService, gateway } = makeController();
		const result = { jobId: "job-1", status: "running", type: "file.import" };
		const dispatch = {
			jobId: "job-1",
			clientId: "client-1",
			type: "file.import",
			payload: {},
		};
		jobService.completeUploadSession.mockResolvedValue({ result, dispatch });

		await expect(controller.completeUploadSession("job-1")).resolves.toBe(result);
		expect(gateway.sendDispatch).toHaveBeenCalledWith(dispatch);
	});

	it("没有 dispatch 时不发送 Client 消息", async () => {
		const { controller, jobService, gateway } = makeController();
		const result = { jobId: "job-1", status: "pending", type: "file.import" };
		jobService.completeUploadSession.mockResolvedValue({
			result,
			dispatch: null,
		});

		await controller.completeUploadSession("job-1");
		expect(gateway.sendDispatch).not.toHaveBeenCalled();
	});
});
