import { describe, expect, it, vi } from "vitest";
import {
	createUltraVncDisplayControl,
	encodeSetSw,
	SET_SW_MESSAGE_TYPE,
} from "./ultravnc-setsw.js";

describe("encodeSetSw", () => {
	it("产出实测有效的 6 字节消息", () => {
		// 类型 10（rfbSetSW），status/x/y 置 0：真机实测该组合即被接受并生效
		expect(SET_SW_MESSAGE_TYPE).toBe(10);
		expect([...encodeSetSw()]).toEqual([10, 0, 0, 0, 0, 0]);
	});

	it("每次返回独立缓冲区，调用方改写不会污染后续发送", () => {
		const first = encodeSetSw();
		first[0] = 99;
		expect([...encodeSetSw()]).toEqual([10, 0, 0, 0, 0, 0]);
	});
});

describe("createUltraVncDisplayControl", () => {
	function makeChannel(readyState: string) {
		return { readyState, send: vi.fn() };
	}

	it("通道已打开时，每次调用发送一条消息", () => {
		const channel = makeChannel("open");
		const control = createUltraVncDisplayControl(channel);
		control.cycle();
		control.cycle();
		expect(channel.send).toHaveBeenCalledTimes(2);
		expect([...(channel.send.mock.calls[0][0] as Uint8Array)]).toEqual([
			10, 0, 0, 0, 0, 0,
		]);
	});

	it("通道未打开时不发送，也不抛错", () => {
		for (const state of ["connecting", "closing", "closed"]) {
			const channel = makeChannel(state);
			const control = createUltraVncDisplayControl(channel);
			expect(() => control.cycle()).not.toThrow();
			expect(channel.send).not.toHaveBeenCalled();
		}
	});
});
