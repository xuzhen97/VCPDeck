import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PiMessageView } from "./pi-message-view.js";
import type { PiMessage } from "@vcpdeck/shared";

describe("PiMessageView", () => {
	it("渲染 Markdown 与 GFM", () => {
		const message: PiMessage = {
			id: "m1",
			role: "assistant",
			content: [{ type: "text", text: "**bold** and ~~strike~~" }],
		};
		render(<PiMessageView message={message} />);
		expect(screen.getByText("bold")).toBeTruthy();
		expect(screen.getByText("strike")).toBeTruthy();
	});

	it("不渲染 raw HTML", () => {
		const message: PiMessage = {
			id: "m1",
			role: "assistant",
			content: [
				{ type: "text", text: "before\n\n<script>alert(1)</script>\n\nafter" },
			],
		};
		const { container } = render(<PiMessageView message={message} />);
		expect(container.textContent).not.toContain("alert(1)");
		expect(container.textContent).toContain("before");
		expect(container.textContent).toContain("after");
	});

	it("thinking 只显示阶段，不渲染正文", () => {
		const message: PiMessage = {
			id: "m1",
			role: "assistant",
			content: [
				{ type: "thinking", deferred: true, durationMs: 2500 },
				{ type: "text", text: "answer" },
			],
		};
		render(<PiMessageView message={message} />);
		expect(screen.getByTestId("thinking-block")).toBeTruthy();
		expect(screen.queryByText("secret thinking")).toBeNull();
	});

	it("Tool Call 默认摘要，展开后显示参数与结果", async () => {
		const user = userEvent.setup();
		const message: PiMessage = {
			id: "m1",
			role: "assistant",
			content: [
				{
					type: "tool_call",
					toolCallId: "t1",
					toolName: "bash",
					input: { command: "pwd" },
				},
			],
		};
		render(
			<PiMessageView message={message} toolResults={{ t1: "output here" }} />,
		);
		expect(screen.getByTestId("tool-call")).toBeTruthy();
		expect(screen.getByText("bash")).toBeTruthy();
		expect(screen.queryByText("output here")).toBeNull();

		await user.click(screen.getByText("bash"));
		expect(screen.getByText("output here")).toBeTruthy();
		expect(screen.getByText(/".*command.*pwd/)).toBeTruthy();
	});

	it("防御性：含 secret 的输入不渲染 secret", () => {
		const message: PiMessage = {
			id: "m1",
			role: "assistant",
			content: [
				{ type: "thinking", deferred: true } as never,
				{ type: "text", text: "ok" },
			],
		};
		render(<PiMessageView message={message} />);
		expect(screen.queryByText(/secret/i)).toBeNull();
	});

	it("user 消息渲染文本", () => {
		const message: PiMessage = {
			id: "u1",
			role: "user",
			content: [{ type: "text", text: "hello there" }],
		};
		render(<PiMessageView message={message} />);
		expect(screen.getByText("hello there")).toBeTruthy();
	});

	it("tool_result 渲染结果文本", () => {
		const message: PiMessage = {
			id: "r1",
			role: "tool_result",
			toolCallId: "t1",
			content: [{ type: "text", text: "result text" }],
		};
		render(<PiMessageView message={message} />);
		expect(screen.getByTestId("tool-result")).toBeTruthy();
		expect(screen.getByText("result text")).toBeTruthy();
	});
});
