import { describe, expect, it } from "vitest";
import {
	buildRemoteDesktopIceConfig,
	parseRemoteDesktopIceDeployment,
	RemoteDesktopIceLimits,
} from "./ice-config.js";
import { RemoteDesktopProtocolError } from "./remote-desktop.js";

const base = { VCPDECK_STUN_URLS: "stun:desktop.example.test:3478" };

describe("Remote Desktop ICE 部署配置", () => {
	it("默认使用 p2p-only 并且不携带任何凭据", () => {
		const deployment = parseRemoteDesktopIceDeployment(base);
		expect(deployment.policy).toBe("p2p-only");
		expect(deployment.turnUrls).toEqual([]);
		expect(deployment.turnSharedSecret).toBeNull();

		const config = buildRemoteDesktopIceConfig(deployment);
		expect(config.policy).toBe("p2p-only");
		expect(config.expiresAt).toBeNull();
		expect(config.iceServers).toEqual([{ urls: ["stun:desktop.example.test:3478"] }]);
		expect(config.iceServers.some((server) => server.username || server.credential)).toBe(false);
	});

	it("支持多个 STUN URL 并保持顺序", () => {
		const deployment = parseRemoteDesktopIceDeployment({
			VCPDECK_STUN_URLS: "stun:a.test:3478 stun:b.test:3478",
		});
		expect(deployment.stunUrls).toEqual(["stun:a.test:3478", "stun:b.test:3478"]);
	});

	it("拒绝 p2p-only 下出现的 TURN 配置", () => {
		expect(() =>
			parseRemoteDesktopIceDeployment({
				...base,
				VCPDECK_TURN_URLS: "turn:turn.example.test:3478",
				VCPDECK_TURN_SHARED_SECRET: "0123456789abcdef",
			}),
		).toThrow(RemoteDesktopProtocolError);
	});

	it("relay-allowed 必须同时提供 TURN URL 与共享密钥", () => {
		expect(() =>
			parseRemoteDesktopIceDeployment({ ...base, VCPDECK_ICE_POLICY: "relay-allowed" }),
		).toThrow(/TURN URL 与共享密钥/);
		expect(() =>
			parseRemoteDesktopIceDeployment({
				...base,
				VCPDECK_ICE_POLICY: "relay-allowed",
				VCPDECK_TURN_URLS: "turn:turn.example.test:3478",
			}),
		).toThrow(/TURN URL 与共享密钥/);
	});

	it("relay-allowed 下组装短期 TURN 凭据", () => {
		const deployment = parseRemoteDesktopIceDeployment({
			...base,
			VCPDECK_ICE_POLICY: "relay-allowed",
			VCPDECK_TURN_URLS: "turns:turn.example.test:5349",
			VCPDECK_TURN_SHARED_SECRET: "0123456789abcdef",
			VCPDECK_TURN_TTL_SECONDS: "300",
		});
		expect(deployment.turnTtlSeconds).toBe(300);
		const expiresAt = new Date(Date.now() + 300_000).toISOString();
		const config = buildRemoteDesktopIceConfig(deployment, {
			username: "1700000000:vcpdeck",
			credential: "signed",
			expiresAt,
		});
		expect(config.policy).toBe("relay-allowed");
		expect(config.expiresAt).toBe(expiresAt);
		expect(config.iceServers).toEqual([
			{ urls: ["stun:desktop.example.test:3478"] },
			{
				urls: ["turns:turn.example.test:5349"],
				username: "1700000000:vcpdeck",
				credential: "signed",
			},
		]);
	});

	it("relay-allowed 缺少凭据时拒绝组装", () => {
		const deployment = parseRemoteDesktopIceDeployment({
			...base,
			VCPDECK_ICE_POLICY: "relay-allowed",
			VCPDECK_TURN_URLS: "turn:turn.example.test:3478",
			VCPDECK_TURN_SHARED_SECRET: "0123456789abcdef",
		});
		expect(() => buildRemoteDesktopIceConfig(deployment)).toThrow(/TURN 凭据/);
	});

	it("TURN TTL 被限制在 60–600 秒", () => {
		const long = parseRemoteDesktopIceDeployment({
			...base,
			VCPDECK_ICE_POLICY: "relay-allowed",
			VCPDECK_TURN_URLS: "turn:turn.example.test:3478",
			VCPDECK_TURN_SHARED_SECRET: "0123456789abcdef",
			VCPDECK_TURN_TTL_SECONDS: "86400",
		});
		expect(long.turnTtlSeconds).toBe(RemoteDesktopIceLimits.maxTurnTtlSeconds);

		const short = parseRemoteDesktopIceDeployment({
			...base,
			VCPDECK_ICE_POLICY: "relay-allowed",
			VCPDECK_TURN_URLS: "turn:turn.example.test:3478",
			VCPDECK_TURN_SHARED_SECRET: "0123456789abcdef",
			VCPDECK_TURN_TTL_SECONDS: "1",
		});
		expect(short.turnTtlSeconds).toBe(RemoteDesktopIceLimits.minTurnTtlSeconds);
	});

	it("拒绝未知 policy、未知 scheme、超长和过量的 URL", () => {
		expect(() => parseRemoteDesktopIceDeployment({ ...base, VCPDECK_ICE_POLICY: "auto" })).toThrow(
			/不受支持/,
		);
		expect(() => parseRemoteDesktopIceDeployment({ VCPDECK_STUN_URLS: "https://evil.test" })).toThrow(
			/scheme 不受支持/,
		);
		expect(() =>
			parseRemoteDesktopIceDeployment({ VCPDECK_STUN_URLS: `stun:${"a".repeat(300)}` }),
		).toThrow(/URL 无效/);
		expect(() =>
			parseRemoteDesktopIceDeployment({
				VCPDECK_STUN_URLS: Array.from({ length: 9 }, (_, index) => `stun:a${index}.test:3478`).join(" "),
			}),
		).toThrow(/数量超限/);
	});

	it("拒绝过短的 TURN 共享密钥", () => {
		expect(() =>
			parseRemoteDesktopIceDeployment({
				...base,
				VCPDECK_ICE_POLICY: "relay-allowed",
				VCPDECK_TURN_URLS: "turn:turn.example.test:3478",
				VCPDECK_TURN_SHARED_SECRET: "short",
			}),
		).toThrow(/长度不足/);
	});

	it("空 STUN 列表仍然产出合法的 p2p-only 配置", () => {
		const deployment = parseRemoteDesktopIceDeployment({});
		const config = buildRemoteDesktopIceConfig(deployment);
		expect(config.iceServers).toEqual([]);
		expect(config.expiresAt).toBeNull();
	});
});
