/**
 * Pi Provider 配置与模型目录（Server 权威，不接触凭据明文）。
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
	PiProtocolError,
	parsePiModelMetadata,
	type PaginatedResult,
	type PiModelMetadataSource,
	type PiProviderCreateInput,
	type PiProviderDiscoveryInput,
	type PiProviderDiscoveryResult,
	type PiProviderInfo,
	type PiProviderModel,
	type PiProviderProtocol,
	type PiProviderUpdateInput,
} from "@vcpdeck/shared";
import { PiCredentialService } from "./pi-credential.service.js";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

interface ProviderRow {
	id: string;
	name: string;
	runtimeProviderId: string;
	protocol: string | null;
	baseUrl: string | null;
	headers: string;
	enabled: boolean;
	revision: number;
	createdAt: Date;
	updatedAt: Date;
	models: Array<{
		id: string;
		modelId: string;
		name: string;
		metadata: string | null;
	}>;
	credentials: Array<{ id: string }>;
}

const supportedProtocols = new Set<PiProviderProtocol>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const PROVIDER_RESPONSE_LIMIT = 1024 * 1024;
const PROVIDER_MODEL_LIMIT = 256;

type ProviderFetch = typeof fetch;

function validationError(protocol: string, reason = "request_failed"): Error {
	return piError(
		"PI_PROVIDER_VALIDATION_FAILED",
		`Provider ${protocol} 校验失败（${reason}）`,
	);
}

function jsonObject(raw: string, what: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error();
		}
		return value as Record<string, unknown>;
	} catch {
		throw piError("PI_CONFIG_UNAVAILABLE", `${what} 配置损坏`);
	}
}

/**
 * 持久化模型行 → 对外模型条目。
 * metadata 为 NULL 表示由 Client 侧 Pi 内置目录解析；非 NULL 必须能通过严格解析。
 */
function toModel(row: ProviderRow["models"][number]): PiProviderModel {
	if (row.metadata === null) {
		return { id: row.modelId, name: row.name, metadataSource: "catalog" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.metadata);
	} catch {
		throw piError("PI_CONFIG_UNAVAILABLE", "Provider 模型配置损坏");
	}
	try {
		const metadata = parsePiModelMetadata(parsed, `模型 ${row.modelId}`);
		if (metadata.id !== row.modelId) {
			throw new PiProtocolError("metadata.id 与 modelId 不一致");
		}
		return {
			id: row.modelId,
			name: row.name,
			metadataSource: "explicit",
			metadata,
		};
	} catch {
		throw piError("PI_CONFIG_UNAVAILABLE", "Provider 模型配置损坏");
	}
}

/** 对外模型条目 → 持久化列。catalog 条目不落元数据，避免出现双重事实来源。 */
function toModelRow(providerId: string, model: PiProviderModel) {
	return {
		id: randomUUID(),
		providerId,
		modelId: model.id,
		name: model.name,
		metadata:
			model.metadataSource === "explicit" ? JSON.stringify(model.metadata) : null,
	};
}

@Injectable()
export class PiProviderService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Optional()
		@Inject(PiCredentialService)
		private readonly credentials?: PiCredentialService,
		@Optional()
		private readonly fetchImpl: ProviderFetch = fetch,
		@Optional()
		@Inject(PiRuntimeRegistry)
		private readonly registry?: PiRuntimeRegistry,
	) {}

	private async row(id: string): Promise<ProviderRow> {
		const row = await this.prisma.piProvider.findUnique({
			where: { id },
			include: { models: true, credentials: { select: { id: true } } },
		});
		if (!row) throw piError("PI_CONFIG_UNAVAILABLE", `Provider "${id}" 不存在`);
		return row as unknown as ProviderRow;
	}

	private async toInfo(row: ProviderRow): Promise<PiProviderInfo> {
		const credentialIds = row.credentials.map((credential) => credential.id);
		const links = credentialIds.length
			? await this.prisma.piProfileCredential.findMany({
					where: { credentialId: { in: credentialIds } },
				})
			: [];
		const profileIds = [...new Set(links.map((link) => link.profileId))];
		const protocol = row.protocol as PiProviderProtocol | null;
		if (protocol !== null && !supportedProtocols.has(protocol)) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Provider 协议配置损坏");
		}
		return {
			id: row.id,
			name: row.name,
			runtimeProviderId: row.runtimeProviderId,
			protocol,
			baseUrl: row.baseUrl,
			headers: jsonObject(row.headers, "Provider headers") as Record<string, string>,
			enabled: row.enabled,
			revision: row.revision,
			models: row.models.map(toModel),
			credentialIds,
			boundProfileIds: profileIds,
			configurationState:
				row.enabled && protocol !== null ? "ready" : "needs_configuration",
		};
	}

	async list(page = 1, pageSize = 20): Promise<PaginatedResult<PiProviderInfo>> {
		const [rows, total] = await Promise.all([
			this.prisma.piProvider.findMany({
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
				include: { models: true, credentials: { select: { id: true } } },
			}),
			this.prisma.piProvider.count(),
		]);
		return {
			data: await Promise.all(
			(rows as unknown as ProviderRow[]).map((row) => this.toInfo(row)),
			),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	async get(id: string): Promise<PiProviderInfo> {
		return this.toInfo(await this.row(id));
	}

	private assertProviderModels(input: PiProviderCreateInput | PiProviderUpdateInput): void {
		if (!input.models) return;
		for (const model of input.models) {
			if (
				model.metadataSource === "explicit" &&
				model.metadata.api &&
				input.protocol &&
				model.metadata.api !== input.protocol
			) {
				throw piError("PI_CONFIG_UNAVAILABLE", `模型 ${model.id} 的协议与 Provider 不一致`);
			}
		}
	}

	/** 显式元数据模型必须能解析出 baseUrl：Pi 自定义模型注册要求（catalog 模型反之）。 */
	private assertExplicitModelsBaseUrl(
		models: PiProviderModel[] | undefined,
		baseUrl: string | null | undefined,
	): void {
		if (!models?.some((model) => model.metadataSource === "explicit")) return;
		if (!baseUrl) {
			throw piError("PI_CONFIG_UNAVAILABLE", "显式元数据模型必须配置 Base URL");
		}
	}

	async create(input: PiProviderCreateInput): Promise<PiProviderInfo> {
		this.assertProviderModels(input);
		this.assertExplicitModelsBaseUrl(input.models, input.baseUrl);
		if (input.credential && !this.credentials) {
			throw piError("PI_CONFIG_UNAVAILABLE", "凭据服务不可用，无法同时创建凭据");
		}
		const id = randomUUID();
		const models = input.models ?? [];
		await this.prisma.$transaction(async (tx) => {
			try {
				await tx.piProvider.create({
					data: {
						id,
						name: input.name,
						runtimeProviderId: input.runtimeProviderId,
						protocol: input.protocol,
						baseUrl: input.baseUrl ?? null,
						headers: JSON.stringify(input.headers ?? {}),
						enabled: input.enabled ?? true,
					},
				});
				if (models.length > 0) {
					await tx.piProviderModel.createMany({
						data: models.map((model) => toModelRow(id, model)),
					});
				}
				if (input.credential) {
					await this.credentials?.createWithin(tx, {
						providerConfigId: id,
						runtimeProviderId: input.runtimeProviderId,
						name: input.credential.name?.trim() || input.name,
						apiKey: input.credential.apiKey,
					});
				}
			} catch (error) {
				// 已带稳定错误码（如密钥未配置）的失败原样上抛，不降级为通用文案。
				if ((error as { code?: string }).code) throw error;
				throw piError("PI_CONFIG_UNAVAILABLE", "Provider 或凭据创建失败（名称可能已存在）");
			}
		});
		return this.get(id);
	}

	async update(id: string, input: PiProviderUpdateInput): Promise<PiProviderInfo> {
		this.assertProviderModels(input);
		await this.prisma.$transaction(async (tx) => {
			const existing = await tx.piProvider.findUnique({ where: { id } });
			if (!existing) throw piError("PI_CONFIG_UNAVAILABLE", `Provider "${id}" 不存在`);
			this.assertExplicitModelsBaseUrl(
				input.models,
				input.baseUrl === undefined ? existing.baseUrl : input.baseUrl,
			);
			try {
				await tx.piProvider.update({
					where: { id },
					data: {
						...(input.name === undefined ? {} : { name: input.name }),
						...(input.runtimeProviderId === undefined
							? {}
							: { runtimeProviderId: input.runtimeProviderId }),
						...(input.protocol === undefined ? {} : { protocol: input.protocol }),
						...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
						...(input.headers === undefined
							? {}
							: { headers: JSON.stringify(input.headers) }),
						...(input.enabled === undefined ? {} : { enabled: input.enabled }),
						revision: { increment: 1 },
					},
				});
				if (input.models !== undefined) {
					await tx.piProviderModel.deleteMany({ where: { providerId: id } });
					if (input.models.length > 0) {
						await tx.piProviderModel.createMany({
							data: input.models.map((model) => toModelRow(id, model)),
						});
					}
				}
			} catch {
				throw piError("PI_CONFIG_UNAVAILABLE", "Provider 更新失败或名称已存在");
			}
		});
		return this.get(id);
	}

	async remove(id: string): Promise<void> {
		await this.prisma.$transaction(async (tx) => {
			const provider = await tx.piProvider.findUnique({
				where: { id },
				include: { credentials: { select: { id: true } } },
			});
			if (!provider) throw piError("PI_CONFIG_UNAVAILABLE", `Provider "${id}" 不存在`);
			const credentialIds = provider.credentials.map((credential) => credential.id);
			if (credentialIds.length > 0) {
				const links = await tx.piProfileCredential.count({
					where: { credentialId: { in: credentialIds } },
				});
				if (links > 0) throw piError("PI_CONFIG_UNAVAILABLE", "Provider 仍被 Profile 使用");
			}
			await tx.piProvider.delete({ where: { id } });
		});
	}

	/**
	 * 对已保存 Provider 重新拉取远程模型目录（复用其已存凭据，不回显 Key）。
	 * 发现结果不落库；来源建议由在线 Client 的内置目录决定。
	 */
	async discoverModels(id: string): Promise<PiProviderDiscoveryResult> {
		const provider = await this.get(id);
		if (
			provider.configurationState !== "ready" ||
			provider.protocol === null ||
			!this.credentials
		) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Provider 尚未完成配置或缺少凭据");
		}
		const apiKey = await this.credentials.resolveProviderSecret(id);
		if (!apiKey) throw piError("PI_CONFIG_UNAVAILABLE", "Provider 缺少有效凭据");
		if (!provider.baseUrl) throw piError("PI_PROVIDER_VALIDATION_FAILED", "Provider 缺少端点");
		const models = await this.fetchRemoteModels({
			protocol: provider.protocol,
			baseUrl: provider.baseUrl,
			headers: provider.headers,
			apiKey,
		});
		return this.discoveryResult(models, provider.runtimeProviderId);
	}

	/**
	 * 对尚未持久化的目标做只读模型发现。
	 * apiKey 只存在于本次请求内存中，不入库、不入响应、不入日志。
	 */
	async discover(input: PiProviderDiscoveryInput): Promise<PiProviderDiscoveryResult> {
		const models = await this.fetchRemoteModels({
			protocol: input.protocol,
			baseUrl: input.baseUrl,
			headers: input.headers ?? {},
			apiKey: input.apiKey,
		});
		return this.discoveryResult(models, input.runtimeProviderId ?? null);
	}

	/** 使用固定协议适配器拉取远程模型目录；只返回 id/name，不保存外部返回结果。 */
	private async fetchRemoteModels(target: {
		protocol: PiProviderProtocol;
		baseUrl: string;
		headers: Record<string, string>;
		apiKey: string;
	}): Promise<Array<{ id: string; name: string }>> {
		const protocol = target.protocol;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
		try {
			const url = new URL("models", `${target.baseUrl.replace(/\/$/, "")}/`).toString();
			const headers: Record<string, string> = {
				Accept: "application/json",
				...target.headers,
			};
			if (protocol === "anthropic-messages") {
				headers["x-api-key"] = target.apiKey;
				headers["anthropic-version"] = "2023-06-01";
			} else if (protocol === "google-generative-ai") {
				headers["x-goog-api-key"] = target.apiKey;
			} else {
				headers.Authorization = `Bearer ${target.apiKey}`;
			}
			const response = await this.fetchImpl(url, {
				method: "GET",
				headers,
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok) {
				throw validationError(protocol, `http_${response.status >= 500 ? "5xx" : "4xx"}`);
			}
			const length = response.headers.get("content-length");
			if (length && Number(length) > PROVIDER_RESPONSE_LIMIT) {
				throw validationError(protocol, "response_too_large");
			}
			const body = await response.arrayBuffer();
			if (body.byteLength > PROVIDER_RESPONSE_LIMIT) {
				throw validationError(protocol, "response_too_large");
			}
			const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
			const models = this.extractModels(parsed, protocol);
			if (models.length > PROVIDER_MODEL_LIMIT) throw validationError(protocol, "too_many_models");
			return models.map((item) => ({ id: item.id, name: item.name ?? item.id }));
		} catch (error) {
			if ((error as { code?: string }).code === "PI_PROVIDER_VALIDATION_FAILED") throw error;
			throw validationError(
				protocol,
				error instanceof DOMException && error.name === "AbortError"
					? "timeout"
					: "response_invalid",
			);
		} finally {
			clearTimeout(timer);
		}
	}

	/** 发现结果：模型 id/name + 依据在线 Client 内置目录给出的建议来源。 */
	private discoveryResult(
		models: Array<{ id: string; name: string }>,
		runtimeProviderId: string | null,
	): PiProviderDiscoveryResult {
		const hit = runtimeProviderId
			? this.registry?.findCatalogProvider(runtimeProviderId) ?? null
			: null;
		const recommendedMetadataSource: PiModelMetadataSource = hit
			? "catalog"
			: "explicit";
		return {
			models,
			recommendedMetadataSource,
			catalogSdkVersion: hit?.sdkVersion ?? null,
		};
	}

	async validate(id: string): Promise<{ ok: true; providerId: string }> {
		const provider = await this.get(id);
		await this.discoverModels(id);
		return { ok: true, providerId: provider.id };
	}

	private extractModels(
		value: unknown,
		protocol: PiProviderProtocol,
	): Array<{ id: string; name?: string }> {
		if (!value || typeof value !== "object") throw validationError(protocol, "response_invalid");
		const data =
			(value as { data?: unknown; models?: unknown }).data ??
			(value as { models?: unknown }).models;
		if (!Array.isArray(data)) throw validationError(protocol, "response_invalid");
		const models: Array<{ id: string; name?: string }> = [];
		for (const item of data) {
			if (!item || typeof item !== "object") throw validationError(protocol, "response_invalid");
			const record = item as {
				id?: unknown;
				name?: unknown;
				displayName?: unknown;
				display_name?: unknown;
			};
			// Google 目录使用 models/<id> 形式的 name 字段，没有 id。
			const id =
				typeof record.id === "string" && record.id.length > 0
					? record.id
					: typeof record.name === "string" && record.name.startsWith("models/")
						? record.name.slice("models/".length)
						: null;
			if (!id) throw validationError(protocol, "response_invalid");
			const name =
				typeof record.displayName === "string"
					? record.displayName
					: typeof record.display_name === "string"
						? record.display_name
						: typeof record.name === "string" && !record.name.startsWith("models/")
							? record.name
							: undefined;
			models.push({ id, name });
		}
		return models;
	}


	/**
	 * 按 `runtimeProviderId` 批量取运行时快照。
	 *
	 * Profile 的 `allowedModels[].provider` 是 `runtimeProviderId`，与表行 id 不同空间；
	 * 因此这里按 `runtimeProviderId` 解析。缺 Provider 或未就绪时 fail closed（不降级、不静默跳过）。
	 */
	async getRuntimeSnapshot(
		runtimeProviderIds: string[],
	): Promise<ReadonlyArray<PiProviderInfo>> {
		const uniqueIds = [...new Set(runtimeProviderIds)];
		const rows = await this.prisma.piProvider.findMany({
			where: { runtimeProviderId: { in: uniqueIds } },
			include: { models: true, credentials: { select: { id: true } } },
		});
		const rowByRuntimeId = new Map(
			rows.map((row) => [row.runtimeProviderId, row]),
		);
		const snapshots = await Promise.all(
			uniqueIds.map((runtimeProviderId) => {
				const row = rowByRuntimeId.get(runtimeProviderId);
				if (!row) {
					throw piError(
						"PI_CONFIG_UNAVAILABLE",
						`Provider "${runtimeProviderId}" 不存在`,
					);
				}
				return this.toInfo(row as unknown as ProviderRow);
			}),
		);
		if (snapshots.some((provider) => provider.configurationState !== "ready")) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Provider 尚未完成配置");
		}
		return snapshots;
	}
}