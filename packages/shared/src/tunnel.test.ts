import { describe, expect, it } from "vitest";
import {
	P2P_TUNNEL_PROTOCOL_VERSION,
	parseP2pTunnelCapabilityStatus,
	parseTunnelBrowserSignal,
	parseTunnelClientSignal,
	parseTunnelConfigInfo,
	parseTunnelConfigUpdate,
	parseTunnelIceServer,
	parseTunnelSessionCreateRequest,
} from "./tunnel.js";

describe("tunnel protocol", () => {
	it("接受最小创建请求并固定协议版本", () => {
		expect(P2P_TUNNEL_PROTOCOL_VERSION).toBe(1);
		expect(
			parseTunnelSessionCreateRequest({ clientId: "client-1", targetPort: 3000 }),
		).toEqual({ clientId: "client-1", targetPort: 3000 });
	});

	it.each([0, 65536, 1.5, "3000", null])("拒绝非法 targetPort %p", (targetPort) => {
		expect(() =>
			parseTunnelSessionCreateRequest({ clientId: "client-1", targetPort }),
		).toThrow();
	});

	it("拒绝未知字段（host 不得进入协议）", () => {
		expect(() =>
			parseTunnelSessionCreateRequest({
				clientId: "client-1",
				targetPort: 3000,
				host: "10.0.0.1",
			}),
		).toThrow();
	});

	it("拒绝缺失或非法 sessionId/clientId", () => {
		expect(() => parseTunnelSessionCreateRequest({ clientId: "", targetPort: 3000 })).toThrow();
		expect(() => parseTunnelSessionCreateRequest({ clientId: "c", targetPort: 3000, extra: 1 })).toThrow();
	});

	it("拒绝超长 SDP 与超长 ICE candidate，边界值接受", () => {
		expect(() =>
			parseTunnelBrowserSignal({
				sessionId: "tn_1",
				description: { type: "offer", sdp: "x".repeat(128 * 1024 + 1) },
			}),
		).toThrow();
		expect(
			parseTunnelBrowserSignal({
				sessionId: "tn_1",
				description: { type: "offer", sdp: "x".repeat(128 * 1024) },
			}),
		).toBeTruthy();
		expect(() =>
			parseTunnelClientSignal({
				sessionId: "tn_1",
				candidate: { candidate: "x".repeat(8 * 1024 + 1), sdpMid: "0" },
			}),
		).toThrow();
	});

	it("Browser 只接受 offer，Client 只接受 answer；candidate 双向接受", () => {
		expect(
			parseTunnelBrowserSignal({ sessionId: "tn_1", description: { type: "offer", sdp: "v=0\r\n" } }),
		).toMatchObject({ sessionId: "tn_1", description: { type: "offer" } });
		expect(() =>
			parseTunnelBrowserSignal({ sessionId: "tn_1", description: { type: "answer", sdp: "v=0\r\n" } }),
		).toThrow();
		expect(
			parseTunnelClientSignal({ sessionId: "tn_1", description: { type: "answer", sdp: "v=0\r\n" } }),
		).toMatchObject({ sessionId: "tn_1", description: { type: "answer" } });
		expect(() =>
			parseTunnelClientSignal({ sessionId: "tn_1", description: { type: "offer", sdp: "v=0\r\n" } }),
		).toThrow();
		expect(
			parseTunnelClientSignal({ sessionId: "tn_1", candidate: { candidate: "cand", sdpMid: "0" } }),
		).toMatchObject({ sessionId: "tn_1" });
		expect(
			parseTunnelBrowserSignal({ sessionId: "tn_1", candidate: { candidate: "cand", sdpMid: "0" } }),
		).toMatchObject({ sessionId: "tn_1" });
	});

	it("信令必须且只能含 sessionId 与 description/candidate 之一", () => {
		expect(() => parseTunnelBrowserSignal({ description: { type: "offer", sdp: "v=0" } })).toThrow();
		expect(() =>
			parseTunnelClientSignal({
				sessionId: "tn_1",
				description: { type: "answer", sdp: "v=0" },
				candidate: { candidate: "c", sdpMid: "0" },
			}),
		).toThrow();
	});

	it("只接受标准 ICE URL scheme，拒绝 userinfo/控制字符/未知 scheme", () => {
		expect(
			parseTunnelConfigUpdate({
				stunUrls: ["stun:turn.example.com:3478"],
				turnUrls: ["turn:turn.example.com:3478?transport=udp"],
				realm: "turn.example.com",
			}),
		).toEqual({
			stunUrls: ["stun:turn.example.com:3478"],
			turnUrls: ["turn:turn.example.com:3478?transport=udp"],
			realm: "turn.example.com",
		});
		expect(() =>
			parseTunnelConfigUpdate({ stunUrls: ["https://evil.example"], turnUrls: [], realm: "x" }),
		).toThrow();
		expect(() =>
			parseTunnelConfigUpdate({ stunUrls: ["turn://user:pass@host"], turnUrls: [], realm: "x" }),
		).toThrow();
		expect(() =>
			parseTunnelConfigUpdate({ stunUrls: ["stun:host\n"], turnUrls: [], realm: "x" }),
		).toThrow();
		expect(() => parseTunnelConfigUpdate({ stunUrls: [], turnUrls: [], realm: "x", extra: 1 })).toThrow();
	});

	it("ICE server 严格解析：urls 数量/长度、scheme、可选凭据", () => {
		expect(
			parseTunnelIceServer({ urls: ["stun:turn.example.com:3478"] }),
		).toEqual({ urls: ["stun:turn.example.com:3478"] });
		expect(
			parseTunnelIceServer({
				urls: ["turn:turn.example.com:3478"],
				username: "123:tn",
				credential: "abc",
			}),
		).toMatchObject({ username: "123:tn" });
		expect(() => parseTunnelIceServer({ urls: [] })).toThrow();
		expect(() => parseTunnelIceServer({ urls: ["http://x"] })).toThrow();
		expect(() => parseTunnelIceServer({ urls: ["stun:" + "x".repeat(512)] })).toThrow();
		expect(() => parseTunnelIceServer({ urls: ["stun:a", "stun:b", "stun:c".repeat(10)] })).not.toThrow();
	});

	it("配置读取解析接受脱敏摘要，拒绝 secret 内容字段", () => {
		expect(
			parseTunnelConfigInfo({
				stunUrls: ["stun:turn.example.com:3478"],
				turnUrls: [],
				realm: "turn.example.com",
				turnSecretConfigured: true,
				updatedAt: null,
			}),
		).toMatchObject({ turnSecretConfigured: true, updatedAt: null });
		expect(() =>
			parseTunnelConfigInfo({
				stunUrls: [],
				turnUrls: [],
				realm: "x",
				turnSecretConfigured: true,
				updatedAt: null,
				sharedSecret: "leak",
			}),
		).toThrow();
	});

	it("P2P 能力摘要接受 v1 与 native 缺失，拒绝未知版本", () => {
		expect(parseP2pTunnelCapabilityStatus({ available: true, protocolVersion: 1 })).toMatchObject({
			available: true,
			protocolVersion: 1,
		});
		expect(
			parseP2pTunnelCapabilityStatus({
				available: false,
				protocolVersion: 1,
				code: "P2P_NATIVE_BACKEND_UNAVAILABLE",
			}),
		).toMatchObject({ available: false, code: "P2P_NATIVE_BACKEND_UNAVAILABLE" });
		expect(() => parseP2pTunnelCapabilityStatus({ available: true, protocolVersion: 2 })).toThrow();
		expect(() => parseP2pTunnelCapabilityStatus({ available: true, protocolVersion: 1, extra: 1 })).toThrow();
	});
});
