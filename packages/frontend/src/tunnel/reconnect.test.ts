import { describe, expect, it } from "vitest";
import { classifyDisconnect, MAX_RETRIES, NON_RETRYABLE_CODES, retryDelayMs } from "./reconnect.js";

describe("retryDelayMs", () => {
	it("退避序列为 1/2/4/8/15 秒并封顶", () => {
		expect([1, 2, 3, 4, 5, 6, 99].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
	});

	it("非法 attempt 退化为首档", () => {
		expect(retryDelayMs(0)).toBe(1000);
		expect(retryDelayMs(-3)).toBe(1000);
		expect(retryDelayMs(Number.NaN)).toBe(1000);
	});

	it("重试上限为 5", () => {
		expect(MAX_RETRIES).toBe(5);
	});
});

describe("classifyDisconnect", () => {
	it("用户主动断开：不重试、不报错", () => {
		expect(
			classifyDisconnect({ failureCode: null, wasConnected: true, userInitiated: true, socketLost: false }),
		).toEqual({ retry: false, message: null });
	});

	it("用户主动断开优先于其它信号（即使 socket 也掉了）", () => {
		expect(
			classifyDisconnect({ failureCode: "TUNNEL_TARGET_REFUSED", wasConnected: true, userInitiated: true, socketLost: true }),
		).toEqual({ retry: false, message: null });
	});

	it("确定性失败：报原因但不重试", () => {
		const expected: Record<string, string> = {
			TUNNEL_TARGET_REFUSED: "目标端口拒绝连接（服务可能未监听）",
			VNC_AUTH_FAILED: "VNC 认证失败",
			TUNNEL_CLIENT_UNAVAILABLE: "目标机器当前离线",
			TUNNEL_CLIENT_UNSUPPORTED: "该 Client 不支持 P2P 隧道协议 v1",
		};
		for (const [code, message] of Object.entries(expected)) {
			expect(NON_RETRYABLE_CODES).toContain(code);
			const d = classifyDisconnect({ failureCode: code, wasConnected: true, userInitiated: false, socketLost: false });
			expect(d).toEqual({ retry: false, message });
		}
	});

	it("控制面 socket 掉线：重试并给控制面文案", () => {
		expect(
			classifyDisconnect({ failureCode: null, wasConnected: true, userInitiated: false, socketLost: true }),
		).toEqual({ retry: true, message: "控制面连接中断，正在重连…" });
	});

	it("其它断线（含已连接后未知原因）：重试并给隧道通用文案", () => {
		expect(
			classifyDisconnect({ failureCode: null, wasConnected: true, userInitiated: false, socketLost: false }),
		).toEqual({ retry: true, message: "隧道操作失败，请重试" });
	});

	it("可重试的具体错误码仍保留其文案", () => {
		expect(
			classifyDisconnect({ failureCode: "TUNNEL_BACKPRESSURE_LIMIT", wasConnected: true, userInitiated: false, socketLost: false }),
		).toEqual({ retry: true, message: "隧道数据回压超限，已关闭" });
	});
});
