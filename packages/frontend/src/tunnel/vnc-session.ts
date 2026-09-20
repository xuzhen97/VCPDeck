/**
 * noVNC 远程桌面会话适配。
 *
 * 把一条已打开的 `RTCDataChannel`（由 `openBrowserTunnel` 返回）交给 noVNC
 * 的 `RFB`，让它直接在这条可靠、有序、带 DTLS 的通道上跑 RFB 协议。
 * noVNC 会接管该 channel 的 `send/close/on*` 事件，因此本模块在创建后不再
 * 持有这些 handler；隧道清理由调用方在会话结束时按固定顺序完成。
 */

/** noVNC RFB 实例的最小面（只声明本模块用到的成员，便于测试注入）。 */
export interface RfbInstance {
	viewOnly: boolean;
	scaleViewport: boolean;
	clipViewport: boolean;
	dragViewport: boolean;
	resizeSession: boolean;
	qualityLevel: number;
	compressionLevel: number;
	background: string;
	disconnect: () => void;
	sendCredentials: (creds: {
		username?: string;
		password?: string;
		target?: string;
	}) => void;
	/** 把文本作为剪贴板内容发送给远端。 */
	clipboardPasteFrom: (text: string) => void;
	/** 发送 Ctrl-Alt-Del。 */
	sendCtrlAltDel: () => void;
	addEventListener: (type: string, listener: EventListener) => void;
	removeEventListener: (type: string, listener: EventListener) => void;
}

/** 查看模式：适配容器 / 1:1 可拖动 / 1:1 带滚动条。 */
export type ViewMode = "fit" | "actual" | "scroll";

/**
 * 把查看模式映射为 noVNC 的三个视口属性（三者互相独立，必须同时设置）。
 * 详见 noVNC API：scaleViewport / clipViewport / dragViewport。
 */
export function applyViewMode(
	rfb: Pick<RfbInstance, "scaleViewport" | "clipViewport" | "dragViewport">,
	mode: ViewMode,
): void {
	rfb.scaleViewport = mode === "fit";
	rfb.clipViewport = mode === "actual";
	rfb.dragViewport = mode === "actual";
}

/** 构造 RFB 实例；默认走 noVNC，测试可注入 fake。 */
export type RfbFactory = (
	container: HTMLElement,
	channel: RTCDataChannel,
) => RfbInstance | Promise<RfbInstance>;

/** 会话对外可见的连接状态。 */
export type VncState = "connecting" | "connected" | "disconnected";

/** 凭据请求（来自 noVNC 的 credentialsrequired 事件）。 */
export interface VncCredentialsRequest {
	types: string[];
}

export interface VncSessionOptions {
	/** 只读模式（不向远端发送键鼠）。默认 false（面板默认传 true）。 */
	viewOnly?: boolean;
	/** 查看模式，决定 scaleViewport/clipViewport/dragViewport。默认 "fit"。 */
	viewMode?: ViewMode;
	/** JPEG 质量 0-9。默认 6。 */
	qualityLevel?: number;
	/** zlib 压缩 0-9。默认 2。 */
	compressionLevel?: number;
	/** 连接状态变化（归一化后）。 */
	onState?: (s: VncState) => void;
	/** 服务端要求凭据时回调（由面板弹窗并调用 sendCredentials）。 */
	onCredentials?: (req: VncCredentialsRequest) => void;
	/** 认证失败时回调。 */
	onSecurityFailure?: (reason?: string) => void;
	/** 收到远端剪贴板文本时回调。 */
	onClipboard?: (text: string) => void;
	/** 注入 RFB 构造器（测试用）。 */
	createRfb?: RfbFactory;
}

export interface VncSession {
	/** 关闭 RFB 连接（幂等）。不关闭底层 tunnel，由调用方决定。 */
	disconnect: () => void;
	/** 运行中切换只读模式。 */
	setViewOnly: (v: boolean) => void;
	/** 运行中切换查看模式。 */
	setViewMode: (mode: ViewMode) => void;
	/** 运行中切换 JPEG 质量（0-9）。 */
	setQuality: (q: number) => void;
	/** 运行中切换压缩等级（0-9）。 */
	setCompression: (c: number) => void;
	/** 把本地文本发送到远端剪贴板。 */
	sendClipboard: (text: string) => void;
	/** 发送 Ctrl-Alt-Del。 */
	sendCtrlAltDel: () => void;
	/** 面板弹窗收集到凭据后提交给服务端。 */
	sendCredentials: (creds: { username?: string; password?: string }) => void;
	/** 只读访问底层 RFB（测试 / 进阶用途）。 */
	readonly rfb: RfbInstance;
}

/** noVNC 模块形状（只声明本模块用到的默认导出）。 */
type RfbModule = {
	default: new (target: HTMLElement, channel: RTCDataChannel) => RfbInstance;
};

/** 共享加载 promise：预热后连接时的构造不再受模块加载延迟影响。 */
let rfbModulePromise: Promise<RfbModule> | null = null;

function loadRfb(): Promise<RfbModule> {
	// SAFETY: noVNC 的 ESM 默认导出是 RFB 构造器，其公开面已由 RfbInstance 声明；
	// 这里用一次静态断言把动态 import 收窄到本模块实际使用的最小面。
	rfbModulePromise ??= import("@novnc/novnc") as unknown as Promise<RfbModule>;
	return rfbModulePromise;
}

/**
 * 预加载 noVNC 模块（不建立连接）。
 *
 * 远程桌面面板应在挂载时调用：RFB 必须在 DataChannel open 之前挂上监听，
 * 否则通道一 open、服务端立即发送的 RFB banner 会在模块加载期间被丢弃，
 * 导致握手永远停在等待版本串。预热把该延迟移出关键路径。
 */
export function preloadRfb(): void {
	void loadRfb();
}

/** 默认 RFB 构造器：动态加载 noVNC，避免单测环境预加载其浏览器依赖。 */
async function defaultFactory(
	container: HTMLElement,
	channel: RTCDataChannel,
): Promise<RfbInstance> {
	const { default: RFB } = await loadRfb();
	// noVNC 构造即开始 RFB 握手；实例成员满足 RfbInstance 最小面
	return new RFB(container, channel) as RfbInstance;
}

/**
 * 创建并连接一个 VNC 会话。
 *
 * 构造 RFB 即开始 RFB 握手；成功/失败通过 onState / onSecurityFailure 回调。
 * 凭据交互通过 onCredentials 抛出，由调用方弹窗收集后回传 sendCredentials。
 */
export async function createVncSession(
	container: HTMLElement,
	channel: RTCDataChannel,
	opts: VncSessionOptions = {},
): Promise<VncSession> {
	const factory = opts.createRfb ?? defaultFactory;
	const rfb = await factory(container, channel);

	// 实例属性默认值：适配模式、中档画质；只读由面板决定
	rfb.viewOnly = !!opts.viewOnly;
	applyViewMode(rfb, opts.viewMode ?? "fit");
	// 永不请求远端改分辨率：SetDesktopSize 在物理 Windows 桌面上等同于改屏幕分辨率，
	// 而本产品要求查看行为不得影响目标机。缩放一律在浏览器本地完成。
	rfb.resizeSession = false;
	rfb.qualityLevel = opts.qualityLevel ?? 6;
	rfb.compressionLevel = opts.compressionLevel ?? 2;

	const listeners: Array<[type: string, fn: EventListener]> = [];
	function listen(type: string, fn: EventListener) {
		rfb.addEventListener(type, fn);
		listeners.push([type, fn]);
	}

	listen("connect", () => opts.onState?.("connected"));
	listen("disconnect", () => opts.onState?.("disconnected"));
	listen("securityfailure", (e: Event) => {
		const detail = (e as CustomEvent).detail ?? {};
		opts.onSecurityFailure?.(detail.reason);
	});
	listen("credentialsrequired", (e: Event) => {
		const detail = (e as CustomEvent).detail ?? {};
		opts.onCredentials?.({ types: detail.types ?? [] });
	});
	listen("clipboard", (e: Event) => {
		const detail = (e as CustomEvent).detail ?? {};
		if (typeof detail.text === "string") opts.onClipboard?.(detail.text);
	});

	// 连接刚建立前（connecting 阶段）先上报一次，便于面板展示进度
	opts.onState?.("connecting");

	let disconnected = false;
	/** 断开后对 RFB 的任何状态写入都会被 noVNC 拒绝，这里统一做幂等保护。 */
	const applyIfLive = (fn: () => void): void => {
		if (disconnected) return;
		fn();
	};
	return {
		disconnect() {
			if (disconnected) return;
			disconnected = true;
			for (const [type, fn] of listeners) rfb.removeEventListener(type, fn);
			listeners.length = 0;
			rfb.disconnect();
		},
		setViewOnly(v: boolean) {
			applyIfLive(() => {
				rfb.viewOnly = v;
			});
		},
		setViewMode(mode: ViewMode) {
			applyIfLive(() => applyViewMode(rfb, mode));
		},
		setQuality(q: number) {
			applyIfLive(() => {
				rfb.qualityLevel = q;
			});
		},
		setCompression(c: number) {
			applyIfLive(() => {
				rfb.compressionLevel = c;
			});
		},
		sendClipboard(text: string) {
			applyIfLive(() => rfb.clipboardPasteFrom(text));
		},
		sendCtrlAltDel() {
			applyIfLive(() => rfb.sendCtrlAltDel());
		},
		sendCredentials(creds) {
			rfb.sendCredentials(creds);
		},
		rfb,
	};
}
