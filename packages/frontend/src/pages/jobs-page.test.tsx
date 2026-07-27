import type { VcpDeckClient, WaitJobOptions } from "@vcpdeck/sdk";
import type { IdentityInfo, JobInfo } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
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

it("explains list limits and only offers reliable exec cancellation", async () => {
	const list = vi
		.fn()
		.mockResolvedValue([
			job({ jobId: "exec-running" }),
			job({ jobId: "file-running", type: "file.list" }),
			job({ jobId: "exec-done", status: "done" as JobInfo["status"] }),
		]);
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

	expect(await screen.findByText("最近 100 条任务")).toBeVisible();
	expect(screen.getByText("任务记录对所有已认证身份可见")).toBeVisible();
	expect(screen.getAllByRole("button", { name: "取消任务" })).toHaveLength(1);
	expect(screen.getAllByText("命令：node --version")).toHaveLength(2);
	expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "取消任务" }));
	expect(cancel).toHaveBeenCalledWith("exec-running", expect.any(AbortSignal));
	expect(wait).toHaveBeenCalledWith("exec-running", {
		signal: expect.any(AbortSignal),
	});
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
			list: vi.fn().mockResolvedValue([job({})]),
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
