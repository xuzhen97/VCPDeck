import { describe, expect, it } from "vitest";
import type { TunnelIceServer } from "@vcpdeck/shared";
import { toNativeIceServers } from "./node-datachannel-peer.js";

/**
 * 回归背景：polyfill 会把凭据拼成 `turn:<username>:<credential>@host:port` 的 URL，
 * 而 coturn REST 用户名本身含冒号（`<expiry>:<sessionId>`），libdatachannel 解析 userinfo
 * 时在第一个冒号处切开，向 TURN 上报的用户名被截断，MESSAGE-INTEGRITY 校验失败（401）。
 * 这里锁定「用户名原样下发且不经过 URL」这一行为。
 */
describe("toNativeIceServers", () => {
	it("TURN 凭据字段原样下发，用户名保留冒号（不被 URL 解析截断）", () => {
		const iceServers: TunnelIceServer[] = [
			{
				urls: ["turn:118.89.196.44:3478?transport=udp"],
				username: "1789901611:tn_60c5f0c1-f1fd-4bdb-b06c-3e1c85fedc2c",
				credential: "8HGY0TDiAmNbm+VnhWT+gbmWQKo=",
			},
		];

		expect(toNativeIceServers(iceServers)).toEqual([
			{
				hostname: "118.89.196.44",
				port: 3478,
				username: "1789901611:tn_60c5f0c1-f1fd-4bdb-b06c-3e1c85fedc2c",
				password: "8HGY0TDiAmNbm+VnhWT+gbmWQKo=",
				relayType: "TurnUdp",
			},
		]);
	});

	it("按 scheme 与 transport 选择 relayType", () => {
		const turn = (url: string): TunnelIceServer[] => [
			{ urls: [url], username: "1:u", credential: "c" },
		];

		expect(toNativeIceServers(turn("turn:h:3478"))[0].relayType).toBe("TurnUdp");
		expect(toNativeIceServers(turn("turn:h:3478?transport=udp"))[0].relayType).toBe("TurnUdp");
		expect(toNativeIceServers(turn("turn:h:3478?transport=tcp"))[0].relayType).toBe("TurnTcp");
		expect(toNativeIceServers(turn("turns:h:5349"))[0].relayType).toBe("TurnTls");
	});

	it("STUN 条目不带凭据", () => {
		expect(toNativeIceServers([{ urls: ["stun:118.89.196.44:3478"] }])).toEqual([
			{ hostname: "118.89.196.44", port: 3478 },
		]);
	});

	it("TURN 缺凭据时不下发（不猜测凭据）", () => {
		expect(toNativeIceServers([{ urls: ["turn:h:3478"] }])).toEqual([]);
	});

	it("形状非法或 scheme 不支持的 URL 一律跳过", () => {
		const iceServers: TunnelIceServer[] = [
			{ urls: ["turn:no-port"] },
			{ urls: ["turn:h:0"] },
			{ urls: ["turn:h:70000"] },
			{ urls: ["http:h:3478"] },
			{ urls: ["stun:h:3478"], username: undefined },
		];

		expect(toNativeIceServers(iceServers)).toEqual([{ hostname: "h", port: 3478 }]);
	});

	it("支持 IPv6 字面量与多 URL 展开", () => {
		const iceServers: TunnelIceServer[] = [
			{ urls: ["turn:[2001:db8::1]:3478?transport=tcp"], username: "1:u", credential: "c" },
		];

		expect(toNativeIceServers(iceServers)).toEqual([
			{
				hostname: "2001:db8::1",
				port: 3478,
				username: "1:u",
				password: "c",
				relayType: "TurnTcp",
			},
		]);
	});
});
