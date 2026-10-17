import { describe, expect, it, vi } from "vitest";
import { AppGateway } from "./app.gateway.js";
import type { Socket } from "socket.io";
import type { ActorContext } from "@vcpdeck/shared";

const ACTOR: ActorContext = { identityId: "id1", displayName: "admin", isAdmin: true, credentialId: null, sessionId: null, source: "web", requestId: "socket-1" };

function makeSocket(id = "socket-1") {
	const socket = {
		id,
		data: {},
		handshake: { headers: {} },
		emit: vi.fn(),
		disconnect: vi.fn(),
		join: vi.fn(),
	} as unknown as Socket;
	(socket as unknown as { actor?: ActorContext }).actor = ACTOR;
	return socket;
}

function makeGateway() {
	const prisma = {
		authSession: { findUnique: vi.fn() },
		credential: { findUnique: vi.fn() },
		identity: { findUnique: vi.fn() },
	};
	const terminalService = {
		attachBrowser: vi.fn(),
		detachBrowser: vi.fn(),
		detachBrowserSocket: vi.fn(),
		browserInput: vi.fn(),
		browserResize: vi.fn(),
		browserTakeover: vi.fn(),
		browserAckOutput: vi.fn(),
		browserResync: vi.fn(),
		bindBrowserEmitter: vi.fn(),
	};
	const gateway = new AppGateway(prisma as never, terminalService as never);
	const emit = vi.fn();
	const to = vi.fn(() => ({ emit }));
	gateway.server = { emit: vi.fn(), to } as never;
	return { gateway, prisma, terminalService, to, emit };
}

describe("AppGateway terminal handlers", () => {
	it("afterInit 绑定浏览器 emitter 精确投递 socketId", () => {
		const { gateway, terminalService, to, emit } = makeGateway();
		gateway.afterInit();
		const binder = terminalService.bindBrowserEmitter.mock.calls[0]?.[0];
		expect(typeof binder).toBe("function");
		binder("browser-9", "terminal:output", { seq: 1 });
		expect(to).toHaveBeenCalledWith("browser-9");
		expect(emit).toHaveBeenCalledWith("terminal:output", { seq: 1 });
	});

	it("attach 透传 actor/socketId 并返回结果", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		terminalService.attachBrowser.mockResolvedValue({
			attachmentId: "ta1",
			reconnectToken: "tok1",
			mode: "operator",
			controlProtectedUntil: null,
		});
		const result = await gateway.handleTerminalAttach(socket, { sessionId: "s1", reconnectToken: "tok" });
		expect(terminalService.attachBrowser).toHaveBeenCalledWith({
			sessionId: "s1",
			actor: ACTOR,
			socketId: "socket-1",
			reconnectToken: "tok",
		});
		expect(result).toEqual({
			ok: true,
			data: { sessionId: "s1", attachmentId: "ta1", reconnectToken: "tok1", mode: "operator", controlProtectedUntil: null },
		});
	});

	it("attach 非法 payload 返回错误", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		const result = await gateway.handleTerminalAttach(socket, { reconnectToken: 42 });
		expect(terminalService.attachBrowser).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "TERMINAL_PROTOCOL_INVALID" }) });
	});

	it("service 错误转为安全返回", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		terminalService.attachBrowser.mockRejectedValue(
			Object.assign(new Error("x"), { code: "TERMINAL_SESSION_ENDED" }),
		);
		const result = await gateway.handleTerminalAttach(socket, { sessionId: "s1" });
		expect(result).toEqual({ ok: false, error: { code: "TERMINAL_SESSION_ENDED", message: "x" } });
	});

	it("viewer 伪造 input 被 service 拒绝（无权限）", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		terminalService.browserInput.mockRejectedValue(
			Object.assign(new Error("readonly"), { code: "TERMINAL_READ_ONLY" }),
		);
		const result = await gateway.handleTerminalInput(socket, { sessionId: "s1", attachmentId: "ta2", data: "rm -rf /" });
		expect(result).toEqual({ ok: false, error: { code: "TERMINAL_READ_ONLY", message: "readonly" } });
	});

	it("input/resize/takeover/ack/resync 都透传并返回", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		terminalService.browserResize.mockResolvedValue(undefined);
		terminalService.browserTakeover.mockResolvedValue({ mode: "operator" });
		expect(await gateway.handleTerminalResize(socket, { sessionId: "s1", attachmentId: "ta1", cols: 100, rows: 40 })).toEqual({ ok: true, data: undefined });
		expect(await gateway.handleTerminalTakeover(socket, { sessionId: "s1", attachmentId: "ta1" })).toEqual({ ok: true, data: { mode: "operator" } });
		expect(await gateway.handleTerminalAckOutput(socket, { sessionId: "s1", attachmentId: "ta1", seq: 9 })).toEqual({ ok: true, data: undefined });
		expect(await gateway.handleTerminalResync(socket, { sessionId: "s1", attachmentId: "ta1" })).toEqual({ ok: true, data: undefined });
	});

	it("detach 按 socketId 清理该 socket 全部 attachment", async () => {
		const { gateway, terminalService } = makeGateway();
		const socket = makeSocket();
		await gateway.handleDisconnect(socket);
		expect(terminalService.detachBrowserSocket).toHaveBeenCalledWith("socket-1");
	});
});
