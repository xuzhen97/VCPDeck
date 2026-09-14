import {
	parseRemoteDesktopHostControlMessage,
	type ClientInfo,
	type RemoteDesktopClipboardMode,
	type RemoteDesktopDisplayInfo,
	type RemoteDesktopRole,
} from "@vcpdeck/shared";
import { Monitor, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusChip } from "@/components/status-chip";
import {
	createRemoteDesktopPeer,
	type RemoteDesktopChannels,
	type RemoteDesktopConnectionState,
	type RemoteDesktopPeer,
} from "./remote-desktop-peer";
import type { RemoteDesktopConnectionStats } from "./remote-desktop-stats";
import { createRemoteDesktopAppSocket, createRemoteDesktopSocket } from "./remote-desktop-socket";
import {
	createRemoteInput,
	type RemoteInput,
	type RemoteInputLayout,
	type RemoteInputOptions,
} from "./remote-input";
import {
	createRemoteDesktopClipboard,
	type RemoteDesktopClipboard,
} from "./remote-clipboard";

export interface RemoteDesktopViewProps {
	client: ClientInfo;
	sessionId: string;
	onClose?: () => void;
	peerFactory?: () => { peer: RemoteDesktopPeer; dispose: () => void };
	inputFactory?: (options: RemoteInputOptions) => RemoteInput;
	getLayout?: () => RemoteInputLayout;
	displays?: RemoteDesktopDisplayInfo[];
	selectedDisplayId?: string | null;
	clipboardMode?: RemoteDesktopClipboardMode;
	clipboardFactory?: (options: Parameters<typeof createRemoteDesktopClipboard>[0]) => RemoteDesktopClipboard;
	readBrowserClipboard?: () => Promise<string>;
	/** 仅在 Host 真实探测通过 Secure Attention 能力时才展示 Ctrl+Alt+Del 动作。 */
	secureAttentionSupported?: boolean;
}

interface ViewState {
	phase: "connecting" | "connected" | "error" | "closed";
	role: RemoteDesktopRole | null;
	error: string | null;
}

function createDefaultPeer() {
	const socket = createRemoteDesktopSocket(createRemoteDesktopAppSocket());
	return {
		peer: createRemoteDesktopPeer(socket),
		dispose: () => socket.dispose(),
	};
}

/** 远程桌面数据面视图：视频仅挂载到浏览器 video，输入只由 Operator 发送。 */
export function RemoteDesktopView({
	client,
	sessionId,
	onClose,
	peerFactory = createDefaultPeer,
	inputFactory = createRemoteInput,
	getLayout,
	displays: initialDisplays = [],
	selectedDisplayId: initialSelectedDisplayId = null,
	clipboardMode = "off",
	clipboardFactory = createRemoteDesktopClipboard,
	secureAttentionSupported = false,
	readBrowserClipboard = async () => {
		if (typeof navigator === "undefined" || !navigator.clipboard) {
			throw new Error("浏览器剪贴板不可用");
		}
		return navigator.clipboard.readText();
	},
}: RemoteDesktopViewProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const layoutRef = useRef<RemoteInputLayout>({ generation: 0, width: 1, height: 1 });
	const [displays, setDisplays] = useState<RemoteDesktopDisplayInfo[]>(initialDisplays);
	const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(initialSelectedDisplayId);
	const getLayoutRef = useRef(getLayout);
	getLayoutRef.current = getLayout;
	// 工厂函数只通过 ref 读取：若把它们放进 effect 依赖，父组件每次用行内函数重新渲染
	// 都会拆掉并重建整个 WebRTC 会话（丢帧、丢通道、重新握手）。
	const peerFactoryRef = useRef(peerFactory);
	peerFactoryRef.current = peerFactory;
	const inputFactoryRef = useRef(inputFactory);
	inputFactoryRef.current = inputFactory;
	const clipboardFactoryRef = useRef(clipboardFactory);
	clipboardFactoryRef.current = clipboardFactory;
	const secureAttentionSupportedRef = useRef(secureAttentionSupported);
	secureAttentionSupportedRef.current = secureAttentionSupported;
	const peerRef = useRef<RemoteDesktopPeer | null>(null);
	const inputRef = useRef<RemoteInput | null>(null);
	const clipboardRef = useRef<RemoteDesktopClipboard | null>(null);
	const [remoteClipboardText, setRemoteClipboardText] = useState<string | null>(null);
	const [clipboardActionError, setClipboardActionError] = useState<string | null>(null);
	const roleRef = useRef<RemoteDesktopRole | null>(null);
	// 画布焦点状态：输入控制器可能晚于焦点创建，创建时要补上抢键开关。
	const canvasFocusedRef = useRef(false);
	const [view, setView] = useState<ViewState>({ phase: "connecting", role: null, error: null });
	// 数据面自身的连接状态；与 `view.phase`（视频是否就绪）分开，
	// 重连时画面可能仍在但输入与数据面已经不可用。
	const [connectionState, setConnectionState] = useState<RemoteDesktopConnectionState>({
		phase: "connecting",
		attempt: 0,
		deadline: null,
		code: null,
	});
	const [connectionStats, setConnectionStats] = useState<RemoteDesktopConnectionStats | null>(null);

	const selectDisplay = useCallback((displayId: string) => {
		setClipboardActionError(null);
		try {
			inputRef.current?.freeze();
			peerRef.current?.sendControl({ type: "display-select", displayId });
			setSelectedDisplayId(displayId);
		} catch {
			setClipboardActionError("无法切换显示器");
		}
	}, []);

	const sendBrowserClipboard = useCallback(async () => {
		setClipboardActionError(null);
		try {
			const text = await readBrowserClipboard();
			clipboardRef.current?.sendBrowserText(text);
		} catch {
			setClipboardActionError("无法发送浏览器剪贴板");
		}
	}, [readBrowserClipboard]);

	// 恢复失败后可以就地重试；不需要用户关闭面板重建整个 Session。
	const retryConnection = useCallback(async () => {
		setClipboardActionError(null);
		try {
			await peerRef.current?.retry();
		} catch {
			setClipboardActionError("重试失败");
		}
	}, []);

	const close = useCallback(async () => {
		inputRef.current?.dispose();
		inputRef.current = null;
		clipboardRef.current = null;
		setRemoteClipboardText(null);
		setClipboardActionError(null);
		await peerRef.current?.close();
		peerRef.current = null;
		if (videoRef.current) videoRef.current.srcObject = null;
		setView((current) => ({ ...current, phase: "closed" }));
		onClose?.();
	}, [onClose]);

	useEffect(() => {
		let disposed = false;
		const runtime = peerFactoryRef.current();
		const peer = runtime.peer;
		peerRef.current = peer;
		const removeTrack = peer.onTrack((event) => {
			if (!videoRef.current || disposed) return;
			const [stream] = event.streams;
			if (stream) videoRef.current.srcObject = stream;
			void videoRef.current.play().catch(() => undefined);
			setView((current) => ({ ...current, phase: "connected" }));
		});
		const removeControlMessages = peer.onControlMessage((message) => {			try {
				clipboardRef.current?.handleMessage(message);
				const layout = parseRemoteDesktopHostControlMessage(message);
				setDisplays((current) => {
					const existing = current.find((display) => display.id === layout.displayId);
					if (!existing) return current;
					return current.map((display) => display.id === layout.displayId
						? { ...display, width: layout.width, height: layout.height }
						: display);
				});
				inputRef.current?.freeze();
				layoutRef.current = { ...layoutRef.current, generation: layout.layoutGeneration, width: layout.width, height: layout.height };
				setSelectedDisplayId(layout.displayId);
				peerRef.current?.sendControl({ type: "layout-confirm", layoutGeneration: layout.layoutGeneration });
				// Host 已在 layout-update 中完成冻结与 generation 切换，确认后恢复 Browser 输入。
				inputRef.current?.resumeLayout(layout.layoutGeneration);
			} catch {
				// Control messages unrelated to host layout are handled by their own controller.
			}
		});
		const removeState = peer.onStateChange(setConnectionState);
		let channels: RemoteDesktopChannels = { control: null, pointer: null };
		let initializedControl: RTCDataChannel | null = null;
		let initializedPointer: RTCDataChannel | null = null;
		const initializeChannels = () => {
			// 数据面消失（重连、断开）时必须拆掉输入与剪贴板控制器：
			// 否则会留下监听已关闭通道的旧控制器，键盘监听也不会释放。
			if (!channels.control) {
				inputRef.current?.dispose();
				inputRef.current = null;
				initializedControl = null;
				initializedPointer = null;
				clipboardRef.current = null;
				return;
			}
			if (disposed || !roleRef.current) return;
			if (initializedControl !== channels.control) {
				clipboardRef.current = clipboardFactoryRef.current({
					channel: channels.control,
					mode: clipboardMode,
					role: roleRef.current,
					onRemoteText: setRemoteClipboardText,
				});
				initializedControl = channels.control;
				setRemoteClipboardText(null);
			}
			if (!channels.pointer || initializedPointer === channels.pointer) return;
			inputRef.current?.dispose();
			inputRef.current = inputFactoryRef.current({
				control: channels.control,
				pointer: channels.pointer,
				role: roleRef.current,
				getLayout: () => getLayoutRef.current?.() ?? layoutRef.current,
				// 只有能力真实可用时才把 Ctrl+Alt+Del 组合转为正式请求；
				// 否则仅就地拦下，避免向不支持的 Host 发送无效动作。
				onSecureAttention: secureAttentionSupportedRef.current
					? () => inputRef.current?.secureAttention()
					: undefined,
			});
			initializedPointer = channels.pointer;
		};
		const removeChannels = peer.onChannels((nextChannels) => {
			channels = nextChannels;
			initializeChannels();
		});
		void peer
			.connect(sessionId)
			.then((attachment) => {
				if (disposed) return;
				roleRef.current = attachment.role;
				setView({ phase: "connecting", role: attachment.role, error: null });
				initializeChannels();
			})
			.catch(() => {
				if (!disposed) setView({ phase: "error", role: roleRef.current, error: "远程桌面连接失败" });
			});
		return () => {
			disposed = true;
			removeTrack();
			removeControlMessages();
			removeState();
			removeChannels();
			inputRef.current?.dispose();
			inputRef.current = null;
			clipboardRef.current = null;
			setRemoteClipboardText(null);
			setClipboardActionError(null);
			void peer.close();
			runtime.dispose();
		};
	}, [clipboardMode, sessionId]);

	// 连接建立后定期刷新真实路径（直连/中继）与延迟；断开时清空，不显示陈旧数据。
	useEffect(() => {
		if (connectionState.phase !== "connected") {
			setConnectionStats(null);
			return;
		}
		const peer = peerRef.current;
		if (!peer) return;
		let cancelled = false;
		const refresh = async () => {
			const next = await peer.stats();
			if (!cancelled) setConnectionStats(next);
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 5_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [connectionState.phase]);

	// 显示器列表以 Server/Host 上报的拓扑为权威。若 layout-update 指向列表外的
	// 显示器，只补一个轻量选项让用户看到当前目标，绝不伪造
	// physical/virtual/primary 等拓扑字段。
	const selectOptions = (
		selectedDisplayId && !displays.some((display) => display.id === selectedDisplayId)
			? [
					...displays.map((display) => ({ id: display.id, label: display.label })),
					{ id: selectedDisplayId, label: selectedDisplayId },
				]
			: displays.map((display) => ({ id: display.id, label: display.label }))
	);

	return (
		<Card className="flex min-h-[28rem] flex-col overflow-hidden" data-testid="remote-desktop-view">
			<CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-border/60">
				<div className="flex min-w-0 items-center gap-3">
					<Monitor className="size-5 text-primary" />
					<div>
						<CardTitle className="text-base">远程桌面 · {client.name ?? client.hostname}</CardTitle>
						<p className="mt-1 text-xs text-muted-foreground">
							Session {sessionId}
							{remoteClipboardText !== null ? " · 已收到远端剪贴板" : ""}
						</p>
						{remoteClipboardText !== null && (
							<button
								type="button"
								className="mt-1 block max-w-64 truncate text-left text-xs text-muted-foreground underline"
								onClick={() => void clipboardRef.current?.copyRemoteText()}
							>
								远端：{remoteClipboardText}
							</button>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2">
					{view.role === "operator" && secureAttentionSupported && (
						<Button
							size="sm"
							variant="outline"
							disabled={view.phase !== "connected"}
							onClick={() => inputRef.current?.secureAttention()}
						>
							Ctrl+Alt+Del
						</Button>
					)}
					{view.role === "operator" && (clipboardMode === "browser-to-remote" || clipboardMode === "bidirectional") && (
						<Button size="sm" variant="outline" onClick={() => void sendBrowserClipboard()}>
							发送浏览器剪贴板
						</Button>
					)}
					{view.role === "operator" && selectOptions.length > 0 && (
						<select
							aria-label="选择显示器"
							value={selectedDisplayId ?? selectOptions[0]?.id ?? ""}
							onChange={(event) => selectDisplay(event.target.value)}
							disabled={view.phase !== "connected"}
							className="h-9 rounded-lg border border-border bg-background px-2 text-xs"
						>
							{selectOptions.map((display) => <option key={display.id} value={display.id}>{display.label}</option>)}
						</select>
					)}
					<StatusChip
						label={
							connectionState.phase === "reconnecting"
								? `恢复中 ${connectionState.attempt}`
								: connectionState.phase === "failed"
									? "连接已中断"
									: view.phase === "connected"
										? "已连接"
										: view.phase === "error"
											? "连接失败"
											: "连接中"
						}
						tone={
							connectionState.phase === "failed" || view.phase === "error"
								? "danger"
								: connectionState.phase === "connected" || view.phase === "connected"
									? "success"
									: "neutral"
						}
					/>
					{connectionStats && connectionStats.path !== "unknown" && (
						<StatusChip
							label={connectionStats.path === "relay" ? "中继" : "直连"}
							tone={connectionStats.path === "relay" ? "warning" : "success"}
						/>
					)}
					{view.role && <StatusChip label={view.role === "operator" ? "操作员" : "观察者"} />}
					<Button aria-label="关闭远程桌面" size="icon" variant="ghost" onClick={() => void close()}>
						<X className="size-4" />
					</Button>
				</div>
				{clipboardActionError && <p role="alert" className="text-xs text-destructive">{clipboardActionError}</p>}
			</CardHeader>
			<CardContent className="flex min-h-0 flex-1 flex-col p-3">
				{connectionState.phase === "reconnecting" && (
					<p role="status" className="mb-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
						正在恢复连接（第 {connectionState.attempt} 次尝试）…恢复前输入保持停用。
					</p>
				)}
				{connectionState.phase === "failed" && (
					<div
						role="alert"
						className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-destructive/60 px-3 py-2 text-xs text-destructive"
					>
						<span>连接已中断：恢复窗口已结束，可以就地重试。</span>
						<Button size="sm" variant="outline" onClick={() => void retryConnection()}>
							<RotateCcw className="size-3" /> 重试
						</Button>
					</div>
				)}
				{view.error ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
						<p className="text-sm text-destructive">{view.error}</p>
						<Button variant="outline" onClick={() => window.location.reload()}>
							<RotateCcw className="size-4" /> 重试
						</Button>
					</div>
				) : (
						<video
							ref={videoRef}
							aria-label="远程桌面画面"
							className="min-h-0 w-full flex-1 rounded-lg bg-black object-contain"
							tabIndex={0}
							onFocus={() => {
								canvasFocusedRef.current = true;
								inputRef.current?.setCaptureActive(true);
							}}
							onBlur={() => {
								canvasFocusedRef.current = false;
								// 失焦时必须停止抢键并释放按住的键，否则会卡死在远端。
								inputRef.current?.setCaptureActive(false);
								inputRef.current?.releaseAll();
							}}
						onLoadedMetadata={(event) => {
							const video = event.currentTarget;
							const nextLayout = {
								...layoutRef.current,
								width: video.videoWidth || video.clientWidth,
								height: video.videoHeight || video.clientHeight,
							};
							layoutRef.current = nextLayout;
						}}
						onKeyDown={(event) => {
							if (!inputRef.current) return;
							event.preventDefault();
							inputRef.current.keyDown(event.nativeEvent);
						}}
						onKeyUp={(event) => {
							if (!inputRef.current) return;
							event.preventDefault();
							inputRef.current.keyUp(event.nativeEvent);
						}}
						onMouseDown={(event) => {
							inputRef.current?.button(event.nativeEvent, true);
						}}
						onMouseUp={(event) => {
							inputRef.current?.button(event.nativeEvent, false);
						}}
						onMouseMove={(event) => {
							inputRef.current?.pointerMove(event.nativeEvent, event.currentTarget.getBoundingClientRect());
						}}
						// 指针捕获单独用 pointer 事件：它提供 pointerId，而 mouse 事件不保证有。
						// 它只做捕获/释放，不转发输入，避免与 mouse 事件重复下发。
						onPointerDown={(event) => {
							event.currentTarget.setPointerCapture?.(event.pointerId);
						}}
						onPointerUp={(event) => {
							event.currentTarget.releasePointerCapture?.(event.pointerId);
						}}
						onLostPointerCapture={() => {
							// 丢失捕获（系统弹窗、拖出窗口）时必须释放按键，不能留下拖拽状态。
							inputRef.current?.releaseAll();
						}}
						onWheel={(event) => {
							if (!inputRef.current) return;
							event.preventDefault();
							inputRef.current.wheel(event.nativeEvent);
						}}
						muted
						playsInline
					/>
				)}
			</CardContent>
		</Card>
	);
}
