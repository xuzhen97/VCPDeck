import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRequestBroker } from "./terminal-request-broker.js";
import type { TerminalClientRequest, TerminalClientResponse } from "@vcpdeck/shared";

function makeRequest(overrides: Partial<TerminalClientRequest> = {}): TerminalClientRequest {
	return { requestId: "req-1", action: "shells.list", ...overrides } as TerminalClientRequest;
}

describe("TerminalRequestBroker", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("request 精确投递 lease socket 并关联响应", async () => {
		const broker = new TerminalRequestBroker();
		const emitted: Array<{ socketId: string; request: TerminalClientRequest }> = [];
		broker.bindEmitter((socketId, request) => emitted.push({ socketId, request }));

		const promise = broker.request({ clientId: "c1", socketId: "socket-2" }, makeRequest());
		expect(emitted).toEqual([{ socketId: "socket-2", request: makeRequest() }]);

		broker.resolve("socket-1", { requestId: "req-1", ok: true, action: "shells.list", shells: [] });
		broker.resolve("socket-2", {
			requestId: "req-1",
			ok: true,
			action: "shells.list",
			shells: [{ id: "bash", label: "bash", kind: "bash", isDefault: true }],
		});
		await expect(promise).resolves.toMatchObject({
			ok: true,
			shells: [{ id: "bash" }],
		});
	});

	it("响应乱序也能正确关联", async () => {
		const broker = new TerminalRequestBroker();
		broker.bindEmitter(() => {});
		const lease = { clientId: "c1", socketId: "socket-1" };

		const p1 = broker.request(lease, makeRequest({ requestId: "r1" }));
		const p2 = broker.request(lease, makeRequest({ requestId: "r2" }));

		broker.resolve("socket-1", { requestId: "r2", ok: true, action: "session.detach", sessionId: "s2" });
		broker.resolve("socket-1", { requestId: "r1", ok: true, action: "session.detach", sessionId: "s1" });

		expect(await p1).toMatchObject({ sessionId: "s1" });
		expect(await p2).toMatchObject({ sessionId: "s2" });
	});

	it("超时返回 TERMINAL_REQUEST_TIMEOUT", async () => {
		vi.useFakeTimers();
		const broker = new TerminalRequestBroker();
		broker.bindEmitter(() => {});

		const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest(), 100);
		promise.catch(() => {});
		await vi.advanceTimersByTimeAsync(150);
		await expect(promise).rejects.toMatchObject({ code: "TERMINAL_REQUEST_TIMEOUT" });
	});

	it("断线只失败该 socket 的 pending 请求", async () => {
		const broker = new TerminalRequestBroker();
		broker.bindEmitter(() => {});
		const oldPromise = broker.request(
			{ clientId: "c1", socketId: "socket-1" },
			makeRequest({ requestId: "old" }),
		);
		const newPromise = broker.request(
			{ clientId: "c1", socketId: "socket-2" },
			makeRequest({ requestId: "new" }),
		);

		broker.disconnect("socket-1");
		await expect(oldPromise).rejects.toMatchObject({ code: "TERMINAL_CLIENT_OFFLINE" });
		broker.resolve("socket-2", { requestId: "new", ok: true, action: "session.detach", sessionId: "s1" });
		await expect(newPromise).resolves.toMatchObject({ sessionId: "s1" });
	});

	it("其他 socket 的伪造响应被拒绝（超时兜底）", async () => {
		vi.useFakeTimers();
		const broker = new TerminalRequestBroker();
		broker.bindEmitter(() => {});
		const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest(), 100);
		promise.catch(() => {});

		broker.resolve("socket-2", { requestId: "req-1", ok: true, action: "session.detach", sessionId: "s1" });
		await vi.advanceTimersByTimeAsync(150);
		await expect(promise).rejects.toMatchObject({ code: "TERMINAL_REQUEST_TIMEOUT" });
	});

	it("重复响应忽略（首响应胜出）", async () => {
		const broker = new TerminalRequestBroker();
		broker.bindEmitter(() => {});
		const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest());

		broker.resolve("socket-1", { requestId: "req-1", ok: true, action: "session.detach", sessionId: "s1" });
		broker.resolve("socket-1", { requestId: "req-1", ok: false, error: { code: "TERMINAL_SESSION_NOT_FOUND", message: "x" } });

		const result = (await promise) as TerminalClientResponse;
		expect(result).toMatchObject({ ok: true, sessionId: "s1" });
	});

	it("未绑定 emitter 时请求失败为 TERMINAL_CLIENT_OFFLINE", async () => {
		const broker = new TerminalRequestBroker();
		const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest());
		await expect(promise).rejects.toMatchObject({ code: "TERMINAL_CLIENT_OFFLINE" });
	});

	it("响应包含非法错误码时直接 resolve 原始数据（校验由上层负责）", async () => {
		const broker = new TerminalRequestBroker();
		broker.bindEmitter(() => {});
		const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest());
		broker.resolve("socket-1", {
			requestId: "req-1",
			ok: false,
			error: { code: "WHATEVER", message: "x" },
		} as unknown as TerminalClientResponse);
		const result = (await promise) as TerminalClientResponse;
		expect(result).toMatchObject({ ok: false });
	});
});
