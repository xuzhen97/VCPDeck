import { JobStatus } from "@vcpdeck/shared";
import { describe, expect, it, vi } from "vitest";
import { createFrpApi } from "./frp.js";

const mapping = {
	id: "fm_1",
	clientId: "client-1",
	frpsInstanceId: "frps_1",
	name: "tcp-1919",
	proxyType: "tcp" as const,
	localIp: "127.0.0.1",
	localPort: 1919,
	remotePort: 20000,
	customDomain: null,
	status: "provisioning" as const,
	publicUrl: "frps.example.com:20000",
	operationJobId: "job-1",
	errorCode: null,
	errorMessage: null,
	createdAt: "2026-08-24T00:00:00.000Z",
	updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("frp sdk", () => {
	it("createAndWait 以 operationJobId 等待并返回 active 映射", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(mapping)
			.mockResolvedValueOnce({
				jobId: "job-1",
				status: JobStatus.DONE,
				result: { mappingId: "fm_1", status: "active" },
			})
			.mockResolvedValueOnce({ ...mapping, status: "active", operationJobId: null });
		const jobs = { wait: vi.fn().mockImplementation(() => request()) };
		const api = createFrpApi({ request } as never, jobs as never);

		await expect(
			api.createAndWait({
				clientId: "client-1",
				proxyType: "tcp",
				localPort: 1919,
			}),
		).resolves.toMatchObject({ status: "active" });
		expect(jobs.wait).toHaveBeenCalledWith("job-1", expect.any(Object));
		expect(request).toHaveBeenLastCalledWith(
			"GET",
			"/api/frp/mappings/fm_1",
			undefined,
			undefined,
		);
	});

	it("createAndWait 在 Job error 时携带稳定错误失败", async () => {
		const request = vi.fn().mockResolvedValue(mapping);
		const jobs = {
			wait: vi.fn().mockResolvedValue({
				jobId: "job-1",
				status: JobStatus.ERROR,
				errorCode: "FRP_PROXY_CONFIRM_TIMEOUT",
				errorMessage: "已自动回滚",
			}),
		};
		const api = createFrpApi({ request } as never, jobs as never);
		await expect(
			api.createAndWait({
				clientId: "client-1",
				proxyType: "tcp",
				localPort: 1919,
			}),
		).rejects.toMatchObject({ code: "FRP_PROXY_CONFIRM_TIMEOUT" });
	});

	it("delete 兼容旧版 AbortSignal 参数", async () => {
		const request = vi.fn().mockResolvedValue({ ...mapping, status: "deleting" });
		const api = createFrpApi({ request } as never);
		const controller = new AbortController();

		await api.delete("fm_1", controller.signal);

		expect(request).toHaveBeenCalledWith(
			"DELETE",
			"/api/frp/mappings/fm_1",
			undefined,
			controller.signal,
		);
	});

	it("deleteAndWait 等待删除 Job 完成，不提前声称删除", async () => {
		const deleting = {
			...mapping,
			status: "deleting" as const,
			operationJobId: "delete-job",
		};
		const request = vi.fn().mockResolvedValue(deleting);
		const jobs = {
			wait: vi.fn().mockResolvedValue({
				jobId: "delete-job",
				status: JobStatus.DONE,
				result: { mappingId: "fm_1", deleted: true },
			}),
		};
		const api = createFrpApi({ request } as never, jobs as never);

		await expect(api.deleteAndWait("fm_1", { timeoutSeconds: 45 })).resolves.toEqual({
			id: "fm_1",
			deleted: true,
		});
		expect(request).toHaveBeenCalledWith(
			"DELETE",
			"/api/frp/mappings/fm_1?timeoutSeconds=45",
			undefined,
			undefined,
		);
		expect(jobs.wait).toHaveBeenCalledWith("delete-job", expect.any(Object));
	});
});
