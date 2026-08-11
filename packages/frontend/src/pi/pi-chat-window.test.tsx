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
		job: overrides.job ?? null,
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

	it("加载历史期间显示加载提示而非空状态", () => {
		render(
			<PiChatWindow
				state={state({ messages: [], status: "loading" })}
				info={null}
				onLoadMore={() => {}}
			/>,
		);

		const loading = screen.getByTestId("pi-history-loading");
		expect(loading.textContent).toContain("正在加载历史消息");
		expect(loading.querySelectorAll(".pi-chat-loading-dot")).toHaveLength(3);
		expect(screen.queryByText("开始一段新的 Pi 会话")).toBeNull();
	});

	it("运行中状态显示动画处理提示", () => {
		render(<PiChatWindow state={state()} info={null} onLoadMore={() => {}} />);

		const indicator = screen.getByTestId("streaming-indicator");
		expect(indicator.textContent).toContain("Pi 正在处理");
		expect(indicator.querySelectorAll(".pi-chat-loading-dot")).toHaveLength(3);
	});

	it("空闲空消息时显示新会话空状态", () => {
		render(
			<PiChatWindow
				state={state({ messages: [], status: "idle" })}
				info={null}
				onLoadMore={() => {}}
			/>,
		);

		expect(screen.getByText("开始一段新的 Pi 会话")).toBeTruthy();
	});
});
