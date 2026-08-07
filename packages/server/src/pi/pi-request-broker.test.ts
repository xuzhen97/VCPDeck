import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRequestBroker } from "./pi-request-broker.js";
import type { PiRequest, PiResponse } from "@vcpdeck/shared";

function makeRequest(overrides: Partial<PiRequest> = {}): PiRequest {
	return {
		requestId: "req-1",
		action: "sessions.list",
		cwdRef: { rootDir: "C:\\", relativePath: "x" },
		...overrides,
	} as PiRequest;
}

describe("PiRequestBroker", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("request 通过 emitter 发送并关联响应", async () => {
		const broker = new PiRequestBroker();
		const emitted: Array<{ clientId: string; request: PiRequest }> = [];
		broker.bindEmitter((clientId, request) => emitted.push({ clientId, request }));

		const promise = broker.request("c1", makeRequest());
		expect(emitted).toHaveLength(1);

		broker.resolve("c1", { requestId: "req-1", ok: true, data: { sessions: [] } });
		const result = await promise;
		expect(result).toMatchObject({ ok: true, data: { sessions: [] } });
	});

	it("响应乱序也能正确关联", async () => {
		const broker = new PiRequestBroker();
		broker.bindEmitter(() => {});

		const p1 = broker.request("c1", makeRequest({ requestId: "r1" }));
		const p2 = broker.request("c1", makeRequest({ requestId: "r2" }));

		broker.resolve("c1", { requestId: "r2", ok: true, data: { n: 2 } });
		broker.resolve("c1", { requestId: "r1", ok: true, data: { n: 1 } });

		expect(await p1).toMatchObject({ data: { n: 1 } });
		expect(await p2).toMatchObject({ data: { n: 2 } });
	});

	it("超时返回 PI_REQUEST_TIMEOUT", async () => {
		vi.useFakeTimers();
		const broker = new PiRequestBroker();
		broker.bindEmitter(() => {});

		const promise = broker.request("c1", makeRequest(), 100);
		promise.catch(() => {}); // 防 fake-timer 边界 unhandled rejection
		await vi.advanceTimersByTimeAsync(150);
		await expect(promise).rejects.toMatchObject({ code: "PI_REQUEST_TIMEOUT" });
	});

	it("断线失败 pending 请求", async () => {
		const broker = new PiRequestBroker();
		broker.bindEmitter(() => {});
		const promise = broker.request("c1", makeRequest());

		broker.disconnect("c1");
		await expect(promise).rejects.toMatchObject({ code: "PI_CLIENT_DISCONNECTED" });
	});

	it("其他 Client 的伪造响应被拒绝", async () => {
		vi.useFakeTimers();
		const broker = new PiRequestBroker();
		broker.bindEmitter(() => {});
		const promise = broker.request("c1", makeRequest(), 100);
		promise.catch(() => {}); // 防 fake-timer 边界 unhandled rejection

		broker.resolve("c2", { requestId: "req-1", ok: true, data: { evil: true } });
		// 仍未 resolve：超时
		await vi.advanceTimersByTimeAsync(150);
		await expect(promise).rejects.toMatchObject({ code: "PI_REQUEST_TIMEOUT" });
	});

	it("重复响应忽略", async () => {
		const broker = new PiRequestBroker();
		broker.bindEmitter(() => {});
		const promise = broker.request("c1", makeRequest());

		broker.resolve("c1", { requestId: "req-1", ok: true, data: { n: 1 } });
		broker.resolve("c1", { requestId: "req-1", ok: false, error: { code: "PI_PROJECT_BUSY", message: "x" } });

		const result = (await promise) as PiResponse;
		expect(result).toMatchObject({ ok: true, data: { n: 1 } });
	});
});
