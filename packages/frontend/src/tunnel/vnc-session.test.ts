import { describe, expect, it, vi } from "vitest";
import { createVncSession, type RfbInstance } from "./vnc-session.js";

/** 记录事件监听、可触发事件的 fake RFB。 */
function makeFakeRfb(): RfbInstance & {
	dispatchEvent: (type: string, detail?: object) => void;
} {
	const listeners: Record<string, EventListener[]> = {};
	return {
		viewOnly: false,
		scaleViewport: false,
		resizeSession: false,
		disconnect: vi.fn(),
		sendCredentials: vi.fn(),
		addEventListener(type: string, fn: EventListener) {
			(listeners[type] ??= []).push(fn);
		},
		removeEventListener(type: string, fn: EventListener) {
			const arr = listeners[type] ?? [];
			const i = arr.indexOf(fn);
			if (i >= 0) arr.splice(i, 1);
		},
		dispatchEvent(type: string, detail?: object) {
			(listeners[type] ?? []).forEach((fn) =>
				fn(new CustomEvent(type, { detail })),
			);
		},
	};
}

function makeChannel() {
	return {
		send: vi.fn(),
		close: vi.fn(),
		binaryType: "arraybuffer",
		onopen: null as unknown,
		onmessage: null as unknown,
		onclose: null as unknown,
		onerror: null as unknown,
		protocol: "",
		readyState: 1,
	} as unknown as RTCDataChannel;
}

function makeContainer() {
	return {} as HTMLElement;
}

describe("createVncSession", () => {
	it("默认 viewOnly=false、scaleViewport=true、resizeSession=false", async () => {
		const rfb = makeFakeRfb();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			createRfb: () => rfb,
		});
		expect(rfb.viewOnly).toBe(false);
		expect(rfb.scaleViewport).toBe(true);
		expect(rfb.resizeSession).toBe(false);
		expect(session.rfb).toBe(rfb);
	});

	it("尊重传入的 viewOnly / scaleViewport 选项", async () => {
		const rfb = makeFakeRfb();
		await createVncSession(makeContainer(), makeChannel(), {
			viewOnly: true,
			scaleViewport: false,
			createRfb: () => rfb,
		});
		expect(rfb.viewOnly).toBe(true);
		expect(rfb.scaleViewport).toBe(false);
	});

	it("connect/disconnect 事件映射为 connected / disconnected", async () => {
		const rfb = makeFakeRfb();
		const states: string[] = [];
		await createVncSession(makeContainer(), makeChannel(), {
			onState: (s) => states.push(s),
			createRfb: () => rfb,
		});
		rfb.dispatchEvent("connect");
		rfb.dispatchEvent("disconnect");
		expect(states).toEqual(["connecting", "connected", "disconnected"]);
	});

	it("securityfailure 回调携带 reason", async () => {
		const rfb = makeFakeRfb();
		const failures: string[] = [];
		await createVncSession(makeContainer(), makeChannel(), {
			onSecurityFailure: (reason) => failures.push(reason ?? ""),
			createRfb: () => rfb,
		});
		rfb.dispatchEvent("securityfailure", { reason: "no auth" });
		expect(failures).toEqual(["no auth"]);
	});

	it("credentialsrequired 回调抛出 types", async () => {
		const rfb = makeFakeRfb();
		const reqs: string[][] = [];
		await createVncSession(makeContainer(), makeChannel(), {
			onCredentials: (r) => reqs.push(r.types),
			createRfb: () => rfb,
		});
		rfb.dispatchEvent("credentialsrequired", { types: ["password"] });
		expect(reqs).toEqual([["password"]]);
	});

	it("sendCredentials 透传给底层 rfb", async () => {
		const rfb = makeFakeRfb();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			createRfb: () => rfb,
		});
		session.sendCredentials({ password: "p" });
		expect(rfb.sendCredentials).toHaveBeenCalledWith({ password: "p" });
	});

	it("setViewOnly 更新底层属性", async () => {
		const rfb = makeFakeRfb();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			createRfb: () => rfb,
		});
		session.setViewOnly(true);
		expect(rfb.viewOnly).toBe(true);
	});

	it("disconnect() 幂等：摘除自身监听、底层 disconnect 仅调用一次", async () => {
		const rfb = makeFakeRfb();
		const onState = vi.fn();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			onState,
			createRfb: () => rfb,
		});
		onState.mockClear(); // 清掉初始 connecting
		session.disconnect();
		session.disconnect();
		expect(rfb.disconnect).toHaveBeenCalledTimes(1);
		// 监听已摘除：再触发底层事件不应回调本会话
		rfb.dispatchEvent("connect");
		expect(onState).not.toHaveBeenCalled();
	});
});
