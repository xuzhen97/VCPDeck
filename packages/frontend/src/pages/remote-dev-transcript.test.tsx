import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteDevSessionInfo } from "@vcpdeck/shared";
import { RemoteDevTranscript } from "./remote-dev-transcript.js";
import type { RemoteDevSocket } from "../remote-dev/remote-dev-socket.js";

function makeSession(
	overrides: Partial<RemoteDevSessionInfo> = {},
): RemoteDevSessionInfo {
	return {
		sessionId: "rds_1",
		clientId: "c1",
		agentPlacementId: "p1",
		state: "active",
		agentStatus: "idle",
		workspaceRoot: "D:/work",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		...overrides,
	} as RemoteDevSessionInfo;
}

function makeSocket() {
	const agentHandlers = new Set<(event: never) => void>();
	const transcriptHandlers = new Set<(payload: never) => void>();
	const socket = {
		onAgentEvent: (cb: (event: never) => void) => {
			agentHandlers.add(cb);
			return () => agentHandlers.delete(cb);
		},
		onTranscript: (cb: (payload: never) => void) => {
			transcriptHandlers.add(cb);
			return () => transcriptHandlers.delete(cb);
		},
	} as unknown as RemoteDevSocket;
	return {
		socket,
		emit: (event: unknown) => {
			for (const handler of agentHandlers) handler(event as never);
		},
		replay: (payload: unknown) => {
			for (const handler of transcriptHandlers) handler(payload as never);
		},
		agentHandlerCount: () => agentHandlers.size,
	};
}

describe("RemoteDevTranscript（只读运行记录）", () => {
	it("只显示记录，不提供输入框或发送按钮", () => {
		const { socket } = makeSocket();
		render(<RemoteDevTranscript session={makeSession()} socket={socket} />);

		expect(screen.getByText("运行记录")).toBeVisible();
		expect(screen.getByText("只读")).toBeVisible();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button", { name: /发送/ })).toBeNull();
	});

	it("回放 transcript 并合并流式增量", () => {
		const { socket, emit, replay } = makeSocket();
		render(<RemoteDevTranscript session={makeSession()} socket={socket} />);

		act(() =>
			replay({
				sessionId: "rds_1",
				entries: [
					{ seq: 1, kind: "prompt", text: "跑一下测试" },
					{
						seq: 2,
						kind: "event",
						event: {
							type: "tool.started",
							toolCallId: "t1",
							title: "pnpm test",
						},
					},
				],
			}),
		);

		expect(screen.getByText("跑一下测试")).toBeVisible();
		expect(screen.getByText("pnpm test")).toBeVisible();

		act(() =>
			emit({
				type: "agent.event",
				event: { type: "agent.message.delta", messageId: "m1", text: "好的，" },
			}),
		);
		act(() =>
			emit({
				type: "agent.event",
				event: { type: "agent.message.delta", messageId: "m1", text: "开始。" },
			}),
		);

		expect(screen.getByText("好的，开始。")).toBeVisible();
	});

	it("重复回放同一会话不会让记录翻倍", () => {
		const { socket, replay } = makeSocket();
		render(<RemoteDevTranscript session={makeSession()} socket={socket} />);

		const payload = {
			sessionId: "rds_1",
			entries: [{ seq: 1, kind: "prompt", text: "只出现一次" }],
		};
		act(() => replay(payload));
		act(() => replay(payload));

		expect(screen.getAllByText("只出现一次")).toHaveLength(1);
	});

	it("订阅在卸载时释放", () => {
		const { socket, agentHandlerCount } = makeSocket();
		const { unmount } = render(
			<RemoteDevTranscript session={makeSession()} socket={socket} />,
		);
		expect(agentHandlerCount()).toBe(1);
		unmount();
		expect(agentHandlerCount()).toBe(0);
	});
});
