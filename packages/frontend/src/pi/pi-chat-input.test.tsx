import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PiChatInput } from "./pi-chat-input.js";

function renderInput(overrides: Partial<Parameters<typeof PiChatInput>[0]> = {}) {
	return render(<PiChatInput status="idle" disabled={false} onSend={vi.fn()} onSteer={vi.fn()} onFollowUp={vi.fn()} onAbort={vi.fn()} onCompact={vi.fn()} onAbortCompact={vi.fn()} onPickFiles={vi.fn()} {...overrides} />);
}

describe("PiChatInput", () => {
	it("Observer 禁用正文并隐藏所有运行和附件 mutation", () => {
		renderInput({ status: "running", disabled: true });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Follow-up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
		expect(screen.queryByRole("button", { name: "中止" })).toBeNull();
		expect(screen.queryByText("🖼️ 添加")).toBeNull();
	});
	it.each(["error", "running", "waiting_input"] as const)("%s 禁止普通 Prompt", (status) => {
		renderInput({ status });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
	});
	it.each(["idle", "done"] as const)("%s 允许普通 Prompt", (status) => {
		renderInput({ status });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeEnabled();
	});
});
