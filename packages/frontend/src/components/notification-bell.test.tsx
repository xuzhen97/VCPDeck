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
		expect(list).toHaveBeenCalledWith({ pageSize: 100 });
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
					payload: {
						targetPath: "uploads/a.txt",
						storageKind: "alibaba",
					},
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
		expect(screen.getByText(/正在上传到阿里云盘/)).toBeInTheDocument();
		expect(screen.getByText(/40%/)).toBeInTheDocument();
	});

	it("waiting_input local 上传不显示阿里云盘", async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				job({
					jobId: "local-upload",
					type: "file.import",
					status: "waiting_input" as JobInfo["status"],
					payload: { targetPath: "uploads/a.txt", storageKind: "local" },
					progress: { loaded: 2, total: 5 },
				}),
			],
			total: 1,
			page: 1,
			pageSize: 100,
			totalPages: 1,
		});
		renderBell({ jobs: { list, get: vi.fn() } });

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

		expect(screen.getByText(/正在上传到 Storage/)).toBeInTheDocument();
		expect(screen.queryByText(/阿里云盘/)).not.toBeInTheDocument();
	});

	it("waiting_input 上传完成后显示阿里云盘保存状态", async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				job({
					jobId: "upload-finalizing",
					type: "file.import",
					status: "waiting_input" as JobInfo["status"],
					payload: {
						targetPath: "uploads/a.txt",
						storageKind: "alibaba",
					},
					progress: { loaded: 5, total: 5 },
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

		expect(
			screen.getByText("上传完成 · 正在保存到阿里云盘…"),
		).toBeInTheDocument();
		expect(screen.queryByText(/100%/)).not.toBeInTheDocument();
	});

	it("pending file.import 显示等待远程机器接收", async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				job({
					jobId: "import-pending",
					type: "file.import",
					status: "pending" as JobInfo["status"],
					payload: { targetPath: "uploads/a.txt" },
					progress: { loaded: 0, total: 5 },
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

		expect(screen.getByText(/等待远程机器接收/)).toBeInTheDocument();
	});

	it("running file.import 显示远程机器导入状态", async () => {
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

		expect(screen.getByText(/正在导入远程机器/)).toBeInTheDocument();
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

	it("慢轮询未完成时不启动下一次轮询", async () => {
		let resolveList!: (value: {
			data: JobInfo[];
			total: number;
			page: number;
			pageSize: number;
			totalPages: number;
		}) => void;
		const list = vi.fn().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
		);
		renderBell({ jobs: { list, get: vi.fn() } });

		await vi.advanceTimersByTimeAsync(500);
		expect(list).toHaveBeenCalledTimes(1);

		resolveList({
			data: [],
			total: 0,
			page: 1,
			pageSize: 5,
			totalPages: 0,
		});
		await act(async () => {});
		await vi.advanceTimersByTimeAsync(500);
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

	it("忽略文件浏览产生的完成任务通知", async () => {
		const runningJob = job({
			jobId: "list-1",
			type: "file.list",
			payload: { rootDir: "D:\\", path: "." },
		});
		const doneJob = job({
			...runningJob,
			status: "done" as JobInfo["status"],
			finishedAt: "2026-08-01T00:01:00.000Z",
		});
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				data: [runningJob],
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
		renderBell({ jobs: { list, get: vi.fn().mockResolvedValue(doneJob) } });

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		await vi.advanceTimersByTimeAsync(500);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

		expect(
			screen.queryByRole("heading", { name: "最近结果" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("完成：.")).not.toBeInTheDocument();
	});

	it("按进行中和最近结果分组展示任务", async () => {
		const running = job({
			jobId: "active-1",
			type: "file.import",
			payload: { targetPath: "uploads/a.txt" },
			progress: { loaded: 2, total: 5 },
		});
		const finished = job({
			jobId: "active-2",
			type: "file.export",
			status: "done" as JobInfo["status"],
			payload: { path: "D:\\done.zip" },
			result: { fileId: "f1", key: "download-key", size: 1, sha256: "x" },
			finishedAt: "2026-08-01T00:01:00.000Z",
		});
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				data: [running, job({ jobId: "active-2" })],
				total: 2,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			})
			.mockResolvedValueOnce({
				data: [running],
				total: 1,
				page: 1,
				pageSize: 5,
				totalPages: 1,
			});
		renderBell({
			jobs: { list, get: vi.fn().mockResolvedValue(finished) },
			storage: { downloadUrl: vi.fn().mockReturnValue("/download") },
		});

		await vi.advanceTimersByTimeAsync(0);
		await act(async () => {});
		await vi.advanceTimersByTimeAsync(500);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

		expect(screen.getByRole("heading", { name: "进行中" })).toBeVisible();
		expect(screen.getByRole("heading", { name: "最近结果" })).toBeVisible();
		expect(
			screen.getByRole("button", { name: "清除通知 active-2" }),
		).toBeVisible();
	});

	it("新完成的 file.export 出现下载按钮，点击触发下载", async () => {
		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
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
		const downloadUrl = vi
			.fn()
			.mockReturnValue("/api/storage/download-redirect/aliyun-fileid-9");
		renderBell({ jobs: { list, get }, storage: { downloadUrl } });

		await vi.advanceTimersByTimeAsync(0); // 首次轮询：running
		await act(async () => {});
		await vi.advanceTimersByTimeAsync(3000); // 第二次轮询：done
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "任务通知" }));
		expect(screen.getByText(/done\.zip/)).toBeInTheDocument();

		fireEvent.click(
			within(screen.getByRole("dialog", { name: "任务通知" })).getByRole(
				"button",
				{
					name: "下载",
				},
			),
		);
		expect(downloadUrl).toHaveBeenCalledWith("aliyun-fileid-9");
		expect(anchorClick).toHaveBeenCalledOnce();
		expect(anchorClick.mock.instances[0]).toHaveProperty(
			"href",
			`${window.location.origin}/api/storage/download-redirect/aliyun-fileid-9`,
		);
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
		const downloadUrl = vi
			.fn()
			.mockReturnValue("/api/storage/download-redirect/aliyun-fileid-9");
		renderBell({ jobs: { list, get }, storage: { downloadUrl } });

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
		expect(downloadUrl).toHaveBeenCalledWith("aliyun-fileid-9");
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
