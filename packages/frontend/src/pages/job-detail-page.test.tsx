import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo, JobInfo } from "@vcpdeck/shared";
import { JobStatus } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
	timeout: null,
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
	downloadUrl: ReturnType<typeof vi.fn>,
	extra: Record<string, unknown> = {},
) {
	const { jobs: extraJobs, ...rest } = extra as {
		jobs?: Record<string, unknown>;
	} & Record<string, unknown>;
	const client = {
		auth: { me: vi.fn().mockResolvedValue(identity) },
		jobs: {
			get: vi.fn().mockResolvedValue(job),
			logs: vi.fn().mockResolvedValue({
				jobId: job.jobId,
				events: [],
				nextSeq: 0,
			}),
			...extraJobs,
		},
		storage: { downloadUrl },
		...rest,
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

it("历史会话 Job 详情不再提供完成动作(ADR-0041)", async () => {
	const session: JobInfo = {
		...exportJob,
		type: "agent.session",
		status: JobStatus.WAITING_INPUT,
		result: null,
		payload: {},
	};
	const get = vi.fn().mockResolvedValue(session);
	renderDetail(session, vi.fn(), { jobs: { get } });

	// 会话完成语义已移除:详情页头部不再有"标记完成"按钮。
	expect(await screen.findByText("agent.session")).toBeVisible();
	expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
	expect(get).toHaveBeenCalledTimes(1);
});

describe("JobDetailPage 日志事件时间线（ADR-0054）", () => {
	it("按 seq 展示事件、来源与详情", async () => {
		const logs = vi.fn().mockResolvedValue({
			jobId: "job-1",
			nextSeq: 2,
			events: [
				{
					seq: 1,
					jobId: "job-1",
					at: "2026-10-17T14:00:00.000Z",
					source: "server",
					event: "created",
					level: "info",
					code: null,
					message: null,
					data: { type: "exec" },
				},
				{
					seq: 2,
					jobId: "job-1",
					at: "2026-10-17T14:00:02.000Z",
					source: "client",
					event: "local_settled",
					level: "warn",
					code: "EXEC_TIMEOUT",
					message: "timed out",
					data: { reason: "timeout", drainTimedOut: false },
				},
			],
		});
		renderDetail(
			{ ...exportJob, type: "exec", result: { exitCode: 1 } },
			vi.fn(),
			{ jobs: { logs } },
		);

		expect(await screen.findByText("日志事件")).toBeInTheDocument();
		expect(await screen.findByText("created")).toBeInTheDocument();
		expect(await screen.findByText("local_settled")).toBeInTheDocument();
		expect(screen.getByText(/reason=timeout/)).toBeInTheDocument();
		expect(logs).toHaveBeenCalledWith(
			"job-1",
			undefined,
			expect.any(AbortSignal),
		);
	});

	it("没有事件时给出明确文案", async () => {
		renderDetail(exportJob, vi.fn());

		expect(await screen.findByText("日志事件")).toBeInTheDocument();
		expect(await screen.findByText(/暂无日志事件/)).toBeInTheDocument();
	});
});
