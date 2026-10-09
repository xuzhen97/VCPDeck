import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_DEV_ORIGIN,
	isTrustedOrigin,
	resolveCorsOrigin,
	resolveFrontendOrigin,
} from "./trusted-origins.js";

// ADR-0013 的浏览器可信 Origin 策略唯一来源。
// 原先这份策略被抄在 4 个文件的 5 处（main.ts、app.gateway.ts、client.gateway.ts、
// frontend-origin.adapter.ts ×2），其中最容易漏掉的差异是「两个变量互相独立」。
describe("trusted-origins", () => {
	afterEach(() => {
		delete process.env.VCPDECK_FRONTEND_ORIGIN;
		delete process.env.VCPDECK_CORS_ORIGIN;
	});

	it("默认值为文档记载的开发 Origin（docs/deployment.md）", () => {
		expect(DEFAULT_DEV_ORIGIN).toBe("http://localhost:5173");
		expect(resolveFrontendOrigin()).toBe(DEFAULT_DEV_ORIGIN);
		expect(resolveCorsOrigin()).toBe(DEFAULT_DEV_ORIGIN);
	});

	it("显式配置优先于默认值", () => {
		process.env.VCPDECK_FRONTEND_ORIGIN = "https://deck.example";
		process.env.VCPDECK_CORS_ORIGIN = "https://agent.example";
		expect(resolveFrontendOrigin()).toBe("https://deck.example");
		expect(resolveCorsOrigin()).toBe("https://agent.example");
	});

	it("两个变量互相独立：只设其一不影响另一个", () => {
		process.env.VCPDECK_FRONTEND_ORIGIN = "https://deck.example";
		expect(resolveCorsOrigin()).toBe(DEFAULT_DEV_ORIGIN);

		delete process.env.VCPDECK_FRONTEND_ORIGIN;
		process.env.VCPDECK_CORS_ORIGIN = "https://agent.example";
		expect(resolveFrontendOrigin()).toBe(DEFAULT_DEV_ORIGIN);
	});

	it("无 Origin（Node/CLI 客户端）放行", () => {
		expect(isTrustedOrigin(undefined, { headers: {} })).toBe(true);
	});

	it("显式配置的跨源放行", () => {
		expect(isTrustedOrigin("http://localhost:5173", { headers: {} })).toBe(true);
	});

	it("同源（页面与 API 同机同端口）放行", () => {
		expect(
			isTrustedOrigin("http://deck.local:3001", {
				headers: { host: "deck.local:3001" },
			}),
		).toBe(true);
	});

	it("https 同源按加密连接判定", () => {
		const req = {
			headers: { host: "deck.local" },
			connection: { encrypted: true },
		};
		expect(isTrustedOrigin("https://deck.local", req)).toBe(true);
		expect(isTrustedOrigin("http://deck.local", req)).toBe(false);
	});

	it("任意跨源被拒绝（防 CSWSH：/app 走 Cookie 会话）", () => {
		expect(
			isTrustedOrigin("http://evil.example", {
				headers: { host: "deck.local:3001" },
			}),
		).toBe(false);
	});

	it("Host 被篡改但 Origin 不符仍拒绝", () => {
		expect(
			isTrustedOrigin("http://deck.local:3001", {
				headers: { host: "attacker.example" },
			}),
		).toBe(false);
	});
});
