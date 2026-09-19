import {
	useEffect,
	useRef,
	useState,
	type FormEvent,
} from "react";
import {
	P2P_TUNNEL_PROTOCOL_VERSION,
	type ClientInfo,
	type TunnelSessionCreated,
} from "@vcpdeck/shared";
import { useSdk } from "@/api/context";
import { createAppSocket } from "@/terminal/terminal-socket";
import { openBrowserTunnel, type BrowserTunnel } from "@/tunnel/browser-tunnel";
import { friendlyDesktopError } from "@/tunnel/errors";
import {
	createVncSession,
	preloadRfb,
	type ViewMode,
	type VncCredentialsRequest,
	type VncSession,
	type VncState,
} from "@/tunnel/vnc-session";
import {
	cropLayout,
	normalizedAspect,
	rectForPreset,
	type DisplayPreset,
} from "@/tunnel/screen-view";
import {
	classifyDisconnect,
	MAX_RETRIES,
	retryDelayMs,
} from "@/tunnel/reconnect";
import {
	createBlackStreak,
	isNearlyBlack,
	sampleCanvasPixels,
} from "@/tunnel/black-screen";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Maximize2, Minimize2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/status-chip";

type Phase = "idle" | "connecting" | "connected" | "reconnecting" | "failed";
type TunnelPath = "direct" | "relay" | "unknown";

const DEFAULT_PORT = "5900";

/** 画质三档 → noVNC qualityLevel。 */
const QUALITY_LEVELS = { low: 3, mid: 6, high: 9 } as const;
type QualityKey = keyof typeof QUALITY_LEVELS;

/** 查看模式按钮文案。 */
const VIEW_MODE_LABELS: Record<ViewMode, string> = {
	fit: "适配",
	actual: "1:1",
	scroll: "滚动",
};

/**
 * 机器「远程桌面」Tab：通过已有 P2P 隧道（目标回环 5900）连接目标机 VNC 服务端。
 * 一次点击只允许一个活动会话；固定顺序 create tunnel session → openBrowserTunnel，
 * 并在其 onChannel 回调内立即 createVncSession（保证 noVNC 在通道 open 前挂载，
 * 否则会丢失 open 后服务端立即发送的 RFB banner）；
 * 关闭时按 rfb.disconnect() → tunnel.close() → tunnels.remove() 的固定顺序清理。
 * 卸载 / 断开 / 切 Tab 都走同一条清理链；凭据经 noVNC 的 credentialsrequired 事件交互。
 */
export function DesktopPanel({
	client,
	blackSampler,
}: {
	client: ClientInfo;
	/** 注入黑屏采样源（测试用）；返回 null 表示本轮不可判定。 */
	blackSampler?: () => Uint8ClampedArray | null;
}) {
	const sdk = useSdk();
	const [port, setPort] = useState(DEFAULT_PORT);
	// 默认只读：不发送任何键鼠事件；可显式切换为可操作
	const [viewOnly, setViewOnly] = useState(true);
	const [viewMode, setViewMode] = useState<ViewMode>("fit");
	const [resizeFollow, setResizeFollow] = useState(true);
	const [quality, setQuality] = useState<QualityKey>("mid");
	const [phase, setPhase] = useState<Phase>("idle");
	const [path, setPath] = useState<TunnelPath | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [credReq, setCredReq] = useState<VncCredentialsRequest | null>(null);
	const [password, setPassword] = useState("");
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [remoteClip, setRemoteClip] = useState<string | null>(null);
	// 显示器区域裁剪：服务端送的是整块虚拟桌面，这里只改变可见区域（不重连）
	const [displayPreset, setDisplayPreset] = useState<DisplayPreset>("all");
	const [displaySplit, setDisplaySplit] = useState(0.5);
	const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null);
	const [canvasBox, setCanvasBox] = useState<{ w: number; h: number } | null>(null);
	const [retryCount, setRetryCount] = useState(0);
	const [blackWarning, setBlackWarning] = useState(false);
	const blackDismissedRef = useRef(false);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const vncHostRef = useRef<HTMLDivElement | null>(null);
	const tunnelRef = useRef<BrowserTunnel | null>(null);
	const vncRef = useRef<VncSession | null>(null);
	const sessionRef = useRef<TunnelSessionCreated | null>(null);
	const connectedRef = useRef(false);
	// 断线分类所需信号：是否为用户主动断开、共享 `/app` socket 是否掉线
	const userIntentRef = useRef(false);
	const socketLostRef = useRef(false);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const retryCountRef = useRef(0);
	const socketCleanupRef = useRef<(() => void) | null>(null);
	// 供定时器/文档事件调用的最新 connect，避免陈旧闭包
	const connectRef = useRef<() => void>(() => {});
	// 连接代际：teardown/新连接会递增，旧连接的 await 回来后不得再写回 ref（否则会把已断开的 RFB 当活跃会话，
	// noVNC 会报 "Tried changing state of a disconnected RFB object"）
	const connectGenRef = useRef(0);
	// 黑屏采样源放进 ref：避免因内联函数标识变化重建检测 effect（否则 streak 会被反复重置）
	const blackSamplerRef = useRef(blackSampler);
	blackSamplerRef.current = blackSampler;

	const p2p = client.capabilityDetails?.p2pTunnel;
	const supported =
		p2p?.available === true &&
		p2p.protocolVersion === P2P_TUNNEL_PROTOCOL_VERSION;

	// noVNC 需要浏览器安全上下文（HTTPS 或 localhost）。明文 HTTP 下 WebCrypto 与 WebCodecs
	// 被浏览器禁用：VNC 密码认证与纯 JS 解码仍可用，但加密认证（VeNCrypt / RA2）、H.264 解码
	// 与剪贴板同步会异常。这里只提示，不阻断连接。
	const insecureContext =
		typeof window !== "undefined" && window.isSecureContext === false;

	// 幂等清理：rfb → tunnel → server session。可安全重复调用。
	// 注意：这里不清 connectedRef —— noVNC 的 "disconnect" 事件是异步触发的，
	// 若在此清除会导致 handleState 把“正常手动断开”误判为连接失败。
	function teardown() {
		if (retryTimerRef.current) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		if (socketCleanupRef.current) {
			socketCleanupRef.current();
			socketCleanupRef.current = null;
		}
		connectGenRef.current += 1;
		const vnc = vncRef.current;
		vncRef.current = null;
		try {
			vnc?.disconnect();
		} catch {
			/* 忽略 */
		}
		const tunnel = tunnelRef.current;
		tunnelRef.current = null;
		void tunnel?.close();
		const sid = sessionRef.current?.sessionId;
		sessionRef.current = null;
		if (sid) void sdk.tunnels.remove(sid).catch(() => undefined);
	}

	useEffect(() => {
		// 预热 noVNC：连接时须在通道 open 前完成挂载（见 connect 的 onChannel）
		preloadRfb();
		return () => {
			teardown();
			setCredReq(null);
			// 卸载时若仍处全屏则退出，避免残留 fullscreen 元素
			if (document.fullscreenElement) void document.exitFullscreen?.();
		};
		// 仅卸载时清理；依赖保持为空避免误触发
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 同步浏览器全屏状态到 UI（全屏/还原按钮图标切换）
	useEffect(() => {
		function onChange() {
			setIsFullscreen(Boolean(document.fullscreenElement));
		}
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	// 跟踪画布盒尺寸：区域裁剪需要按真实像素把被裁区域等比放到画布内
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const update = () =>
			setCanvasBox({ w: el.clientWidth, h: el.clientHeight });
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// 帧尺寸（noVNC canvas 的 width/height 即画面像素）——远端可能因 SetDesktopSize 改变
	useEffect(() => {
		if (phase !== "connected") {
			setFrameSize(null);
			return;
		}
		const sample = () => {
			const c = containerRef.current?.querySelector("canvas");
			if (!c || c.width === 0 || c.height === 0) return;
			setFrameSize((prev) =>
				prev && prev.w === c.width && prev.h === c.height
					? prev
					: { w: c.width, h: c.height },
			);
		};
		sample();
		const timer = setInterval(sample, 2000);
		return () => clearInterval(timer);
	}, [phase]);

	// 连续全黑 → “未检测到活动显示输出”提示（低成本缩采样，不影响连接）
	useEffect(() => {
		if (phase !== "connected") {
			setBlackWarning(false);
			blackDismissedRef.current = false;
			return;
		}
		const streak = createBlackStreak();
		const scratch = document.createElement("canvas");
		scratch.width = 32;
		scratch.height = 32;
		const defaultSampler = (): Uint8ClampedArray | null => {
			const canvas = containerRef.current?.querySelector("canvas");
			if (!canvas) return null;
			return sampleCanvasPixels(canvas, scratch);
		};
		const sample = () => {
			if (blackDismissedRef.current) return;
			const bytes = (blackSamplerRef.current ?? defaultSampler)();
			if (!bytes) return; // 本轮不可判定：不计入、也不重置
			const black = isNearlyBlack(bytes);
			const tripped = streak.push(black);
			if (black) {
				if (tripped) setBlackWarning(true);
			} else {
				streak.reset();
				setBlackWarning(false);
			}
		};
		const timer = setInterval(sample, 2000);
		return () => clearInterval(timer);
	}, [phase]);

	// ICE 刚 connected 时 getStats 的 nominated pair 可能尚未就绪，轮询直至可判定；
	// 隧道已清理则停止。最多 ~3.6s，超时保持 unknown（芯片显示“路径未知”）。
	async function detectPath(): Promise<void> {
		for (let i = 0; i < 12; i += 1) {
			const t = tunnelRef.current;
			if (!t) return;
			const p = await t.selectedPath().catch(() => "unknown");
			if (p === "direct" || p === "relay") {
				setPath(p);
				return;
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		setPath("unknown");
	}

	function handleState(s: VncState) {
		if (s === "connected") {
			connectedRef.current = true;
			retryCountRef.current = 0;
			setRetryCount(0);
			setPhase("connected");
			void detectPath();
		} else if (s === "disconnected") {
			const decision = classifyDisconnect({
				failureCode: tunnelRef.current?.failureCode ?? null,
				wasConnected: connectedRef.current,
				userInitiated: userIntentRef.current,
				socketLost: socketLostRef.current,
			});
			socketLostRef.current = false;
			connectedRef.current = false;
			teardown();
			setPath(null);

			if (decision.retry) {
				scheduleRetry(decision.message ?? "隧道操作失败，请重试");
				return;
			}
			if (decision.message === null) {
				// 用户主动断开：不报错、不重连
				retryCountRef.current = 0;
				setRetryCount(0);
				setPhase("idle");
				setError(null);
				return;
			}
			// 确定性失败：报原因，不重试
			setPhase("failed");
			setError(decision.message);
		}
	}

	/** 安排一次自动重连；超过上限则报失败。 */
	function scheduleRetry(message: string): void {
		const next = retryCountRef.current + 1;
		retryCountRef.current = next;
		if (next > MAX_RETRIES) {
			setPhase("failed");
			setError("重连失败，请手动重试");
			return;
		}
		setRetryCount(next);
		setError(message);
		setPhase("reconnecting");
		retryTimerRef.current = setTimeout(() => {
			retryTimerRef.current = null;
			connectRef.current();
		}, retryDelayMs(next));
	}

	function connect() {
		if (phase === "connecting" || phase === "connected" || !supported) return;
		const targetPort = Number.parseInt(port, 10);
		if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
			setPhase("failed");
			setError("目标端口非法");
			return;
		}
		userIntentRef.current = false;
		setPhase("connecting");
		setError(null);
		setPath(null);
		setRemoteClip(null);
		connectedRef.current = false; // 新一次连接从“未连接”起步
		const gen = connectGenRef.current + 1;
		connectGenRef.current = gen;

		// 隧道 Session 绑定在共享 `/app` socket 上：socket 一断 Server 就会回收会话，
			// 因此这里记录该信号，供 handleState 分类“控制面掉线”并触发自动重连。
		const appSocket = createAppSocket();
		socketLostRef.current = false;
		const onSocketDisconnect = () => {
			socketLostRef.current = true;
		};
		appSocket.on("disconnect", onSocketDisconnect);
		socketCleanupRef.current = () =>
			appSocket.off("disconnect", onSocketDisconnect);

		void (async () => {
			try {
				const session = await sdk.tunnels.create({
					clientId: client.clientId,
					targetPort,
				});
				sessionRef.current = session;
				// noVNC 必须在 DataChannel open 之前挂上监听：通道一 open，目标 VNC 服务端
				// 会立即发送 RFB banner；若等 open 之后再加载/构造 noVNC，首帧已到达并被丢弃，
				// 握手会永远停在等待版本串（表现为一直「连接中…」+ 黑屏）。
				let vncPromise: Promise<VncSession> | null = null;
				const tunnel = await openBrowserTunnel({
					socket: createAppSocket(),
					session,
					onChannel: (channel) => {
						vncPromise = createVncSession(
							vncHostRef.current as HTMLDivElement,
							channel,
							{
								viewOnly,
								viewMode,
								resizeSession: resizeFollow,
								qualityLevel: QUALITY_LEVELS[quality],
								compressionLevel: 2,
								onState: handleState,
								onCredentials: (req) => setCredReq(req),
								onClipboard: (text) => setRemoteClip(text),
								onSecurityFailure: (reason) => {
									// 认证失败：给出具体错误并清理
									const code = "VNC_AUTH_FAILED";
									const failureCode = tunnelRef.current?.failureCode ?? null;
									teardown();
									setCredReq(null);
									setPhase("failed");
									setError(
										friendlyDesktopError(reason ? code : failureCode ?? code),
									);
								},
							},
						);
					},
				});
				tunnelRef.current = tunnel;
				if (vncPromise && connectGenRef.current === gen) {
					vncRef.current = await vncPromise;
				}
			} catch (err) {
				// 隧道建立阶段失败（含 attach 被拒、目标无监听、离线）
				const code = (err as { code?: string })?.code;
				teardown();
				if (retryCountRef.current > 0) {
					// 这是一次重连尝试的失败：继续退避重试，直到达到上限
					scheduleRetry(friendlyDesktopError(code ?? null));
					return;
				}
				setPhase("failed");
				setError(friendlyDesktopError(code ?? null));
			}
		})();
	}

	function disconnect() {
		userIntentRef.current = true;
		retryCountRef.current = 0;
		setRetryCount(0);
		teardown();
		setPhase("idle");
		setPath(null);
		setError(null);
	}

	// 全屏/还原：把画面容器设为浏览器 Fullscreen（Esc 或按钮均可退出，native 优先）
	function toggleFullscreen() {
		const el = containerRef.current;
		if (!el) return;
		if (document.fullscreenElement) {
			void document.exitFullscreen?.();
		} else {
			void el.requestFullscreen?.();
		}
	}

	// 把本地剪贴板文本发到远端（需要浏览器授权，失败只提示不中断会话）
	async function sendLocalClipboard(): Promise<void> {
		try {
			const text = await navigator.clipboard.readText();
			if (!text) {
				setError("本地剪贴板为空");
				return;
			}
			vncRef.current?.sendClipboard(text);
			setError(null);
		} catch {
			setError("读取本地剪贴板失败（浏览器可能未授权剪贴板权限）");
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		connect();
	}

	// 供定时器与文档事件使用最新的 connect（避免陈旧闭包）
	connectRef.current = connect;

	// 页面重新可见时若正处于重连等待，立即重试一次
	useEffect(() => {
		function onVisible() {
			if (document.visibilityState !== "visible") return;
			if (!retryTimerRef.current) return;
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
			connectRef.current();
		}
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	function submitCredentials(e: FormEvent) {
		e.preventDefault();
		const vnc = vncRef.current;
		setCredReq(null);
		const pw = password;
		setPassword("");
		vnc?.sendCredentials({ password: pw });
	}

	function cancelCredentials() {
		setCredReq(null);
		setPassword("");
		// 取消凭据 → 视为主动断开
		teardown();
		setPhase("idle");
		setError(null);
		setPath(null);
	}

	if (!supported) {
		return (
			<Card>
				<CardContent className="py-10 text-center text-sm text-muted-foreground">
					该 Client 不支持 P2P 隧道协议 v1
				</CardContent>
			</Card>
		);
	}

	const connecting = phase === "connecting";
	const connected = phase === "connected";

	// 区域裁剪：rect 为画面内百分比矩形；layout 把 noVNC 挂载点放大并反向平移。
	const cropRect = rectForPreset(displayPreset, displaySplit);
	const frameW = frameSize?.w ?? 100;
	const frameH = frameSize?.h ?? 100;
	const crop = cropLayout(cropRect, frameW, frameH);
	// 被裁区域在画布内的等比适配盒（保证不变形、完整显示该区域）
	const regionW = cropRect.w * frameW;
	const regionH = cropRect.h * frameH;
	const fitScale = canvasBox
		? Math.min(canvasBox.w / regionW, canvasBox.h / regionH)
		: null;
	const cropFrameStyle =
		fitScale && fitScale > 0
			? { width: `${regionW * fitScale}px`, height: `${regionH * fitScale}px` }
			: { width: "100%", height: "100%" };

	return (
		<Card>
			<CardHeader>
				<CardTitle>远程桌面</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<form
					data-testid="desktop-form"
					onSubmit={submit}
					className="flex flex-wrap items-end gap-3"
				>
					<div className="space-y-1.5">
						<Label htmlFor="desktop-port">目标端口</Label>
						<Input
							id="desktop-port"
							data-testid="desktop-port"
							value={port}
							inputMode="numeric"
							disabled={connecting || connected}
							onChange={(e) => setPort(e.target.value)}
						/>
					</div>
					{/*
						单一 type=button 切换钮：点击按状态决定连接/断开，绝不触发 form submit。
						（若用条件 type=submit，断开后重渲染为提交钮会因点击激活而再次 submit→connect 重连。）
					*/}
					<Button
						type="button"
						disabled={connecting}
						onClick={() => (connected ? disconnect() : connect())}
					>
						{connected ? "断开" : connecting ? "连接中…" : "连接"}
					</Button>
				</form>

				{connected && (
					<div className="flex flex-wrap items-center gap-4 rounded-lg border border-border/60 p-3">
						<div className="flex items-center gap-1">
							<span className="mr-1 text-xs text-muted-foreground">查看</span>
							{(Object.keys(VIEW_MODE_LABELS) as ViewMode[]).map((m) => (
								<Button
									key={m}
									type="button"
									size="sm"
									variant={viewMode === m ? "default" : "outline"}
									data-testid={`desktop-view-${m}`}
									onClick={() => {
										setViewMode(m);
										vncRef.current?.setViewMode(m);
									}}
								>
									{VIEW_MODE_LABELS[m]}
								</Button>
							))}
						</div>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								aria-label="只读"
								data-testid="desktop-viewonly"
								checked={viewOnly}
								onChange={(e) => {
									setViewOnly(e.target.checked);
									vncRef.current?.setViewOnly(e.target.checked);
								}}
							/>
							只读（当前已会发送键鼠）
						</label>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								aria-label="远端分辨率跟随"
								data-testid="desktop-resize-follow"
								checked={resizeFollow}
								onChange={(e) => {
									setResizeFollow(e.target.checked);
									vncRef.current?.setResizeSession(e.target.checked);
								}}
							/>
							远端跟随
						</label>
						<div className="flex items-center gap-2 text-sm">
							<label htmlFor="desktop-quality">画质</label>
							<select
								id="desktop-quality"
								data-testid="desktop-quality"
								className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
								value={quality}
								onChange={(e) => {
									const q = e.target.value as QualityKey;
									setQuality(q);
									vncRef.current?.setQuality(QUALITY_LEVELS[q]);
								}}
							>
								<option value="low">低</option>
								<option value="mid">中</option>
								<option value="high">高</option>
							</select>
						</div>
						<Button
							type="button"
							size="sm"
							variant="outline"
							data-testid="desktop-clipboard-send"
							onClick={() => void sendLocalClipboard()}
						>
							发送剪贴板
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							data-testid="desktop-cad"
							onClick={() => vncRef.current?.sendCtrlAltDel()}
						>
							Ctrl+Alt+Del
						</Button>
						<div className="flex items-center gap-1">
							<span className="mr-1 text-xs text-muted-foreground">显示</span>
							{(
								[
									["all", "全部"],
									["left", "左半"],
									["right", "右半"],
								] as Array<[DisplayPreset, string]>
							).map(([value, label]) => (
								<Button
									key={value}
									type="button"
									size="sm"
									variant={displayPreset === value ? "default" : "outline"}
									data-testid={`desktop-display-${value}`}
									onClick={() => setDisplayPreset(value)}
								>
									{label}
								</Button>
							))}
						</div>
					</div>
				)}

				{remoteClip !== null && (
					<div className="space-y-1">
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">远端剪贴板</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setRemoteClip(null)}
							>
								清除
							</Button>
						</div>
						<pre
							data-testid="desktop-clipboard-recv"
							className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 p-2 text-xs"
						>
							{remoteClip.length > 200 ? `${remoteClip.slice(0, 200)}…` : remoteClip}
						</pre>
					</div>
				)}

				{insecureContext && (
					<p
						data-testid="desktop-insecure-context"
						className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300"
					>
						当前页面不是安全上下文（明文 HTTP）：noVNC 依赖的 WebCrypto 与 WebCodecs
						被浏览器禁用，加密认证（VeNCrypt / RA2）、H.264 解码与剪贴板同步不可用，
						连接可能异常。请改用 HTTPS 或 localhost 入口访问驾驶台。
					</p>
				)}

				{/* noVNC 画布容器：连接前后都渲染，供 RFB 挂载；同时也是浏览器全屏目标。
				    连接后的控制（状态芯片 + 全屏按钮）以悬浮层放进容器内 —— 全屏时
				    Fullscreen API 只显示该元素及其后代，这样按钮仍可见可点（Esc 亦可退出）。
				    noVNC 内部 _screen 为 100%×100% 并挂 ResizeObserver，容器有确定高度即自适应缩放。 */}
				<div
					data-testid="desktop-canvas"
					ref={containerRef}
					className={"desktop-canvas relative flex h-[70dvh] min-h-64 w-full items-center justify-center overflow-hidden border border-border bg-black"}
				>
					{!connected && phase !== "connecting" && (
						<span className="text-sm text-muted-foreground">
							连接后可在此查看远程桌面画面
						</span>
					)}

					{/* 裁剪包裹层：只显示 cropRect 区域；切换区域不重连、不重建会话 */}
					<div className="absolute inset-0 flex items-center justify-center">
						<div
							data-testid="desktop-crop-frame"
							data-crop-aspect={normalizedAspect(cropRect)}
							className="relative overflow-hidden"
							style={cropFrameStyle}
						>
							<div
								ref={vncHostRef}
								className="desktop-vnc-host"
								style={crop.inner}
							/>
						</div>
					</div>

					{connected && (
						<div className="absolute right-2 top-2 z-10 flex flex-wrap items-center gap-1 rounded-md border border-border/60 bg-black/60 p-1 backdrop-blur-sm">
							<StatusChip
								label={
									path === "direct"
										? "P2P 直连"
										: path === "relay"
											? "TURN 中继"
											: "路径未知"
								}
								tone={path === "unknown" ? "warning" : "success"}
							/>
							{viewOnly && <StatusChip label="只读" tone="success" />}
							<Button
								type="button"
								size="icon"
								variant="ghost"
								aria-label={isFullscreen ? "退出全屏" : "全屏"}
								onClick={toggleFullscreen}
							>
								{isFullscreen ? (
									<Minimize2 className="size-4" />
								) : (
									<Maximize2 className="size-4" />
								)}
							</Button>
						</div>
					)}
				</div>

				{blackWarning && (
					<p
						data-testid="desktop-black-warning"
						className="flex items-start justify-between gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300"
					>
						<span>
							未检测到活动显示输出（该机器可能未接显示器且无虚拟显示器驱动）。可插 HDMI
							假负载或安装虚拟显示器驱动后重连。
						</span>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								blackDismissedRef.current = true;
								setBlackWarning(false);
							}}
						>
							不再提示
						</Button>
					</p>
				)}

				{phase === "reconnecting" && (
					<p
						data-testid="desktop-reconnect"
						className="text-sm text-amber-300"
					>
						第 {retryCount} 次重连中…
					</p>
				)}

				{error && (
					<p data-testid="desktop-error" className="text-sm text-destructive">
						{error}
					</p>
				)}

				<p className="text-xs text-muted-foreground">
					画面经 P2P 隧道回环到目标机 5900；目标机需已运行 VNC 服务端，且仅监听 127.0.0.1。
				</p>
			</CardContent>

			<Dialog open={credReq !== null} onOpenChange={(open) => !open && cancelCredentials()}>
				<DialogContent>
					<DialogTitle>VNC 凭据</DialogTitle>
					<DialogDescription>
						远程桌面服务端要求认证。密码仅在本机内存中短暂使用，不保存。
					</DialogDescription>
					<form
						data-testid="credentials-form"
						onSubmit={submitCredentials}
						className="space-y-4"
					>
						<div className="space-y-1.5">
							<Label htmlFor="desktop-password">密码</Label>
							<Input
								id="desktop-password"
								data-testid="desktop-password"
								type="password"
								autoFocus
								value={password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						</div>
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								onClick={cancelCredentials}
							>
								取消
							</Button>
							<Button type="submit">连接</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
