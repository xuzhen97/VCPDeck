import { describe, expect, it } from "vitest";
import {
	PI_RUNTIME_SPEC_PROTOCOL_VERSION,
	parsePiCredentialLease,
	parsePiCredentialLeaseV2,
	parsePiRuntimeAck,
	parsePiRuntimeSpecMessageV3,
	parsePiRuntimeSpecV1,
	parsePiRuntimeSpecV3,
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
		expect(PI_RUNTIME_SPEC_PROTOCOL_VERSION).toBe(3);
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
