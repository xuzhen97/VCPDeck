import type { ClientInfo, RemoteDesktopBrowserAttached } from "@vcpdeck/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoteDesktopView } from "./remote-desktop-view";
import type { RemoteDesktopConnectionState, RemoteDesktopPeer } from "./remote-desktop-peer";
import type { RemoteInput, RemoteInputOptions } from "./remote-input";
import type { RemoteDesktopClipboard } from "./remote-clipboard";

const attachedStub: RemoteDesktopBrowserAttached = {
	sessionId: "s1",
	attachmentId: "a1",
	role: "operator",
	reconnectToken: "token",
	controlProtectedUntil: null,
	iceConfig: { policy: "p2p-only", iceServers: [], expiresAt: null },
};

const client: ClientInfo = {
	clientId: "c1",
	name: "workstation",
	hostname: "workstation",
	os: "win32",
	cpuModel: "CPU",
	totalMemMB: 1024,
	disks: [],
	clientVersion: "1.0.0",
	capabilities: ["remote-desktop"],
	capabilityDetails: {},
	online: true,
	cpuPercent: null,
	memPercent: null,
	lastHeartbeatAt: null,
};

describe("RemoteDesktopView", () => {
	it("forwards keyboard, pointer and button events from the video surface", async () => {
		let channelListener: ((channels: { control: RTCDataChannel | null; pointer: RTCDataChannel | null }) => void) | undefined;
		const input: RemoteInput = {
			keyDown: vi.fn(),
			keyUp: vi.fn(),
			button: vi.fn(),
			wheel: vi.fn(),
			pointerMove: vi.fn(),
			freeze: vi.fn(),
			resumeLayout: vi.fn(),
			releaseAll: vi.fn(),
			dispose: vi.fn(),
			secureAttention: vi.fn(),
			pressedButtons: () => [],
			setCaptureActive: vi.fn(),
		};
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1",
				attachmentId: "a1",
				role: "operator" as const,
				reconnectToken: "token",
				controlProtectedUntil: null,
				iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: (callback) => {
				channelListener = callback;
				return () => {
					channelListener = undefined;
				};
			},
			onTrack: () => () => undefined,
			onControlMessage: () => () => undefined,
			sendControl: vi.fn(),
			sendPointer: vi.fn(),
			close: vi.fn(async () => undefined),
			state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
			onStateChange: () => () => undefined,
			stats: async () => null,
			retry: async () => attachedStub,
		};
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
				inputFactory={() => input}
				getLayout={() => ({ generation: 7, width: 1920, height: 1080 })}
				clipboardFactory={() => ({
					sendBrowserText: vi.fn(),
					handleMessage: vi.fn(() => false),
					copyRemoteText: vi.fn(async () => undefined),
					remoteText: () => null,
				} satisfies RemoteDesktopClipboard)}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		channelListener?.({ control: {} as RTCDataChannel, pointer: {} as RTCDataChannel });
		const video = screen.getByLabelText("远程桌面画面");
		fireEvent.keyDown(video, { code: "KeyA", keyCode: 65 });
		fireEvent.keyUp(video, { code: "KeyA", keyCode: 65 });
		fireEvent.mouseMove(video, { clientX: 10, clientY: 20 });
		fireEvent.mouseDown(video, { button: 0 });
		fireEvent.mouseUp(video, { button: 0 });
		fireEvent.wheel(video, { deltaX: 4, deltaY: -12 });
		expect(input.keyDown).toHaveBeenCalledOnce();
		expect(input.keyUp).toHaveBeenCalledOnce();
		expect(input.pointerMove).toHaveBeenCalledOnce();
		expect(input.button).toHaveBeenNthCalledWith(1, expect.objectContaining({ button: 0 }), true);
		expect(input.button).toHaveBeenNthCalledWith(2, expect.objectContaining({ button: 0 }), false);
		expect(input.wheel).toHaveBeenCalledWith(expect.objectContaining({ deltaX: 4, deltaY: -12 }));
	});

	it("sends the browser clipboard only after an explicit operator action", async () => {
		let channelListener: ((channels: { control: RTCDataChannel | null; pointer: RTCDataChannel | null }) => void) | undefined;
		const sendBrowserText = vi.fn();
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1",
				attachmentId: "a1",
				role: "operator" as const,
				reconnectToken: "token",
				controlProtectedUntil: null,
				iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: (callback) => {
				channelListener = callback;
				return () => {
					channelListener = undefined;
				};
			},
			onTrack: () => () => undefined,
			onControlMessage: () => () => undefined,
			sendControl: vi.fn(),
			sendPointer: vi.fn(),
			close: vi.fn(async () => undefined),
			state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
			onStateChange: () => () => undefined,
			stats: async () => null,
			retry: async () => attachedStub,
		};
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
				clipboardMode="browser-to-remote"
				readBrowserClipboard={vi.fn(async () => "browser text")}
				clipboardFactory={() => ({
					sendBrowserText,
					handleMessage: () => false,
					copyRemoteText: vi.fn(async () => undefined),
					remoteText: () => null,
				})}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		channelListener?.({ control: {} as RTCDataChannel, pointer: {} as RTCDataChannel });
		await screen.findByRole("button", { name: "发送浏览器剪贴板" }).then((button) => button.click());
		expect(sendBrowserText).toHaveBeenCalledWith("browser text");
	});

	it("does not let an early control message race hide clipboard initialization", async () => {
		let controlMessageListener: ((message: unknown) => void) | undefined;
		let channelListener: ((channels: { control: RTCDataChannel | null; pointer: RTCDataChannel | null }) => void) | undefined;
		const onRemoteText = vi.fn();
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1",
				attachmentId: "a1",
				role: "operator" as const,
				reconnectToken: "token",
				controlProtectedUntil: null,
				iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: (callback) => {
				channelListener = callback;
				return () => {
					channelListener = undefined;
				};
			},
			onTrack: () => () => undefined,
			onControlMessage: (callback) => {
				controlMessageListener = callback;
				return () => {
					controlMessageListener = undefined;
				};
			},
			sendControl: vi.fn(),
			sendPointer: vi.fn(),
			close: vi.fn(async () => undefined),
			state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
			onStateChange: () => () => undefined,
			stats: async () => null,
			retry: async () => attachedStub,
		};
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
				clipboardMode="bidirectional"
				clipboardFactory={(options) => ({
					sendBrowserText: vi.fn(),
					handleMessage: (message) => {
						if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "remote-to-browser") return false;
						options.onRemoteText?.("early");
						onRemoteText("early");
						return true;
					},
					copyRemoteText: vi.fn(async () => undefined),
					remoteText: () => "early",
				})}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		controlMessageListener?.({ type: "remote-to-browser", text: "early" });
		expect(onRemoteText).not.toHaveBeenCalled();
		channelListener?.({ control: {} as RTCDataChannel, pointer: {} as RTCDataChannel });
		controlMessageListener?.({ type: "remote-to-browser", text: "early" });
		expect(onRemoteText).toHaveBeenCalledWith("early");
	});

	it("shows received clipboard text and exposes an explicit copy action", async () => {
		let controlMessageListener: ((message: unknown) => void) | undefined;
		let channelListener: ((channels: { control: RTCDataChannel | null; pointer: RTCDataChannel | null }) => void) | undefined;
		const copyRemoteText = vi.fn(async () => undefined);
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1",
				attachmentId: "a1",
				role: "operator" as const,
				reconnectToken: "token",
				controlProtectedUntil: null,
				iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: (callback) => {
				channelListener = callback;
				return () => {
					channelListener = undefined;
				};
			},
			onTrack: () => () => undefined,
			onControlMessage: (callback) => {
				controlMessageListener = callback;
				return () => {
					controlMessageListener = undefined;
				};
			},
			sendControl: vi.fn(),
			sendPointer: vi.fn(),
			close: vi.fn(async () => undefined),
			state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
			onStateChange: () => () => undefined,
			stats: async () => null,
			retry: async () => attachedStub,
		};
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
				clipboardMode="bidirectional"
				clipboardFactory={(options) => ({
					sendBrowserText: vi.fn(),
					handleMessage: (message) => {
						if (message === null) return false;
						options.onRemoteText?.("remote");
						return true;
					},
					copyRemoteText,
					remoteText: () => "remote",
				})}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		channelListener?.({ control: {} as RTCDataChannel, pointer: {} as RTCDataChannel });
		controlMessageListener?.({ type: "remote-to-browser", text: "remote" });
		await waitFor(() => expect(screen.getByRole("button", { name: "远端：remote" })).toBeVisible());
		await screen.getByRole("button", { name: "远端：remote" }).click();
		expect(copyRemoteText).toHaveBeenCalledOnce();
	});

	it("renders display selection after a host layout update and freezes input during the update", async () => {
		let controlMessageListener: ((message: unknown) => void) | undefined;
		let channelListener: ((channels: { control: RTCDataChannel | null; pointer: RTCDataChannel | null }) => void) | undefined;
		const input: RemoteInput = {
			keyDown: vi.fn(), keyUp: vi.fn(), button: vi.fn(), wheel: vi.fn(), pointerMove: vi.fn(),
			releaseAll: vi.fn(), freeze: vi.fn(), resumeLayout: vi.fn(), dispose: vi.fn(),
			secureAttention: vi.fn(),
			pressedButtons: () => [],
			setCaptureActive: vi.fn(),
		};
		const createInput = vi.fn((_options: RemoteInputOptions) => input);
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1", attachmentId: "a1", role: "operator" as const, reconnectToken: "token",
				controlProtectedUntil: null, iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: (callback) => { channelListener = callback; return () => { channelListener = undefined; }; },
			onTrack: () => () => undefined,
			onControlMessage: (callback) => { controlMessageListener = callback; return () => { controlMessageListener = undefined; }; },
			sendControl: vi.fn(), sendPointer: vi.fn(), close: vi.fn(async () => undefined),
state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
onStateChange: () => () => undefined,
stats: async () => null,
retry: async () => attachedStub,
		};
		render(<RemoteDesktopView client={client} sessionId="s1" displays={[{ id: "display-1", label: "主屏幕", width: 1280, height: 720, physical: true, virtual: false, primary: true, rotation: 0, scalePercent: 100 }]} peerFactory={() => ({ peer, dispose: vi.fn() })} inputFactory={(options) => { createInput(options); return input; }} />);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		await waitFor(() => expect(channelListener).toBeDefined());
		channelListener?.({ control: {} as RTCDataChannel, pointer: {} as RTCDataChannel });
		await waitFor(() => expect(createInput).toHaveBeenCalled());
		controlMessageListener?.({ type: "layout-update", layoutGeneration: 8, displayId: "display-2", width: 1920, height: 1080 });
		await waitFor(() => expect(input.freeze).toHaveBeenCalled());
		expect(input.freeze).toHaveBeenCalledOnce();
		expect(input.resumeLayout).toHaveBeenCalledWith(8);
		expect(await screen.findByRole("combobox", { name: "选择显示器" })).toHaveValue("display-2");
	});

	it("renders the video surface and keeps the data plane behind injectable WebRTC boundaries", () => {
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1",
				attachmentId: "a1",
				role: "viewer" as const,
				reconnectToken: "token",
				controlProtectedUntil: null,
				iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: () => () => undefined,
			onTrack: () => () => undefined,
			onControlMessage: () => () => undefined,
			sendControl: vi.fn(),
			sendPointer: vi.fn(),
			close: vi.fn(async () => undefined),
			state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
			onStateChange: () => () => undefined,
			stats: async () => null,
			retry: async () => attachedStub,
		};
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
			/>,
		);
		expect(screen.getByRole("heading", { name: "远程桌面 · workstation" })).toBeVisible();
		expect(screen.getByRole("button", { name: "关闭远程桌面" })).toBeVisible();
		expect(screen.getByLabelText("远程桌面画面")).toBeVisible();
	});

	it("hides the Ctrl+Alt+Del action when the host does not report the capability", async () => {
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1", attachmentId: "a1", role: "operator" as const, reconnectToken: "token",
				controlProtectedUntil: null, iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: () => () => undefined,
			onTrack: () => () => undefined,
			onControlMessage: () => () => undefined,
			sendControl: vi.fn(), sendPointer: vi.fn(), close: vi.fn(async () => undefined),
state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
onStateChange: () => () => undefined,
stats: async () => null,
retry: async () => attachedStub,
		};
		const inputFactory = vi.fn();
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
				inputFactory={inputFactory}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		// 系统级提权动作默认不可用，绝不因为角色是 operator 就展示。
		expect(screen.queryByRole("button", { name: "Ctrl+Alt+Del" })).toBeNull();
	});

	it("sends an explicit secure-attention request when the capability is present", async () => {
		// jsdom 未实现 HTMLMediaElement.play，而连接成功路径会调用它。
		const play = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue(undefined as never);
		let channelListener: ((channels: { control: RTCDataChannel | null; pointer: RTCDataChannel | null }) => void) | undefined;
		let trackListener: ((event: RTCTrackEvent) => void) | undefined;
		const input: RemoteInput = {
			keyDown: vi.fn(), keyUp: vi.fn(), button: vi.fn(), wheel: vi.fn(), pointerMove: vi.fn(),
			releaseAll: vi.fn(), freeze: vi.fn(), resumeLayout: vi.fn(), dispose: vi.fn(),
			secureAttention: vi.fn(),
			pressedButtons: () => [],
			setCaptureActive: vi.fn(),
		};
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1", attachmentId: "a1", role: "operator" as const, reconnectToken: "token",
				controlProtectedUntil: null, iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: (callback) => { channelListener = callback; return () => { channelListener = undefined; }; },
			onTrack: (callback) => { trackListener = callback; return () => { trackListener = undefined; }; },
			onControlMessage: () => () => undefined,
			sendControl: vi.fn(), sendPointer: vi.fn(), close: vi.fn(async () => undefined),
state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
onStateChange: () => () => undefined,
stats: async () => null,
retry: async () => attachedStub,
		};
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				secureAttentionSupported
				peerFactory={() => ({ peer, dispose: vi.fn() })}
				inputFactory={() => input}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		await waitFor(() => expect(channelListener).toBeDefined());
		channelListener?.({ control: {} as RTCDataChannel, pointer: {} as RTCDataChannel });
		// 按钮在建立连接前禁用；需要视频轨道到位后才算 connected。
		const button = await screen.findByRole("button", { name: "Ctrl+Alt+Del" });
		expect(button).toBeDisabled();
		await waitFor(() => expect(trackListener).toBeDefined());
		trackListener?.({ streams: [] } as unknown as RTCTrackEvent);
		await waitFor(() => expect(button).toBeEnabled());
		// 先展示按钮，点击后才发送：组合键不作为普通按键下发。
		expect(input.secureAttention).not.toHaveBeenCalled();
		button.click();
		expect(input.secureAttention).toHaveBeenCalledOnce();
		play.mockRestore();
	});
	it("shows a recovery banner while the peer is reconnecting and an error when it gives up", async () => {
		let stateListener: ((state: RemoteDesktopConnectionState) => void) | undefined;
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1", attachmentId: "a1", role: "operator" as const, reconnectToken: "token",
				controlProtectedUntil: null, iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: () => () => undefined,
			onTrack: () => () => undefined,
			onControlMessage: () => () => undefined,
			state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
			onStateChange: (callback) => {
				stateListener = callback;
				return () => { stateListener = undefined; };
			},
			stats: async () => null,
			retry: vi.fn(async () => attachedStub),
			sendControl: vi.fn(), sendPointer: vi.fn(), close: vi.fn(async () => undefined),
		};
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		// 断线后画面可能还在，但必须让操作者知道数据面已经不在。
		stateListener?.({ phase: "reconnecting", attempt: 2, deadline: Date.now() + 30_000, code: null });
		expect(await screen.findByText(/正在恢复连接/)).toBeVisible();
		stateListener?.({ phase: "failed", attempt: 3, deadline: null, code: "REMOTE_DESKTOP_RECONNECT_TIMEOUT" });
		// 用 role 定位警告横幅，避免与状态标签的文字重叠。
		expect(await screen.findByRole("alert")).toHaveTextContent("连接已中断");
		// 失败后必须能就地重试，而不是只能关闭面板重建。
		await (await screen.findByRole("button", { name: /重试/ })).click();
		expect(peer.retry).toHaveBeenCalledOnce();
	});
	it("shows the real media path instead of assuming a direct connection", async () => {
		let trackListener: ((event: RTCTrackEvent) => void) | undefined;
		let stateListener: ((state: RemoteDesktopConnectionState) => void) | undefined;
		const peer: RemoteDesktopPeer = {
			connect: vi.fn(async () => ({
				sessionId: "s1", attachmentId: "a1", role: "operator" as const, reconnectToken: "token",
				controlProtectedUntil: null, iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
			})),
			channels: () => ({ control: null, pointer: null }),
			onChannels: () => () => undefined,
			onTrack: (callback) => { trackListener = callback; return () => { trackListener = undefined; }; },
			onControlMessage: () => () => undefined,
			state: () => ({ phase: "connected" as const, attempt: 0, deadline: null, code: null }),
			onStateChange: (callback) => { stateListener = callback; return () => { stateListener = undefined; }; },
			retry: async () => attachedStub,
			stats: async () => ({
				path: "relay" as const,
				localCandidateType: "relay",
				remoteCandidateType: "host",
				roundTripTimeMs: 42,
				availableOutgoingBitrate: 1_000_000,
				framesPerSecond: 30,
			}),
			sendControl: vi.fn(), sendPointer: vi.fn(), close: vi.fn(async () => undefined),
		};
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined as never);
		render(
			<RemoteDesktopView
				client={client}
				sessionId="s1"
				peerFactory={() => ({ peer, dispose: vi.fn() })}
			/>,
		);
		await waitFor(() => expect(peer.connect).toHaveBeenCalledWith("s1"));
		await waitFor(() => expect(trackListener).toBeDefined());
		// 数据面进入 connected 后才读取真实路径统计。
		stateListener?.({ phase: "connected", attempt: 0, deadline: null, code: null });
		trackListener?.({ streams: [] } as unknown as RTCTrackEvent);
		// 走中继必须如实显示为“中继”，不能一律显示为直连。
		expect(await screen.findByText("中继")).toBeVisible();
		expect(screen.queryByText("直连")).toBeNull();
		play.mockRestore();
	});
});
