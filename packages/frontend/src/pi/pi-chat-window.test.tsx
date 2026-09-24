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

describe("消息体经 pi-web MessageView 渲染（带降级护栏）", () => {
	it("assistant 消息带 data-message-role=assistant（pi-web 渲染器标记）", async () => {
		render(
			<PiChatWindow
				state={state({
					messages: [
						{ id: "u1", role: "user", content: [{ type: "text", text: "提问" }] },
						{
							id: "a1",
							role: "assistant",
							content: [{ type: "text", text: "渲染管线接管这行文本" }],
						},
					],
				})}
				info={null}
				onLoadMore={() => {}}
			/>,
		);
		expect(await screen.findByText("渲染管线接管这行文本")).toBeDefined();
		expect(
			document.querySelector('[data-message-role="assistant"]'),
		).not.toBeNull();
	});
});

describe("工具输出经 toolResults map 内联在 assistant 卡（上游契约）", () => {
	it("tool_result 不再独立渲染，其内容出现在 assistant 消息内且仅一次", async () => {
		render(
			<PiChatWindow
				state={state({
					messages: [
						{ id: "u1", role: "user", content: [{ type: "text", text: "提问" }] },
						{
							id: "a1",
							role: "assistant",
							content: [
								{
									type: "tool_call",
									toolCallId: "t1",
									toolName: "bash",
									input: { command: "ls" },
								},
								{ type: "text", text: "答案已生成" },
							],
						},
						{
							id: "r1",
							role: "tool_result",
							toolCallId: "t1",
							content: [{ type: "text", text: "结果输出内容" }],
						},
					],
				})}
				info={null}
				onLoadMore={() => {}}
			/>,
		);
		// 结果仅在工具卡展开时渲染（上游 MessageView 语义）
		await userEvent.click(await screen.findByRole("button", { name: /bash/ }));
		const found = await screen.findAllByText("结果输出内容");
		expect(found).toHaveLength(1);
	});
});
