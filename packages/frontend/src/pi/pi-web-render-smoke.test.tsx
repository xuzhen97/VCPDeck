import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/pi-web/hooks/useI18n";
import { MessageView } from "@/pi-web/components/MessageView";
import type { AgentMessage } from "@/pi-web/lib/types";

describe("pi-web 渲染冒烟（React 18 + vite 管线）", () => {
	it("渲染 user/assistant/thinking/toolCall/toolResult 消息不抛错", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "你好" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "先想一下" },
					{ type: "text", text: "回答正文" },
					{
						type: "toolCall",
						toolCallId: "t1",
						toolName: "bash",
						input: { command: "echo hi" },
					},
				],
				model: "m1",
				provider: "p1",
			},
			{
				role: "toolResult",
				toolCallId: "t1",
				content: [{ type: "text", text: "hi" }],
			},
		];
		render(
			<I18nProvider>
				<div>
					{messages.map((m, i) => (
						<MessageView key={i} message={m} />
					))}
				</div>
			</I18nProvider>,
		);
		expect(screen.getByText("你好")).toBeDefined();
		expect(screen.getByText("回答正文")).toBeDefined();
	});
});
