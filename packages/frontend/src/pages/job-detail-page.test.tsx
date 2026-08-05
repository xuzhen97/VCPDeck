import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo, JobInfo } from "@vcpdeck/shared";
import { JobStatus } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { JobDetailPage } from "./job-detail-page";

const exportJob: JobInfo = {
	jobId: "job-1",
	clientId: "c1",
	clientName: "machine-1",
	type: "file.export",
	status: JobStatus.DONE,
	payload: { rootDir: "/srv", path: "/srv/logs/app.log" },
	result: { fileId: "f1", key: "aliyun-fileid-123", size: 1024, sha256: "x" },
	progress: null,
	errorCode: null,
	errorMessage: null,
	createdAt: "2026-08-01T00:00:00.000Z",
	startedAt: "2026-08-01T00:00:00.000Z",
	finishedAt: "2026-08-01T00:00:00.000Z",
	createdByIdentityId: null,
	createdByName: "admin",
	createdVia: "ui",
};

const identity: IdentityInfo = {
	id: "i1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function renderDetail(job: JobInfo, downloadUrl: ReturnType<typeof vi.fn>) {
	const client = {
		auth: { me: vi.fn().mockResolvedValue(identity) },
		jobs: { get: vi.fn().mockResolvedValue(job) },
		storage: { downloadUrl },
	} as unknown as VcpDeckClient;
	return render(
		<MemoryRouter initialEntries={["/jobs/job-1"]}>
			<SdkProvider client={client}>
				<AuthProvider>
					<Routes>
						<Route path="/jobs/:jobId" element={<JobDetailPage />} />
					</Routes>
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("JobDetailPage 下载链接", () => {
	it("file.export 完成的 job 展示稳定下载链接", async () => {
		const downloadUrl = vi
			.fn()
			.mockReturnValue("/api/storage/download-redirect/aliyun-fileid-123");
		renderDetail(exportJob, downloadUrl);

		const link = await screen.findByRole("link", { name: "下载文件" });
		expect(link).toHaveAttribute(
			"href",
			`${window.location.origin}/api/storage/download-redirect/aliyun-fileid-123`,
		);
		expect(link).toHaveAttribute("download", "app.log");
		expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
		expect(downloadUrl).toHaveBeenCalledWith("aliyun-fileid-123");
		expect(screen.queryByText(/正在生成下载链接/)).not.toBeInTheDocument();
	});

	it("file.import 完成的 job 展示下载链接且文件名取 targetPath", async () => {
		const downloadUrl = vi
			.fn()
			.mockReturnValue("/api/storage/download-redirect/aliyun-fileid-456");
		renderDetail(
			{
				...exportJob,
				type: "file.import",
				payload: { rootDir: "/srv", targetPath: "/srv/uploads/app.log" },
				result: {
					path: "/srv/uploads/app.log",
					size: 1024,
					sha256: "x",
					key: "aliyun-fileid-456",
				},
			},
			downloadUrl,
		);

		const link = await screen.findByRole("link", { name: "下载文件" });
		expect(link).toHaveAttribute("download", "app.log");
		expect(downloadUrl).toHaveBeenCalledWith("aliyun-fileid-456");
	});

	it("file.import 完成但没有 key 时不显示下载链接", async () => {
		const downloadUrl = vi.fn();
		renderDetail(
			{
				...exportJob,
				type: "file.import",
				payload: { rootDir: "/srv", targetPath: "/srv/uploads/app.log" },
				result: { path: "/srv/uploads/app.log", size: 1024, sha256: "x" },
			},
			downloadUrl,
		);

		expect(await screen.findByText("状态")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "下载文件" }),
		).not.toBeInTheDocument();
		expect(downloadUrl).not.toHaveBeenCalled();
	});

	it("exec 类型的 job 不显示下载链接", async () => {
		const downloadUrl = vi.fn();
		renderDetail(
			{
				...exportJob,
				type: "exec",
				result: { exitCode: 0, stdout: "hello" },
				payload: { command: "ls" },
			},
			downloadUrl,
		);

		expect(await screen.findByText("标准输出")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "下载文件" }),
		).not.toBeInTheDocument();
		expect(downloadUrl).not.toHaveBeenCalled();
	});
});
