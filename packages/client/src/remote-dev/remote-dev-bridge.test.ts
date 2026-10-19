import { describe, expect, it, vi } from "vitest";
import { Events } from "@vcpdeck/shared";
import type { Socket } from "socket.io-client";
import { attachRemoteDevBridge } from "./remote-dev-bridge.js";

function fakeSocket() {
	const handlers = new Map<string, (value: unknown) => void>();
	const socket = {
		on: vi.fn((event: string, handler: (value: unknown) => void) => {
			handlers.set(event, handler);
		}),
		emit: vi.fn(),
	} as unknown as Socket;
	return {
		socket,
		trigger(event: string, value: unknown) {
			handlers.get(event)?.(value);
		},
	};
}

const createCommand = {
	action: "session.create",
	requestId: "req-1",
	sessionId: "r1",
	agentPlacementId: "p1",
	workspaceRoot: "/repo",
	workspaceRoots: ["/repo"],
	command: "node",
	args: ["agent.mjs"],
	cwd: "/repo",
};

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RemoteDevBridge", () => {
	it("session.create 调 runtime 并回报 generation", async () => {
		const { socket, trigger } = fakeSocket();
		const runtime = {
			create: vi
				.fn()
				.mockResolvedValue({
					sessionId: "r1",
					generationId: "g1",
					acpSessionId: "acp-1",
				}),
			prompt: vi.fn(),
			cancel: vi.fn(),
			permission: vi.fn(),
			close: vi.fn(),
			listSessions: vi.fn(() => []),
		};
		attachRemoteDevBridge(socket, { runtime });
		trigger(Events.RDS_COMMAND, createCommand);
		await tick();
		expect(runtime.create).toHaveBeenCalledWith(
			expect.objectContaining({ action: "session.create" }),
		);
		expect(socket.emit).toHaveBeenCalledWith(
			Events.RDS_COMMAND_RESULT,
			expect.objectContaining({ ok: true, generationId: "g1" }),
		);
		expect(socket.emit).toHaveBeenCalledWith(Events.RDS_ACP_SESSION, {
			sessionId: "r1",
			generationId: "g1",
			acpSessionId: "acp-1",
		});
	});

	it("非法命令返回稳定错误，不抛到 socket", async () => {
		const { socket, trigger } = fakeSocket();
		const runtime = {
			create: vi.fn(),
			prompt: vi.fn(),
			cancel: vi.fn(),
			permission: vi.fn(),
			close: vi.fn(),
			listSessions: vi.fn(() => []),
		};
		attachRemoteDevBridge(socket, { runtime });
		trigger(Events.RDS_COMMAND, {
			action: "session.create",
			requestId: "req-1",
			sessionId: "r1",
			extra: true,
		});
		await tick();
		expect(socket.emit).toHaveBeenCalledWith(
			Events.RDS_COMMAND_RESULT,
			expect.objectContaining({
				ok: false,
				error: expect.objectContaining({ code: "RDS_PROTOCOL_INVALID" }),
			}),
		);
	});

	it("tunnelFactory 失败时关闭已启动的 ACP 会话并回报错误", async () => {
		const { socket, trigger } = fakeSocket();
		const runtime = {
			create: vi.fn().mockResolvedValue({ sessionId: "r1", generationId: "g1" }),
			prompt: vi.fn(),
			cancel: vi.fn(),
			permission: vi.fn(),
			close: vi.fn().mockResolvedValue(undefined),
			listSessions: vi.fn(() => []),
		};
		attachRemoteDevBridge(socket, {
			runtime,
			tunnelFactory: () => {
				throw new Error("tunnel failed");
			},
		});
		trigger(Events.RDS_COMMAND, createCommand);
		await tick();
		expect(runtime.close).toHaveBeenCalledWith("r1", "tunnel_error");
		expect(socket.emit).toHaveBeenCalledWith(
			Events.RDS_COMMAND_RESULT,
			expect.objectContaining({ ok: false }),
		);
	});
});
