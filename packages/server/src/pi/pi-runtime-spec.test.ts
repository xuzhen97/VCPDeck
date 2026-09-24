import { describe, expect, it } from "vitest";
import type { PiProfileInfo } from "@vcpdeck/shared";
import {
	buildPiRuntimeSpec,
	buildPiRuntimeSpecV4,
	computeRuntimeRevision,
	parseAllowedModelsColumn,
} from "./pi-runtime-spec.js";

const profile: PiProfileInfo = {
	id: "p1",
	name: "default",
	enabled: true,
	defaultModel: { provider: "anthropic", modelId: "claude-x" },
	allowedModels: [
		{ provider: "anthropic", modelId: "claude-x" },
		{ provider: "openai", modelId: "gpt-y" },
	],
	defaultThinkingLevel: "medium",
	enabledResourceIds: [],
	toolPolicy: { allow: [], confirm: [], deny: [] },
	toolExecutionMode: "auto",
	revision: 3,
	credentialIds: ["c1"],
	boundClientIds: ["client-1"],
};

describe("computeRuntimeRevision", () => {
	const base = {
		profileId: "p1",
		profileRevision: 1,
		credentials: [{ id: "c1", updatedAt: new Date("2026-09-20T00:00:00Z") }],
	};

	it("相同输入稳定，输出 16 位小写 hex", () => {
		const r1 = computeRuntimeRevision(base);
		expect(r1).toMatch(/^[0-9a-f]{16}$/);
		expect(
			computeRuntimeRevision({
				profileId: "p1",
				profileRevision: 1,
				credentials: [{ id: "c1", updatedAt: new Date("2026-09-20T00:00:00Z") }],
			}),
		).toBe(r1);
	});

	it("顺序无关，但 Profile revision 与凭据轮换都会改变结果", () => {
		expect(
			computeRuntimeRevision({
				...base,
				credentials: [
					{ id: "c2", updatedAt: new Date("2026-09-21T00:00:00Z") },
					{ id: "c1", updatedAt: new Date("2026-09-20T00:00:00Z") },
				],
			}),
		).toBe(
			computeRuntimeRevision({
				...base,
				credentials: [
					{ id: "c1", updatedAt: new Date("2026-09-20T00:00:00Z") },
					{ id: "c2", updatedAt: new Date("2026-09-21T00:00:00Z") },
				],
			}),
		);
		expect(computeRuntimeRevision({ ...base, profileRevision: 2 })).not.toBe(
			computeRuntimeRevision(base),
		);
		expect(
			computeRuntimeRevision({
				...base,
				credentials: [{ id: "c1", updatedAt: new Date("2026-09-25T00:00:00Z") }],
			}),
		).not.toBe(computeRuntimeRevision(base));
	});

	it("不含任何 Secret 或路径", () => {
		const revision = computeRuntimeRevision(base);
		expect(revision).not.toContain("sk-");
		expect(revision).not.toContain("/");
	});
});

describe("buildPiRuntimeSpec", () => {
	it("由 Profile 与凭据元数据构造 V1 Spec（不含 Secret）", () => {
		const spec = buildPiRuntimeSpec(profile, [
			{ id: "c1", updatedAt: new Date("2026-09-20T00:00:00Z") },
		]);
		expect(spec.schemaVersion).toBe(1);
		expect(spec.profileId).toBe("p1");
		expect(spec.profileRevision).toBe(3);
		expect(spec.modelPolicy).toEqual({
			defaultModel: { provider: "anthropic", modelId: "claude-x" },
			allowedModels: profile.allowedModels,
			defaultThinkingLevel: "medium",
		});
		expect(spec.runtimeRevision).toMatch(/^[0-9a-f]{16}$/);
		expect(JSON.stringify(spec)).not.toContain("sk-");
		expect(spec.specId).not.toBe("p1");
	});

	it("每次构建生成新的 specId", () => {
		const a = buildPiRuntimeSpec(profile, []);
		const b = buildPiRuntimeSpec(profile, []);
		expect(a.specId).not.toBe(b.specId);
		expect(a.runtimeRevision).toBe(b.runtimeRevision);
	});
});

describe("buildPiRuntimeSpecV4", () => {
	const providers = [
		{
			id: "provider-1",
			name: "Anthropic",
			runtimeProviderId: "anthropic",
			protocol: "anthropic-messages" as const,
			baseUrl: null,
			headers: {},
			enabled: true,
			revision: 1,
			models: [
				{ id: "claude-x", name: "Claude X", metadataSource: "catalog" as const },
			],
			credentialIds: ["c1"],
			boundProfileIds: ["p1"],
			configurationState: "ready" as const,
		},
	];
	const credentials = [{ id: "c1", updatedAt: new Date("2026-09-20T00:00:00Z") }];

	it("构造 v4 Spec：携带模式、策略与 requiredBundle，且不含 Secret", () => {
		const spec = buildPiRuntimeSpecV4(
			{
				...profile,
				toolPolicy: { allow: ["read"], confirm: ["bash"], deny: [] },
				toolExecutionMode: "yolo",
				enabledResourceIds: ["vcp.tool-policy"],
			},
			providers,
			credentials,
			"0.11.0",
		);
		expect(spec).toMatchObject({
			schemaVersion: 4,
			toolExecutionMode: "yolo",
			toolPolicy: { allow: ["read"], confirm: ["bash"], deny: [] },
			requiredBundle: {
				protocolVersion: 1,
				bundleVersion: "0.11.0",
				resourceIds: ["vcp.tool-policy"],
			},
		});
		expect(JSON.stringify(spec)).not.toContain("sk-");
	});

	it("无资源需求时不构造 requiredBundle", () => {
		const spec = buildPiRuntimeSpecV4(profile, providers, credentials);
		expect(spec.requiredBundle).toBeUndefined();
		expect(spec.toolExecutionMode).toBe("auto");
	});
});

describe("parseAllowedModelsColumn", () => {
	it("解析合法 JSON 列", () => {
		expect(
			parseAllowedModelsColumn('[{"provider":"a","modelId":"x"}]'),
		).toEqual([{ provider: "a", modelId: "x" }]);
	});

	it("损坏或形状非法时 fail closed 为空数组而不是崩溃", () => {
		expect(parseAllowedModelsColumn("{not-json")).toEqual([]);
		expect(parseAllowedModelsColumn('{"provider":"a"}')).toEqual([]);
		expect(parseAllowedModelsColumn('[{"provider":"a"}]')).toEqual([]);
	});
});
