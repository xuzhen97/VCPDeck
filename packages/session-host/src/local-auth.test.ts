import { describe, expect, it } from "vitest";
import {
	generateAuthToken,
	isAuthenticatedLocalRequest,
	parseAuthorizationHeader,
	verifyAuthToken,
} from "./local-auth.js";

const TOKEN = "a".repeat(64);

describe("宿主本机认证", () => {
	it("令牌为 64 位十六进制且每次不同", () => {
		const first = generateAuthToken();
		const second = generateAuthToken();
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(first).not.toBe(second);
	});

	it("令牌由注入的随机源决定，可确定性重放", () => {
		expect(generateAuthToken(() => Buffer.alloc(32, 7))).toBe("07".repeat(32));
	});

	it("正确令牌放行，错误令牌拒绝", () => {
		expect(verifyAuthToken(TOKEN, TOKEN)).toBe(true);
		expect(verifyAuthToken(TOKEN.slice(0, -1), TOKEN)).toBe(false);
		expect(verifyAuthToken(`${TOKEN}x`, TOKEN)).toBe(false);
	});

	it("缺失或非字符串令牌拒绝，且不抛异常", () => {
		expect(verifyAuthToken(undefined, TOKEN)).toBe(false);
		expect(verifyAuthToken(null, TOKEN)).toBe(false);
		expect(verifyAuthToken(12345, TOKEN)).toBe(false);
		// 长度为 0 的期望值意味着未配置，必须拒绝而不是放行。
		expect(verifyAuthToken("", "")).toBe(false);
	});

	it("长度不等时返回 false 而不是抛异常", () => {
		expect(() => verifyAuthToken("short", TOKEN)).not.toThrow();
		expect(verifyAuthToken("short", TOKEN)).toBe(false);
	});

	it("Bearer 头解析：合法形式", () => {
		expect(parseAuthorizationHeader(`Bearer ${TOKEN}`)).toBe(TOKEN);
		expect(parseAuthorizationHeader(`bearer ${TOKEN}`)).toBe(TOKEN);
		expect(parseAuthorizationHeader(`  BEARER   ${TOKEN}  `)).toBe(TOKEN);
	});

	it("Bearer 头解析：非法形式一律拒绝", () => {
		expect(parseAuthorizationHeader(TOKEN)).toBeUndefined();
		expect(parseAuthorizationHeader("Bearer")).toBeUndefined();
		expect(parseAuthorizationHeader("Bearer   ")).toBeUndefined();
		expect(parseAuthorizationHeader("Basic abc")).toBeUndefined();
		expect(parseAuthorizationHeader("")).toBeUndefined();
		expect(parseAuthorizationHeader(undefined)).toBeUndefined();
		// 多段令牌不接受：避免解析歧义。
		expect(parseAuthorizationHeader(`Bearer ${TOKEN} extra`)).toBeUndefined();
		expect(parseAuthorizationHeader(`x`.repeat(600))).toBeUndefined();
	});

	it("本机请求放行判定覆盖完整路径", () => {
		expect(isAuthenticatedLocalRequest(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
		expect(isAuthenticatedLocalRequest("Bearer wrong", TOKEN)).toBe(false);
		expect(isAuthenticatedLocalRequest(undefined, TOKEN)).toBe(false);
	});
});
