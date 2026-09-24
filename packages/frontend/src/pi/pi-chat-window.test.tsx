import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PiSessionState } from "./use-pi-session.js";
import { PiChatWindow } from "./pi-chat-window.js";
import { setPiThinkingLoader } from "./pi-thinking-loader.js";

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
	it("实时思考块渲染在本轮提问气泡之后，而不是时间线顶部", () => {
		render(<PiChatWindow state={state()} info={null} onLoadMore={() => {}} />);

		const thinking = screen.getByTestId("live-thinking-block");
		const prompt = screen.getByText("question");
		// 文档顺序必须是「提问 → 思考」；README 之前它在时间线最上方（截图 bug）。
		expect(
			prompt.compareDocumentPosition(thinking) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("流式期间思考正文默认展开、实时可见（不用先点展开）", () => {
		// 未收到 thinking_end（thinkingDurationMs === null）= 正在思考
		render(
			<PiChatWindow
				state={state({ thinkingDurationMs: null })}
				info={null}
				onLoadMore={() => {}}
			/>,
		);

		expect(screen.getByTestId("live-thinking-text").textContent).toContain(
			"先检查项目结构，再读取 README。",
		);
		expect(screen.getByText("思考中…")).toBeTruthy();
	});

	it("思考结束后默认折叠为摘要，仍可手动展开", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<PiChatWindow
				state={state({ thinkingDurationMs: null })}
				info={null}
				onLoadMore={() => {}}
			/>,
		);

		// 结束事件带 durationMs：默认收起（保留摘要，不消失）
		rerender(
			<PiChatWindow
				state={state({ thinkingDurationMs: 1234 })}
				info={null}
				onLoadMore={() => {}}
			/>,
		);
		expect(screen.queryByTestId("live-thinking-text")).toBeNull();
		expect(screen.getByText("已思考 1.2 秒")).toBeTruthy();

		await user.click(screen.getByRole("button", { name: /展开思考/ }));
		expect(screen.getByTestId("live-thinking-text")).toBeTruthy();
	});

	describe("历史 thinking 经注入 loader 惰性加载", () => {
		afterEach(() => setPiThinkingLoader(null));

		it("展开历史思考块时显示正文", async () => {
			const user = userEvent.setup();
			const loader = vi.fn(async () => "历史会话里的推理正文");
			setPiThinkingLoader(loader);
			render(
				<PiChatWindow
					state={state({
						thinkingText: "",
						thinkingDurationMs: null,
						messages: [
							{ id: "u1", role: "user", content: [{ type: "text", text: "提问" }] },
							{
								id: "a1",
								role: "assistant",
								content: [
									{ type: "thinking", deferred: true, durationMs: 2000 },
									{ type: "text", text: "渲染管线接管这行文本" },
								],
							},
						],
					})}
					info={null}
					sessionId="s1"
					onLoadMore={() => {}}
				/>,
			);

			// 上游思考块的展开按钮 aria-label = i18n.thinking（测试环境按浏览器语言解析，故两种都接受）
			const toggle = await screen.findByRole("button", {
				name: /^(思考|Thinking)/,
			});
			if (toggle.getAttribute("aria-expanded") !== "true") {
				await user.click(toggle);
			}

			expect(await screen.findByText("历史会话里的推理正文")).toBeTruthy();
			expect(loader).toHaveBeenCalledWith("s1", "a1", expect.any(Number));
		});

		it("未注入 loader 时不伪造正文", async () => {
			const user = userEvent.setup();
			render(
				<PiChatWindow
					state={state({
						thinkingText: "",
						thinkingDurationMs: null,
						messages: [
							{
								id: "a2",
								role: "assistant",
								content: [
									{ type: "thinking", deferred: true },
									{ type: "text", text: "答案" },
								],
							},
						],
					})}
					info={null}
					sessionId="s1"
					onLoadMore={() => {}}
				/>,
			);

			const toggle = await screen.findByRole("button", {
				name: /^(思考|Thinking)/,
			});
			if (toggle.getAttribute("aria-expanded") !== "true") {
				await user.click(toggle);
			}

			// 没有真正文就不得编造内容：正文不出现，页面仍可正常使用
			expect(screen.queryByText("历史会话里的推理正文")).toBeNull();
			expect(screen.getByText("答案")).toBeTruthy();
		});
	});

	it("尚无回合时（新会话首轮）思考块仍然可见", () => {
		render(
			<PiChatWindow
				state={state({ messages: [] })}
				info={null}
				onLoadMore={() => {}}
			/>,
		);

		expect(screen.getByTestId("live-thinking-block")).toBeTruthy();
	});

	it("无思考文本（已结算）时不渲染思考块", () => {
		render(
			<PiChatWindow
				state={state({ thinkingText: "", thinkingDurationMs: null })}
				info={null}
				onLoadMore={() => {}}
			/>,
		);

		expect(screen.queryByTestId("live-thinking-block")).toBeNull();
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
