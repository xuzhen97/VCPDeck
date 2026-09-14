import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopRequestBroker } from "./remote-desktop-request-broker.js";
import type { RemoteDesktopClientRequest, RemoteDesktopClientResponse } from "@vcpdeck/shared";

function request(overrides: Partial<RemoteDesktopClientRequest> = {}): RemoteDesktopClientRequest {
	return {
		requestId: "request-1",
		protocolVersion: 1,
		action: "session.prepare",
		sessionId: "session-1",
		...overrides,
	};
}

describe("RemoteDesktopRequestBroker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends to the exact Client socket and resolves matching response", async () => {
		const broker = new RemoteDesktopRequestBroker();
		const emitted: unknown[] = [];
		broker.bindEmitter((socketId, payload) => emitted.push({ socketId, payload }));
		const pending = broker.request({ clientId: "client-1", socketId: "socket-1" }, request());
		expect(emitted).toEqual([{ socketId: "socket-1", payload: request() }]);
		const response: RemoteDesktopClientResponse = {
			requestId: "request-1",
			protocolVersion: 1,
			hostGeneration: "generation-1",
			ok: true,
			result: { ready: true },
		};
		broker.resolve("socket-1", response);
		await expect(pending).resolves.toEqual(response);
	});

	it("rejects on timeout, wrong socket response and disconnect", async () => {
		vi.useFakeTimers();
		const broker = new RemoteDesktopRequestBroker();
		broker.bindEmitter(() => undefined);
		const pending = broker.request({ clientId: "client-1", socketId: "socket-1" }, request(), 100);
		broker.resolve("socket-2", {
			requestId: "request-1",
			protocolVersion: 1,
			hostGeneration: "generation-1",
			ok: true,
		} satisfies RemoteDesktopClientResponse);
		const timeoutRejection = expect(pending).rejects.toMatchObject({
			code: "REMOTE_DESKTOP_HOST_OFFLINE",
		});
		await vi.advanceTimersByTimeAsync(101);
		await timeoutRejection;

		const disconnected = broker.request(
			{ clientId: "client-1", socketId: "socket-3" },
			request({ requestId: "request-3" }),
		);
		broker.disconnect("socket-3");
		await expect(disconnected).rejects.toMatchObject({ code: "REMOTE_DESKTOP_HOST_OFFLINE" });
	});

	it("fails closed when no emitter is bound", async () => {
		const broker = new RemoteDesktopRequestBroker();
		await expect(
			broker.request({ clientId: "client-1", socketId: "socket-1" }, request()),
		).rejects.toMatchObject({ code: "REMOTE_DESKTOP_HOST_OFFLINE" });
	});
});
