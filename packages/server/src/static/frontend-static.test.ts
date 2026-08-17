import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createFrontendFallback } from "./frontend-static.js";

/** 造一个最小请求/响应；sendFile 用 vi.fn 接管。 */
function run(req: {
	method: string;
	path: string;
	accepts?: (type: string) => string | false;
}) {
	const res = { sendFile: vi.fn() };
	const next = vi.fn();
	createFrontendFallback("C:/vcpdeck/public")(req as never, res as never, next);
	return { sendFile: res.sendFile, next };
}

describe("createFrontendFallback", () => {
	it("HTML GET 根路径回退到 index.html", () => {
		const { sendFile, next } = run({
			method: "GET",
			path: "/",
			accepts: () => "html",
		});
		expect(sendFile).toHaveBeenCalledWith(join("C:/vcpdeck/public", "index.html"));
		expect(next).not.toHaveBeenCalled();
	});

	it("HTML GET 前端路由（SPA history 模式）回退到 index.html", () => {
		const { sendFile } = run({
			method: "GET",
			path: "/clients/node-1",
			accepts: () => "html",
		});
		expect(sendFile).toHaveBeenCalledTimes(1);
	});

	it.each([["/api/status"], ["/client/?EIO=4&transport=polling"], ["/app/?EIO=4"]])(
		"%s 不拦截，交给下一处理器",
		(path) => {
			const { sendFile, next } = run({
				method: "GET",
				path,
				accepts: () => "html",
			});
			expect(sendFile).not.toHaveBeenCalled();
			expect(next).toHaveBeenCalledTimes(1);
		},
	);

	it("非 HTML 请求（静态资源）不拦截", () => {
		const { sendFile, next } = run({
			method: "GET",
			path: "/assets/index-abc123.js",
			accepts: () => false,
		});
		expect(sendFile).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("非 GET/HEAD 请求不拦截", () => {
		const { sendFile, next } = run({
			method: "POST",
			path: "/api/jobs",
			accepts: () => "html",
		});
		expect(sendFile).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});
});