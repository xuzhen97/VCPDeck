import { describe, expect, it } from "vitest";
import {
	PI_RUNTIME_SPEC_PROTOCOL_VERSION,
	isPiToolExecutionMode,
	parsePiCredentialLease,
	parsePiCredentialLeaseV2,
	parsePiRuntimeAck,
	parsePiRuntimeSpecMessageV3,
	parsePiRuntimeSpecMessageV4,
	parsePiRuntimeSpecV1,
	parsePiRuntimeSpecV3,
	parsePiRuntimeSpecV4,
} from "./pi.js";

const validSpec = {
	schemaVersion: 1,
	specId: "s1",
	profileId: "p1",
	profileRevision: 3,
	modelPolicy: {
		defaultModel: { provider: "anthropic", modelId: "claude-x" },
		allowedModels: [
			{ provider: "anthropic", modelId: "claude-x" },
			{ provider: "openai", modelId: "gpt-y", maxThinkingLevel: "high" },
		],
		defaultThinkingLevel: "medium",
	},
	runtimeRevision: "0123456789abcdef",
};

const validLease = {
	issuedAt: "2026-09-20T00:00:00.000Z",
	entries: [{ provider: "anthropic", apiKey: "sk-live-abc" }],
};

const validV3Spec = {
	schemaVersion: 3,
	specId: "s3",
	profileId: "p1",
	profileRevision: 4,
	providers: [
		{
			providerId: "company-openai",
			name: "公司 OpenAI",
			protocol: "openai-responses",
			baseUrl: "https://llm.example.test/v1",
			headers: { "x-tenant": "team-a" },
			models: [
				{ id: "gpt-test", name: "GPT Test", metadataSource: "catalog" },
				{
					id: "custom-test",
					name: "Custom Test",
					metadataSource: "explicit",
					metadata: {
						id: "custom-test",
						name: "Custom Test",
						api: "openai-responses",
						reasoning: true,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						compat: {},
					},
				},
			],
		},
	],
	modelPolicy: {
		defaultModel: { provider: "company-openai", modelId: "gpt-test" },
		allowedModels: [{ provider: "company-openai", modelId: "gpt-test" }],
		defaultThinkingLevel: "medium",
	},
	toolPolicy: { allow: ["read", "grep"], confirm: ["bash"], deny: ["write"] },
	runtimeRevision: "0123456789abcdef",
};

const validLeaseV2 = {
	issuedAt: "2026-09-20T00:00:00.000Z",
	entries: [{ providerId: "company-openai", apiKey: "sk-live-abc" }],
};

describe("parsePiRuntimeSpecV3", () => {
	it("接受 Provider 配置、模型目录与工具策略", () => {
		expect(parsePiRuntimeSpecV3(validV3Spec)).toEqual(validV3Spec);
	});

	it("接受带 requiredBundle 的 Spec", () => {
		const spec = {
			...validV3Spec,
			requiredBundle: {
				protocolVersion: 1,
				bundleVersion: "0.11.0",
				resourceIds: ["vcp.tool-policy"],
			},
		};
		expect(parsePiRuntimeSpecV3(spec).requiredBundle).toEqual(
			spec.requiredBundle,
		);
	});

	it("拒绝 v1/v2 schemaVersion", () => {
		expect(() =>
			parsePiRuntimeSpecV3({ ...validV3Spec, schemaVersion: 2 }),
		).toThrow(/schemaVersion/);
		expect(() =>
			parsePiRuntimeSpecV3({ ...validV3Spec, schemaVersion: 1 }),
		).toThrow(/schemaVersion/);
	});

	it("拒绝未知字段", () => {
		expect(() => parsePiRuntimeSpecV3({ ...validV3Spec, extra: 1 })).toThrow(
			/未知字段/,
		);
	});

	it("缺少 toolPolicy 时拒绝（策略不可省略）", () => {
		const { toolPolicy: _ignored, ...withoutPolicy } = validV3Spec;
		expect(() => parsePiRuntimeSpecV3(withoutPolicy)).toThrow(/缺少字段/);
	});

	it("拒绝非法工具策略（跨桶与未知工具）", () => {
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				toolPolicy: { allow: ["bash"], confirm: ["bash"], deny: [] },
			}),
		).toThrow(/互斥/);
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				toolPolicy: { allow: ["nope"], confirm: [], deny: [] },
			}),
		).toThrow(/未知工具/);
	});

	it("拒绝非法 requiredBundle", () => {
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				requiredBundle: {
					protocolVersion: 2,
					bundleVersion: "0.11.0",
					resourceIds: ["vcp.tool-policy"],
				},
			}),
		).toThrow(/protocolVersion/);
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				requiredBundle: {
					protocolVersion: 1,
					bundleVersion: "0.11.0",
					resourceIds: [],
				},
			}),
		).toThrow(/resourceIds/);
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				requiredBundle: {
					protocolVersion: 1,
					bundleVersion: "0.11.0",
					resourceIds: ["vcp.tool-policy", "vcp.tool-policy"],
				},
			}),
		).toThrow(/重复/);
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				requiredBundle: {
					protocolVersion: 1,
					bundleVersion: "0.11.0",
					resourceIds: ["vcp.tool-policy"],
					extra: true,
				},
			}),
		).toThrow(/未知字段/);
	});

	it("catalog 模型不得携带 metadata，explicit 模型必须有匹配 metadata", () => {
		const provider = validV3Spec.providers[0];
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				providers: [
					{
						...provider,
						models: [
							{
								id: "gpt-test",
								name: "GPT Test",
								metadataSource: "catalog",
								metadata: {},
							},
						],
					},
				],
			}),
		).toThrow(/metadata/);
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				providers: [
					{
						...provider,
						models: [
							{ id: "gpt-test", name: "GPT Test", metadataSource: "explicit" },
						],
					},
				],
			}),
		).toThrow(/metadata/);
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				providers: [
					{
						...provider,
						models: [
							{ id: "gpt-test", name: "GPT Test", metadataSource: "guessed" },
						],
					},
				],
			}),
		).toThrow(/metadataSource/);
	});

	it("拒绝秘密 Header 与目录外模型", () => {
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				providers: [
					{ ...validV3Spec.providers[0], headers: { authorization: "x" } },
				],
			}),
		).toThrow(/Header|秘密/);
		expect(() =>
			parsePiRuntimeSpecV3({
				...validV3Spec,
				modelPolicy: {
					...validV3Spec.modelPolicy,
					allowedModels: [
						{ provider: "company-openai", modelId: "missing" },
					],
				},
			}),
		).toThrow(/model|模型/i);
	});
});

describe("parsePiRuntimeSpecMessageV3", () => {
	it("校验 lease 的 providerId 必须与 Spec 完全匹配", () => {
		expect(
			parsePiRuntimeSpecMessageV3({
				spec: validV3Spec,
				credentials: validLeaseV2,
			}),
		).toMatchObject({ spec: validV3Spec, credentials: validLeaseV2 });
		expect(() =>
			parsePiRuntimeSpecMessageV3({
				spec: validV3Spec,
				credentials: {
					...validLeaseV2,
					entries: [{ providerId: "other", apiKey: "sk" }],
				},
			}),
		).toThrow(/不匹配/);
	});

	it("保留工具策略（策略不得在 envelope 层丢失）", () => {
		const parsed = parsePiRuntimeSpecMessageV3({
			spec: validV3Spec,
			credentials: validLeaseV2,
		});
		expect(parsed.spec.toolPolicy).toEqual(validV3Spec.toolPolicy);
	});
});

describe("parsePiRuntimeSpecV4（执行模式随协议升级）", () => {
	const validV4Spec = {
		...validV3Spec,
		schemaVersion: 4,
		toolExecutionMode: "auto",
	};

	it("接受严格 v4 Spec 并暴露当前协议版本 4", () => {
		expect(parsePiRuntimeSpecV4(validV4Spec)).toEqual(validV4Spec);
		expect(PI_RUNTIME_SPEC_PROTOCOL_VERSION).toBe(4);
	});

	it("模式判断函数只接受三种合法值", () => {
		expect(isPiToolExecutionMode("approval")).toBe(true);
		expect(isPiToolExecutionMode("auto")).toBe(true);
		expect(isPiToolExecutionMode("yolo")).toBe(true);
		expect(isPiToolExecutionMode("unsafe")).toBe(false);
		expect(isPiToolExecutionMode(undefined)).toBe(false);
		expect(isPiToolExecutionMode(3)).toBe(false);
	});

	it("缺少或非法 toolExecutionMode 时拒绝", () => {
		const { toolExecutionMode: _mode, ...withoutMode } = validV4Spec;
		expect(() => parsePiRuntimeSpecV4(withoutMode)).toThrow(/toolExecutionMode/);
		expect(() =>
			parsePiRuntimeSpecV4({ ...validV4Spec, toolExecutionMode: "unsafe" }),
		).toThrow(/toolExecutionMode/);
	});

	it("拒绝 v3 输入与未知顶层字段", () => {
		expect(() => parsePiRuntimeSpecV4(validV3Spec)).toThrow(/schemaVersion/);
		expect(() => parsePiRuntimeSpecV4({ ...validV4Spec, extra: 1 })).toThrow(
			/未知字段/,
		);
	});

	it("v4 仍复用 Provider/模型/策略与 Bundle 严格校验", () => {
		expect(() =>
			parsePiRuntimeSpecV4({
				...validV4Spec,
				toolPolicy: { allow: ["bash"], confirm: ["bash"], deny: [] },
			}),
		).toThrow(/互斥/);
		expect(() =>
			parsePiRuntimeSpecV4({
				...validV4Spec,
				requiredBundle: {
					protocolVersion: 1,
					bundleVersion: "0.11.0",
					resourceIds: ["vcp.tool-policy"],
				},
			}),
		).not.toThrow();
	});
});

describe("parsePiRuntimeSpecMessageV4", () => {
	const spec = { ...validV3Spec, schemaVersion: 4, toolExecutionMode: "yolo" };

	it("校验 lease 的 providerId 必须与 Spec 完全匹配", () => {
		expect(
			parsePiRuntimeSpecMessageV4({ spec, credentials: validLeaseV2 }),
		).toMatchObject({ spec, credentials: validLeaseV2 });
		expect(() =>
			parsePiRuntimeSpecMessageV4({
				spec,
				credentials: {
					...validLeaseV2,
					entries: [{ providerId: "other", apiKey: "sk" }],
				},
			}),
		).toThrow(/不匹配/);
	});

	it("拒绝未知顶层字段与 v3 spec", () => {
		expect(() =>
			parsePiRuntimeSpecMessageV4({
				spec,
				credentials: validLeaseV2,
				extra: true,
			}),
		).toThrow(/未知字段/);
		expect(() =>
			parsePiRuntimeSpecMessageV4({
				spec: validV3Spec,
				credentials: validLeaseV2,
			}),
		).toThrow(/schemaVersion/);
	});
});

describe("v1 与 lease 解析保持不变", () => {
	it("v1 仍可解析", () => {
		expect(parsePiRuntimeSpecV1(validSpec).schemaVersion).toBe(1);
		expect(parsePiCredentialLease(validLease).entries).toHaveLength(1);
	});

	it("v2 lease 与 ACK 仍可解析", () => {
		expect(parsePiCredentialLeaseV2(validLeaseV2).entries).toHaveLength(1);
		expect(
			parsePiRuntimeAck({
				clientId: "c1",
				specId: "s3",
				runtimeRevision: "0123456789abcdef",
				configState: "ready",
			}).configState,
		).toBe("ready");
	});
});
