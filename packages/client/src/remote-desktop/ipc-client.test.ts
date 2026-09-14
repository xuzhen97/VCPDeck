import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopLimits, type RemoteDesktopClientResponse } from "@vcpdeck/shared";
import {
	createDesktopHostIpcTransport,
	DesktopHostFrameDecoder,
	DesktopHostIpcClient,
	encodeDesktopHostFrame,
	type DesktopHostIpcSocket,
	type DesktopHostIpcTransport,
} from "./ipc-client.js";

function transport() {
	let listener: ((chunk: Uint8Array) => void) | undefined;
	const writes: Uint8Array[] = [];
	const value: DesktopHostIpcTransport = {
		write: (frame) => writes.push(frame),
		onData: (next) => {
			listener = next;
			return () => { listener = undefined; };
		},
	};
	return { value, writes, push: (chunk: Uint8Array) => listener?.(chunk) };
}

const request = {
	requestId: "r1",
	protocolVersion: 1 as const,
	action: "session.state" as const,
	sessionId: "s1",
};

function response(): RemoteDesktopClientResponse {
	return { requestId: "r1", protocolVersion: 1, hostGeneration: "host-1", ok: true, result: {} };
}

afterEach(() => vi.useRealTimers());

function socketStub() {
	type EventName = "data" | "error" | "close";
	type Listener = (...args: unknown[]) => void;
	const listeners = new Map<EventName, Set<Listener>>();
	const socket: DesktopHostIpcSocket = {
		on: (event: EventName, listener: Listener) => {
			const current = listeners.get(event) ?? new Set<Listener>();
			current.add(listener);
			listeners.set(event, current);
			return socket;
		},
		off: (event: EventName, listener: Listener) => {
			listeners.get(event)?.delete(listener);
			return socket;
		},
		write: vi.fn(() => true),
		destroy: vi.fn(),
	};
	return { socket, listeners };
}

describe("DesktopHostIpcTransport", () => {
	it("uses the configured local endpoint and forwards bounded socket data", () => {
		const fake = socketStub();
		const transport = createDesktopHostIpcTransport({
			endpoint: "\\\\.\\pipe\\vcpdeck-test",
			connect: vi.fn(() => fake.socket),
		});
		const onData = vi.fn();
		transport.onData(onData);
		transport.write(new Uint8Array([1, 2, 3]));
		for (const listener of fake.listeners.get("data") ?? []) listener(new Uint8Array([4]));
		transport.close?.();

		expect(fake.socket.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
		expect(onData).toHaveBeenCalledWith(new Uint8Array([4]));
		expect(fake.socket.destroy).toHaveBeenCalledTimes(1);
	});
});

describe("DesktopHostFrameDecoder", () => {
	it("handles fragmented length-prefixed frames", () => {
		const frame = encodeDesktopHostFrame({ protocolVersion: 1, generationId: "g1", kind: "response", payload: response() });
		const decoder = new DesktopHostFrameDecoder();
		expect(decoder.push(frame.slice(0, 3))).toEqual([]);
		expect(decoder.push(frame.slice(3))).toHaveLength(1);
	});

	it("rejects oversized frames before allocating the body", () => {
		const header = new Uint8Array(4);
		new DataView(header.buffer).setUint32(0, RemoteDesktopLimits.maxIpcFrameBytes + 1);
		expect(() => new DesktopHostFrameDecoder().push(header)).toThrow("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
	});
});

describe("DesktopHostIpcClient", () => {
	it("rejects a host response from another generation", async () => {
		const t = transport();
		const client = new DesktopHostIpcClient({ transport: t.value, generationId: "g1", timeoutMs: 1000 });
		const pending = client.request(request);
		const rejected = expect(pending).rejects.toMatchObject({ code: "REMOTE_DESKTOP_HOST_OFFLINE" });
		t.push(encodeDesktopHostFrame({ protocolVersion: 1, generationId: "old", kind: "response", payload: response() }));
		await rejected;
		client.close();
	});

	it("rejects pending requests on timeout and closes them", async () => {
		vi.useFakeTimers();
		const t = transport();
		const client = new DesktopHostIpcClient({ transport: t.value, generationId: "g1", timeoutMs: 10 });
		const pending = client.request(request);
		const rejected = expect(pending).rejects.toMatchObject({ code: "REMOTE_DESKTOP_HOST_OFFLINE" });
		await vi.advanceTimersByTimeAsync(11);
		await rejected;
		client.close();
	});
});
