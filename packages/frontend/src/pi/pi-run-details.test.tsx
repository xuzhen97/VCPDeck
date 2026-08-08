import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PiRunDetails } from "./pi-run-details.js";

const agentState = {
	status: "idle" as const,
	streaming: false,
	prompting: false,
	compacting: false,
	thinkingLevel: "medium" as const,
	model: { provider: "p", modelId: "m1" },
	queuedMessages: { steering: [], followUp: [] },
};

function renderDetails(overrides: Partial<Parameters<typeof PiRunDetails>[0]> = {}) {
	const props: Parameters<typeof PiRunDetails>[0] = {
		agentState,
		models: [
			{ provider: "p", modelId: "m1" },
			{ provider: "p", modelId: "m2" },
		],
		thinkingSelection: "medium",
		disabled: false,
		onModelChange: vi.fn(),
		onThinkingChange: vi.fn(),
		runId: null,
		sessionId: "s1",
		ownerName: null,
		isObserver: false,
		...overrides,
	};
	return { ...render(<PiRunDetails {...props} />), props };
}

describe("PiRunDetails", () => {
	it("渲染模型和思考深度选择器", () => {
		renderDetails();

		expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("p\u0000m1");
		expect(screen.getByRole("combobox", { name: "思考深度" })).toHaveValue("medium");
		expect(screen.getByRole("option", { name: "p / m1" })).toBeTruthy();
		expect(screen.getByRole("option", { name: "自动" })).toBeTruthy();
	});

	it("禁用时不允许切换，空闲时转发选择", () => {
		const onModelChange = vi.fn();
		const onThinkingChange = vi.fn();
		const view = renderDetails({ onModelChange, onThinkingChange, disabled: true });

		expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
		expect(screen.getByRole("combobox", { name: "思考深度" })).toBeDisabled();

		view.rerender(<PiRunDetails {...view.props} disabled={false} />);
		fireEvent.change(screen.getByRole("combobox", { name: "模型" }), { target: { value: "p\u0000m2" } });
		fireEvent.change(screen.getByRole("combobox", { name: "思考深度" }), { target: { value: "high" } });
		expect(onModelChange).toHaveBeenCalledWith("p", "m2");
		expect(onThinkingChange).toHaveBeenCalledWith("high");
	});
});
