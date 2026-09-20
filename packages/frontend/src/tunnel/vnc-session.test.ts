import { describe, expect, it, vi } from "vitest";
import { applyViewMode, createVncSession, type RfbInstance } from "./vnc-session.js";

/** 记录事件监听、可触发事件的 fake RFB。 */
function makeFakeRfb(): RfbInstance & {
	dispatchEvent: (type: string, detail?: object) => void;
} {
	const listeners: Record<string, EventListener[]> = {};
	return {
		viewOnly: false,
		scaleViewport: false,
		clipViewport: false,
		dragViewport: false,
		resizeSession: false,
		qualityLevel: 0,
		compressionLevel: 0,
		background: "",
		disconnect: vi.fn(),
		sendCredentials: vi.fn(),
		clipboardPasteFrom: vi.fn(),
		sendCtrlAltDel: vi.fn(),
		addEventListener(type: string, fn: EventListener) {
			const arr = listeners[type] ?? [];
			arr.push(fn);
			listeners[type] = arr;
		},
		removeEventListener(type: string, fn: EventListener) {
			const arr = listeners[type] ?? [];
			const i = arr.indexOf(fn);
			if (i >= 0) arr.splice(i, 1);
		},
		dispatchEvent(type: string, detail?: object) {
			for (const fn of listeners[type] ?? []) {
				fn(new CustomEvent(type, { detail }));
			}
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
	it("默认 viewOnly=false、适配模式（scaleViewport=true）、resizeSession 恒为 false、中档画质", async () => {
		const rfb = makeFakeRfb();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			createRfb: () => rfb,
		});
		expect(rfb.viewOnly).toBe(false);
		expect(rfb.scaleViewport).toBe(true);
		expect(rfb.clipViewport).toBe(false);
		// 永不请求远端改分辨率（Phase C）：发 SetDesktopSize 会改变目标机显示设置
		expect(rfb.resizeSession).toBe(false);
		expect([rfb.qualityLevel, rfb.compressionLevel]).toEqual([6, 2]);
		expect(session.rfb).toBe(rfb);
	});

	it("尊重传入的 viewOnly / viewMode / 画质选项", async () => {
		const rfb = makeFakeRfb();
		await createVncSession(makeContainer(), makeChannel(), {
			viewOnly: true,
			viewMode: "actual",
			qualityLevel: 9,
			compressionLevel: 0,
			createRfb: () => rfb,
		});
		expect(rfb.viewOnly).toBe(true);
		expect([rfb.scaleViewport, rfb.clipViewport, rfb.dragViewport]).toEqual([false, true, true]);
		expect(rfb.resizeSession).toBe(false);
		expect([rfb.qualityLevel, rfb.compressionLevel]).toEqual([9, 0]);
	});

	it("applyViewMode 产出三种模式的属性组合", () => {
		const rfb = makeFakeRfb();
		applyViewMode(rfb, "fit");
		expect([rfb.scaleViewport, rfb.clipViewport, rfb.dragViewport]).toEqual([true, false, false]);
		applyViewMode(rfb, "actual");
		expect([rfb.scaleViewport, rfb.clipViewport, rfb.dragViewport]).toEqual([false, true, true]);
		applyViewMode(rfb, "scroll");
		expect([rfb.scaleViewport, rfb.clipViewport, rfb.dragViewport]).toEqual([false, false, false]);
	});

	it("运行时切换模式 / 画质均作用于底层属性", async () => {
		const rfb = makeFakeRfb();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			createRfb: () => rfb,
		});
		session.setViewMode("actual");
		session.setQuality(3);
		session.setCompression(7);
		expect([rfb.scaleViewport, rfb.clipViewport, rfb.dragViewport]).toEqual([false, true, true]);
		// 任何运行时操作都不得把远端 resize 打开
		expect(rfb.resizeSession).toBe(false);
		expect([rfb.qualityLevel, rfb.compressionLevel]).toEqual([3, 7]);
	});

	it("clipboard 事件转发文本；sendClipboard / sendCtrlAltDel 透传", async () => {
		const rfb = makeFakeRfb();
		const seen: string[] = [];
		const session = await createVncSession(makeContainer(), makeChannel(), {
			onClipboard: (text) => seen.push(text),
			createRfb: () => rfb,
		});
		rfb.dispatchEvent("clipboard", { text: "from-remote" });
		expect(seen).toEqual(["from-remote"]);
		session.sendClipboard("to-remote");
		session.sendCtrlAltDel();
		expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith("to-remote");
		expect(rfb.sendCtrlAltDel).toHaveBeenCalledTimes(1);
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

	it("disconnect() 幂等：摘除自身监听、底层 disconnect 仅调用一次", async () => {		const rfb = makeFakeRfb();
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

	it("会话对象不再暴露远端 resize 开关", async () => {
		const rfb = makeFakeRfb();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			createRfb: () => rfb,
		});
		expect(session).not.toHaveProperty("setResizeSession");
	});

	it("断开后各 setter / 出站方法不再作用到底层 RFB（noVNC 会拒绝已断开对象）", async () => {
		const rfb = makeFakeRfb();
		const session = await createVncSession(makeContainer(), makeChannel(), {
			createRfb: () => rfb,
		});
		session.disconnect();
		session.setViewOnly(true);
		session.setViewMode("actual");
		session.setQuality(9);
		session.setCompression(9);
		session.sendClipboard("x");
		session.sendCtrlAltDel();
		expect(rfb.viewOnly).toBe(false);
		expect(rfb.scaleViewport).toBe(true); // 仍保持 fit
		expect(rfb.resizeSession).toBe(false);
		expect([rfb.qualityLevel, rfb.compressionLevel]).toEqual([6, 2]);
		expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
		expect(rfb.sendCtrlAltDel).not.toHaveBeenCalled();
	});
});
