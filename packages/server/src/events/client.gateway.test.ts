import { describe, expect, it, vi } from "vitest";
import { ClientGateway } from "./client.gateway.js";

function makeGateway() {
	const jobService = {
		markDone: vi.fn().mockResolvedValue(null),
	};
	const fileService = {
		confirmUpload: vi.fn().mockResolvedValue({
			key: "aliyun-file-id",
			size: 158601385,
		}),
	};
	const gateway = new ClientGateway(
		{} as never,
		jobService as never,
		fileService as never,
		{ updateStatus: vi.fn() } as never,
		{
			bindEmitter: vi.fn(),
			request: vi.fn(),
			resolve: vi.fn(),
			disconnect: vi.fn(),
		} as never,
		{
			publish: vi.fn(),
			stream: vi.fn(),
			handleState: vi.fn().mockResolvedValue([]),
		} as never,
		{
			markDisconnected: vi.fn().mockResolvedValue(undefined),
		} as never,
	);
	gateway.server = { emit: vi.fn() } as never;
	return { gateway, jobService, fileService };
}

describe("ClientGateway.handleJobDone", () => {
	it("用数据库中的真实 key 覆盖 Client 回传的临时 key", async () => {
		const { gateway, jobService, fileService } = makeGateway();
		const result = {
			fileId: "file-1",
			key: "temporary-key/nginx-1.18.0.zip",
			sha256: "sha256-value",
			size: 158601385,
		};

		await gateway.handleJobDone({
			jobId: "job-1",
			type: "file.export",
			result,
		});

		expect(fileService.confirmUpload).toHaveBeenCalledWith(
			"file-1",
			"sha256-value",
		);
		expect(jobService.markDone).toHaveBeenCalledWith("job-1", "file.export", {
			...result,
			key: "aliyun-file-id",
		});
	});
});
