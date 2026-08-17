import { describe, expect, it } from "vitest";
import { isFrontendOriginAllowed } from "./frontend-origin.adapter.js";

// 默认配置：VCPDECK_FRONTEND_ORIGIN / VCPDECK_CORS_ORIGIN 均为 http://localhost:5173
describe("isFrontendOriginAllowed", () => {
	it("无 Origin（Node/CLI 客户端）放行", () => {
		expect(isFrontendOriginAllowed(undefined, { headers: {} })).toBe(true);
	});

	it("显式配置的跨源放行", () => {
		expect(
			isFrontendOriginAllowed("http://localhost:5173", { headers: {} }),
		).toBe(true);
	});

	it("同源（页面与 API 同机同端口）放行", () => {
		expect(
			isFrontendOriginAllowed("http://deck.local:3001", {
				headers: { host: "deck.local:3001" },
			}),
		).toBe(true);
	});

	it("任意跨源被拒绝（防 CSWSH：/app 走 Cookie 会话）", () => {
		expect(
			isFrontendOriginAllowed("http://evil.example", {
				headers: { host: "deck.local:3001" },
			}),
		).toBe(false);
	});

	it("Host 被篡改但 Origin 不符仍拒绝", () => {
		expect(
			isFrontendOriginAllowed("http://deck.local:3001", {
				headers: { host: "attacker.example" },
			}),
		).toBe(false);
	});
});