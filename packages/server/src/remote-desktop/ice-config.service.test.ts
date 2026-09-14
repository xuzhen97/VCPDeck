import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { RemoteDesktopIceConfigService } from "./ice-config.service.js";

const STUN_ONLY = { VCPDECK_STUN_URLS: "stun:desktop.example.test:3478" };
const RELAY = {
	...STUN_ONLY,
	VCPDECK_ICE_POLICY: "relay-allowed",
	VCPDECK_TURN_URLS: "turns:turn.example.test:5349",
	VCPDECK_TURN_SHARED_SECRET: "0123456789abcdef",
};

describe("RemoteDesktopIceConfigService", () => {
	it("打包模式只下发 STUN，且不产生任何凭据字段", () => {
		const service = new RemoteDesktopIceConfigService(STUN_ONLY, () => 1_000_000);
		expect(service.policy()).toBe("p2p-only");

		const config = service.forAttachment("rda_1", "alice");
		expect(config.policy).toBe("p2p-only");
		expect(config.expiresAt).toBeNull();
		expect(config.iceServers.flatMap((server) => server.urls)).toEqual([
			"stun:desktop.example.test:3478",
		]);
		expect(config.iceServers.some((server) => server.username || server.credential)).toBe(false);
	});

	it("relay-allowed 下发可被 coturn 校验的短期凭据", () => {
		const now = 1_700_000_000_000;
		const service = new RemoteDesktopIceConfigService(RELAY, () => now);

		const config = service.forAttachment("rda_1", "alice");
		expect(config.policy).toBe("relay-allowed");
		expect(config.expiresAt).toBe(new Date(now + 600_000).toISOString());

		const turn = config.iceServers.find((server) => server.credential !== undefined);
		expect(turn).toBeDefined();
		expect(turn?.urls).toEqual(["turns:turn.example.test:5349"]);
		const username = turn?.username ?? "";
		const expiry = Number.parseInt(username.split(":")[0] ?? "", 10);
		expect(expiry).toBe(Math.floor((now + 600_000) / 1000));
		// coturn REST 校验：base64(HMAC-SHA1(secret, username))。
		const expected = createHmac("sha1", "0123456789abcdef").update(username).digest("base64");
		expect(turn?.credential).toBe(expected);
	});

	it("凭据从不定长于 TTL，且每个 attachment 的 username 互不相同", () => {
		const now = 1_700_000_000_000;
		const service = new RemoteDesktopIceConfigService(RELAY, () => now);

		const first = service.forAttachment("rda_1", "alice");
		const second = service.forAttachment("rda_2", "alice");
		const firstUser = first.iceServers.find((server) => server.username)?.username;
		const secondUser = second.iceServers.find((server) => server.username)?.username;
		expect(firstUser).not.toBe(secondUser);
		expect(firstUser).toContain("rda_1");
		expect(secondUser).toContain("rda_2");
	});

	it("username 不含冒号，避免 coturn 解析歧义", () => {
		const service = new RemoteDesktopIceConfigService(RELAY, () => 1_700_000_000_000);
		const config = service.forAttachment("rda:evil", "bob:admin");
		const username = config.iceServers.find((server) => server.username)?.username ?? "";
		// 只允许 `expiry:attachment:actor` 三段结构。
		expect(username.split(":")).toHaveLength(3);
		expect(username).toContain("rda_evil");
		expect(username).toContain("bob_admin");
	});

	it("拒绝非法策略与 p2p-only 下的 TURN 配置", () => {
		expect(() => new RemoteDesktopIceConfigService({ VCPDECK_ICE_POLICY: "auto" })).toThrow(
			/不受支持/,
		);
		expect(
			() =>
				new RemoteDesktopIceConfigService({
					...STUN_ONLY,
					VCPDECK_TURN_URLS: "turn:turn.example.test:3478",
					VCPDECK_TURN_SHARED_SECRET: "0123456789abcdef",
				}),
		).toThrow(/不得配置 TURN/);
	});

	it("配置对象不暴露共享密钥", () => {
		const service = new RemoteDesktopIceConfigService(RELAY, () => 1_700_000_000_000);
		const serialized = JSON.stringify(service.forAttachment("rda_1", "alice"));
		expect(serialized).not.toContain("0123456789abcdef");
		expect(Object.keys(service)).not.toContain("turnSharedSecret");
	});
});
