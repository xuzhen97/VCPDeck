import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PiSessionState } from "./use-pi-session.js";
import { PiChatWindow } from "./pi-chat-window.js";

function state(overrides: Partial<PiSessionState> = {}): PiSessionState {
	return {
		messages: [
			{
				id: "u1",
				role: "user",
				content: [{ type: "text", text: "question" }],
			},
		],
		session: null,
		agentState: null,
		runId: "j1",
		status: "running",
		error: null,
		hasMore: false,
		nextCursor: null,
		pendingExtension: null,
		models: [],
		thinkingSelection: "auto",
		thinkingText: "先检查项目结构，再读取 README。",
		thinkingDurationMs: 1234,
		...overrides,
	};
}

describe("PiChatWindow", () => {
	it("实时思考正文默认折叠，展开后可查看", async () => {
		const user = userEvent.setup();
		render(<PiChatWindow state={state()} info={null} onLoadMore={() => {}} />);

		expect(screen.getByText("已思考 1.2 秒")).toBeTruthy();
		expect(screen.getByText("展开思考")).toBeTruthy();
		expect(screen.queryByText("先检查项目结构，再读取 README。")).toBeNull();
		await user.click(screen.getByRole("button", { name: /展开思考/ }));
		expect(screen.getByText("先检查项目结构，再读取 README。")).toBeTruthy();
	});
});
