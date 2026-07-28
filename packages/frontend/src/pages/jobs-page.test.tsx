import type { VcpDeckClient, WaitJobOptions } from "@vcpdeck/sdk";
import type { IdentityInfo, JobInfo } from "@vcpdeck/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { JobsPage } from "./jobs-page";

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
		clientName: null,
		type: "exec",
		status: "running" as JobInfo["status"],
		payload: { mode: "command", command: "node --version", secret: "hidden" },
		result: null,
		errorCode: null,
		errorMessage: null,
		createdAt: "2026-07-26T00:00:00.000Z",
		startedAt: null,
		finishedAt: null,
		createdByIdentityId: "i1",
		createdByName: "管理员",
		createdVia: "web",
		...overrides,
	};
}

it("shows the global jobs table and filters status through the paginated API", async () => {
	const list = vi.fn().mockResolvedValue({
		data: [
			job({ jobId: "exec-running", clientId: "machine-a" }),
			job({ jobId: "file-running", clientId: "machine-b", type: "file.list" }),
			job({
				jobId: "exec-done",
				clientId: "machine-a",
				status: "done" as JobInfo["status"],
			}),
		],
		total: 42,
		page: 1,
		pageSize: 20,
		totalPages: 3,
	});
	const cancel = vi
		.fn()
		.mockResolvedValue({ jobId: "exec-running", status: "cancelling" });
	const wait = vi
		.fn()
		.mockResolvedValue(
			job({ jobId: "exec-running", status: "cancelled" as JobInfo["status"] }),
		);
	const client = {
		auth: { me: async () => identity },
		jobs: { list, cancel, wait },
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter>
			<SdkProvider client={client}>
				<AuthProvider>
					<JobsPage />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);

	expect(await screen.findByText("任务记录")).toBeVisible();
	expect(screen.getByText("任务记录对所有已认证身份可见")).toBeVisible();
	expect(list).toHaveBeenCalledWith(
		{ clientId: undefined, status: undefined, page: 1, pageSize: 20 },
		expect.any(AbortSignal),
	);
	const table = screen.getByRole("table", { name: "任务记录" });
	expect(
		within(table).getByRole("columnheader", { name: "机器" }),
	).toBeVisible();
	expect(within(table).getAllByText("machine-a")).toHaveLength(2);
	expect(screen.getAllByRole("button", { name: "取消任务" })).toHaveLength(1);
	expect(screen.getAllByText("命令：node --version")).toHaveLength(2);
	expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();

	await userEvent.click(screen.getByRole("button", { name: "下一页" }));
	await waitFor(() =>
		expect(list).toHaveBeenLastCalledWith(
			{ clientId: undefined, status: undefined, page: 2, pageSize: 20 },
			expect.any(AbortSignal),
		),
	);
	await userEvent.selectOptions(screen.getByLabelText("按状态筛选"), "error");
	await waitFor(() =>
		expect(list).toHaveBeenLastCalledWith(
			{ clientId: undefined, status: "error", page: 1, pageSize: 20 },
			expect.any(AbortSignal),
		),
	);

	await userEvent.click(screen.getByRole("button", { name: "取消任务" }));
	expect(cancel).toHaveBeenCalledWith("exec-running", expect.any(AbortSignal));
	expect(wait).toHaveBeenCalledWith("exec-running", {
		signal: expect.any(AbortSignal),
	});
});

it("shows understandable jobs in a paginated table and opens details in a drawer", async () => {
	const list = vi.fn().mockResolvedValue({
		data: [
			job({
				jobId: "exec-done",
				status: "done" as JobInfo["status"],
				startedAt: "2026-07-26T00:00:01.000Z",
				finishedAt: "2026-07-26T00:00:03.000Z",
				result: { exitCode: 0, stdout: "v24.0.0", stderr: "warning" },
			}),
			job({
				jobId: "file-list",
				type: "file.list",
				payload: { rootDir: "C:\\", path: "Users", password: "hidden" },
			}),
		],
		total: 42,
		page: 1,
		pageSize: 20,
		totalPages: 3,
	});
	const client = {
		auth: { me: async () => identity },
		jobs: { list },
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter>
			<SdkProvider client={client}>
				<AuthProvider>
					<JobsPage clientId="c1" />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);

	const table = await screen.findByRole("table", { name: "任务记录" });
	expect(list).toHaveBeenCalledWith(
		{ clientId: "c1", status: undefined, page: 1, pageSize: 20 },
		expect.any(AbortSignal),
	);
	expect(screen.getByText("第 1 / 3 页 · 共 42 条")).toBeVisible();
	await userEvent.click(screen.getByRole("button", { name: "下一页" }));
	await waitFor(() =>
		expect(list).toHaveBeenLastCalledWith(
			{ clientId: "c1", status: undefined, page: 2, pageSize: 20 },
			expect.any(AbortSignal),
		),
	);
	expect(within(table).getByText("执行命令")).toBeVisible();
	expect(within(table).getByText("读取目录")).toBeVisible();
	expect(within(table).getByText("已完成")).toBeVisible();
	expect(within(table).getByText("命令：node --version")).toBeVisible();
	expect(within(table).getByText("目录：C:\\Users")).toBeVisible();

	await userEvent.click(within(table).getByText("命令：node --version"));
	const drawer = screen.getByRole("dialog", { name: "任务详情" });
	expect(drawer).toHaveTextContent("exec-done");
	expect(drawer).toHaveTextContent("标准输出");
	expect(drawer).toHaveTextContent("v24.0.0");
	expect(drawer).toHaveTextContent("标准错误");
	expect(drawer).toHaveTextContent("warning");
	expect(drawer).toHaveTextContent("2 秒");
	expect(drawer).not.toHaveTextContent("hidden");
});

it("stops cancellation polling when the page unmounts", async () => {
	let rejectWait: ((reason: unknown) => void) | undefined;
	const wait = vi.fn(
		(_jobId: string, options?: WaitJobOptions) =>
			new Promise<JobInfo>((_resolve, reject) => {
				rejectWait = reject;
				options?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			}),
	);
	const client = {
		auth: { me: async () => identity },
		jobs: {
			list: vi.fn().mockResolvedValue({
				data: [job({})],
				total: 1,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			}),
			cancel: vi.fn().mockResolvedValue({ jobId: "j1", status: "cancelling" }),
			wait,
		},
	} as unknown as VcpDeckClient;
	const view = render(
		<StrictMode>
			<MemoryRouter>
				<SdkProvider client={client}>
					<AuthProvider>
						<JobsPage />
					</AuthProvider>
				</SdkProvider>
			</MemoryRouter>
		</StrictMode>,
	);
	await userEvent.click(
		await screen.findByRole("button", { name: "取消任务" }),
	);
	await waitFor(() => expect(wait).toHaveBeenCalled());
	const signal = wait.mock.calls[0]?.[1]?.signal;
	expect(signal?.aborted).toBe(false);
	view.unmount();
	expect(signal?.aborted).toBe(true);
	rejectWait?.(new DOMException("Aborted", "AbortError"));
	await Promise.resolve();
});
