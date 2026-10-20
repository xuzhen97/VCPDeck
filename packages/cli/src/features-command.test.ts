import type { FeatureInfo } from "@vcpdeck/shared";
import { describe, expect, it, vi } from "vitest";
import { runFeaturesCommand } from "./features-command.js";

const feature: FeatureInfo = {
	id: "ft_1",
	slug: "comfyui-t2i",
	name: "ComfyUI 文生图",
	summary: "按工作流出图",
	clientId: "c1",
	clientName: "silvermoon-box",
	scope: "generic",
	invoke: {
		kind: "http",
		method: "POST",
		url: "http://10.0.0.1:8188/prompt",
		timeoutSeconds: 60,
	},
	verify: {
		kind: "http",
		method: "GET",
		url: "http://10.0.0.1:8188/system_stats",
		timeoutSeconds: 60,
	},
	inputs: [],
	output: "",
	notes: "",
	status: "active",
	freshness: "fresh",
	lastVerifiedAt: "2026-10-18T00:00:00.000Z",
	lastVerifiedOk: true,
	lastVerifyEvidence: "HTTP 200",
	verifiedVia: "cli",
	sourceJobId: null,
	createdByName: "Admin",
	createdVia: "cli",
	createdAt: "2026-10-18T00:00:00.000Z",
	updatedAt: "2026-10-18T00:00:00.000Z",
};

function page(data: FeatureInfo[]) {
	return {
		data,
		total: data.length,
		page: 1,
		pageSize: 100,
		totalPages: 1,
	};
}

function context(data: FeatureInfo[] = [feature]) {
	const log = vi.fn();
	return {
		ctx: {
			log,
			sdk: {
				features: {
					list: vi.fn(async () => page(data)),
					reportVerification: vi.fn(async () => feature),
					create: vi.fn(async () => feature),
					update: vi.fn(async () => feature),
				},
			},
			resolveClientIdFn: vi.fn(async () => "c1"),
		} as never,
		log,
	};
}

describe("runFeaturesCommand", () => {
	it("update 拒绝 --status=active", async () => {
		const { ctx } = context();
		await expect(
			runFeaturesCommand("update", ["comfyui-t2i", "--status=active"], ctx),
		).rejects.toThrow(/active 只能由/);
	});

	it("list --json 只输出可解析 JSON", async () => {
		const { ctx, log } = context();
		await runFeaturesCommand("list", ["--json"], ctx);
		const output = log.mock.calls[0]?.[0] as string;
		expect(() => JSON.parse(output)).not.toThrow();
	});

	it("slug 命中多台 host 且未给 --client 时 fail closed", async () => {
		const second: FeatureInfo = {
			...feature,
			id: "ft_2",
			clientId: "c2",
			clientName: "other-box",
		};
		const { ctx } = context([feature, second]);
		await expect(runFeaturesCommand("get", ["comfyui-t2i"], ctx)).rejects.toThrow(
			/--client/,
		);
	});

	it("get 命中唯一条目时输出详情", async () => {
		const { ctx, log } = context();
		await runFeaturesCommand("get", ["comfyui-t2i"], ctx);
		const output = log.mock.calls[0]?.[0] as string;
		expect(output).toContain("comfyui-t2i");
	});

	it("verify 在条目缺失时报错", async () => {
		const { ctx } = context([]);
		await expect(runFeaturesCommand("verify", ["nope"], ctx)).rejects.toThrow(
			/未找到功能/,
		);
	});

	it("最近验证失败时展示失败文案而非“通过”", async () => {
		const draft: FeatureInfo = {
			...feature,
			status: "draft",
			lastVerifiedOk: false,
			lastVerifyEvidence: "exitCode=1",
		};
		const { ctx, log } = context([draft]);
		await runFeaturesCommand("list", [], ctx);
		const output = log.mock.calls.map((call) => String(call[0])).join("\n");
		expect(output).toContain("最新验证失败");
		expect(output).not.toContain("前通过");
	});

	it("退役条目在 --include-retired 下带“已退役”前缀", async () => {
		// 断言依赖「今天」这一相对时间：把时钟固定到 fixture 的验证时间，
		// 否则跨天之后 lastVerifiedAt 变成「N 天前通过」，测试必然失败。
		vi.useFakeTimers({ now: new Date("2026-10-18T12:00:00.000Z") });
		try {
			const retired: FeatureInfo = {
				...feature,
				id: "ft_retired",
				slug: "old-feature",
				name: "旧条目",
				status: "retired",
			};
			const { ctx, log } = context([retired]);
			await runFeaturesCommand("list", ["--include-retired"], ctx);
			const output = log.mock.calls.map((call) => String(call[0])).join("\n");
			expect(output).toContain("已退役（今天通过）");
		} finally {
			vi.useRealTimers();
		}
	});

	it("--env 在创建客户端前解析并透传", async () => {
		const resolveEnvironmentFn = vi.fn(async () => ({
			name: "localtest",
			server: "http://127.0.0.1:3001",
			auth: { type: "bearer" as const },
			source: "flag" as const,
			credentials: { type: "bearer" as const, token: "t" },
		}));
		const createClientFn = vi.fn(async () => ({
			features: { list: vi.fn(async () => page([feature])) },
		}));
		await runFeaturesCommand("list", ["--env=localtest", "--json"], {
			log: vi.fn(),
			resolveEnvironmentFn: resolveEnvironmentFn as never,
			createClientFn: createClientFn as never,
		});
		expect(resolveEnvironmentFn).toHaveBeenCalledWith(
			expect.objectContaining({ environment: "localtest" }),
		);
		expect(createClientFn).toHaveBeenCalledTimes(1);
	});
});
