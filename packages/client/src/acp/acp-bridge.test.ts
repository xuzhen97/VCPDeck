import { describe, expect, it, vi } from "vitest";
import type { AcpHostOptions } from "./acp-host.js";
import { attachAcpTaskBridge } from "./acp-bridge.js";

function fakeSocket() {
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	const sent: Array<{ event: string; payload: unknown }> = [];
	return {
		connected: true,
		on(event: string, handler: (payload: unknown) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		emit(event: string, payload: unknown) {
			sent.push({ event, payload });
		},
		receive(event: string, payload: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
		sent,
	};
}

function fakeHost() {
	let options: AcpHostOptions | null = null;
	const host = {
		start: vi.fn(async () => ({ sessionId: "s1" })),
		prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
		cancel: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
	return {
		host,
		createHost: (next: AcpHostOptions) => {
			options = next;
			return host;
		},
		getOptions: () => options,
	};
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("attachAcpTaskBridge", () => {
	it("start 启动 Host、回传 sessionId，并转发事件 seq", async () => {
		const socket = fakeSocket();
		const fake = fakeHost();
		attachAcpTaskBridge(socket as never, {
			clientId: "c1",
			createHost: fake.createHost,
			now: () => 1,
		});
		socket.receive("task:command", {
			requestId: "r1",
			action: "start",
			taskId: "t1",
			attemptId: "a1",
			command: "dsh",
			args: ["--profile", "acp"],
			cwd: "/repo",
			prompt: "hello",
		});
		await tick();
		expect(fake.host.start).toHaveBeenCalled();
		expect(fake.host.prompt).toHaveBeenCalledWith("hello");
		expect(socket.sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "task:command-result",
					payload: expect.objectContaining({
						requestId: "r1",
						ok: true,
						sessionId: "s1",
					}),
				}),
			]),
		);
		fake.getOptions()?.onEvent({ type: "agent.thought.delta", text: "x" });
		await tick();
		expect(socket.sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "task:event",
					payload: expect.objectContaining({ taskId: "t1", seq: 1 }),
				}),
			]),
		);
	});

	it("permission 命令解析挂起的 permission 请求", async () => {
		const socket = fakeSocket();
		const fake = fakeHost();
		attachAcpTaskBridge(socket as never, {
			clientId: "c1",
			createHost: fake.createHost,
		});
		socket.receive("task:command", {
			requestId: "r1",
			action: "start",
			taskId: "t1",
			attemptId: "a1",
			command: "dsh",
			args: [],
			cwd: "/repo",
		});
		await tick();
		const options = fake.getOptions();
		const outcome = options?.onPermission?.({
			requestId: "p1",
			sessionId: "s1",
			toolCallId: "call-1",
			options: [
				{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
			],
		});
		await tick();
		expect(socket.sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "task:event",
					payload: expect.objectContaining({
						event: expect.objectContaining({ type: "permission.requested" }),
					}),
				}),
			]),
		);
		socket.receive("task:command", {
			requestId: "r2",
			action: "permission",
			taskId: "t1",
			attemptId: "a1",
			permissionRequestId: "p1",
			outcome: { outcome: "selected", optionId: "allow-once" },
		});
		await expect(outcome).resolves.toEqual({
			outcome: "selected",
			optionId: "allow-once",
		});
	});
});
