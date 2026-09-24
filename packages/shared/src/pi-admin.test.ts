import { describe, expect, it } from "vitest";
import {
	PiAdminProtocolError,
	parsePiCredentialCreateInput,
	parsePiCredentialUpdateInput,
	parsePiProfileCreateInput,
	parsePiProfileUpdateInput,
	parsePiProviderCreateInput,
	parsePiProviderDiscoveryInput,
	parsePiProviderUpdateInput,
} from "./pi-admin.js";

const validProfile = {
	name: "default",
	defaultModel: { provider: "anthropic", modelId: "claude-x" },
	allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
	defaultThinkingLevel: "medium",
};

const validProvider = {
	name: "公司 OpenAI",
	runtimeProviderId: "company-openai",
	protocol: "openai-responses",
	baseUrl: "https://llm.example.test/v1",
	headers: { "x-tenant": "team-a" },
	models: [
		{
			id: "gpt-test",
			name: "GPT Test",
			metadataSource: "catalog",
		},
		{
			id: "custom-test",
			name: "Custom Test",
			metadataSource: "explicit",
			metadata: {
				id: "custom-test",
				name: "Custom Test",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {},
			},
		},
	],
};

describe("parsePiProvider*Input", () => {
	it("解析 Provider 配置并拒绝秘密 Header", () => {
		expect(parsePiProviderCreateInput(validProvider)).toMatchObject(validProvider);
		expect(() =>
			parsePiProviderCreateInput({
				...validProvider,
				headers: { authorization: "Bearer x" },
			}),
		).toThrow(/Header|秘密/);
	});

	it("解析模型来源判别联合并拒绝不规范组合", () => {
		const provider = parsePiProviderCreateInput(validProvider);
		expect(provider.models?.[0]).toEqual({
			id: "gpt-test",
			name: "GPT Test",
			metadataSource: "catalog",
		});
		expect(provider.models?.[1]).toMatchObject({
			id: "custom-test",
			metadataSource: "explicit",
		});
		expect(() =>
			parsePiProviderCreateInput({
				...validProvider,
				models: [{ id: "x", name: "x", metadataSource: "catalog", metadata: {} }],
			}),
		).toThrow(/不得携带/);
		expect(() =>
			parsePiProviderCreateInput({
				...validProvider,
				models: [{ id: "x", name: "x", metadataSource: "explicit" }],
			}),
		).toThrow();
		expect(() =>
			parsePiProviderCreateInput({
				...validProvider,
				models: [{ id: "x", name: "x", metadataSource: "guessed" }],
			}),
		).toThrow(/metadataSource/);
		expect(() =>
			parsePiProviderCreateInput({
				...validProvider,
				models: [
					{
						id: "x",
						name: "x",
						metadataSource: "explicit",
						metadata: { ...validProvider.models[1].metadata, id: "different" },
					},
				],
			}),
		).toThrow(/不一致/);
	});

	it("接入时可选携带凭据，且更新请求拒绝 credential", () => {
		expect(
			parsePiProviderCreateInput({
				...validProvider,
				credential: { apiKey: "sk-live" },
			}),
		).toMatchObject({ credential: { apiKey: "sk-live" } });
		expect(() =>
			parsePiProviderCreateInput({
				...validProvider,
				credential: { apiKey: "sk-live", providerConfigId: "p" },
			}),
		).toThrow(/未知字段/);
		expect(() =>
			parsePiProviderUpdateInput({ credential: { apiKey: "sk" } }),
		).toThrow(/credential/);
	});

	it("严格解析瞬时模型发现请求并拒绝秘密 Header", () => {
		expect(
			parsePiProviderDiscoveryInput({
				protocol: "anthropic-messages",
				baseUrl: "https://llm.example.test",
				apiKey: "sk-live",
				runtimeProviderId: "anthropic",
			}),
		).toEqual({
			protocol: "anthropic-messages",
			baseUrl: "https://llm.example.test",
			apiKey: "sk-live",
			runtimeProviderId: "anthropic",
		});
		expect(() =>
			parsePiProviderDiscoveryInput({
				protocol: "anthropic-messages",
				baseUrl: "https://llm.example.test",
				apiKey: "sk",
				headers: { "x-api-key": "sk" },
			}),
		).toThrow(/Header|秘密/);
		expect(() =>
			parsePiProviderDiscoveryInput({ protocol: "anthropic-messages", apiKey: "sk" }),
		).toThrow(/baseUrl/);
		expect(() =>
			parsePiProviderDiscoveryInput({
				protocol: "anthropic-messages",
				baseUrl: "https://llm.example.test",
				apiKey: "",
			}),
		).toThrow(/apiKey/);
	});

	it("拒绝未知协议、未知字段、非法 URL 和重复模型", () => {
		expect(() =>
			parsePiProviderCreateInput({ ...validProvider, protocol: "grpc" }),
		).toThrow();
		expect(() =>
			parsePiProviderCreateInput({ ...validProvider, extra: true }),
		).toThrow(/未知字段/);
		expect(() =>
			parsePiProviderCreateInput({ ...validProvider, baseUrl: "file:///tmp/x" }),
		).toThrow();
		expect(() =>
			parsePiProviderCreateInput({
				...validProvider,
				models: [validProvider.models[0], validProvider.models[0]],
			}),
		).toThrow(/重复/);
	});

	it("更新请求允许部分 Provider 字段", () => {
		expect(parsePiProviderUpdateInput({ protocol: "openai-completions" })).toEqual({
			protocol: "openai-completions",
		});
	});
});

describe("parsePiProfileCreateInput", () => {
	it("接受合法请求并保留可选字段", () => {
		expect(
			parsePiProfileCreateInput({
				...validProfile,
				enabled: false,
				credentialIds: ["c1"],
			}),
		).toMatchObject({ name: "default", enabled: false, credentialIds: ["c1"] });
	});

	it("拒绝未知字段、非法 thinking 级别与重复模型", () => {
		expect(() =>
			parsePiProfileCreateInput({ ...validProfile, toolPolicy: {} }),
		).toThrow(PiAdminProtocolError);
		expect(() =>
			parsePiProfileCreateInput({
				...validProfile,
				defaultThinkingLevel: "bogus",
			}),
		).toThrow(/defaultThinkingLevel/);
		expect(() =>
			parsePiProfileCreateInput({
				...validProfile,
				allowedModels: [
					{ provider: "a", modelId: "x" },
					{ provider: "a", modelId: "x" },
				],
			}),
		).toThrow(/重复/);
	});

	it("拒绝非法 defaultModel 与超限 credentialIds", () => {
		expect(() =>
			parsePiProfileCreateInput({ ...validProfile, defaultModel: { provider: "a" } }),
		).toThrow(/defaultModel/);
		expect(() =>
			parsePiProfileCreateInput({
				...validProfile,
				credentialIds: Array.from({ length: 17 }, (_, i) => `c${i}`),
			}),
		).toThrow(/credentialIds/);
	});
});

describe("parsePiProfileUpdateInput", () => {
	it("接受部分字段", () => {
		expect(parsePiProfileUpdateInput({ enabled: true })).toEqual({
			enabled: true,
		});
		expect(
			parsePiProfileUpdateInput({
				defaultModel: { provider: "openai", modelId: "gpt-y" },
			}),
		).toEqual({ defaultModel: { provider: "openai", modelId: "gpt-y" } });
	});

	it("拒绝空请求与未知字段", () => {
		expect(() => parsePiProfileUpdateInput({})).toThrow(/至少/);
		expect(() => parsePiProfileUpdateInput({ nope: 1 })).toThrow(/未知字段/);
	});
});

describe("parsePiCredential*Input", () => {
	it("接受创建请求并拒绝空 apiKey", () => {
		expect(
			parsePiCredentialCreateInput({
				name: "k",
				providerConfigId: "provider-1",
				apiKey: "sk-x",
			}),
		).toEqual({ name: "k", providerConfigId: "provider-1", apiKey: "sk-x" });
		expect(() =>
			parsePiCredentialCreateInput({
				name: "k",
				providerConfigId: "provider-1",
				apiKey: "",
			}),
		).toThrow(/apiKey/);
	});

	it("不接受孤立 provider 字段", () => {
		expect(() =>
			parsePiCredentialCreateInput({
				name: "key",
				provider: "anthropic",
				apiKey: "sk-test",
			}),
		).toThrow(/未知字段|providerConfigId/);
	});

	it("更新请求不允许空对象，也不接受未知字段", () => {
		expect(parsePiCredentialUpdateInput({ apiKey: "sk-y" })).toEqual({
			apiKey: "sk-y",
		});
		expect(() => parsePiCredentialUpdateInput({})).toThrow(/至少/);
		expect(() => parsePiCredentialUpdateInput({ ciphertext: "x" })).toThrow(
			/未知字段/,
		);
	});
});

describe("Profile 的工具策略与 Bundle 资源字段", () => {
	const base = {
		name: "测试",
		defaultModel: { provider: "axonhub", modelId: "mimo" },
		allowedModels: [{ provider: "axonhub", modelId: "mimo" }],
		defaultThinkingLevel: "medium",
	};

	it("创建时解析 toolPolicy 与 enabledResourceIds", () => {
		const parsed = parsePiProfileCreateInput({
			...base,
			toolPolicy: { allow: ["read"], confirm: ["bash"], deny: [] },
			enabledResourceIds: ["vcp.tool-policy"],
		});
		expect(parsed.toolPolicy).toEqual({
			allow: ["read"],
			confirm: ["bash"],
			deny: [],
		});
		expect(parsed.enabledResourceIds).toEqual(["vcp.tool-policy"]);
	});

	it("省略新字段时不产生额外键", () => {
		const parsed = parsePiProfileCreateInput(base);
		expect("toolPolicy" in parsed).toBe(false);
		expect("enabledResourceIds" in parsed).toBe(false);
	});

	it("未知工具名与跨桶冲突按协议错误拒绝（400 而非 500）", () => {
		expect(() =>
			parsePiProfileCreateInput({
				...base,
				toolPolicy: { allow: ["nope"], confirm: [], deny: [] },
			}),
		).toThrow(PiAdminProtocolError);
		expect(() =>
			parsePiProfileCreateInput({
				...base,
				toolPolicy: { allow: ["bash"], confirm: ["bash"], deny: [] },
			}),
		).toThrow(/互斥/);
	});

	it("enabledResourceIds 重复或超限时拒绝", () => {
		expect(() =>
			parsePiProfileCreateInput({
				...base,
				enabledResourceIds: ["vcp.a", "vcp.a"],
			}),
		).toThrow(/重复/);
		expect(() =>
			parsePiProfileCreateInput({
				...base,
				enabledResourceIds: Array.from({ length: 65 }, (_, i) => `vcp.${i}`),
			}),
		).toThrow(/数量/);
	});

	it("更新时可单独提交 toolPolicy", () => {
		const parsed = parsePiProfileUpdateInput({
			toolPolicy: { allow: [], confirm: [], deny: ["bash"] },
		});
		expect(parsed.toolPolicy).toEqual({ allow: [], confirm: [], deny: ["bash"] });
	});

	it("创建/更新时可提交工具执行模式，非法值按协议错误拒绝", () => {
		expect(
			parsePiProfileCreateInput({ ...base, toolExecutionMode: "auto" })
				.toolExecutionMode,
		).toBe("auto");
		expect(parsePiProfileUpdateInput({ toolExecutionMode: "yolo" })).toEqual({
			toolExecutionMode: "yolo",
		});
		expect("toolExecutionMode" in parsePiProfileCreateInput(base)).toBe(false);
		expect(() =>
			parsePiProfileCreateInput({ ...base, toolExecutionMode: "unsafe" }),
		).toThrow(PiAdminProtocolError);
		for (const mode of ["approval", "auto", "yolo"]) {
			expect(
				parsePiProfileUpdateInput({ toolExecutionMode: mode }).toolExecutionMode,
			).toBe(mode);
		}
	});

	it("更新时未知字段仍拒绝", () => {
		expect(() => parsePiProfileUpdateInput({ nope: 1 })).toThrow(/未知字段/);
	});
});
