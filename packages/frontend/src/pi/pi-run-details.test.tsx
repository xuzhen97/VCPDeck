import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PiRunInfo, PiSessionSnapshot } from "@vcpdeck/shared";
import { PiRunDetails } from "./pi-run-details.js";
import type { PiSessionStatus } from "./use-pi-session.js";

const agentState = {
	status: "idle" as const,
	streaming: false,
	prompting: false,
	compacting: false,
	thinkingLevel: "medium" as const,
	model: { provider: "p", modelId: "m1" },
	queuedMessages: { steering: [], followUp: [] },
};

const idleSnapshot: PiSessionSnapshot = {
	sessionId: "s1",
	status: "available",
	activeRun: null,
	executionModeOverride: null,
	effectiveExecutionMode: "supervised",
	executionModeNeedsConfirmation: false,
	ownerName: "User",
	isOwner: true,
};

function activeRun(status: PiRunInfo["status"]): PiRunInfo {
	const terminal = status === "succeeded" || status === "failed" || status === "aborted";
	return {
		runId: "run-1",
		sessionId: "s1",
		status,
		kind: "prompt",
		executionMode: "supervised",
		actorName: "User",
		source: "web",
		createdAt: "2026-10-08T00:00:00.000Z",
		acceptedAt: "2026-10-08T00:00:01.000Z",
		startedAt: "2026-10-08T00:00:01.000Z",
		finishedAt: terminal ? "2026-10-08T00:00:05.000Z" : null,
		errorCode: status === "failed" ? "PI_WORKER_EXITED" : null,
	};
}

/** 与 usePiSession.effectiveStatus 等价的展示态推导,供用例默认值使用。 */
function statusOf(snapshot: PiSessionSnapshot): PiSessionStatus {
	const run = snapshot.activeRun;
	if (run?.status === "disconnected") return "disconnected";
	if (run?.status === "failed") return "error";
	if (run?.status === "waiting_input") return "waiting_input";
	if (!run || run.status === "succeeded" || run.status === "aborted") return "idle";
	return "running";
}

function renderDetails(
	overrides: Partial<Parameters<typeof PiRunDetails>[0]> = {},
) {
	const props: Parameters<typeof PiRunDetails>[0] = {
		snapshot: idleSnapshot,
		status: statusOf(idleSnapshot),
		agentState,
		models: [
			{ provider: "p", modelId: "m1" },
			{ provider: "p", modelId: "m2" },
		],
		thinkingSelection: "medium",
		disabled: false,
		onModelChange: vi.fn(),
		onThinkingChange: vi.fn(),
		onArchive: vi.fn(),
		onRestore: vi.fn(),
		...overrides,
	};
	return { ...render(<PiRunDetails {...props} />), props };
}

describe("PiRunDetails", () => {
	it("空闲会话没有完成语义,只提供归档入口", async () => {
		const onArchive = vi.fn();
		renderDetails({ onArchive });
		// ADR-0041:会话不再有\"完成\"动作。
		expect(screen.queryByRole("button", { name: /完成/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "归档会话" }));
		expect(onArchive).toHaveBeenCalledOnce();
	});

	it("活跃轮次禁用设置且不显示完成入口", () => {
		renderDetails({
			snapshot: { ...idleSnapshot, activeRun: activeRun("running") },
			status: "running",
		});
		expect(screen.queryByRole("button", { name: /完成/ })).toBeNull();
		expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
		expect(screen.getByText("运行中")).toBeTruthy();
	});

	it("上一轮失败展示安全错误码,会话仍可继续", () => {
		renderDetails({
			snapshot: { ...idleSnapshot, activeRun: activeRun("failed") },
			status: "error",
		});
		expect(screen.getByRole("alert").textContent).toContain("PI_WORKER_EXITED");
		// 失败不阻塞设置:没有活跃执行即可调整。
		expect(screen.getByRole("combobox", { name: "模型" })).not.toBeDisabled();
	});

	it("归档会话提供恢复入口", async () => {
		const onRestore = vi.fn();
		renderDetails({
			snapshot: { ...idleSnapshot, status: "archived" },
			onRestore,
		});
		expect(screen.getByText("已归档")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "恢复会话" }));
		expect(onRestore).toHaveBeenCalledOnce();
	});

	it("Observer 不显示归档入口且设置只读", () => {
		renderDetails({ snapshot: { ...idleSnapshot, isOwner: false } });
		expect(screen.queryByRole("button", { name: /归档|恢复/ })).toBeNull();
		expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
		expect(screen.getByRole("combobox", { name: "思考深度" })).toBeDisabled();
	});

	it("空闲时转发模型和思考选择", () => {
		const onModelChange = vi.fn();
		const onThinkingChange = vi.fn();
		renderDetails({ onModelChange, onThinkingChange });
		fireEvent.change(screen.getByRole("combobox", { name: "模型" }), {
			target: { value: "p\u0000m2" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: "思考深度" }), {
			target: { value: "high" },
		});
		expect(onModelChange).toHaveBeenCalledWith("p", "m2");
		expect(onThinkingChange).toHaveBeenCalledWith("high");
	});

	it("思考深度选项显示协议对应的英文标签", () => {
		renderDetails();
		const options = Array.from(
			screen
				.getByRole("combobox", { name: "思考深度" })
				.querySelectorAll("option"),
		).map((option) => option.textContent);
		expect(options).toEqual([
			"Auto",
			"Off",
			"Minimal",
			"Low",
			"Medium",
			"High",
			"XHigh",
			"Max",
		]);
	});

	it("无候选模型时下拉框给出可见文案而不是空白", () => {
		renderDetails({ models: [] });
		const select = screen.getByRole("combobox", { name: "模型" });
		expect(select).toBeDisabled();
		// 已知当前模型时直接回显它，否则明确说明暂无可用模型。
		expect(select.querySelectorAll("option")[0]?.textContent).toBe("p / m1");

		renderDetails({ models: [], agentState: { ...agentState, model: undefined } });
		const empty = screen.getAllByRole("combobox", { name: "模型" })[1];
		expect(empty?.querySelectorAll("option")[0]?.textContent).toBe(
			"（暂无可用模型）",
		);
	});
});
