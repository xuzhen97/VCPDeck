import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
	RemoteDevClientEvent,
	RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import { RemoteDevAgentPanel } from "./remote-dev-agent-panel.js";
import type { RemoteDevSocket } from "../remote-dev/remote-dev-socket.js";

const SESSION: RemoteDevSessionInfo = {
	sessionId: "rds_1",
	clientId: "c1",
	agentPlacementId: "p1",
	workspaceRoot: "/repo",
	state: "active",
	agentStatus: "ready",
	generationId: "gen-1",
	createdAt: "2026-10-18T00:00:00.000Z",
	updatedAt: "2026-10-18T00:00:00.000Z",
	cleanupStatus: "unknown",
};

function makeSocket() {
	let emitEvent: ((event: RemoteDevClientEvent) => void) | null = null;
	const socket = {
		onAgentEvent: vi.fn((cb: (event: RemoteDevClientEvent) => void) => {
			emitEvent = cb;
			return () => {
				emitEvent = null;
			};
		}),
		permission: vi.fn().mockResolvedValue(undefined),
		prompt: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn().mockResolvedValue(undefined),
	} as unknown as RemoteDevSocket;
	return {
		socket,
		emit(event: RemoteDevClientEvent) {
			act(() => emitEvent?.(event));
		},
	};
}

function agentEvent(
	event: Extract<RemoteDevClientEvent, { type: "agent.event" }>["event"],
): RemoteDevClientEvent {
	return {
		type: "agent.event",
		sessionId: "rds_1",
		generationId: "gen-1",
		seq: 1,
		event,
	};
}

describe("RemoteDevAgentPanel", () => {
	it("展示消息、工具事件与 permission 选项并提交选择", async () => {
		const { socket, emit } = makeSocket();
		render(
			<RemoteDevAgentPanel session={SESSION} socket={socket} mode="operator" />,
		);
		emit(agentEvent({ type: "agent.message.delta", messageId: "m1", text: "hello" }));
		emit(agentEvent({ type: "tool.started", toolCallId: "t1", title: "pnpm test" }));
		emit(
			agentEvent({
				type: "permission.requested",
				requestId: "perm-1",
				toolCallId: "t1",
				title: "Run tests",
				options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
			}),
		);

		expect(screen.getByText("hello")).toBeVisible();
		expect(screen.getByText("[tool] pnpm test")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
		expect(socket.permission).toHaveBeenCalledWith("rds_1", "perm-1", "allow");
	});

	it("viewer 不能发送 prompt 或回答 permission", () => {
		const { socket, emit } = makeSocket();
		render(
			<RemoteDevAgentPanel session={SESSION} socket={socket} mode="viewer" />,
		);
		emit(
			agentEvent({
				type: "permission.requested",
				requestId: "perm-1",
				toolCallId: "t1",
				options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
			}),
		);

		expect(screen.getByPlaceholderText("给 agent 发消息…")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
	});
});
