import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo, JobInfo } from "@vcpdeck/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { NotificationBell } from "./notification-bell";

const identity: IdentityInfo = {
	id: "i1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function job(overrides: Partial<JobInfo>): JobInfo {
	return {
		jobId: "j1",
		clientId: "c1",
		clientName: "wujie14",
		type: "exec",
		status: "running" as JobInfo["status"],
		payload: {},
		result: null,
		progress: null,
		errorCode: null,
		errorMessage: null,
		createdAt: "2026-08-01T00:00:00.000Z",
		startedAt: "2026-08-01T00:00:00.000Z",
		finishedAt: null,
		createdByIdentityId: null,
		createdByName: "admin",
		createdVia: "web",
		...overrides,
	};
}

function renderBell(client: Record<string, unknown>) {
	return render(
		<SdkProvider
			client={
				{
					auth: { me: vi.fn().mockResolvedValue(identity) },
					...client,
				} as unknown as VcpDeckClient
			}
		>
			<AuthProvider>
				<NotificationBell />
			</AuthProvider>
		</SdkProvider>,
	);
}

describe("NotificationBell", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("进行中 file.export 显示进度条与字节数", async () => {
		const MB = 1024 * 1024;
		const list = vi.fn().mockResolvedValue({
			data: [
				job({
					jobId: "export-1",
					type: "file.export",
					payload: { path: "D:\\big.zip" },
					progress: { loaded: 66 * MB, total: 158 * MB },
				}),
			],
			total: 1,
			page: 1,
			pageSize: 5,
			totalPages: 1,
		});
		renderBell({ jobs: { list, get: vi.fn() } });

		await vi.advanceTimersByTimeAsync(0);
		expect(list).toHaveBeenCalled();
		await act(async () => {}); // flush 轮询后的 setState
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));
		expect(screen.getByText(/big\.zip/)).toBeInTheDocument();
		expect(screen.getByText(/66.*MB/)).toBeInTheDocument();
		expect(screen.getByText(/42%/)).toBeInTheDocument();
	});

	it("waiting_input 文件上传显示 Storage 上传状态", async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				job({
					jobId: "upload-1",
					type: "file.import",
					status: "waiting_input" as JobInfo["status"],
					payload: { targetPath: "uploads/a.txt" },
					progress: { loaded: 2, total: 5 },
				}),
			],
			total: 1,
			page: 1,
			pageSize: 5,
			totalPages: 1,
		});
		renderBell({ jobs: { list, get: vi.fn() } });

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

		expect(screen.getByText(/a\.txt/)).toBeInTheDocument();
		expect(screen.getByText(/正在上传到 Storage/)).toBeInTheDocument();
		expect(screen.getByText(/40%/)).toBeInTheDocument();
	});

	it("running file.import 显示远程目录写入状态", async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				job({
					jobId: "import-1",
					type: "file.import",
					payload: { targetPath: "uploads/a.txt" },
					progress: { loaded: 2, total: 5 },
				}),
			],
			total: 1,
			page: 1,
			pageSize: 5,
			totalPages: 1,
		});
		renderBell({ jobs: { list, get: vi.fn() } });

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

		expect(screen.getByText(/正在写入远程目录/)).toBeInTheDocument();
		expect(screen.getByText(/40%/)).toBeInTheDocument();
	});

	it("每 500ms 刷新一次进行中任务进度", async () => {
		const list = vi.fn().mockResolvedValue({
			data: [job({ jobId: "progress-1", type: "file.export" })],
			total: 1,
			page: 1,
			pageSize: 5,
			totalPages: 1,
		});
		renderBell({ jobs: { list, get: vi.fn() } });

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		expect(list).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(499);
		expect(list).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("上传字节达到 100% 但 Job 未完成时显示云盘收尾状态", async () => {
		const MB = 1024 * 1024;
		const list = vi.fn().mockResolvedValue({
			data: [
				job({
					jobId: "export-finalizing",
					type: "file.export",
					payload: { path: "D:\\big.zip" },
					progress: { loaded: 158 * MB, total: 158 * MB },
				}),
			],
			total: 1,
			page: 1,
			pageSize: 5,
			totalPages: 1,
		});
		renderBell({ jobs: { list, get: vi.fn() } });

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

		expect(screen.getByText("上传完成 · 正在保存到云盘…")).toBeInTheDocument();
		expect(screen.queryByText(/100%/)).not.toBeInTheDocument();
	});

	it("新完成的 file.export 出现下载按钮，点击触发下载", async () => {
		const running = job({
			jobId: "export-2",
			type: "file.export",
			payload: { path: "D:\\done.zip" },
		});
		const doneJob = job({
			jobId: "export-2",
			type: "file.export",
			status: "done" as JobInfo["status"],
			payload: { path: "D:\\done.zip" },
			result: { fileId: "f1", key: "aliyun-fileid-9", size: 1, sha256: "x" },
			finishedAt: "2026-08-01T00:01:00.000Z",
		});
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				data: [running],
				total: 1,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			})
			.mockResolvedValueOnce({
				data: [doneJob],
				total: 1,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			});
		const get = vi.fn().mockResolvedValue(doneJob);
		const createDownloadToken = vi.fn().mockResolvedValue({
			url: "/api/storage/download/aliyun-fileid-9?expires=0&sig=abc",
			expiresAt: 0,
		});
		renderBell({ jobs: { list, get }, storage: { createDownloadToken } });

		await vi.advanceTimersByTimeAsync(0); // 首次轮询：running
		await act(async () => {});
		await vi.advanceTimersByTimeAsync(3000); // 第二次轮询：done
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));
		console.log(
			"DIALOG2:",
			JSON.stringify(
				screen.getByRole("dialog", { name: "任务通知" }).textContent,
			),
		);
		expect(screen.getByText(/done\.zip/)).toBeInTheDocument();

		fireEvent.click(
			within(screen.getByRole("dialog", { name: "任务通知" })).getByRole(
				"button",
				{
					name: "下载",
				},
			),
		);
		expect(createDownloadToken).toHaveBeenCalledWith({
			key: "aliyun-fileid-9",
			ttlSeconds: 0,
		});
	});

	it("新完成的 file.import 出现下载按钮，点击触发下载", async () => {
		const running = job({
			jobId: "import-2",
			type: "file.import",
			payload: { targetPath: "D:\\in.zip" },
		});
		const doneJob = job({
			jobId: "import-2",
			type: "file.import",
			status: "done" as JobInfo["status"],
			payload: { targetPath: "D:\\in.zip" },
			result: {
				path: "D:\\in.zip",
				key: "aliyun-fileid-9",
				size: 1,
				sha256: "x",
			},
			finishedAt: "2026-08-01T00:01:00.000Z",
		});
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				data: [running],
				total: 1,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			})
			.mockResolvedValueOnce({
				data: [doneJob],
				total: 1,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			});
		const get = vi.fn().mockResolvedValue(doneJob);
		const createDownloadToken = vi.fn().mockResolvedValue({
			url: "/api/storage/download/aliyun-fileid-9?expires=0&sig=abc",
			expiresAt: 0,
		});
		renderBell({ jobs: { list, get }, storage: { createDownloadToken } });

		await vi.advanceTimersByTimeAsync(0); // 首次轮询：running
		await act(async () => {});
		await vi.advanceTimersByTimeAsync(3000); // 第二次轮询：done
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));
		expect(screen.getByText(/in\.zip/)).toBeInTheDocument();

		fireEvent.click(
			within(screen.getByRole("dialog", { name: "任务通知" })).getByRole(
				"button",
				{
					name: "下载",
				},
			),
		);
		expect(createDownloadToken).toHaveBeenCalledWith({
			key: "aliyun-fileid-9",
			ttlSeconds: 0,
		});
	});

	it("失败任务显示错误并可清除", async () => {
		const running = job({
			jobId: "export-3",
			type: "file.export",
			payload: { path: "D:\\fail.zip" },
		});
		const errorJob = job({
			jobId: "export-3",
			type: "file.export",
			status: "error" as JobInfo["status"],
			payload: { path: "D:\\fail.zip" },
			errorCode: "IO_ERROR",
			errorMessage: "upload failed",
			finishedAt: "2026-08-01T00:01:00.000Z",
		});
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				data: [running],
				total: 1,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			})
			.mockResolvedValueOnce({
				data: [errorJob],
				total: 1,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			});
		renderBell({ jobs: { list, get: vi.fn().mockResolvedValue(errorJob) } });

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		await vi.advanceTimersByTimeAsync(3000);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));
		expect(screen.getByText(/fail.zip/)).toBeInTheDocument();
		expect(screen.getByText(/upload failed/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "清除通知 export-3" }));
		expect(screen.queryByText(/fail.zip/)).not.toBeInTheDocument();
	});
});
