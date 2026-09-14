import type { RemoteDesktopRole } from "@vcpdeck/shared";

const MAX_COORDINATE = 65_535;

interface RemoteInputChannel {
	readonly readyState?: string;
	send(data: string): void;
}

export interface RemoteInputLayout {
	generation: number;
	width: number;
	height: number;
}

export interface RemoteInputOptions {
	control: RemoteInputChannel;
	pointer: RemoteInputChannel;
	role?: RemoteDesktopRole;
	getLayout: () => RemoteInputLayout;
	windowTarget?: EventTarget;
	documentTarget?: EventTarget;
	/** 检测到 Ctrl+Alt+Del 时回调；由调用方决定是否真的请求 Secure Attention。 */
	onSecureAttention?: () => void;
}

export interface RemoteInput {
	keyDown(event: Pick<KeyboardEvent, "code" | "keyCode">): void;
	keyUp(event: Pick<KeyboardEvent, "code" | "keyCode">): void;
	button(event: Pick<MouseEvent, "button">, pressed: boolean): void;
	wheel(event: Pick<WheelEvent, "deltaX" | "deltaY">): void;
	pointerMove(event: Pick<MouseEvent, "clientX" | "clientY">, bounds: DOMRect): void;
	releaseAll(): void;
	freeze(): void;
	resumeLayout(generation: number): void;
	secureAttention(): void;
	/** 当前处于按下状态的鼠标按键，供拖拽诊断与断言。 */
	pressedButtons(): number[];
	/**
	 * 是否从浏览器抢回保留组合键。
	 *
	 * 仅在远程画布获得焦点时开启：始终开启会让整个应用无法使用浏览器快捷键。
	 */
	setCaptureActive(active: boolean): void;
	dispose(): void;
}

/**
 * 浏览器会自行处理、因而必须抢回来转发给远端的组合键。
 *
 * 仅返回需要 `preventDefault()` 的组合：事件仍会继续派发到已聚焦的远程画布，
 * 由它正常转发，不必在这里重复发送。
 * Escape 与裸 Tab 必须保留为退出通道，绝不能把用户困在远端会话里。
 */
export function isBrowserReservedShortcut(event: {
	key: string;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
}): boolean {
	const key = event.key;
	if (key === "Escape") return false;
	if (key === "Tab" && event.ctrlKey !== true) return false;
	if (event.ctrlKey === true) {
		// Ctrl+W/T/N/R 关闭标签页/新标签页/新窗口/刷新；Ctrl+Tab 切换标签页。
		if (["w", "t", "n", "r", "tab"].includes(key.toLowerCase())) return true;
	}
	// Alt+左右 是浏览器前进/后退。
	if (event.altKey === true && (key === "ArrowLeft" || key === "ArrowRight")) return true;
	// F5 刷新；F12（开发者工具）保留为排障通道。
	return key === "F5";
}

function keyCodeOf(event: Pick<KeyboardEvent, "code" | "keyCode">): number {
	if (Number.isInteger(event.keyCode) && event.keyCode > 0) return event.keyCode;
	const code = event.code;
	if (code.startsWith("Key") && code.length === 4) return code.charCodeAt(3);
	if (code.startsWith("Digit") && code.length === 6) return Number(code[5]);
	const common: Record<string, number> = {
		ControlLeft: 17,
		ControlRight: 17,
		AltLeft: 18,
		AltRight: 18,
		ShiftLeft: 16,
		ShiftRight: 16,
		MetaLeft: 91,
		MetaRight: 92,
		Enter: 13,
		Escape: 27,
		Tab: 9,
		Backspace: 8,
		Space: 32,
		ArrowUp: 38,
		ArrowDown: 40,
		ArrowLeft: 37,
		ArrowRight: 39,
	};
	return common[code] ?? 0;
}

function boundedCoordinate(value: number, start: number, size: number): number {
	if (!Number.isFinite(value) || !Number.isFinite(start) || size <= 0) return 0;
	const ratio = Math.min(1, Math.max(0, (value - start) / size));
	return Math.round(ratio * MAX_COORDINATE);
}

function send(channel: RemoteInputChannel, message: unknown): void {
	if (channel.readyState !== undefined && channel.readyState !== "open") return;
	try {
		channel.send(JSON.stringify(message));
	} catch {
		// WebRTC channel 关闭竞态时安全丢弃，不让浏览器事件线程抛出异常。
	}
}

/** Browser 输入适配器：只发送归一化输入，并在焦点/可见性丢失时释放全部按键。 */
const CTRL_KEY_CODE = 17;
const ALT_KEY_CODE = 18;
const DELETE_KEY_CODE = 46;

export function createRemoteInput(options: RemoteInputOptions): RemoteInput {
	const role = options.role ?? "operator";
	const pressedKeys = new Set<number>();
	const pressedButtons = new Set<number>();
	let frozen = false;
	let captureActive = false;
	// Ctrl+Alt+Del 被拦下后，它自己的 keyup 也要丢弃，否则会下发一个未按下过的 Delete。
	let suppressedDelete = false;
	const windowTarget = options.windowTarget ?? (typeof window !== "undefined" ? window : undefined);
	const documentTarget = options.documentTarget ?? (typeof document !== "undefined" ? document : undefined);

	const releaseAll = () => {
		if (role !== "operator") return;
		pressedKeys.clear();
		// 拖拽途中丢失焦点/断线时必须一并释放鼠标键，否则远端会卡住左键。
		pressedButtons.clear();
		send(options.control, { type: "release-all" });
	};
	const onBlur = () => releaseAll();
	const onVisibilityChange = () => {
		if (documentTarget && "visibilityState" in documentTarget) {
			const visibilityState = (documentTarget as Document).visibilityState;
			if (visibilityState === "hidden") releaseAll();
		}
	};

	windowTarget?.addEventListener("blur", onBlur);
	documentTarget?.addEventListener("visibilitychange", onVisibilityChange);

	// 捕获阶段运行：必须在浏览器执行刷新/关标签页等默认动作之前抢下来。
	const onCaptureKeyDown = (event: Event) => {
		if (!captureActive) return;
		const keyboard = event as KeyboardEvent;
		if (isBrowserReservedShortcut(keyboard)) keyboard.preventDefault();
	};
	windowTarget?.addEventListener("keydown", onCaptureKeyDown, true);

	return {
		keyDown: (event) => {
			if (role !== "operator" || frozen) return;
			const keyCode = keyCodeOf(event);
			if (keyCode <= 0) return;
			// Ctrl+Alt+Del 是系统级 Secure Attention Sequence，无法用普通按键注入送达。
			// 下发 Delete 既无效又可能在本机触发意外行为，因此就地拦下并释放已按下的修饰键。
			if (
				keyCode === DELETE_KEY_CODE &&
				pressedKeys.has(CTRL_KEY_CODE) &&
				pressedKeys.has(ALT_KEY_CODE)
			) {
				suppressedDelete = true;
				releaseAll();
				options.onSecureAttention?.();
				return;
			}
			pressedKeys.add(keyCode);
			send(options.control, {
				type: "input",
				event: { kind: "key", keyCode, pressed: true },
			});
		},
		keyUp: (event) => {
			if (role !== "operator" || frozen) return;
			const keyCode = keyCodeOf(event);
			if (keyCode <= 0) return;
			if (keyCode === DELETE_KEY_CODE && suppressedDelete) {
				suppressedDelete = false;
				return;
			}
			pressedKeys.delete(keyCode);
			send(options.control, {
				type: "input",
				event: { kind: "key", keyCode, pressed: false },
			});
		},
		button: (event, pressed) => {
			if (role !== "operator" || frozen || !Number.isInteger(event.button) || event.button < 0 || event.button > 7) return;
			if (pressed) pressedButtons.add(event.button);
			else pressedButtons.delete(event.button);
			send(options.control, {
				type: "input",
				event: { kind: "button", button: event.button, pressed },
			});
		},
		wheel: (event) => {
			if (role !== "operator" || frozen) return;
			const deltaX = Number.isFinite(event.deltaX) ? Math.max(-32_767, Math.min(32_767, Math.round(event.deltaX))) : 0;
			const deltaY = Number.isFinite(event.deltaY) ? Math.max(-32_767, Math.min(32_767, Math.round(event.deltaY))) : 0;
			if (deltaX === 0 && deltaY === 0) return;
			send(options.control, { type: "input", event: { kind: "wheel", deltaX, deltaY } });
		},
		pointerMove: (event, bounds) => {
			if (role !== "operator" || frozen) return;
			const layout = options.getLayout();
			if (layout.width <= 0 || layout.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return;
			send(options.pointer, {
				layoutGeneration: layout.generation,
				x: boundedCoordinate(event.clientX, bounds.left, bounds.width),
				y: boundedCoordinate(event.clientY, bounds.top, bounds.height),
			});
		},
		releaseAll,
		freeze: () => {
			if (role !== "operator") return;
			frozen = true;
			releaseAll();
		},
		resumeLayout: (generation) => {
			const layout = options.getLayout();
			if (generation === layout.generation) frozen = false;
		},
		secureAttention: () => {
			// 只有 Operator 能请求 Secure Attention；它不是输入注入，
			// 因此在冻结期间（登录屏/锁屏切换）仍然可用，与 Host 侧判定一致。
			if (role !== "operator") return;
			send(options.control, { type: "secure-attention" });
		},
		pressedButtons: () => [...pressedButtons].sort((a, b) => a - b),
		setCaptureActive: (active) => {
			// 只有 Operator 需要抢键；Viewer 不发送任何输入。
			captureActive = active && role === "operator";
		},
		dispose: () => {
			releaseAll();
			windowTarget?.removeEventListener("blur", onBlur);
			windowTarget?.removeEventListener("keydown", onCaptureKeyDown, true);
			documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
		},
	};
}
