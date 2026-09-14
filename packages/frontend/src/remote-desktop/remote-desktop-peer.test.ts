import type { RemoteDesktopBrowserAttached, RemoteDesktopSignal } from "@vcpdeck/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteDesktopSocket } from "./remote-desktop-socket.js";
import { RECONNECT_WINDOW_MS, createRemoteDesktopPeer } from "./remote-desktop-peer";

class FakeDataChannel {
	label: string;
	readyState = "open";
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: (() => void) | null = null;
	sent: string[] = [];
	constructor(label: string) { this.label = label; }
	send(data: string) { this.sent.push(data); }
	close() { this.readyState = "closed"; }
	fireOpen() { this.onopen?.(); }
}

class FakePeerConnection {
	onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
	ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
	ontrack: ((event: RTCTrackEvent) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	connectionState: RTCPeerConnectionState = "new";
	localDescription: RTCSessionDescriptionInit | null = null;
	remoteDescription: RTCSessionDescriptionInit | null = null;
	closed = false;
	control = new FakeDataChannel("control-reliable");
	pointer = new FakeDataChannel("pointer-realtime");
	/** 记录 Browser 在 offer 前创建的通道，用于验证 m=application 段可被协商。 */
	createdChannels: Array<{ label: string; init?: RTCDataChannelInit }> = [];
	addTransceiver() { return {}; }
	createDataChannel(label: string, init?: RTCDataChannelInit) {
		this.createdChannels.push({ label, init });
		if (label === "control-reliable") return this.control;
		if (label === "pointer-realtime") return this.pointer;
		return new FakeDataChannel(label);
	}
	async createOffer() { return { type: "offer" as const, sdp: "offer-sdp" }; }
	async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
	async setRemoteDescription(description: RTCSessionDescriptionInit) {
		this.remoteDescription = description;
	}
	async addIceCandidate() {}
	close() { this.closed = true; }
	fireConnectionState(state: RTCPeerConnectionState) {
		this.connectionState = state;
		this.onconnectionstatechange?.();
	}
	fireChannels() {
		this.ondatachannel?.({ channel: this.control } as unknown as RTCDataChannelEvent);
		this.ondatachannel?.({ channel: this.pointer } as unknown as RTCDataChannelEvent);
	}
	fireChallenge() {
		this.control.onmessage?.({ data: JSON.stringify({ type: "challenge", nonce: Array(32).fill(8), attachment_id: "a1" }) } as MessageEvent);
	}
}

const attached = {
	sessionId: "s1",
	attachmentId: "a1",
	role: "operator" as const,
	reconnectToken: "token",
	controlProtectedUntil: null,
	iceConfig: { policy: "p2p-only" as const, iceServers: [], expiresAt: null },
} satisfies RemoteDesktopBrowserAttached;

function makeSocket() {
	let signalHandler: ((message: { sessionId: string; attachmentId: string; signal: RemoteDesktopSignal }) => void) | undefined;
	let connectionHandler: ((connected: boolean) => void) | undefined;
	let attachCount = 0;
	const socket: RemoteDesktopSocket = {
		attach: vi.fn(async (sessionId: string) => {
			attachCount += 1;
			return {
				...attached,
				sessionId,
				// 重连必须得到新的 attachment 与新的单次恢复材料。
				attachmentId: `a${attachCount}`,
				reconnectToken: `token-${attachCount}`,
			};
		}),
		detach: vi.fn(async () => undefined),
		takeover: vi.fn(async () => ({ role: "operator" as const })),
		signal: vi.fn(async () => undefined),
		onSignal: vi.fn((cb) => { signalHandler = cb; return () => { signalHandler = undefined; }; }),
		onConnectionChange: vi.fn((cb) => { connectionHandler = cb; return () => { connectionHandler = undefined; }; }),
		isConnected: () => true,
		dispose: vi.fn(),
	};
	return {
		socket,
		fireSignal: (signal: RemoteDesktopSignal, attachmentId = "a1") => signalHandler?.({ sessionId: "s1", attachmentId, signal }),
		fireConnection: (connected: boolean) => connectionHandler?.(connected),
	};
}

describe("createRemoteDesktopPeer", () => {
	beforeEach(() => {
		// Peer 会把恢复材料写进 sessionStorage；不清理会污染后续用例的首次 attach。
		sessionStorage.clear();
	});
	it("creates both data channels before the offer so SCTP can be negotiated", async () => {
		const fake = makeSocket();
		const pc = new FakePeerConnection();
		const peer = createRemoteDesktopPeer(fake.socket, () => pc as unknown as RTCPeerConnection);
		await peer.connect("s1");

		// Browser 是 offerer：不创建通道就不会有 m=application 段，
		// Host 单方面创建的通道永远无法完成协商。
		expect(pc.createdChannels.map((channel) => channel.label)).toEqual([
			"control-reliable",
			"pointer-realtime",
		]);
		expect(pc.createdChannels[0]?.init?.ordered).toBe(true);
		expect(pc.createdChannels[1]?.init?.ordered).toBe(false);
		expect(pc.createdChannels[1]?.init?.maxRetransmits).toBe(0);
		// 通道必须在 offer 之前创建。
		expect(pc.localDescription).toEqual({ type: "offer", sdp: "offer-sdp" });
		expect(peer.channels()).toEqual({ control: pc.control, pointer: pc.pointer });
	});

	it("creates an offer, sends signaling, answers host SDP and discovers both channels", async () => {
		const fake = makeSocket();
		const pc = new FakePeerConnection();
		const messages: unknown[] = [];
		const peer = createRemoteDesktopPeer(fake.socket, () => pc as unknown as RTCPeerConnection);
		const removeMessages = peer.onControlMessage((message) => messages.push(message));
		await peer.connect("s1");
		expect(fake.socket.attach).toHaveBeenCalledWith("s1", undefined);
		expect(fake.socket.signal).toHaveBeenCalledWith("s1", "a1", { kind: "offer", sdp: "offer-sdp" });
		pc.fireChannels();
		pc.control.onmessage?.({ data: JSON.stringify({ type: "remote-to-browser", text: "hello" }) } as MessageEvent);
		expect(messages).toEqual([{ type: "remote-to-browser", text: "hello" }]);
		expect(peer.channels()).toEqual({ control: pc.control, pointer: pc.pointer });
		removeMessages();
		fake.fireSignal({ kind: "ice", candidate: "candidate:1" });
		fake.fireSignal({ kind: "answer", sdp: "answer-sdp" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "answer-sdp" });
	});

	it("keeps challenge-response working when a control observer throws", async () => {
		const fake = makeSocket();
		const pc = new FakePeerConnection();
		const peer = createRemoteDesktopPeer(fake.socket, () => pc as unknown as RTCPeerConnection);
		await peer.connect("s1");
		peer.onControlMessage(() => {
			throw new Error("observer failed");
		});
		pc.fireChannels();
		pc.fireChallenge();
		expect(JSON.parse(pc.control.sent[0]!)).toEqual({
			type: "challenge-response",
			nonce: Array(32).fill(8),
			attachment_id: "a1",
		});
	});

	it("responds to the attachment-bound challenge and closes cleanly", async () => {
		const fake = makeSocket();
		const pc = new FakePeerConnection();
		const peer = createRemoteDesktopPeer(fake.socket, () => pc as unknown as RTCPeerConnection);
		await peer.connect("s1");
		pc.fireChannels();
		pc.fireChallenge();
		expect(JSON.parse(pc.control.sent[0]!)).toEqual({
			type: "challenge-response",
			nonce: Array(32).fill(8),
			attachment_id: "a1",
		});
		await peer.close();
		expect(fake.socket.detach).toHaveBeenCalledWith("s1", "a1");
		expect(pc.closed).toBe(true);
	});
});

describe("remote desktop reconnect state machine", () => {
	/** 每次调用返回新的 PeerConnection：重连必须建立全新的连接。 */
	function pcFactory() {
		const connections: FakePeerConnection[] = [];
		return {
			connections,
			create: () => {
				const pc = new FakePeerConnection();
				connections.push(pc);
				return pc as unknown as RTCPeerConnection;
			},
		};
	}

	it("reports connecting then connected as the control channel opens", async () => {
		const fake = makeSocket();
		const factory = pcFactory();
		const peer = createRemoteDesktopPeer(fake.socket, factory.create);
		const states: string[] = [];
		peer.onStateChange((state) => states.push(state.phase));
		await peer.connect("s1");
		expect(peer.state().phase).toBe("connecting");
		factory.connections[0]!.control.fireOpen();
		expect(peer.state().phase).toBe("connected");
		expect(states).toContain("connected");
	});

	it("closes the dead connection and re-attaches with new material on socket loss", async () => {
		const fake = makeSocket();
		const factory = pcFactory();
		const peer = createRemoteDesktopPeer(fake.socket, factory.create);
		await peer.connect("s1");
		factory.connections[0]!.control.fireOpen();
		expect(peer.state().phase).toBe("connected");

		fake.fireConnection(false);
		expect(peer.state().phase).toBe("reconnecting");
		expect(peer.state().attempt).toBe(1);
		expect(peer.state().deadline).not.toBeNull();
		// 旧连接与旧 attachment 都不能复用。
		expect(factory.connections[0]!.closed).toBe(true);

		fake.fireConnection(true);
		await vi.waitFor(() => expect(factory.connections.length).toBe(2));
		// 必须带上次下发的恢复材料重新 attach，并拿到新的 attachment。
		expect(fake.socket.attach).toHaveBeenLastCalledWith("s1", "token-1");
		await vi.waitFor(() =>
			expect(fake.socket.signal).toHaveBeenLastCalledWith("s1", "a2", {
				kind: "offer",
				sdp: "offer-sdp",
			}),
		);
		expect(fake.socket.attach).toHaveBeenCalledTimes(2);

		factory.connections[1]!.control.fireOpen();
		expect(peer.state().phase).toBe("connected");
		expect(peer.state().attempt).toBe(0);
	});

	it("fails once the recovery window expires without the socket coming back", async () => {
		const fake = makeSocket();
		const factory = pcFactory();
		const peer = createRemoteDesktopPeer(fake.socket, factory.create);
		await peer.connect("s1");
		vi.useFakeTimers();
		try {
			fake.fireConnection(false);
			expect(peer.state().phase).toBe("reconnecting");
			// 恢复窗口内不得放弃。
			vi.advanceTimersByTime(RECONNECT_WINDOW_MS - 1_000);
			expect(peer.state().phase).toBe("reconnecting");
			vi.advanceTimersByTime(2_000);
			expect(peer.state().phase).toBe("failed");
			expect(peer.state().code).toBe("REMOTE_DESKTOP_RECONNECT_TIMEOUT");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects when ICE fails instead of showing a frozen picture forever", async () => {
		const fake = makeSocket();
		const factory = pcFactory();
		const peer = createRemoteDesktopPeer(fake.socket, factory.create);
		await peer.connect("s1");
		factory.connections[0]!.control.fireOpen();

		factory.connections[0]!.fireConnectionState("failed");
		expect(peer.state().phase).toBe("reconnecting");
		expect(factory.connections[0]!.closed).toBe(true);
		await vi.waitFor(() => expect(factory.connections.length).toBe(2));
	});

	it("reports a closed state and drops recovery material when closed", async () => {
		const fake = makeSocket();
		const factory = pcFactory();
		const peer = createRemoteDesktopPeer(fake.socket, factory.create);
		await peer.connect("s1");
		await peer.close();
		expect(peer.state().phase).toBe("closed");
		expect(peer.state().deadline).toBeNull();
		// 正常关闭后不应再尝试重连。
		fake.fireConnection(false);
		expect(peer.state().phase).toBe("closed");
	});
	it("can be retried explicitly after the recovery window expired", async () => {
		const fake = makeSocket();
		const factory = pcFactory();
		const peer = createRemoteDesktopPeer(fake.socket, factory.create);
		await peer.connect("s1");
		factory.connections[0]!.control.fireOpen();

		vi.useFakeTimers();
		try {
			fake.fireConnection(false);
			vi.advanceTimersByTime(RECONNECT_WINDOW_MS + 1_000);
			expect(peer.state().phase).toBe("failed");
		} finally {
			vi.useRealTimers();
		}

		// 失败后不能只让用户关闭重建：必须能显式重试。
		await peer.retry();
		expect(peer.state().phase).toBe("connecting");
		expect(peer.state().code).toBeNull();
		await vi.waitFor(() => expect(factory.connections.length).toBe(2));
		expect(fake.socket.attach).toHaveBeenCalledTimes(2);

		factory.connections[1]!.control.fireOpen();
		expect(peer.state().phase).toBe("connected");
	});

	it("refuses to retry a closed session", async () => {
		const fake = makeSocket();
		const factory = pcFactory();
		const peer = createRemoteDesktopPeer(fake.socket, factory.create);
		await peer.connect("s1");
		await peer.close();
		await expect(peer.retry()).rejects.toThrow();
	});
});
