import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PiRunDetails } from "./pi-run-details.js";

const agentState = {
	status: "idle" as const, streaming: false, prompting: false, compacting: false,
	thinkingLevel: "medium" as const, model: { provider: "p", modelId: "m1" },
	queuedMessages: { steering: [], followUp: [] },
};
const idleJob = { jobId: "s1", sessionId: "s1", status: "idle" as const, runId: null, ownerName: "User", isOwner: true };

function renderDetails(overrides: Partial<Parameters<typeof PiRunDetails>[0]> = {}) {
	const props: Parameters<typeof PiRunDetails>[0] = {
		job: idleJob, agentState,
		models: [{ provider: "p", modelId: "m1" }, { provider: "p", modelId: "m2" }],
		thinkingSelection: "medium", disabled: false, onModelChange: vi.fn(),
		onThinkingChange: vi.fn(), onComplete: vi.fn(), ...overrides,
	};
	return { ...render(<PiRunDetails {...props} />), props };
}

describe("PiRunDetails", () => {
	it("空闲 Owner 可以标记完成", async () => {
		const onComplete = vi.fn(); renderDetails({ onComplete });
		await userEvent.click(screen.getByRole("button", { name: "标记完成" }));
		expect(onComplete).toHaveBeenCalledOnce();
	});
	it("活动时显示停止并标记完成", () => {
		renderDetails({ job: { ...idleJob, status: "running", runId: "run-1" } });
		expect(screen.getByRole("button", { name: "停止并标记完成" })).toBeTruthy();
		expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
	});
	it("done 显示可重新激活说明", () => {
		renderDetails({ job: { ...idleJob, status: "done" } });
		expect(screen.getByText("已完成，可继续提问以重新激活")).toBeTruthy();
	});
	it("Observer 不显示完成按钮且设置只读", () => {
		renderDetails({ job: { ...idleJob, isOwner: false } });
		expect(screen.queryByRole("button", { name: /标记完成/ })).toBeNull();
		expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
		expect(screen.getByRole("combobox", { name: "思考深度" })).toBeDisabled();
	});
	it("空闲时转发模型和思考选择", () => {
		const onModelChange = vi.fn(); const onThinkingChange = vi.fn();
		renderDetails({ onModelChange, onThinkingChange });
		fireEvent.change(screen.getByRole("combobox", { name: "模型" }), { target: { value: "p\u0000m2" } });
		fireEvent.change(screen.getByRole("combobox", { name: "思考深度" }), { target: { value: "high" } });
		expect(onModelChange).toHaveBeenCalledWith("p", "m2");
		expect(onThinkingChange).toHaveBeenCalledWith("high");
	});
});
