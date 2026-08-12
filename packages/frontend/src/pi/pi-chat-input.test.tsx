import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PiChatInput } from "./pi-chat-input.js";

function renderInput(
	overrides: Partial<Parameters<typeof PiChatInput>[0]> = {},
) {
	return render(
		<PiChatInput
			status="idle"
			disabled={false}
			onSend={vi.fn()}
			onSteer={vi.fn()}
			onFollowUp={vi.fn()}
			onAbort={vi.fn()}
			onCompact={vi.fn()}
			onAbortCompact={vi.fn()}
			onPickFiles={vi.fn()}
			{...overrides}
		/>,
	);
}

describe("PiChatInput", () => {
	it("Observer 禁用正文并隐藏所有运行和附件 mutation", () => {
		const onAbort = vi.fn();
		renderInput({ status: "running", disabled: true, onAbort });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Follow-up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
		expect(screen.queryByRole("button", { name: "中止" })).toBeNull();
		expect(screen.queryByText("🖼️ 添加")).toBeNull();

		fireEvent.keyDown(window, { key: "Escape" });
		expect(onAbort).not.toHaveBeenCalled();
	});
	it.each([
		"error",
		"running",
		"waiting_input",
	] as const)("%s 禁止普通 Prompt", (status) => {
		renderInput({ status });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
	});
	it.each(["idle", "done"] as const)("%s 允许普通 Prompt", (status) => {
		renderInput({ status });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeEnabled();
	});

	it("输入区附件按钮、文本框和发送按钮使用统一高度", () => {
		renderInput();

		expect(screen.getByTestId("pi-chat-composer")).toHaveClass("p-3");
		expect(screen.getByText("🖼️ 添加")).toHaveClass("h-12");
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toHaveClass(
			"h-12",
			"min-h-12",
		);
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toHaveAttribute(
			"rows",
			"1",
		);
		expect(screen.getByRole("button", { name: "发送" })).toHaveClass("h-12");
	});
});
