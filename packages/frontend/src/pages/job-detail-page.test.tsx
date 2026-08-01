import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo, JobInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { JobDetailPage } from "./job-detail-page";
import { JobStatus } from "@vcpdeck/shared";

const exportJob: JobInfo = {
	jobId: "job-1",
	clientId: "c1",
	clientName: "machine-1",
	type: "file.export",
	status: JobStatus.DONE,
	payload: { rootDir: "/srv", path: "/srv/logs/app.log" },
	result: { fileId: "f1", key: "aliyun-fileid-123", size: 1024, sha256: "x" },
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

function renderDetail(
	job: JobInfo,
	createDownloadToken: ReturnType<typeof vi.fn>,
) {
	const client = {
		auth: { me: vi.fn().mockResolvedValue(identity) },
		jobs: { get: vi.fn().mockResolvedValue(job) },
		storage: { createDownloadToken },
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
	it("file.export 完成的 job 展示可点击的下载链接", async () => {
		const createDownloadToken = vi.fn().mockResolvedValue({
			url: "/api/storage/download/aliyun-fileid-123?expires=0&sig=abc",
			expiresAt: 0,
		});
		renderDetail(exportJob, createDownloadToken);

		const link = await screen.findByRole("link", { name: "下载文件" });
		expect(link).toHaveAttribute(
			"href",
			`${window.location.origin}/api/storage/download/aliyun-fileid-123?expires=0&sig=abc`,
		);
		expect(link).toHaveAttribute("download", "app.log");
		expect(
			screen.getByText(
				`${window.location.origin}/api/storage/download/aliyun-fileid-123?expires=0&sig=abc`,
			),
		).toBeInTheDocument();
		expect(createDownloadToken).toHaveBeenCalledWith({
			key: "aliyun-fileid-123",
			ttlSeconds: 0,
		});
	});

	it("签发失败时显示下载链接不可用", async () => {
		const createDownloadToken = vi
			.fn()
			.mockRejectedValue(new Error("invalid key"));
		renderDetail(exportJob, createDownloadToken);

		expect(await screen.findByText("下载链接不可用")).toBeInTheDocument();
	});

	it("exec 类型的 job 不显示下载链接", async () => {
		const createDownloadToken = vi.fn();
		renderDetail(
			{
				...exportJob,
				type: "exec",
				result: { exitCode: 0, stdout: "hello" },
				payload: { command: "ls" },
			},
			createDownloadToken,
		);

		expect(await screen.findByText("标准输出")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "下载文件" }),
		).not.toBeInTheDocument();
		expect(createDownloadToken).not.toHaveBeenCalled();
	});
});
