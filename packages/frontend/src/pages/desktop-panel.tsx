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
	type VncCredentialsRequest,
	type VncSession,
	type VncState,
} from "@/tunnel/vnc-session";
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

type Phase = "idle" | "connecting" | "connected" | "failed";
type TunnelPath = "direct" | "relay" | "unknown";

const DEFAULT_PORT = "5900";

/**
 * 机器「远程桌面」Tab：通过已有 P2P 隧道（目标回环 5900）连接目标机 VNC 服务端。
 * 一次点击只允许一个活动会话；固定顺序 create tunnel session → openBrowserTunnel，
 * 并在其 onChannel 回调内立即 createVncSession（保证 noVNC 在通道 open 前挂载，
 * 否则会丢失 open 后服务端立即发送的 RFB banner）；
 * 关闭时按 rfb.disconnect() → tunnel.close() → tunnels.remove() 的固定顺序清理。
 * 卸载 / 断开 / 切 Tab 都走同一条清理链；凭据经 noVNC 的 credentialsrequired 事件交互。
 */
export function DesktopPanel({ client }: { client: ClientInfo }) {
	const sdk = useSdk();
	const [port, setPort] = useState(DEFAULT_PORT);
	const [viewOnly, setViewOnly] = useState(false);
	const [phase, setPhase] = useState<Phase>("idle");
	const [path, setPath] = useState<TunnelPath | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [credReq, setCredReq] = useState<VncCredentialsRequest | null>(null);
	const [password, setPassword] = useState("");
	const [isFullscreen, setIsFullscreen] = useState(false);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const tunnelRef = useRef<BrowserTunnel | null>(null);
	const vncRef = useRef<VncSession | null>(null);
	const sessionRef = useRef<TunnelSessionCreated | null>(null);
	const connectedRef = useRef(false);

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
			setPhase("connected");
			void detectPath();
		} else if (s === "disconnected") {
			const failureCode = tunnelRef.current?.failureCode ?? null;
			teardown();
			if (!connectedRef.current) {
				// 连接建立前断开（握手失败 / 目标无监听）→ 报具体错误
				setPhase("failed");
				setError(friendlyDesktopError(failureCode));
			} else {
				// 已连接后正常断开 → 静默回到空闲
				setPhase("idle");
				setError(null);
			}
			setPath(null);
		}
	}

	function connect() {
		if (phase === "connecting" || phase === "connected" || !supported) return;
		const targetPort = Number.parseInt(port, 10);
		if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
			setPhase("failed");
			setError("目标端口非法");
			return;
		}
		setPhase("connecting");
		setError(null);
		setPath(null);
		connectedRef.current = false; // 新一次连接从“未连接”起步

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
							containerRef.current as HTMLDivElement,
							channel,
							{
								viewOnly,
								onState: handleState,
								onCredentials: (req) => setCredReq(req),
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
				if (vncPromise) vncRef.current = await vncPromise;
			} catch (err) {
				// 隧道建立阶段失败（含 attach 被拒、目标无监听）
				const code = (err as { code?: string })?.code;
				teardown();
				setPhase("failed");
				setError(friendlyDesktopError(code ?? null));
			}
		})();
	}

	function disconnect() {
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

	function submit(e: FormEvent) {
		e.preventDefault();
		connect();
	}

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
					<label className="flex items-center gap-2 pb-2 text-sm">
						<input
							type="checkbox"
							aria-label="只读模式"
							disabled={connecting || connected}
							checked={viewOnly}
							onChange={(e) => setViewOnly(e.target.checked)}
						/>
						只读模式
					</label>
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
					className={`desktop-canvas relative flex w-full items-center justify-center overflow-hidden border border-border bg-black ${connected ? "h-[60vh] min-h-64" : "min-h-64"}`}
				>
					{!connected && phase !== "connecting" && (
						<span className="text-sm text-muted-foreground">
							连接后可在此查看远程桌面画面
						</span>
					)}

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
