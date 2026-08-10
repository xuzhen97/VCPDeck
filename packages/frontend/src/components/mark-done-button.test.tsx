import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { JobInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { MarkDoneButton } from "./mark-done-button";

function sessionJob(overrides: Partial<JobInfo> = {}): JobInfo {
	return {
		jobId: "session-1",
		clientId: "client-1",
		clientName: null,
		type: "agent.session",
		status: "idle" as JobInfo["status"],
		payload: {},
		result: null,
		progress: null,
		errorCode: null,
		errorMessage: null,
		createdAt: "2026-08-10T00:00:00.000Z",
		startedAt: null,
		finishedAt: null,
		createdByIdentityId: "identity-1",
		createdByName: "管理员",
		createdVia: "web",
		...overrides,
	};
}

function renderButton(job: JobInfo, onChanged = vi.fn()) {
	const complete = vi.fn().mockResolvedValue({});
	const client = { pi: { agent: { complete } } } as unknown as VcpDeckClient;
	const view = render(
		<SdkProvider client={client}>
			<MarkDoneButton job={job} onChanged={onChanged} />
		</SdkProvider>,
	);
	return {
		complete,
		onChanged,
		rerender: (next: JobInfo) =>
			view.rerender(
				<SdkProvider client={client}>
					<MarkDoneButton job={next} onChanged={onChanged} />
				</SdkProvider>,
			),
	};
}

describe("MarkDoneButton", () => {
	it("非 agent.session 任务不渲染", () => {
		renderButton(sessionJob({ type: "exec" }));
		expect(
			screen.queryByRole("button", { name: "标记完成" }),
		).not.toBeInTheDocument();
	});

	it("done 或 cancelled 会话不渲染", () => {
		const { rerender } = renderButton(
			sessionJob({ status: "done" as JobInfo["status"] }),
		);
		expect(
			screen.queryByRole("button", { name: "标记完成" }),
		).not.toBeInTheDocument();
		rerender(sessionJob({ status: "cancelled" as JobInfo["status"] }));
		expect(
			screen.queryByRole("button", { name: "标记完成" }),
		).not.toBeInTheDocument();
	});

	it("确认后调用 pi.complete 并触发 onChanged", async () => {
		const { complete, onChanged } = renderButton(
			sessionJob({ status: "waiting_input" as JobInfo["status"] }),
		);
		await userEvent.click(screen.getByRole("button", { name: "标记完成" }));
		await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
		expect(complete).toHaveBeenCalledWith(
			"client-1",
			"session-1",
			undefined,
			expect.any(AbortSignal),
		);
		expect(onChanged).toHaveBeenCalled();
	});

	it("失败时对话框保持打开并显示错误", async () => {
		const { complete } = renderButton(sessionJob());
		complete.mockRejectedValueOnce(new Error("PI_CONTROL_FORBIDDEN"));
		await userEvent.click(screen.getByRole("button", { name: "标记完成" }));
		await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"PI_CONTROL_FORBIDDEN",
		);
		expect(screen.getByRole("button", { name: "确认完成" })).toBeEnabled();
	});
});
