import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { JobInfo } from "@vcpdeck/shared";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { ExecutePanel } from "./execute-panel";

function completed(overrides: Partial<JobInfo> = {}): JobInfo {
	return {
		jobId: "job-1",
		clientId: "client-1",
		clientName: null,
		type: "exec",
		status: "done" as JobInfo["status"],
		payload: { mode: "command", command: "node --version" },
		result: { exitCode: 0 },
		errorCode: null,
		errorMessage: null,
		createdAt: "2026-07-26T00:00:00.000Z",
		startedAt: "2026-07-26T00:00:01.000Z",
		finishedAt: "2026-07-26T00:00:03.000Z",
		createdByIdentityId: "identity-1",
		createdByName: "管理员",
		createdVia: "web",
		...overrides,
	};
}

function renderPanel(job = completed(), wait = vi.fn().mockResolvedValue(job)) {
	const create = vi
		.fn()
		.mockResolvedValue({ jobId: "job-1", status: "running", type: "exec" });
	const client = { jobs: { create, wait } } as unknown as VcpDeckClient;
	render(
		<SdkProvider client={client}>
			<ExecutePanel clientId="client-1" />
		</SdkProvider>,
	);
	return { create, wait };
}

describe("ExecutePanel", () => {
	it("opens an animated dialog immediately and replaces it with the result", async () => {
		let finish!: (job: JobInfo) => void;
		const wait = vi.fn().mockReturnValue(
			new Promise<JobInfo>((resolve) => {
				finish = resolve;
			}),
		);
		const { create } = renderPanel(completed(), wait);
		await userEvent.type(screen.getByLabelText("命令"), "node --version");
		await userEvent.click(screen.getByRole("button", { name: "执行命令" }));

		const dialog = screen.getByRole("dialog", { name: "执行任务" });
		expect(dialog).toBeVisible();
		expect(screen.getByRole("status")).toHaveTextContent(
			"正在等待机器返回结果",
		);
		expect(
			screen.queryByText("提交后将在此显示 Job 状态摘要。"),
		).not.toBeInTheDocument();
		expect(create).toHaveBeenCalledWith(
			{
				clientId: "client-1",
				type: "exec",
				payload: { mode: "command", command: "node --version" },
			},
			expect.any(AbortSignal),
		);

		await act(async () =>
			finish(
				completed({
					result: {
						exitCode: 0,
						stdout: "v24.15.0\r\n",
						stderr: "warning\r\n",
					},
				}),
			),
		);
		expect(dialog).toHaveTextContent("退出码");
		expect(within(dialog).getByText("0")).toBeVisible();
		expect(dialog).toHaveTextContent("2 秒");
		expect(within(dialog).getByText("标准输出")).toBeVisible();
		expect(within(dialog).getByText(/v24\.15\.0/)).toBeVisible();
		expect(within(dialog).getByText("标准错误")).toBeVisible();
		expect(within(dialog).getByText(/warning/)).toBeVisible();
		expect(
			within(dialog).queryByText("当前 Server 未持久化过程输出"),
		).not.toBeInTheDocument();
	});

	it("submits script payload", async () => {
		const { create } = renderPanel();
		await userEvent.click(screen.getByRole("tab", { name: "脚本" }));
		await userEvent.type(screen.getByLabelText("解释器"), "node");
		await userEvent.type(screen.getByLabelText("参数"), "-");
		await userEvent.type(
			screen.getByLabelText("脚本内容"),
			"console.log('hello')",
		);
		await userEvent.click(screen.getByRole("button", { name: "执行脚本" }));
		expect(create).toHaveBeenCalledWith(
			{
				clientId: "client-1",
				type: "exec",
				payload: {
					mode: "script",
					executable: "node",
					args: ["-"],
					script: "console.log('hello')",
				},
			},
			expect.any(AbortSignal),
		);
	});

	it("shows stable job errors", async () => {
		renderPanel(
			completed({
				status: "error" as JobInfo["status"],
				result: null,
				errorCode: "EXEC_FAILED",
				errorMessage: "Command failed",
			}),
		);
		await userEvent.type(screen.getByLabelText("命令"), "false");
		await userEvent.click(screen.getByRole("button", { name: "执行命令" }));
		expect(await screen.findByText("EXEC_FAILED")).toBeVisible();
		expect(screen.getByText("Command failed")).toBeVisible();
	});
});
