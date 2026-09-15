import { describe, expect, it, vi } from "vitest";
import { probeHttp, type ProbeChannel } from "./http-probe.js";

function makeProbeChannel() {
	const channel = {
		sent: [] as Uint8Array[],
		onmessage: null as ((e: { data: ArrayBuffer | Uint8Array }) => void) | null,
		onclose: null as (() => void) | null,
		onerror: null as ((e?: unknown) => void) | null,
		send(d: Uint8Array) {
			this.sent.push(d);
		},
		close: vi.fn(),
		emitMessage(d: ArrayBuffer | Uint8Array) {
			this.onmessage?.({ data: d });
		},
		emitClose() {
			this.onclose?.();
		},
		emitError() {
			this.onerror?.();
		},
	};
	return channel as unknown as ProbeChannel & {
		sent: Uint8Array[];
		emitMessage: (d: ArrayBuffer | Uint8Array) => void;
		emitClose: () => void;
		emitError: () => void;
	};
}

describe("probeHttp", () => {
	it("发送固定 HTTP/1.1 GET 并返回受限原始响应", async () => {
		const channel = makeProbeChannel();
		const resultPromise = probeHttp(channel, "/health");
		expect(new TextDecoder().decode(channel.sent[0])).toBe(
			"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
		);
		channel.emitMessage(new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"));
		channel.emitClose();
		await expect(resultPromise).resolves.toMatchObject({ statusLine: "HTTP/1.1 200 OK", body: "OK" });
	});

	it("拒绝非法路径", async () => {
		await expect(probeHttp(makeProbeChannel(), "http://evil.example/")).rejects.toMatchObject({
			code: "TUNNEL_HTTP_PATH_INVALID",
		});
		await expect(probeHttp(makeProbeChannel(), "a\nb")).rejects.toMatchObject({
			code: "TUNNEL_HTTP_PATH_INVALID",
		});
	});

	it("1 MiB 超限", async () => {
		const channel = makeProbeChannel();
		const p = probeHttp(channel, "/");
		channel.emitMessage(new Uint8Array(1024 * 1024 + 1));
		await expect(p).rejects.toMatchObject({ code: "TUNNEL_HTTP_RESPONSE_TOO_LARGE" });
	});

	it("超时", async () => {
		const channel = makeProbeChannel();
		const p = probeHttp(channel, "/", { timeoutMs: 1 });
		await expect(p).rejects.toMatchObject({ code: "TUNNEL_HTTP_TIMEOUT" });
	});

	it("channel error 映射 TUNNEL_HTTP_ERROR", async () => {
		const channel = makeProbeChannel();
		const p = probeHttp(channel, "/");
		channel.emitError();
		await expect(p).rejects.toMatchObject({ code: "TUNNEL_HTTP_ERROR" });
	});
});
