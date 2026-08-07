import { afterEach, describe, expect, it, vi } from "vitest";
import { openPiEventStream } from "./pi-stream.js";
import type { PiClientEvent } from "@vcpdeck/shared";

class MockEventSource {
	static instances: MockEventSource[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readyState = MockEventSource.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(
		public url: string,
		public options?: unknown,
	) {
		MockEventSource.instances.push(this);
	}
	close() {
		this.closed = true;
		this.readyState = MockEventSource.CLOSED;
	}
}

function last(): MockEventSource {
	return MockEventSource.instances.at(-1)!;
}

afterEach(() => {
	vi.unstubAllGlobals();
	MockEventSource.instances = [];
});

describe("openPiEventStream", () => {
	it("连接就绪后 connected() resolve", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const stream = openPiEventStream("/events", { onEvent: () => {} });

		last().readyState = MockEventSource.OPEN;
		last().onopen?.();

		await expect(stream.connected()).resolves.toBeUndefined();
	});

	it("转发解析后的事件", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const events: PiClientEvent[] = [];
		const stream = openPiEventStream("/events", { onEvent: (e) => events.push(e) });

		last().onmessage?.({ data: JSON.stringify({ type: "agent_end", sessionId: "s1" }) });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "agent_end", sessionId: "s1" });
		void stream;
	});

	it("解析失败只上报诊断信息，不抛异常", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const diagnostics: string[] = [];
		const events: PiClientEvent[] = [];
		const stream = openPiEventStream("/events", {
			onEvent: (e) => events.push(e),
			onDiagnostics: (m) => diagnostics.push(m),
		});

		last().onmessage?.({ data: "not-json" });
		expect(diagnostics).toHaveLength(1);
		expect(events).toHaveLength(0);
		void stream;
	});

	it("close() 手动关闭不触发 onFatal", () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const fatal: Error[] = [];
		const stream = openPiEventStream("/events", {
			onEvent: () => {},
			onFatal: (e) => fatal.push(e),
		});

		stream.close();
		last().onerror?.();
		expect(fatal).toHaveLength(0);
	});

	it("非手动 CLOSED 触发 onFatal", () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const fatal: Error[] = [];
		const stream = openPiEventStream("/events", {
			onEvent: () => {},
			onFatal: (e) => fatal.push(e),
		});

		last().readyState = MockEventSource.CLOSED;
		last().onerror?.();
		expect(fatal).toHaveLength(1);
		void stream;
	});
});
