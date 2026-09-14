import { Events } from "@vcpdeck/shared";
import type { Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import { createRemoteDesktopSocket } from "./remote-desktop-socket.js";

function fakeSocket() {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const emitCalls: Array<{ event: string; args: unknown[] }> = [];
	const socket = {
		connected: true,
		on: (event: string, cb: (...args: unknown[]) => void) => {
			const entries = listeners.get(event) ?? [];
			entries.push(cb);
			listeners.set(event, entries);
			return socket;
		},
		off: (event: string, cb: (...args: unknown[]) => void) => {
			const entries = listeners.get(event) ?? [];
			const index = entries.indexOf(cb);
			if (index >= 0) entries.splice(index, 1);
			return socket;
		},
		emit: (event: string, ...args: unknown[]) => {
			emitCalls.push({ event, args });
			return socket;
		},
	} as unknown as Socket;
	const fire = (event: string, value: unknown) => {
		for (const cb of listeners.get(event) ?? []) cb(value);
	};
	const ack = (event: string, value: unknown) => {
		const call = emitCalls.find((entry) => entry.event === event && typeof entry.args[1] === "function");
		(call?.args[1] as ((value: unknown) => void) | undefined)?.(value);
	};
	return { socket, emitCalls, fire, ack };
}

const attached = {
	sessionId: "s1",
	attachmentId: "a1",
	role: "operator" as const,
	reconnectToken: "token",
	controlProtectedUntil: null,
	iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
};

describe("createRemoteDesktopSocket", () => {
	it("attaches and strictly parses the server response", async () => {
		const fake = fakeSocket();
		const api = createRemoteDesktopSocket(fake.socket);
		const promise = api.attach("s1", "token");
		expect(fake.emitCalls[0]).toMatchObject({
			event: Events.REMOTE_DESKTOP_ATTACH,
			args: [{ sessionId: "s1", reconnectToken: "token" }, expect.any(Function)],
		});
		fake.ack(Events.REMOTE_DESKTOP_ATTACH, { ok: true, data: attached });
		await expect(promise).resolves.toEqual(attached);
	});

	it("rejects server errors and forwards only valid host signals", async () => {
		const fake = fakeSocket();
		const api = createRemoteDesktopSocket(fake.socket);
		const promise = api.attach("s1");
		fake.ack(Events.REMOTE_DESKTOP_ATTACH, {
			ok: false,
			error: { code: "REMOTE_DESKTOP_HOST_OFFLINE", message: "offline" },
		});
		await expect(promise).rejects.toMatchObject({ code: "REMOTE_DESKTOP_HOST_OFFLINE" });
		const onSignal = vi.fn();
		api.onSignal(onSignal);
		fake.fire(Events.REMOTE_DESKTOP_SIGNAL, {
			sessionId: "s1",
			attachmentId: "a1",
			signal: { kind: "answer", sdp: "v=0\r\n" },
		});
		fake.fire(Events.REMOTE_DESKTOP_SIGNAL, {
			sessionId: "s1",
			attachmentId: "a1",
			signal: { kind: "answer", sdp: "v=0\r\n", forged: true },
		});
		expect(onSignal).toHaveBeenCalledTimes(1);
	});

	it("sends signaling through the authenticated app socket", async () => {
		const fake = fakeSocket();
		const api = createRemoteDesktopSocket(fake.socket);
		const promise = api.signal("s1", "a1", { kind: "offer", sdp: "v=0\r\n" });
		expect(fake.emitCalls[0]).toMatchObject({
			event: Events.REMOTE_DESKTOP_SIGNAL,
			args: [{ sessionId: "s1", attachmentId: "a1", signal: { kind: "offer", sdp: "v=0\r\n" } }, expect.any(Function)],
		});
		fake.ack(Events.REMOTE_DESKTOP_SIGNAL, { ok: true, data: undefined });
		await expect(promise).resolves.toBeUndefined();
	});
});
