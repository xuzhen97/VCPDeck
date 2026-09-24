import { describe, expect, it, vi } from "vitest";
import type {
	PiCredentialLeaseV2,
	PiModelRef,
	PiRuntimeProviderSpec,
	PiRuntimeSpecMessageV4,
} from "@vcpdeck/shared";
import { PI_BUILTIN_TOOL_IDS } from "@vcpdeck/shared";
import {
	effectiveDefaultModel,
	evaluateRuntimeSpec,
	resolveModelRegistrations,
	toolSetsFor,
	type ModelRuntimeLike,
} from "./runtime-spec.js";

const explicitMetadata = {
	id: "gpt-custom",
	name: "GPT Custom",
	reasoning: true,
	input: ["text" as const],
	contextWindow: 128000,
	maxTokens: 8192,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	compat: {},
};

const providers: PiRuntimeProviderSpec[] = [
	{
		providerId: "anthropic",
		name: "Anthropic",
		protocol: "anthropic-messages",
		headers: {},
		models: [
			{ id: "claude-x", name: "Claude X", metadataSource: "catalog" },
			{ id: "claude-y", name: "Claude Y", metadataSource: "catalog" },
		],
	},
	{
		providerId: "custom",
		name: "Custom",
		protocol: "openai-completions",
		baseUrl: "https://llm.example.test/v1",
		headers: {},
		models: [
			{
				id: "gpt-custom",
				name: "GPT Custom",
				metadataSource: "explicit",
				metadata: explicitMetadata,
			},
		],
	},
];

/** 内置目录桩：只声明 claude-x 与其真实元数据，claude-y 故意缺失。 */
const builtinCatalog: Record<string, Record<string, unknown>> = {
	"anthropic/claude-x": {
		id: "claude-x",
		name: "Claude X",
		api: "anthropic-messages",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		compat: { supportsStrictTools: true },
		thinkingLevelMap: { off: null, max: "max" },
		promptCache: { short: 300 },
		baseUrl: "https://api.anthropic.com",
	},
};

function message(overrides: {
	defaultModel?: { provider: string; modelId: string };
	allowedModels?: PiModelRef[];
	entries?: Array<{ providerId: string; apiKey: string }>;
} = {}): PiRuntimeSpecMessageV4 {
	return {
		spec: {
			schemaVersion: 4,
			specId: "s1",
			profileId: "p1",
			profileRevision: 3,
			providers,
			modelPolicy: {
				defaultModel: overrides.defaultModel ?? { provider: "anthropic", modelId: "claude-x" },
				allowedModels: overrides.allowedModels ?? [
					{ provider: "anthropic", modelId: "claude-x" },
					{ provider: "custom", modelId: "gpt-custom" },
				],
				defaultThinkingLevel: "medium",
			},
			toolPolicy: { allow: ["read"], confirm: ["bash"], deny: [] },
			toolExecutionMode: "auto",
			runtimeRevision: "0123456789abcdef",
		},
		credentials: {
			issuedAt: "2026-09-20T00:00:00.000Z",
			entries: overrides.entries ?? [
				{ providerId: "anthropic", apiKey: "sk-live-abc" },
				{ providerId: "custom", apiKey: "sk-live-def" },
			],
		},
	};
}

function makeRuntime(available: string[]): ModelRuntimeLike {
	return {
		getModel: (providerId, modelId) =>
			(builtinCatalog[`${providerId}/${modelId}`] as never) ?? undefined,
		getAvailable: async () =>
			available.map((entry) => {
				const [provider, id] = entry.split("/");
				return { provider: provider!, id: id! };
			}),
	};
}

function fakeRuntimeFactory(available: string[]) {
	return async () => ({
		runtime: makeRuntime(available),
		missingCatalogModels: [] as PiModelRef[],
	});
}

describe("resolveModelRegistrations", () => {
	it("catalog 模型取内置定义并保留内置元数据，只覆盖 baseUrl", () => {
		const runtime = makeRuntime([]);
		const { registers, missingCatalogModels } = resolveModelRegistrations(
			runtime,
			providers,
		);

		expect(missingCatalogModels).toEqual([
			{ provider: "anthropic", modelId: "claude-y" },
		]);
		const anthropic = registers.find(
			(register) => register.providerId === "anthropic",
		);
		const models = anthropic?.config.models as Array<Record<string, unknown>>;
		expect(models).toHaveLength(1);
		// 真实上下文窗口与成本来自内置目录，不能被占位值覆盖。
		expect(models[0]).toMatchObject({
			id: "claude-x",
			contextWindow: 1000000,
			maxTokens: 128000,
			reasoning: true,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			thinkingLevelMap: { off: null, max: "max" },
			promptCache: { short: 300 },
		});
		// 未配置 baseUrl 时沿用内置 baseUrl。
		expect(models[0]?.baseUrl).toBe("https://api.anthropic.com");
	});

	it("Provider 配置的 baseUrl 覆盖目录 baseUrl", () => {
		const runtime = makeRuntime([]);
		const withProxy: PiRuntimeProviderSpec[] = [
			{ ...providers[0]!, baseUrl: "https://proxy.example.test/anthropic" },
		];
		const { registers } = resolveModelRegistrations(runtime, withProxy);
		const models = registers[0]?.config.models as Array<Record<string, unknown>>;
		expect(models[0]?.baseUrl).toBe("https://proxy.example.test/anthropic");
	});

	it("显式元数据原样下发", () => {
		const runtime = makeRuntime([]);
		const { registers } = resolveModelRegistrations(runtime, providers);
		const custom = registers.find((register) => register.providerId === "custom");
		const models = custom?.config.models as Array<Record<string, unknown>>;
		expect(models[0]).toMatchObject({
			id: "gpt-custom",
			contextWindow: 128000,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			// 显式模型没有 baseUrl 字段，沿用 Provider 端点。
			baseUrl: "https://llm.example.test/v1",
		});
	});

	it("全部模型缺失内置定义时不注册该 Provider（不得放大可用面）", () => {
		const runtime = makeRuntime([]);
		const onlyMissing: PiRuntimeProviderSpec[] = [
			{
				...providers[0]!,
				models: [{ id: "nope", name: "Nope", metadataSource: "catalog" }],
			},
		];
		const { registers, missingCatalogModels } = resolveModelRegistrations(
			runtime,
			onlyMissing,
		);
		expect(registers).toEqual([]);
		expect(missingCatalogModels).toEqual([
			{ provider: "anthropic", modelId: "nope" },
		]);
	});
});

describe("evaluateRuntimeSpec", () => {
	it("注册 Server Provider 后按凭据与目录求可用模型交集", async () => {
		const state = await evaluateRuntimeSpec(message(), {
			createModelRuntime: fakeRuntimeFactory([
				"anthropic/claude-x",
				"custom/gpt-custom",
				"other/unknown",
			]),
		});
		expect(state).toMatchObject({ configState: "ready", runtimeRevision: "0123456789abcdef" });
		expect(state.config?.resolvedModels).toEqual([
			{ provider: "anthropic", modelId: "claude-x" },
			{ provider: "custom", modelId: "gpt-custom" },
		]);
	});

	it("catalog 模型缺失内置定义时单项 fail closed 并标注原因", async () => {
		const state = await evaluateRuntimeSpec(
			message({
				defaultModel: { provider: "anthropic", modelId: "claude-x" },
				allowedModels: [
					{ provider: "anthropic", modelId: "claude-x" },
					{ provider: "anthropic", modelId: "claude-y" },
				],
			}),
			{
				createModelRuntime: async () => ({
					runtime: makeRuntime(["anthropic/claude-x"]),
					missingCatalogModels: [
						{ provider: "anthropic", modelId: "claude-y" },
					],
				}),
			},
		);
		expect(state.configState).toBe("ready");
		expect(state.config?.resolvedModels).toEqual([
			{ provider: "anthropic", modelId: "claude-x" },
		]);
		expect(state.config?.unavailableModels).toEqual([
			{ provider: "anthropic", modelId: "claude-y", reason: "model_not_in_catalog" },
		]);
	});

	it("未收到 Spec → pending 且不持有凭据", async () => {
		expect(await evaluateRuntimeSpec(null)).toMatchObject({ configState: "pending", config: null, runtimeRevision: null });
	});

	it("v3 或畸形 Spec → incompatible（v4 硬切换，不回退）", async () => {
		expect(await evaluateRuntimeSpec({ spec: { schemaVersion: 1 }, credentials: {} })).toMatchObject({
			configState: "incompatible",
			reasonCode: "PI_RUNTIME_SPEC_INCOMPATIBLE",
		});
		const legacy = message();
		const { toolExecutionMode: _mode, ...withoutMode } = legacy.spec;
		expect(
			await evaluateRuntimeSpec({
				...legacy,
				spec: { ...withoutMode, schemaVersion: 3 },
			}),
		).toMatchObject({
			configState: "incompatible",
			reasonCode: "PI_RUNTIME_SPEC_INCOMPATIBLE",
		});
	});

	it("模型交集为空 → incompatible + PI_CREDENTIAL_UNAVAILABLE", async () => {
		const state = await evaluateRuntimeSpec(message(), {
			createModelRuntime: fakeRuntimeFactory(["other/unknown"]),
		});
		expect(state).toMatchObject({ configState: "incompatible", reasonCode: "PI_CREDENTIAL_UNAVAILABLE", config: null });
	});

	it("默认模型不可用但交集非空 → ready，并选择第一个可用模型", async () => {
		const state = await evaluateRuntimeSpec(message({
			defaultModel: { provider: "anthropic", modelId: "claude-y" },
			allowedModels: [
				{ provider: "anthropic", modelId: "claude-y" },
				{ provider: "anthropic", modelId: "claude-x" },
			],
		}), { createModelRuntime: fakeRuntimeFactory(["anthropic/claude-x"]) });
		expect(state.configState).toBe("ready");
		expect(effectiveDefaultModel(state.config!)).toEqual({ provider: "anthropic", modelId: "claude-x" });
	});

	it("Provider registration 失败 → incompatible 且不创建可用配置", async () => {
		const state = await evaluateRuntimeSpec(message(), {
			createModelRuntime: async () => { throw new Error("registration failed"); },
		});
		expect(state).toMatchObject({ configState: "incompatible", reasonCode: "PI_CREDENTIAL_UNAVAILABLE", config: null });
	});
});

describe("createModelRuntimeWithLease 与 SDK 目录交互", () => {
	it("catalog 模型经 SDK getModel 解析后注册，绝不下发空 models", async () => {
		vi.resetModules();
		const registerProvider = vi.fn();
		const setRuntimeApiKey = vi.fn(async () => {});
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			ModelRuntime: {
				create: async () => ({
					getModel: (providerId: string, modelId: string) =>
						builtinCatalog[`${providerId}/${modelId}`],
					getAvailable: async () => [],
					registerProvider,
					setRuntimeApiKey,
				}),
			},
		}));
		const { createModelRuntimeWithLease } = await import("./runtime-spec.js");
		const created = await createModelRuntimeWithLease(
			{
				issuedAt: "2026-09-20T00:00:00.000Z",
				entries: [{ providerId: "anthropic", apiKey: "sk-live" }],
			},
			[providers[0]!],
		);

		expect(created.missingCatalogModels).toEqual([
			{ provider: "anthropic", modelId: "claude-y" },
		]);
		expect(registerProvider).toHaveBeenCalledTimes(1);
		const [providerId, config] = registerProvider.mock.calls[0] as [
			string,
			{ models: Array<Record<string, unknown>> },
		];
		expect(providerId).toBe("anthropic");
		expect(config.models).toHaveLength(1);
		expect(config.models[0]).toMatchObject({ id: "claude-x", contextWindow: 1000000 });
		expect(setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "sk-live");
		vi.doUnmock("@earendil-works/pi-coding-agent");
	});
});

describe("toolSetsFor（策略与执行模式的工具映射）", () => {
	it("approval/auto：tools = allow ∪ confirm 去重排序，excludeTools = deny", () => {
		for (const mode of ["approval", "auto"] as const) {
			expect(
				toolSetsFor(
					{
						allow: ["read", "grep"],
						confirm: ["bash", "read"],
						deny: ["write"],
					},
					mode,
				),
			).toEqual({
				tools: ["bash", "grep", "read"],
				excludeTools: ["write"],
			});
		}
	});

	it("approval/auto：空策略得到空白名单（未列出工具全部不可用）", () => {
		expect(toolSetsFor({ allow: [], confirm: [], deny: [] }, "auto")).toEqual({
			tools: [],
			excludeTools: [],
		});
	});

	it("approval/auto：未列出的工具既不进 tools 也不进 excludeTools", () => {
		const { tools, excludeTools } = toolSetsFor(
			{ allow: ["read"], confirm: [], deny: [] },
			"approval",
		);
		expect(tools).not.toContain("bash");
		expect(excludeTools).not.toContain("bash");
	});

	it("yolo：暴露当前 Runtime 的内置工具全集，且不应用 deny", () => {
		expect(
			toolSetsFor({ allow: [], confirm: [], deny: ["bash"] }, "yolo"),
		).toEqual({
			tools: [...PI_BUILTIN_TOOL_IDS].sort(),
			excludeTools: [],
		});
	});
});

describe("requiredBundle 的客户端二次校验", () => {
	const bundleMessage = () => {
		const base = message();
		return {
			...base,
			spec: {
				...base.spec,
				requiredBundle: {
					protocolVersion: 1,
					bundleVersion: "0.11.0",
					resourceIds: ["vcp.tool-policy"],
				},
			},
		};
	};

	it("本地资源覆盖时接纳，并把扩展入口放进 config", async () => {
		const state = await evaluateRuntimeSpec(bundleMessage(), {
			createModelRuntime: fakeRuntimeFactory(["anthropic/claude-x", "custom/gpt-custom"]),
			bundleResourceIds: ["vcp.tool-policy"],
			bundleExtensionPaths: ["/bundle/extensions/vcp-tool-policy/index.js"],
		});

		expect(state.configState).toBe("ready");
		expect(state.config?.bundleExtensionPaths).toEqual([
			"/bundle/extensions/vcp-tool-policy/index.js",
		]);
	});

	it("本地资源缺失时 fail closed（PI_BUNDLE_UNAVAILABLE）", async () => {
		const state = await evaluateRuntimeSpec(bundleMessage(), {
			createModelRuntime: fakeRuntimeFactory(["anthropic/claude-x", "custom/gpt-custom"]),
			bundleResourceIds: [],
			bundleExtensionPaths: [],
		});

		expect(state).toMatchObject({
			configState: "incompatible",
			reasonCode: "PI_BUNDLE_UNAVAILABLE",
			config: null,
		});
	});

	it("缺部分资源同样 fail closed（不得只加载部分策略面）", async () => {
		const base = message();
		const state = await evaluateRuntimeSpec(
			{
				...base,
				spec: {
					...base.spec,
					requiredBundle: {
						protocolVersion: 1,
						bundleVersion: "0.11.0",
						resourceIds: ["vcp.tool-policy", "vcp.other"],
					},
				},
			},
			{
				createModelRuntime: fakeRuntimeFactory(["anthropic/claude-x", "custom/gpt-custom"]),
				bundleResourceIds: ["vcp.tool-policy"],
				bundleExtensionPaths: ["/bundle/extensions/vcp-tool-policy/index.js"],
			},
		);

		expect(state.reasonCode).toBe("PI_BUNDLE_UNAVAILABLE");
	});

	it("未要求 Bundle 时不校验本地资源", async () => {
		const state = await evaluateRuntimeSpec(message(), {
			createModelRuntime: fakeRuntimeFactory(["anthropic/claude-x", "custom/gpt-custom"]),
			bundleResourceIds: [],
			bundleExtensionPaths: [],
		});
		expect(state.configState).toBe("ready");
		expect(state.config?.bundleExtensionPaths).toEqual([]);
	});
});
