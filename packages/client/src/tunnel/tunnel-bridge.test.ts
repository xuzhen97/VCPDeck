import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import type { Socket } from "socket.io-client";
import { Events, type TunnelIceServer } from "@vcpdeck/shared";
import {
	attachTunnelBridge,
	type TunnelDataChannel,
	type TunnelPeer,
	type TunnelTcpSocket,
	type TunnelTcpTarget,
} from "./tunnel-bridge.js";

function makeSocket() {
	return {
		connected: true,
		emit: vi.fn(),
		on: vi.fn(),
		disconnect: vi.fn(),
		data: {},
	} as unknown as Socket;
}

// 测试 fake：真实对象（推断类型，闭包而非 `this` 承载 vi.fn 实现），只在传入 bridge 时按接口 cast。

function makePeer() {
	const peer = {
		setRemoteDescription: vi.fn(async (): Promise<void> => {}),
		setLocalDescription: vi.fn(async (): Promise<void> => {}),
		createAnswer: vi.fn(async () => ({ type: "answer" as const, sdp: "v=0-answer" })),
		addIceCandidate: vi.fn(async (): Promise<void> => {}),
		close: vi.fn(),
		ondatachannel: null as ((e: { channel: TunnelDataChannel }) => void) | null,
		onicecandidate: null as ((e: { candidate: { candidate: string; sdpMid: string } | null }) => void) | null,
		emitDataChannel(channel: TunnelDataChannel) {
			this.ondatachannel?.({ channel });
		},
		emitIceCandidate(candidate: { candidate: string; sdpMid: string } | null) {
			this.onicecandidate?.({ candidate });
		},
	};
	return peer;
}

function makeChannel() {
	const channel = {
		sentBinary: [] as Uint8Array[],
		bufferedAmount: 0,
		bufferedAmountLowThreshold: 0,
		onopen: null as (() => void) | null,
		onmessage: null as ((e: { data: ArrayBuffer | Uint8Array }) => void) | null,
		onclose: null as (() => void) | null,
		onerror: null as ((e?: unknown) => void) | null,
		onbufferedamountlow: null as (() => void) | null,
		send(data: Uint8Array) {
			this.sentBinary.push(data);
		},
		close: vi.fn(),
		emitOpen() {
			this.onopen?.();
		},
		emitMessage(data: ArrayBuffer | Uint8Array) {
			this.onmessage?.({ data });
		},
		emitClose() {
			this.onclose?.();
		},
		emitError() {
			this.onerror?.();
		},
		emitBufferedAmountLow() {
			this.onbufferedamountlow?.();
		},
	};
	return channel;
}

function makeTcp() {
	const listeners: Record<string, Array<(...a: unknown[]) => void>> = {
		data: [],
		drain: [],
		error: [],
		close: [],
	};
	const writes: Uint8Array[] = [];
	const tcp = {
		writes,
		pause: vi.fn(),
		resume: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
		write: vi.fn((d: Uint8Array) => {
			writes.push(d);
			return true;
		}),
		on(ev: string, cb: (...a: unknown[]) => void) {
			listeners[ev].push(cb);
		},
		emitData(d: Uint8Array) {
			listeners.data.forEach((l) => l(d));
		},
		emitDrain() {
			listeners.drain.forEach((l) => l());
		},
		emitError(err: { code?: string }) {
			listeners.error.forEach((l) => l(err));
		},
		emitClose() {
			listeners.close.forEach((l) => l());
		},
	};
	return tcp;
}

function setup() {
	const socket = makeSocket();
	const peer = makePeer();
	const channel = makeChannel();
	const tcp = makeTcp();
	const createPeer = vi.fn((_ice: TunnelIceServer[]) => peer as unknown as TunnelPeer);
	const connectTcp = vi.fn((_t: TunnelTcpTarget) => tcp as unknown as TunnelTcpSocket);
	const bridge = attachTunnelBridge(socket, {
		clientId: "c1",
		createPeer,
		createTcp: connectTcp,
	});
	return { socket, peer, channel, tcp, createPeer, connectTcp, bridge };
}

describe("TunnelBridge 回环 TCP 数据泵", () => {
	it("始终连接 127.0.0.1 并保持双向二进制顺序", () => {
		const { peer, channel, tcp, connectTcp, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		channel.emitOpen();
		expect(connectTcp).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3000 });

		tcp.emitData(Buffer.from([1, 2]));
		tcp.emitData(Buffer.from([3, 4]));
		expect(channel.sentBinary).toEqual([Buffer.from([1, 2]), Buffer.from([3, 4])]);

		channel.emitMessage(Buffer.from([5, 6]));
		expect(tcp.writes).toEqual([Buffer.from([5, 6])]);
	});

	it("TCP→DataChannel 大 chunk 切分为 16 KiB 二进制消息", () => {
		const { peer, channel, tcp, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		tcp.emitData(Buffer.alloc(40 * 1024));
		// 40KiB → 3 片：16KiB + 16KiB + 8KiB
		expect(channel.sentBinary.length).toBe(3);
		expect((channel.sentBinary[0] as Buffer).length).toBe(16 * 1024);
		expect((channel.sentBinary[1] as Buffer).length).toBe(16 * 1024);
		expect((channel.sentBinary[2] as Buffer).length).toBe(8 * 1024);
	});

	it("DataChannel 高水位暂停 TCP，低水位恢复", () => {
		const { peer, channel, tcp, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		channel.bufferedAmount = 1024 * 1024;
		tcp.emitData(Buffer.alloc(16 * 1024));
		expect(tcp.pause).toHaveBeenCalled();
		expect(channel.sentBinary).toHaveLength(0);
		channel.emitBufferedAmountLow();
		expect(tcp.resume).toHaveBeenCalled();
	});

	it("TCP 写入回压超过 1 MiB 关闭 Session 并上报（不丢包）", () => {
		const { socket, peer, channel, tcp, bridge } = setup();
		tcp.write.mockReturnValue(false);
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		channel.emitMessage(Buffer.alloc(1024 * 1024 + 1));
		expect(socket.emit).toHaveBeenCalledWith(
			Events.TUNNEL_STATE,
			expect.objectContaining({ state: "failed", code: "TUNNEL_BACKPRESSURE_LIMIT" }),
		);
		expect(peer.close).toHaveBeenCalled();
	});

	it("DataChannel 在数据流传输中关闭：send 抛错被捕获，清理 Session 不崩溃", () => {
		const { peer, channel, tcp, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		channel.emitOpen();
		// 模拟浏览器断开：对端 DataChannel 关闭，send() 同步抛错（旧代码会拖垮整个 Client 进程）
		(channel as unknown as { send: (d: Uint8Array) => void }).send = () => {
			throw new Error("DataChannel is closed");
		};
		expect(() => tcp.emitData(Buffer.alloc(16 * 1024))).not.toThrow();
		expect(tcp.end).toHaveBeenCalled();
		expect(tcp.destroy).toHaveBeenCalled();
		expect(peer.close).toHaveBeenCalled();
	});

	it("candidate 在 remote description 前排队，offer 到达后补发", async () => {
		const { peer, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		bridge.receiveSignal({ sessionId: "tn_1", candidate: { candidate: "candidate:1", sdpMid: "0" } });
		expect(peer.addIceCandidate).not.toHaveBeenCalled();
		bridge.receiveSignal({ sessionId: "tn_1", description: { type: "offer", sdp: "v=0-offer" } });
		await vi.waitFor(() => expect(peer.addIceCandidate).toHaveBeenCalled());
		expect(peer.addIceCandidate).toHaveBeenCalledWith({ candidate: "candidate:1", sdpMid: "0" });
	});

	it("offer 到达后回传 answer 信令", async () => {
		const { socket, peer, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		bridge.receiveSignal({ sessionId: "tn_1", description: { type: "offer", sdp: "v=0-offer" } });
		await vi.waitFor(() =>
			expect(socket.emit).toHaveBeenCalledWith(
				Events.TUNNEL_SIGNAL,
				expect.objectContaining({ description: expect.objectContaining({ type: "answer" }) }),
			),
		);
		expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "v=0-offer" });
	});

	it("TCP ECONNREFUSED 映射 TUNNEL_TARGET_REFUSED", () => {
		const { socket, peer, channel, tcp, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		tcp.emitError({ code: "ECONNREFUSED" });
		expect(socket.emit).toHaveBeenCalledWith(
			Events.TUNNEL_STATE,
			expect.objectContaining({ state: "failed", code: "TUNNEL_TARGET_REFUSED" }),
		);
		// 目标终止：拆目标 TCP，但保留 WebRTC 通道——等 Server 的 TUNNEL_CLOSE 再统一关闭，
		// 这样 Browser 会先收到具体错误码（TUNNEL_STATE）再感知到通道拆除。
		expect(tcp.end).toHaveBeenCalled();
		expect(peer.close).not.toHaveBeenCalled();
	});

	it("native 后端不可用时上报 P2P_NATIVE_BACKEND_UNAVAILABLE 且不建数据面", () => {
		const socket = makeSocket();
		const connectTcp = vi.fn((_t: TunnelTcpTarget) => (null as unknown as TunnelTcpSocket));
		const bridge = attachTunnelBridge(socket, {
			clientId: "c1",
			createPeer: vi.fn((_ice: TunnelIceServer[]) => null),
			createTcp: connectTcp,
		});
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		expect(socket.emit).toHaveBeenCalledWith(
			Events.TUNNEL_STATE,
			expect.objectContaining({ state: "failed", code: "P2P_NATIVE_BACKEND_UNAVAILABLE" }),
		);
		expect(connectTcp).not.toHaveBeenCalled();
	});

	it("close 幂等：重复 close 只清理一次", () => {
		const { peer, channel, tcp, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		bridge.receiveClose("tn_1");
		expect(peer.close).toHaveBeenCalledTimes(1);
		expect(tcp.end).toHaveBeenCalled();
		bridge.receiveClose("tn_1");
		expect(peer.close).toHaveBeenCalledTimes(1);
	});

	it("dispose 关闭所有 Session（peer/tcp/channel）", () => {
		const { peer, channel, tcp, bridge } = setup();
		bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
		peer.emitDataChannel(channel as unknown as TunnelDataChannel);
		bridge.dispose();
		expect(peer.close).toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalled();
		expect(tcp.end).toHaveBeenCalled();
	});
});
