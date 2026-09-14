import { describe, expect, it } from "vitest";
import { createRemoteInput, isBrowserReservedShortcut, type RemoteInput } from "./remote-input.js";

function channel() {
	const sent: string[] = [];
	return { sent, send: (value: string) => sent.push(value), readyState: "open" };
}

function layout() {
	return { generation: 7, width: 1920, height: 1080 };
}

describe("createRemoteInput", () => {
	it("sends physical keyboard input and releases it on window blur", () => {
		const control = channel();
		const input = createRemoteInput({
			control,
			pointer: channel(),
			getLayout: layout,
			windowTarget: window,
			documentTarget: document,
		});

		input.keyDown(new KeyboardEvent("keydown", { code: "ControlLeft", keyCode: 17 }));
		const firstMessage = control.sent[0];
		expect(firstMessage).toBeDefined();
		expect(JSON.parse(firstMessage ?? "")).toEqual({
			type: "input",
			event: { kind: "key", keyCode: 17, pressed: true },
		});
		window.dispatchEvent(new Event("blur"));
		const lastMessage = control.sent.at(-1);
		expect(lastMessage).toBeDefined();
		expect(JSON.parse(lastMessage ?? "")).toEqual({ type: "release-all" });
		input.dispose();
	});

	it("sends mouse button transitions through the reliable control channel", () => {
		const control = channel();
		const input = createRemoteInput({
			control,
			pointer: channel(),
			getLayout: layout,
		});
		input.button({ button: 0 }, true);
		input.button({ button: 0 }, false);
		expect(control.sent.map((value) => JSON.parse(value))).toEqual([
			{ type: "input", event: { kind: "button", button: 0, pressed: true } },
			{ type: "input", event: { kind: "button", button: 0, pressed: false } },
		]);
		input.dispose();
	});

	it("maps pointer coordinates to bounded layout-independent values", () => {
		const pointer = channel();
		const input = createRemoteInput({
			control: channel(),
			pointer,
			getLayout: layout,
		});
		input.pointerMove({ clientX: 150, clientY: 75 }, {
			left: 50,
			top: 25,
			width: 200,
			height: 100,
		} as DOMRect);
		const pointerMessage = pointer.sent[0];
		expect(pointerMessage).toBeDefined();
		expect(JSON.parse(pointerMessage ?? "")).toEqual({
			layoutGeneration: 7,
			x: 32768,
			y: 32768,
		});
	});

	it("sends wheel input through the reliable control channel", () => {
		const control = channel();
		const input: RemoteInput = createRemoteInput({
			control,
			pointer: channel(),
			getLayout: layout,
		});
		input.wheel({ deltaX: 4, deltaY: -12 });
		expect(control.sent.map((value) => JSON.parse(value))).toEqual([
			{ type: "input", event: { kind: "wheel", deltaX: 4, deltaY: -12 } },
		]);
		input.dispose();
	});

	it("freezes input during a layout change and resumes only for the current generation", () => {
		const control = channel();
		const input = createRemoteInput({
			control,
			pointer: channel(),
			getLayout: layout,
		});
		input.keyDown({ code: "KeyA", keyCode: 65 });
		input.freeze();
		input.keyDown({ code: "KeyB", keyCode: 66 });
		input.resumeLayout(8);
		input.keyDown({ code: "KeyC", keyCode: 67 });
		input.resumeLayout(7);
		input.keyDown({ code: "KeyD", keyCode: 68 });
		expect(control.sent.map((value) => JSON.parse(value))).toEqual([
			{ type: "input", event: { kind: "key", keyCode: 65, pressed: true } },
			{ type: "release-all" },
			{ type: "input", event: { kind: "key", keyCode: 68, pressed: true } },
		]);
		input.dispose();
	});

	it("uses the canonical camelCase control fields for keyboard and wheel input", () => {
		const control = channel();
		const input = createRemoteInput({
			control,
			pointer: channel(),
			getLayout: layout,
		});
		input.keyDown({ code: "KeyA", keyCode: 65 });
		input.wheel({ deltaX: 4, deltaY: -12 });
		expect(control.sent.map((value) => JSON.parse(value))).toEqual([
			{ type: "input", event: { kind: "key", keyCode: 65, pressed: true } },
			{ type: "input", event: { kind: "wheel", deltaX: 4, deltaY: -12 } },
		]);
		input.dispose();
	});

	it("never sends input for a viewer", () => {
		const control = channel();
		const pointer = channel();
		const input = createRemoteInput({
			control,
			pointer,
			role: "viewer",
			getLayout: layout,
		});
		input.keyDown(new KeyboardEvent("keydown", { keyCode: 65 }));
		input.pointerMove({ clientX: 1, clientY: 1 }, {
			left: 0,
			top: 0,
			width: 1,
			height: 1,
		} as DOMRect);
		expect(control.sent).toHaveLength(0);
		expect(pointer.sent).toHaveLength(0);
	});
});

describe("secure attention", () => {
	it("never delivers Ctrl+Alt+Del as a raw Delete keycode", () => {
		const control = channel();
		const input = createRemoteInput({ control, pointer: channel(), getLayout: layout });

		// Windows 的 SAS 无法用按键注入送达，下发 Delete 既无效又可能在本机触发意外行为。
		input.keyDown(new KeyboardEvent("keydown", { code: "ControlLeft", keyCode: 17 }));
		input.keyDown(new KeyboardEvent("keydown", { code: "AltLeft", keyCode: 18 }));
		input.keyDown(new KeyboardEvent("keydown", { code: "Delete", keyCode: 46 }));
		input.keyUp(new KeyboardEvent("keyup", { code: "Delete", keyCode: 46 }));

		const keyCodes = control.sent
			.map((message) => JSON.parse(message))
			.filter((message) => message.type === "input" && message.event.kind === "key")
			.map((message) => message.event.keyCode);
		expect(keyCodes).not.toContain(46);
		// 被拦下的组合不能把修饰键留在按下状态。
		expect(control.sent.map((message) => JSON.parse(message).type)).toContain("release-all");
		input.dispose();
	});

	it("sends an explicit secure-attention request only for operators", () => {
		const control = channel();
		const input = createRemoteInput({ control, pointer: channel(), getLayout: layout });
		input.secureAttention();
		expect(JSON.parse(control.sent[0] ?? "")).toEqual({ type: "secure-attention" });
		input.dispose();

		const viewerControl = channel();
		const viewer = createRemoteInput({
			control: viewerControl,
			pointer: channel(),
			role: "viewer",
			getLayout: layout,
		});
		viewer.secureAttention();
		expect(viewerControl.sent).toEqual([]);
		viewer.dispose();
	});

	it("still delivers Delete and the modifiers when they are not the SAS combination", () => {
		const control = channel();
		const input = createRemoteInput({ control, pointer: channel(), getLayout: layout });
		input.keyDown(new KeyboardEvent("keydown", { code: "Delete", keyCode: 46 }));
		input.keyDown(new KeyboardEvent("keydown", { code: "ControlLeft", keyCode: 17 }));
		input.keyDown(new KeyboardEvent("keydown", { code: "KeyC", keyCode: 67 }));
		const keyCodes = control.sent
			.map((message) => JSON.parse(message))
			.filter((message) => message.type === "input" && message.event.kind === "key")
			.map((message) => message.event.keyCode);
		expect(keyCodes).toEqual([46, 17, 67]);
		input.dispose();
	});
});

describe("mouse buttons and drags", () => {
	it("tracks pressed buttons and clears them on release-all", () => {
		const control = channel();
		const input = createRemoteInput({ control, pointer: channel(), getLayout: layout });
		input.button({ button: 0 }, true);
		input.button({ button: 2 }, true);
		expect(input.pressedButtons()).toEqual([0, 2]);
		// 拖拽过程中丢失焦点/断开连接时，必须释放所有按住的键，否则远端会卡住左键。
		input.releaseAll();
		expect(input.pressedButtons()).toEqual([]);
		expect(JSON.parse(control.sent.at(-1) ?? "")).toEqual({ type: "release-all" });
		input.dispose();
	});

	it("ignores releases for buttons that were never pressed", () => {
		const control = channel();
		const input = createRemoteInput({ control, pointer: channel(), getLayout: layout });
		input.button({ button: 1 }, false);
		expect(input.pressedButtons()).toEqual([]);
		input.dispose();
	});

	it("drops button tracking while frozen so the next drag starts clean", () => {
		const control = channel();
		const input = createRemoteInput({ control, pointer: channel(), getLayout: layout });
		input.button({ button: 0 }, true);
		input.freeze();
		expect(input.pressedButtons()).toEqual([]);
		// 冻结期间按钮事件不得下发。
		const before = control.sent.length;
		input.button({ button: 0 }, true);
		expect(control.sent.length).toBe(before);
		input.dispose();
	});
});

describe("browser-reserved shortcut capture", () => {
	it("recognises the combos the browser would otherwise swallow", () => {
		// 这些组合键默认由浏览器处理；不抢回来就无法送到远端。
		for (const event of [
			{ key: "w", ctrlKey: true },
			{ key: "t", ctrlKey: true },
			{ key: "n", ctrlKey: true },
			{ key: "r", ctrlKey: true },
			{ key: "F5" },
			{ key: "Tab", ctrlKey: true },
			{ key: "ArrowLeft", altKey: true },
			{ key: "ArrowRight", altKey: true },
		]) {
			expect(isBrowserReservedShortcut(event)).toBe(true);
		}
		// Escape 与 Tab 必须保留为退出通道，绝不能把用户困在会话里。
		expect(isBrowserReservedShortcut({ key: "Escape" })).toBe(false);
		expect(isBrowserReservedShortcut({ key: "Tab" })).toBe(false);
		// 普通按键不是保留组合。
		expect(isBrowserReservedShortcut({ key: "a" })).toBe(false);
		expect(isBrowserReservedShortcut({ key: "F12" })).toBe(false);
	});

	it("prevents the browser default only while capture is active", () => {
		const input = createRemoteInput({ control: channel(), pointer: channel(), getLayout: layout });
		const press = () => {
			const event = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};
		// 未激活时不得劫持浏览器快捷键（否则整个应用都无法正常使用）。
		expect(press()).toBe(false);
		input.setCaptureActive(true);
		expect(press()).toBe(true);
		input.setCaptureActive(false);
		expect(press()).toBe(false);
		input.dispose();
	});

	it("stops capturing after dispose", () => {
		const input = createRemoteInput({ control: channel(), pointer: channel(), getLayout: layout });
		input.setCaptureActive(true);
		input.dispose();
		const event = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});
});
