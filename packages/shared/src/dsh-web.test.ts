import { describe, expect, it } from "vitest";
import { parseDshWebCommand, parseDshWebCommandResult } from "./dsh-web.js";

describe("远程 DSH 受管命令契约", () => {
	it("解析 start 命令", () => {
		expect(
			parseDshWebCommand({
				requestId: "r1",
				action: "start",
				clientId: "c1",
				port: 30123,
			}),
		).toEqual({
			requestId: "r1",
			action: "start",
			clientId: "c1",
			port: 30123,
		});
	});

	it("拒绝未知 action、越界端口与未知字段", () => {
		expect(() =>
			parseDshWebCommand({
				requestId: "r1",
				action: "restart",
				clientId: "c1",
				port: 30123,
			}),
		).toThrow();
		expect(() =>
			parseDshWebCommand({
				requestId: "r1",
				action: "start",
				clientId: "c1",
				port: 80,
			}),
		).toThrow();
		expect(() =>
			parseDshWebCommand({
				requestId: "r1",
				action: "start",
				clientId: "c1",
				port: 30123,
				extra: 1,
			}),
		).toThrow();
	});

	it("解析成功与失败结果", () => {
		expect(
			parseDshWebCommandResult({
				requestId: "r1",
				ok: true,
				port: 30123,
				token: "tok",
			}),
		).toMatchObject({ ok: true, port: 30123, token: "tok" });
		expect(
			parseDshWebCommandResult({
				requestId: "r1",
				ok: false,
				error: { code: "DSH_WEB_START_FAILED", message: "boom" },
			}),
		).toMatchObject({
			ok: false,
			error: { code: "DSH_WEB_START_FAILED", message: "boom" },
		});
	});

	it("拒绝缺字段的结果", () => {
		expect(() => parseDshWebCommandResult({ requestId: "r1" })).toThrow();
	});
});
