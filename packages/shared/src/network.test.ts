import { describe, expect, it } from "vitest";
import { describeTransportError } from "./network.js";

function withCause(base: Error, cause: unknown): Error {
	return Object.assign(base, { cause });
}

describe("describeTransportError", () => {
	it("把 cause 链的 code 拼成一行（undici 只暴露 fetch failed）", () => {
		const error = withCause(new TypeError("fetch failed"), { code: "ECONNRESET" });
		expect(describeTransportError(error)).toBe("fetch failed / ECONNRESET");
	});

	it("优先取 code，其次 message，最多展开三层 cause", () => {
		const error = withCause(new Error("outer"), {
			message: "c1",
			cause: { code: "C2", cause: { code: "C3", cause: { code: "C4" } } },
		});
		expect(describeTransportError(error)).toBe("outer / c1 / C2 / C3");
	});

	it("没有 cause 时保留外层消息", () => {
		expect(describeTransportError(new Error("only"))).toBe("only");
	});

	it("非 Error 输入退化为字符串", () => {
		expect(describeTransportError("boom")).toBe("boom");
	});
});
