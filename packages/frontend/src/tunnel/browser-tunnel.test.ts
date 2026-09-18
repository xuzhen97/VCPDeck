import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events, type TunnelSessionCreated } from "@vcpdeck/shared";
import { classifySelectedPath, openBrowserTunnel } from "./browser-tunnel.js";

function makeSocket() {
	const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
	const emitCallbacks: Record<string, Array<(...a: unknown[]) => void>> = {};
	const socket = {
		connected: true,
		emit: vi.fn((event: string, _payload?: unknown, ack?: (...a: unknown[]) => void) => {
			if (ack) (emitCallbacks[event] ??= []).push(ack);
		}),
		off: vi.fn(),
		on(event: string, handler: (...a: unknown[]) => void) {
			(handlers[event] ??= []).push(handler);
			return socket;
		},
		emitServer(event: string, payload?: unknown) {
			(handlers[event] ?? []).forEach((h) => h(payload));
		},
		emitAck(event: string, payload?: unknown) {
			(emitCallbacks[event] ?? []).forEach((h) => h(payload));
		},
	};
	return socket as unknown as Socket & {
		emitServer: (event: string, payload?: unknown) => void;
		emitAck: (event: string, payload?: unknown) => void;
	};
}

function makeChannel() {
	const channel = {
		onopen: null as (() => void) | null,
		onerror: null as ((e?: unknown) => void) | null,
		onclose: null as (() => void) | null,
		onmessage: null as ((e: { data: ArrayBuffer | Uint8Array }) => void) | null,
		send: vi.fn(),
		close: vi.fn(),
		emitOpen() {
			this.onopen?.();
		},
		emitError(e?: unknown) {
			this.onerror?.(e);
		},
	};
	return channel;
}

function makePeer(channel: ReturnType<typeof makeChannel>) {
	const peer = {
		createDataChannel: vi.fn((_label: string, _init?: unknown) => channel),
		createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "v=0-offer" })),
		setLocalDescription: vi.fn(async () => {}),
		setRemoteDescription: vi.fn(async () => {}),
		addIceCandidate: vi.fn(async () => {}),
		close: vi.fn(),
		getStats: vi.fn(async () => new Map()),
		onicecandidate: null as unknown,
		ondatachannel: null as unknown,
		emitIceCandidate(candidate: { candidate: string; sdpMid: string } | null) {
			(this.onicecandidate as (e: { candidate: unknown }) => void)?.({ candidate });
		},
	};
	return peer;
}

function fakeStats(type: string) {
	const local: Record<string, unknown> = { id: "lc", type: "local-candidate", candidateType: type };
	const remote: Record<string, unknown> = { id: "rc", type: "remote-candidate", candidateType: type };
	const pair: Record<string, unknown> = {
		id: "pair",
		type: "candidate-pair",
		state: "succeeded",
		nominated: true,
		localCandidateId: "lc",
		remoteCandidateId: "rc",
	};
	return new Map<string, Record<string, unknown>>([
		["lc", local],
		["rc", remote],
		["pair", pair],
	]);
}

const SESSION: TunnelSessionCreated = {
	clientId: "c1",
	targetPort: 3000,
	attachDeadline: "2026-09-11T00:01:00.000Z",
	iceServers: [{ urls: ["stun:turn.example.com:3478"] }],
	sessionId: "tn_1",
};

function setup(relayOnly = false) {
	const socket = makeSocket();
	const channel = makeChannel();
	const peer = makePeer(channel);
	const createPeer = vi.fn(() => peer as unknown as RTCPeerConnection);
	const opts = { socket, session: SESSION, relayOnly, createPeer };
	return { socket, channel, peer, createPeer, opts };
}

describe("openBrowserTunnel", () => {
	it("attach 后创建可靠有序 channel、发送 offer/candidate 并应用 answer", async () => {
		const { socket, channel, peer, createPeer, opts } = setup();
		const opening = openBrowserTunnel(opts);
		expect(createPeer).toHaveBeenCalledWith({ iceServers: SESSION.iceServers, iceTransportPolicy: "all" });
		expect(peer.createDataChannel).toHaveBeenCalledWith("vcpdeck-tcp", { ordered: true });
		expect(socket.emit).toHaveBeenCalledWith(
			Events.TUNNEL_ATTACH,
			{ sessionId: SESSION.sessionId },
			expect.any(Function),
		);

		peer.emitIceCandidate({ candidate: "candidate:1", sdpMid: "0" });
		expect(socket.emit).toHaveBeenCalledWith(
			Events.TUNNEL_SIGNAL,
			expect.objectContaining({ sessionId: SESSION.sessionId }),
		);

		socket.emitServer(Events.TUNNEL_SIGNAL, {
			sessionId: SESSION.sessionId,
			description: { type: "answer", sdp: "v=0\r\n" },
		});
		channel.emitOpen();
		await expect(opening).resolves.toMatchObject({ channel });
	});

	it("relayOnly 设置 iceTransportPolicy=relay", () => {
		const { createPeer, opts } = setup(true);
		void openBrowserTunnel(opts);
		expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceTransportPolicy: "relay" }));
	});

	it("candidate 早于 answer 时排队，answer 应用后补发", async () => {
		const { socket, peer, channel, opts } = setup();
		const opening = openBrowserTunnel(opts);
		socket.emitServer(Events.TUNNEL_SIGNAL, {
			sessionId: SESSION.sessionId,
			candidate: { candidate: "candidate:1", sdpMid: "0" },
		});
		expect(peer.addIceCandidate).not.toHaveBeenCalled();
		socket.emitServer(Events.TUNNEL_SIGNAL, {
			sessionId: SESSION.sessionId,
			description: { type: "answer", sdp: "v=0" },
		});
		await vi.waitFor(() => expect(peer.addIceCandidate).toHaveBeenCalledWith({ candidate: "candidate:1", sdpMid: "0" }));
		channel.emitOpen();
		await expect(opening).resolves.toBeDefined();
	});

	it("attach ack 失败时清理并拒绝 open", async () => {
		const { socket, peer, opts } = setup();
		const opening = openBrowserTunnel(opts);
		socket.emitAck(Events.TUNNEL_ATTACH, { ok: false, error: { code: "TUNNEL_FORBIDDEN" } });
		await expect(opening).rejects.toMatchObject({ code: "TUNNEL_FORBIDDEN" });
		expect(peer.close).toHaveBeenCalled();
	});

	it("Server 上报 failed 状态时以该 code 清理并拒绝 open", async () => {
		const { socket, peer, opts } = setup();
		const opening = openBrowserTunnel(opts);
		socket.emitServer(Events.TUNNEL_STATE, {
			sessionId: SESSION.sessionId,
			state: "failed",
			code: "TUNNEL_TARGET_REFUSED",
		});
		await expect(opening).rejects.toMatchObject({ code: "TUNNEL_TARGET_REFUSED" });
		expect(peer.close).toHaveBeenCalled();
	});

	it("Server TUNNEL_CLOSE 时清理并拒绝 open", async () => {
		const { socket, channel, peer, opts } = setup();
		const opening = openBrowserTunnel(opts);
		socket.emitServer(Events.TUNNEL_CLOSE, { sessionId: SESSION.sessionId });
		await expect(opening).rejects.toMatchObject({ code: "TUNNEL_CLOSED" });
		expect(peer.close).toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalled();
	});

	it("close() 幂等：只清理一次", async () => {
		const { channel, peer, opts } = setup();
		const opening = openBrowserTunnel(opts);
		channel.emitOpen();
		const tunnel = await opening;
		await tunnel.close();
		await tunnel.close();
		expect(peer.close).toHaveBeenCalledTimes(1);
		expect(channel.close).toHaveBeenCalledTimes(1);
	});
});

describe("classifySelectedPath", () => {
	it("按 candidateType 分类 relay / direct / unknown", async () => {
		await expect(classifySelectedPath(fakeStats("relay"))).resolves.toBe("relay");
		await expect(classifySelectedPath(fakeStats("srflx"))).resolves.toBe("direct");
		await expect(classifySelectedPath(fakeStats("host"))).resolves.toBe("direct");
		// 无 selected pair
		const none: Record<string, unknown> = { id: "x", type: "local-candidate" };
		await expect(classifySelectedPath(new Map<string, Record<string, unknown>>([["x", none]]))).resolves.toBe(
			"unknown",
		);
		// 空 stats
		await expect(classifySelectedPath(new Map())).resolves.toBe("unknown");
	});
});
