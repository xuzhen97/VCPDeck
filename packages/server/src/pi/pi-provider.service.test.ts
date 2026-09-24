import { describe, expect, it, vi } from "vitest";
import type { PiCredentialService } from "./pi-credential.service.js";
import { PiProviderService } from "./pi-provider.service.js";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";

const providerRow = {
	id: "provider-1",
	name: "公司 OpenAI",
	runtimeProviderId: "company-openai",
	protocol: "openai-responses",
	baseUrl: "https://llm.example.test/v1",
	headers: JSON.stringify({ "x-tenant": "team-a" }),
	enabled: true,
	revision: 1,
	createdAt: new Date("2026-09-20T00:00:00Z"),
	updatedAt: new Date("2026-09-20T00:00:00Z"),
	models: [],
	credentials: [{ id: "credential-1" }],
};

const explicitModelRow = {
	id: "model-row-1",
	providerId: "provider-1",
	modelId: "custom-test",
	name: "Custom Test",
	metadata: JSON.stringify({
		id: "custom-test",
		name: "Custom Test",
		reasoning: true,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {},
	}),
};

function makeService(
	fetchImpl: typeof fetch = fetch,
	registry?: PiRuntimeRegistry,
) {
	const prisma = {
		piProvider: {
			findUnique: vi.fn().mockResolvedValue(providerRow),
			findMany: vi.fn().mockResolvedValue([providerRow]),
			count: vi.fn().mockResolvedValue(1),
			create: vi.fn().mockResolvedValue(providerRow),
			update: vi.fn().mockResolvedValue(providerRow),
			delete: vi.fn(),
		},
		piProviderModel: {
			createMany: vi.fn(),
			deleteMany: vi.fn(),
		},
		piProfileCredential: {
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		},
		piClientBinding: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		$transaction: vi.fn(async (work: (tx: never) => Promise<unknown>) =>
			work(prisma as never),
		),
	};
	const credentials = {
		resolveProviderSecret: vi.fn().mockResolvedValue("sk-secret"),
		createWithin: vi.fn().mockResolvedValue({ id: "credential-new" }),
	};
	return {
		service: new PiProviderService(
			prisma as never,
			credentials as unknown as PiCredentialService,
			fetchImpl,
			registry,
		),
		credentials,
		prisma,
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("PiProviderService 模型发现", () => {
	it("瞬时发现只请求固定 models 路径，并解析 OpenAI 目录", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				jsonResponse({ data: [{ id: "gpt-test", owned_by: "team" }] }),
			);
		const { service } = makeService(fetchImpl);

		await expect(
			service.discover({
				protocol: "openai-responses",
				baseUrl: "https://llm.example.test/v1",
				headers: { "x-tenant": "team-a" },
				apiKey: "sk-secret",
			}),
		).resolves.toEqual({
			models: [{ id: "gpt-test", name: "gpt-test" }],
			recommendedMetadataSource: "explicit",
			catalogSdkVersion: null,
		});

		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe("https://llm.example.test/v1/models");
		expect(init).toMatchObject({ method: "GET", redirect: "error" });
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: "Bearer sk-secret",
			"x-tenant": "team-a",
		});
	});

	it("anthropic 使用 x-api-key，Google 解析 models/ 前缀与 displayName", async () => {
		const anthropicFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				jsonResponse({ data: [{ id: "claude-x", display_name: "Claude X" }] }),
			);
		const anon = makeService(anthropicFetch);
		await expect(
			anon.service.discover({
				protocol: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				apiKey: "sk-ant",
			}),
		).resolves.toMatchObject({
			models: [{ id: "claude-x", name: "Claude X" }],
		});
		expect((anthropicFetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
			"x-api-key": "sk-ant",
			"anthropic-version": "2023-06-01",
		});

		const googleFetch = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				models: [
					{ name: "models/gemini-x", displayName: "Gemini X" },
					{ name: "models/gemini-y" },
				],
			}),
		);
		const google = makeService(googleFetch);
		await expect(
			google.service.discover({
				protocol: "google-generative-ai",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				apiKey: "goog-key",
			}),
		).resolves.toMatchObject({
			models: [
				{ id: "gemini-x", name: "Gemini X" },
				{ id: "gemini-y", name: "gemini-y" },
			],
		});
		expect((googleFetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
			"x-goog-api-key": "goog-key",
		});
	});

	it("在线 Client 报告内置目录时建议 catalog 来源", async () => {
		const registry = new PiRuntimeRegistry();
		registry.setCapability("c1", {
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 3,
			configMode: "server-authoritative",
		});
		registry.setModelCatalog("c1", {
			sdkVersion: "0.86.0",
			providerIds: ["anthropic", "openai"],
		});
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => jsonResponse({ data: [{ id: "claude-x" }] }));
		const { service } = makeService(fetchImpl, registry);

		await expect(
			service.discover({
				protocol: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				apiKey: "sk",
				runtimeProviderId: "anthropic",
			}),
		).resolves.toMatchObject({
			recommendedMetadataSource: "catalog",
			catalogSdkVersion: "0.86.0",
		});
		await expect(
			service.discover({
				protocol: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				apiKey: "sk",
				runtimeProviderId: "custom-vllm",
			}),
		).resolves.toMatchObject({
			recommendedMetadataSource: "explicit",
			catalogSdkVersion: null,
		});
	});

	it("已保存 Provider 发现复用已存凭据，不返回元数据也不回显 Key", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ data: [{ id: "gpt-test" }] }));
		const { service, credentials } = makeService(fetchImpl);

		await expect(service.discoverModels("provider-1")).resolves.toMatchObject({
			models: [{ id: "gpt-test", name: "gpt-test" }],
		});
		expect(credentials.resolveProviderSecret).toHaveBeenCalledWith("provider-1");
	});

	it("校验失败只返回稳定错误且不回显 Provider 正文或 API Key", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("provider body includes sk-secret"));
		const { service } = makeService(fetchImpl);

		await expect(service.validate("provider-1")).rejects.toMatchObject({
			code: "PI_PROVIDER_VALIDATION_FAILED",
		});
		await expect(service.validate("provider-1")).rejects.not.toThrow("sk-secret");
	});
});

describe("PiProviderService 接入与模型映射", () => {
	it("接入时在同一事务内创建 Provider + 模型 + 凭据，Provider 行不含秘密", async () => {
		const { service, prisma, credentials } = makeService();

		await service.create({
			name: "公司 OpenAI",
			runtimeProviderId: "company-openai",
			protocol: "openai-responses",
			baseUrl: "https://llm.example.test/v1",
			models: [
				{ id: "gpt-test", name: "GPT Test", metadataSource: "catalog" },
			],
			credential: { apiKey: "sk-live-secret" },
		});

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		const createdId = prisma.piProvider.create.mock.calls[0]?.[0]?.data?.id as string;
		expect(createdId).toBeTruthy();
		expect(prisma.piProviderModel.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					providerId: createdId,
					modelId: "gpt-test",
					metadata: null,
				}),
			],
		});
		expect(credentials.createWithin).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				providerConfigId: createdId,
				runtimeProviderId: "company-openai",
				name: "公司 OpenAI",
				apiKey: "sk-live-secret",
			}),
		);
		// Provider 行只写非秘密字段：请求体里的 apiKey 不得出现在任何 Provider 写入中。
		const providerWrites = JSON.stringify([
			prisma.piProvider.create.mock.calls,
			prisma.piProvider.update.mock.calls,
		]);
		expect(providerWrites).not.toContain("sk-live-secret");
	});

	it("显式元数据落库为 JSON，catalog 条目不落元数据", async () => {
		const { service, prisma } = makeService();

		await service.update("provider-1", {
			models: [
				{ id: "gpt-test", name: "GPT Test", metadataSource: "catalog" },
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
		});

		const rows = prisma.piProviderModel.createMany.mock.calls[0]?.[0]?.data ?? [];
		expect(rows[0]).toMatchObject({ modelId: "gpt-test", metadata: null });
		expect(JSON.parse(rows[1].metadata)).toMatchObject({
			id: "custom-test",
			reasoning: true,
		});
	});

	it("显式模型协议与 Provider 不一致时拒绝", async () => {
		const { service } = makeService();

		await expect(
			service.create({
				name: "公司 OpenAI",
				runtimeProviderId: "company-openai",
				protocol: "openai-responses",
				models: [
					{
						id: "custom-test",
						name: "Custom Test",
						metadataSource: "explicit",
						metadata: {
							id: "custom-test",
							name: "Custom Test",
							api: "anthropic-messages",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 8192,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							compat: {},
						},
					},
				],
			}),
		).rejects.toMatchObject({ code: "PI_CONFIG_UNAVAILABLE" });
	});

	it("显式元数据模型必须配置 Base URL（Pi 自定义模型注册要求）", async () => {
		const { service } = makeService();

		await expect(
			service.create({
				name: "本地 vLLM",
				runtimeProviderId: "local-vllm",
				protocol: "openai-completions",
				models: [
					{
						id: "local-model",
						name: "Local Model",
						metadataSource: "explicit",
						metadata: {
							id: "local-model",
							name: "Local Model",
							reasoning: false,
							input: ["text"],
							contextWindow: 32768,
							maxTokens: 8192,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							compat: {},
						},
					},
				],
			}),
		).rejects.toMatchObject({ code: "PI_CONFIG_UNAVAILABLE" });
	});

	it("持久化元数据损坏时读取 fail closed", async () => {
		const { service, prisma } = makeService();
		prisma.piProvider.findUnique.mockResolvedValueOnce({
			...providerRow,
			models: [{ ...explicitModelRow, metadata: "{not-json" }],
		});

		await expect(service.get("provider-1")).rejects.toMatchObject({
			code: "PI_CONFIG_UNAVAILABLE",
		});
	});

	it("持久化 catalog 行（metadata 为 NULL）映射为 catalog 条目", async () => {
		const { service, prisma } = makeService();
		prisma.piProvider.findUnique.mockResolvedValueOnce({
			...providerRow,
			models: [
				{
					id: "model-row-2",
					providerId: "provider-1",
					modelId: "gpt-test",
					name: "GPT Test",
					metadata: null,
				},
			],
		});

		await expect(service.get("provider-1")).resolves.toMatchObject({
			models: [{ id: "gpt-test", name: "GPT Test", metadataSource: "catalog" }],
		});
	});

	it("拒绝删除仍被 Profile 使用的 Provider，并在事务内检查关系", async () => {
		const { service, prisma } = makeService();
		prisma.piProvider.findUnique.mockResolvedValueOnce({
			...providerRow,
			credentials: [{ id: "credential-1" }],
		});
		prisma.piProfileCredential.count.mockResolvedValueOnce(1);

		await expect(service.remove("provider-1")).rejects.toMatchObject({
			code: "PI_CONFIG_UNAVAILABLE",
		});
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(prisma.piProvider.delete).not.toHaveBeenCalled();
	});

	it("删除无关联 Provider 时在事务内执行删除", async () => {
		const { service, prisma } = makeService();
		prisma.piProvider.findUnique.mockResolvedValueOnce({
			...providerRow,
			credentials: [],
		});

		await expect(service.remove("provider-1")).resolves.toBeUndefined();
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(prisma.piProvider.delete).toHaveBeenCalledWith({
			where: { id: "provider-1" },
		});
	});
});

describe("PiProviderService 运行时快照", () => {
	it("按 runtimeProviderId 解析，而不是表行 id", async () => {
		const { service, prisma } = makeService();

		const snapshots = await service.getRuntimeSnapshot(["company-openai"]);

		expect(prisma.piProvider.findMany).toHaveBeenCalledWith({
			where: { runtimeProviderId: { in: ["company-openai"] } },
			include: { models: true, credentials: { select: { id: true } } },
		});
		expect(snapshots.map((provider) => provider.runtimeProviderId)).toEqual([
			"company-openai",
		]);
		expect(snapshots[0]?.configurationState).toBe("ready");
	});

	it("Provider 不存在时 fail closed", async () => {
		const { service, prisma } = makeService();
		prisma.piProvider.findMany.mockResolvedValue([]);

		await expect(service.getRuntimeSnapshot(["missing"])).rejects.toThrow(
			'Provider "missing" 不存在',
		);
	});

	it("Provider 未就绪时 fail closed", async () => {
		const { service, prisma } = makeService();
		prisma.piProvider.findMany.mockResolvedValue([
			{ ...providerRow, protocol: null },
		]);

		await expect(
			service.getRuntimeSnapshot(["company-openai"]),
		).rejects.toThrow("Provider 尚未完成配置");
	});
});
