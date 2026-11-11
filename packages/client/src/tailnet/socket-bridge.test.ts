/**
 * Tailnet 密钥交付桥单测（ADR-0062）。
 *
 * 用内存 fake socket 驱动：不建立真实网络、不记录任何正文。
 */
import { Events, type TailnetSecretRequest } from "@vcpdeck/shared";
import { describe, expect, it } from "vitest";
import {
	TailnetSocketBridge,
	type TailnetSecretSocket,
} from "./socket-bridge.js";

class FakeSocket implements TailnetSecretSocket {
	readonly handlers = new Map<string, (payload: unknown) => void>();
	readonly emitted: { event: string; payload: unknown }[] = [];

	on(event: string, handler: (payload: unknown) => void): void {
		this.handlers.set(event, handler);
	}

	emit(event: string, payload: unknown): void {
		this.emitted.push({ event, payload });
	}

	deliver(payload: unknown): void {
		this.handlers.get(Events.TAILNET_SECRET_RESPONSE)?.(payload);
	}
}

const SIGNAL = new AbortController().signal;

function response(
	request: TailnetSecretRequest,
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		protocolVersion: 1,
		jobId: request.jobId,
		requestId: request.requestId,
		expiresAt: new Date(Date.now() + 30_000).toISOString(),
		authKey: "tskey-fake-secret",
		...overrides,
	};
}

function lastRequest(socket: FakeSocket): TailnetSecretRequest {
	const entry = socket.emitted.at(-1);
	expect(entry?.event).toBe(Events.TAILNET_SECRET_REQUEST);
	return entry?.payload as TailnetSecretRequest;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? "NO_CODE";
	}
	return "NO_THROW";
}

describe("Tailnet 密钥交付桥", () => {
	it("未收到 REGISTER ack 或未 allow 的 job 不发送请求", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket);
		expect(await codeOf(bridge.request("job-1", SIGNAL))).toBe(
			"TAILNET_SECRET_DENIED",
		);
		bridge.onRegistered();
		expect(await codeOf(bridge.request("job-1", SIGNAL))).toBe(
			"TAILNET_SECRET_DENIED",
		);
		expect(socket.emitted).toHaveLength(0);
	});

	it("请求只发 jobId/requestId，响应匹配后交付正文", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket);
		bridge.onRegistered();
		bridge.allowJob("job-1");
		const pending = bridge.request("job-1", SIGNAL);
		const request = lastRequest(socket);
		expect(request).toEqual({
			protocolVersion: 1,
			jobId: "job-1",
			requestId: expect.any(String),
		});
		socket.deliver(response(request));
		await expect(pending).resolves.toBe("tskey-fake-secret");
	});

	it("jobId 不匹配的响应被忽略，正确响应仍可交付", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket);
		bridge.onRegistered();
		bridge.allowJob("job-1");
		const pending = bridge.request("job-1", SIGNAL);
		const request = lastRequest(socket);
		socket.deliver(response(request, { jobId: "job-2" }));
		socket.deliver(response(request));
		await expect(pending).resolves.toBe("tskey-fake-secret");
	});

	it("过期响应拒绝交付", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket);
		bridge.onRegistered();
		bridge.allowJob("job-1");
		const pending = bridge.request("job-1", SIGNAL);
		const request = lastRequest(socket);
		socket.deliver(
			response(request, { expiresAt: new Date(Date.now() - 1_000).toISOString() }),
		);
		expect(await codeOf(pending)).toBe("TAILNET_SECRET_EXPIRED");
	});

	it("同一 requestId 重放不会二次交付", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket);
		bridge.onRegistered();
		bridge.allowJob("job-1");
		const first = bridge.request("job-1", SIGNAL);
		const request = lastRequest(socket);
		socket.deliver(response(request));
		await expect(first).resolves.toBe("tskey-fake-secret");

		expect(() => socket.deliver(response(request))).not.toThrow();

		const second = bridge.request("job-1", SIGNAL);
		const secondRequest = lastRequest(socket);
		expect(secondRequest.requestId).not.toBe(request.requestId);
		socket.deliver(response(secondRequest));
		await expect(second).resolves.toBe("tskey-fake-secret");
	});

	it("断连清空 allow-set 并让在途请求失败，重连不自动恢复", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket);
		bridge.onRegistered();
		bridge.allowJob("job-1");
		const pending = bridge.request("job-1", SIGNAL);
		bridge.onDisconnected();
		expect(await codeOf(pending)).toBe("TAILNET_SECRET_DENIED");

		bridge.onRegistered();
		expect(await codeOf(bridge.request("job-1", SIGNAL))).toBe(
			"TAILNET_SECRET_DENIED",
		);
	});

	it("等待超时后拒绝，迟到的响应被忽略", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket, { ttlMs: 20 });
		bridge.onRegistered();
		bridge.allowJob("job-1");
		const pending = bridge.request("job-1", SIGNAL);
		const request = lastRequest(socket);
		expect(await codeOf(pending)).toBe("TAILNET_SECRET_TIMEOUT");
		expect(() => socket.deliver(response(request))).not.toThrow();
	});

	it("abort 立即拒绝且不交付正文", async () => {
		const socket = new FakeSocket();
		const bridge = new TailnetSocketBridge(socket);
		bridge.onRegistered();
		bridge.allowJob("job-1");
		const controller = new AbortController();
		const pending = bridge.request("job-1", controller.signal);
		const request = lastRequest(socket);
		controller.abort();
		expect(await codeOf(pending)).toBe("TAILNET_SECRET_DENIED");
		socket.deliver(response(request));
	});
});
