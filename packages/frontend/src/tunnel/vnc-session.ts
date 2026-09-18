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
	resizeSession: boolean;
	disconnect: () => void;
	sendCredentials: (creds: {
		username?: string;
		password?: string;
		target?: string;
	}) => void;
	addEventListener: (type: string, listener: EventListener) => void;
	removeEventListener: (type: string, listener: EventListener) => void;
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
	/** 只读模式（不向远端发送键鼠）。默认 false。 */
	viewOnly?: boolean;
	/** 缩放远端画面适配容器，不改变远端分辨率。默认 true。 */
	scaleViewport?: boolean;
	/** 连接状态变化（归一化后）。 */
	onState?: (s: VncState) => void;
	/** 服务端要求凭据时回调（由面板弹窗并调用 sendCredentials）。 */
	onCredentials?: (req: VncCredentialsRequest) => void;
	/** 认证失败时回调。 */
	onSecurityFailure?: (reason?: string) => void;
	/** 注入 RFB 构造器（测试用）。 */
	createRfb?: RfbFactory;
}

export interface VncSession {
	/** 关闭 RFB 连接（幂等）。不关闭底层 tunnel，由调用方决定。 */
	disconnect: () => void;
	/** 运行中切换只读模式。 */
	setViewOnly: (v: boolean) => void;
	/** 面板弹窗收集到凭据后提交给服务端。 */
	sendCredentials: (creds: { username?: string; password?: string }) => void;
	/** 只读访问底层 RFB（测试 / 进阶用途）。 */
	readonly rfb: RfbInstance;
}

/** 默认 RFB 构造器：动态加载 noVNC，避免单测环境预加载其浏览器依赖。 */
async function defaultFactory(
	container: HTMLElement,
	channel: RTCDataChannel,
): Promise<RfbInstance> {
	const { default: RFB } = await import("@novnc/novnc");
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

	// 实例属性默认值：缩放默认开、不改远端分辨率、只读由面板决定
	rfb.viewOnly = !!opts.viewOnly;
	rfb.scaleViewport = opts.scaleViewport ?? true;
	rfb.resizeSession = false;

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

	// 连接刚建立前（connecting 阶段）先上报一次，便于面板展示进度
	opts.onState?.("connecting");

	let disconnected = false;
	return {
		disconnect() {
			if (disconnected) return;
			disconnected = true;
			for (const [type, fn] of listeners) rfb.removeEventListener(type, fn);
			listeners.length = 0;
			rfb.disconnect();
		},
		setViewOnly(v: boolean) {
			rfb.viewOnly = v;
		},
		sendCredentials(creds) {
			rfb.sendCredentials(creds);
		},
		rfb,
	};
}
