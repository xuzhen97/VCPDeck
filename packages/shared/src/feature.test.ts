import { describe, expect, it } from "vitest";
import {
	FEATURE_STALE_AFTER_DAYS,
	FeatureProtocolError,
	getFeatureFreshness,
	parseFeatureCreateInput,
	parseFeatureInputs,
	parseFeatureInvocation,
	parseFeatureUpdateInput,
	parseFeatureVerificationReport,
} from "./feature.js";

function validCreate() {
	return {
		clientId: "c1",
		slug: "comfyui-t2i",
		name: "ComfyUI 文生图",
		summary: "按工作流出图",
		scope: "generic",
		invoke: {
			kind: "http",
			method: "POST",
			url: "http://192.168.100.215:8188/prompt",
		},
		verify: {
			kind: "http",
			method: "GET",
			url: "http://192.168.100.215:8188/system_stats",
		},
		inputs: [],
		output: "PNG 落盘到 host 侧 output/",
		notes: "",
	};
}

describe("parseFeatureCreateInput", () => {
	it("接受合法条目并补默认超时", () => {
		const parsed = parseFeatureCreateInput(validCreate());
		expect(parsed.invoke.timeoutSeconds).toBe(60);
		expect(parsed.scope).toBe("generic");
	});

	it("拒绝 URL 携带 userinfo", () => {
		const input = validCreate();
		input.invoke.url = "http://user:pass@192.168.100.215:8188/prompt";
		expect(() => parseFeatureCreateInput(input)).toThrow(FeatureProtocolError);
	});

	it("拒绝未知字段", () => {
		expect(() =>
			parseFeatureCreateInput({ ...validCreate(), extra: 1 }),
		).toThrow(FeatureProtocolError);
	});
});

describe("parseFeatureUpdateInput", () => {
	it("拒绝把 status 写成 active", () => {
		expect(() => parseFeatureUpdateInput({ status: "active" })).toThrow(
			FeatureProtocolError,
		);
	});

	it("拒绝修改 slug 与 clientId", () => {
		expect(() => parseFeatureUpdateInput({ slug: "x" })).toThrow(
			FeatureProtocolError,
		);
		expect(() => parseFeatureUpdateInput({ clientId: "c2" })).toThrow(
			FeatureProtocolError,
		);
	});
});

describe("getFeatureFreshness", () => {
	const now = new Date("2026-10-18T00:00:00.000Z");

	it("从未验证返回 never", () => {
		expect(getFeatureFreshness(null, now)).toBe("never");
	});

	it("正好 14 天仍为 fresh，超过 1 毫秒变 stale", () => {
		const edge = new Date(
			now.getTime() - FEATURE_STALE_AFTER_DAYS * 86_400_000,
		);
		expect(getFeatureFreshness(edge.toISOString(), now)).toBe("fresh");
		expect(
			getFeatureFreshness(new Date(edge.getTime() - 1).toISOString(), now),
		).toBe("stale");
	});

	it("损坏时间串按从未验证处理", () => {
		expect(getFeatureFreshness("not-a-date", now)).toBe("never");
	});
});

describe("parseFeatureInvocation", () => {
	it("命令型超长时拒绝", () => {
		expect(() =>
			parseFeatureInvocation({ kind: "command", command: "x".repeat(4_001) }),
		).toThrow(FeatureProtocolError);
	});

	it("timeoutSeconds 为 0 时拒绝", () => {
		expect(() =>
			parseFeatureInvocation({
				kind: "http",
				method: "GET",
				url: "http://a/b",
				timeoutSeconds: 0,
			}),
		).toThrow(FeatureProtocolError);
	});

	it("未知 kind 拒绝", () => {
		expect(() => parseFeatureInvocation({ kind: "grpc" })).toThrow(
			FeatureProtocolError,
		);
	});
});

describe("parseFeatureInputs", () => {
	it("重复 name 拒绝", () => {
		expect(() =>
			parseFeatureInputs([
				{ name: "prompt", type: "string", required: true, description: "a" },
				{ name: "prompt", type: "string", required: false, description: "b" },
			]),
		).toThrow(FeatureProtocolError);
	});

	it("enum 缺少 options 拒绝", () => {
		expect(() =>
			parseFeatureInputs([
				{ name: "mode", type: "enum", required: true, description: "a" },
			]),
		).toThrow(FeatureProtocolError);
	});

	it("非 enum 携带 options 拒绝", () => {
		expect(() =>
			parseFeatureInputs([
				{
					name: "mode",
					type: "string",
					required: true,
					description: "a",
					options: ["x"],
				},
			]),
		).toThrow(FeatureProtocolError);
	});
});

describe("parseFeatureVerificationReport", () => {
	it("非法 via 拒绝", () => {
		expect(() =>
			parseFeatureVerificationReport({ ok: true, via: "server" }),
		).toThrow(FeatureProtocolError);
	});

	it("证据超长时截断到 2000", () => {
		const report = parseFeatureVerificationReport({
			ok: true,
			via: "cli",
			evidence: "x".repeat(3_000),
		});
		expect(report.evidence?.length).toBe(2_000);
	});
});

describe("文本上限", () => {
	it("notes 超过 8000 字符拒绝", () => {
		const input = validCreate();
		expect(() =>
			parseFeatureCreateInput({ ...input, notes: "n".repeat(8_001) }),
		).toThrow(FeatureProtocolError);
	});

	it("显式 null 的 sourceJobId 归一化为 null", () => {
		const parsed = parseFeatureCreateInput({
			...validCreate(),
			sourceJobId: null,
		});
		expect(parsed.sourceJobId).toBeNull();
	});

	it("slug 含大写拒绝", () => {
		const input = validCreate();
		expect(() =>
			parseFeatureCreateInput({ ...input, slug: "ComfyUI-T2I" }),
		).toThrow(FeatureProtocolError);
	});
});
