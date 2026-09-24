/**
 * Pi Profile 与 Client→Profile 绑定（Server 权威持久化）。
 *
 * 设计来源：docs/design/remote-pi-control-plane.md §6.1/§6.3/§6.4。
 * 本 Service 不接触任何凭据明文；凭据解析在 PiCredentialService。
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
	emptyPiToolPolicy,
	isPiToolExecutionMode,
	parsePiToolPolicy,
	type PaginatedResult,
	type PiClientBindingInfo,
	type PiModelRef,
	type PiProfileCreateInput,
	type PiProfileInfo,
	type PiProfileUpdateInput,
	type PiToolExecutionMode,
	type PiToolPolicy,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";

/** 策略依赖：启用 confirm 必须同时启用执行它的 Bundle 资源。 */
export const PI_TOOL_POLICY_RESOURCE_ID = "vcp.tool-policy";

/** 本地错误工具（与仓库既有 pi-*.ts 约定一致） */
function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

interface PiProfileRow {
	id: string;
	name: string;
	enabled: boolean;
	defaultProvider: string;
	defaultModelId: string;
	allowedModels: string;
	defaultThinkingLevel: string;
	enabledResourceIds: string | null;
	toolPolicyJson: string | null;
	toolExecutionMode: string;
	revision: number;
}

/** 迁移与 API 缺省的保守默认（ADR-0033 决策 7）。 */
const DEFAULT_TOOL_EXECUTION_MODE: PiToolExecutionMode = "approval";

/**
 * 读取执行模式列：只接受三个合法值；未知值抛 PI_CONFIG_UNAVAILABLE，不静默回退为默认，
 * 否则损坏数据会被解释成“更宽松”或“更保守”的权限语义而不被察觉。
 */
function parseToolExecutionModeColumn(raw: string | null | undefined): PiToolExecutionMode {
	if (!isPiToolExecutionMode(raw)) {
		throw piError(
			"PI_CONFIG_UNAVAILABLE",
			`Profile 工具执行模式列非法：${String(raw)}`,
		);
	}
	return raw;
}

/**
 * 读取策略列：NULL 视为未配置（等价空策略），非 NULL 必须严格合法。
 * 损坏时抛 PI_CONFIG_UNAVAILABLE 而不是静默降级为“放行”，避免授权面被放宽。
 */
function parseToolPolicyColumn(raw: string | null | undefined): PiToolPolicy {
	if (raw === null || raw === undefined) return emptyPiToolPolicy();
	try {
		return parsePiToolPolicy(JSON.parse(raw));
	} catch (error) {
		throw piError(
			"PI_CONFIG_UNAVAILABLE",
			`Profile 工具策略列非法：${(error as Error).message}`,
		);
	}
}

/** 读取资源列：NULL 视为未启用任何 Bundle 资源。 */
function parseResourceIdsColumn(raw: string | null | undefined): string[] {
	if (raw === null || raw === undefined) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) throw new Error("必须为数组");
		return parsed.map((item) => {
			if (typeof item !== "string" || item.length === 0) {
				throw new Error("只能包含非空字符串");
			}
			return item;
		});
	} catch (error) {
		throw piError(
			"PI_CONFIG_UNAVAILABLE",
			`Profile 资源启用列非法：${(error as Error).message}`,
		);
	}
}

/** 宽松读取 allowedModels 列：损坏时 fail closed 为不可用模型而不是崩溃 */
function parseAllowedModelsColumn(raw: string): PiModelRef[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item): item is PiModelRef =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as PiModelRef).provider === "string" &&
					typeof (item as PiModelRef).modelId === "string",
			)
			.map((item) => ({ ...item }));
	} catch {
		return [];
	}
}

/** 空策略（三桶皆空）= 未配置策略；该列存 NULL。 */
function isDefaultToolPolicy(policy: PiToolPolicy): boolean {
	return (
		policy.allow.length === 0 &&
		policy.confirm.length === 0 &&
		policy.deny.length === 0
	);
}

@Injectable()
export class PiProfileService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		/** 可选注入：Bundle 资源的已上报集合用于配置校验（旧测试构造保持兼容）。 */
		@Optional()
		@Inject(PiRuntimeRegistry)
		private readonly registry?: PiRuntimeRegistry,
	) {}

	private async toInfo(row: PiProfileRow): Promise<PiProfileInfo> {
		const [links, bindings] = await Promise.all([
			this.prisma.piProfileCredential.findMany({ where: { profileId: row.id } }),
			this.prisma.piClientBinding.findMany({ where: { profileId: row.id } }),
		]);
		return {
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			defaultModel: { provider: row.defaultProvider, modelId: row.defaultModelId },
			allowedModels: parseAllowedModelsColumn(row.allowedModels),
			defaultThinkingLevel: row.defaultThinkingLevel,
			enabledResourceIds: parseResourceIdsColumn(row.enabledResourceIds),
			toolPolicy: parseToolPolicyColumn(row.toolPolicyJson),
			toolExecutionMode: parseToolExecutionModeColumn(row.toolExecutionMode),
			revision: row.revision,
			credentialIds: links.map((link) => link.credentialId),
			boundClientIds: bindings.map((binding) => binding.clientId),
		};
	}

	async create(input: PiProfileCreateInput): Promise<PiProfileInfo> {
		const enabledResourceIds = input.enabledResourceIds ?? [];
		const toolPolicy = input.toolPolicy ?? emptyPiToolPolicy();
		this.assertToolPolicyAndResources(toolPolicy, enabledResourceIds);
		const row = await this.prisma.$transaction(async (tx) => {
			const created = await tx.piProfile.create({
				data: {
					id: randomUUID(),
					name: input.name,
					enabled: input.enabled ?? true,
					defaultProvider: input.defaultModel.provider,
					defaultModelId: input.defaultModel.modelId,
					allowedModels: JSON.stringify(input.allowedModels),
					defaultThinkingLevel: input.defaultThinkingLevel,
					toolExecutionMode: input.toolExecutionMode ?? DEFAULT_TOOL_EXECUTION_MODE,
					enabledResourceIds:
						enabledResourceIds.length > 0
							? JSON.stringify(enabledResourceIds)
							: null,
					toolPolicyJson: isDefaultToolPolicy(toolPolicy)
						? null
						: JSON.stringify(toolPolicy),
				},
			});
			const credentialIds = input.credentialIds ?? [];
			await this.assertProfileConfiguration({ ...input, credentialIds }, tx);
			if (credentialIds.length > 0) {
				await tx.piProfileCredential.createMany({
					data: credentialIds.map((credentialId) => ({ profileId: created.id, credentialId })),
				});
			}
			return created;
		});
		return this.toInfo(row);
	}

	async update(id: string, input: PiProfileUpdateInput): Promise<PiProfileInfo> {
		const row = await this.prisma.$transaction(async (tx) => {
			const existing = await tx.piProfile.findUnique({ where: { id } });
			if (!existing) throw piError("PI_CONFIG_UNAVAILABLE", `Profile "${id}" 不存在`);
			const data: Record<string, unknown> = { revision: { increment: 1 } };
			if (input.name !== undefined) data.name = input.name;
			if (input.enabled !== undefined) data.enabled = input.enabled;
			if (input.defaultModel !== undefined) {
				data.defaultProvider = input.defaultModel.provider;
				data.defaultModelId = input.defaultModel.modelId;
			}
			if (input.allowedModels !== undefined) data.allowedModels = JSON.stringify(input.allowedModels);
			if (input.defaultThinkingLevel !== undefined) data.defaultThinkingLevel = input.defaultThinkingLevel;
			if (input.toolExecutionMode !== undefined) data.toolExecutionMode = input.toolExecutionMode;
			const next = {
				defaultModel: input.defaultModel ?? { provider: existing.defaultProvider, modelId: existing.defaultModelId },
				allowedModels: input.allowedModels ?? parseAllowedModelsColumn(existing.allowedModels),
				credentialIds: input.credentialIds ?? (await tx.piProfileCredential.findMany({ where: { profileId: id } })).map((link) => link.credentialId),
			};
			await this.assertProfileConfiguration(next, tx);
			// 策略与资源：省略时保留既有值；提供时先校验再落库（fail closed）。
			const existingResources = parseResourceIdsColumn(existing.enabledResourceIds);
			const existingPolicy = parseToolPolicyColumn(existing.toolPolicyJson);
			const nextResources = input.enabledResourceIds ?? existingResources;
			const nextPolicy = input.toolPolicy ?? existingPolicy;
			if (
				input.enabledResourceIds !== undefined ||
				input.toolPolicy !== undefined
			) {
				this.assertToolPolicyAndResources(nextPolicy, nextResources);
				data.enabledResourceIds =
					nextResources.length > 0 ? JSON.stringify(nextResources) : null;
				data.toolPolicyJson = isDefaultToolPolicy(nextPolicy)
					? null
					: JSON.stringify(nextPolicy);
			}
			if (input.credentialIds !== undefined) {
				await tx.piProfileCredential.deleteMany({ where: { profileId: id } });
				if (input.credentialIds.length > 0) {
					await tx.piProfileCredential.createMany({
						data: input.credentialIds.map((credentialId) => ({ profileId: id, credentialId })),
					});
				}
			}
			return tx.piProfile.update({ where: { id }, data });
		});
		return this.toInfo(row);
	}

	async remove(id: string): Promise<void> {
		await this.prisma.$transaction(async (tx) => {
			const bindings = await tx.piClientBinding.findMany({ where: { profileId: id } });
			if (bindings.length > 0) {
				throw piError(
					"PI_CONFIG_UNAVAILABLE",
					`Profile "${id}" 仍被 ${bindings.length} 个 Client 绑定`,
				);
			}
			const existing = await tx.piProfile.findUnique({ where: { id } });
			if (!existing) throw piError("PI_CONFIG_UNAVAILABLE", `Profile "${id}" 不存在`);
			await tx.piProfile.delete({ where: { id } });
		});
	}

	async get(id: string): Promise<PiProfileInfo> {
		const row = await this.prisma.piProfile.findUnique({ where: { id } });
		if (!row) throw piError("PI_CONFIG_UNAVAILABLE", `Profile "${id}" 不存在`);
		return this.toInfo(row);
	}

	async list(page = 1, pageSize = 20): Promise<PaginatedResult<PiProfileInfo>> {
		const [rows, total] = await Promise.all([
			this.prisma.piProfile.findMany({
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.piProfile.count(),
		]);
		return {
			data: await Promise.all(rows.map((row) => this.toInfo(row))),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	async setBinding(clientId: string, profileId: string): Promise<void> {
		await this.prisma.$transaction(async (tx) => {
			const profile = await tx.piProfile.findUnique({ where: { id: profileId } });
			if (!profile) {
				throw piError("PI_CONFIG_UNAVAILABLE", `Profile "${profileId}" 不存在`);
			}
			await tx.piClientBinding.upsert({
				where: { clientId },
				create: { clientId, profileId },
				update: { profileId },
			});
		});
	}

	async clearBinding(clientId: string): Promise<void> {
		await this.prisma.piClientBinding.deleteMany({ where: { clientId } });
	}

	async listBindings(): Promise<PiClientBindingInfo[]> {
		const rows = await this.prisma.piClientBinding.findMany();
		return rows.map((row) => ({
			clientId: row.clientId,
			profileId: row.profileId,
			updatedAt: row.updatedAt.toISOString(),
		}));
	}

	/** 解析 Client 绑定 Profile；未绑定返回 null（Pi 不可用，不读本机 Pi）。 */
	async resolveBoundProfile(clientId: string): Promise<PiProfileInfo | null> {
		const binding = await this.prisma.piClientBinding.findUnique({
			where: { clientId },
		});
		if (!binding) return null;
		const row = await this.prisma.piProfile.findUnique({
			where: { id: binding.profileId },
		});
		if (!row) return null;
		return this.toInfo(row);
	}

	/** 递增 revision（凭据轮换/撤销时由 PiCredentialService 调用）。 */
	async bumpRevision(profileId: string): Promise<void> {
		await this.prisma.piProfile.update({
			where: { id: profileId },
			data: { revision: { increment: 1 } },
		});
	}

	/**
	 * 校验工具策略与资源启用项的一致性：
	 * 1. `confirm` 非空时必须启用执行它的 Bundle 资源（否则策略永远无法生效）；
	 * 2. 仅当已有 Client 上报 Bundle 时校验资源 ID 存在性（下发时的门控才是权威 fail closed 点）。
	 */
	private assertToolPolicyAndResources(
		toolPolicy: PiToolPolicy,
		enabledResourceIds: string[],
	): void {
		if (
			toolPolicy.confirm.length > 0 &&
			!enabledResourceIds.includes(PI_TOOL_POLICY_RESOURCE_ID)
		) {
			throw piError(
				"PI_CONFIG_UNAVAILABLE",
				`启用 confirm 必须先启用 ${PI_TOOL_POLICY_RESOURCE_ID} 资源`,
			);
		}
		const reported = this.registry?.reportedResourceIds();
		if (reported && reported.size > 0) {
			for (const id of enabledResourceIds) {
				if (!reported.has(id)) {
					throw piError(
						"PI_CONFIG_UNAVAILABLE",
						`未知资源 ${id}：没有任何在线 Client 上报该 Bundle 资源`,
					);
				}
			}
		}
	}

	private async assertProfileConfiguration(
		input: Pick<PiProfileCreateInput, "defaultModel" | "allowedModels" | "credentialIds">,
		tx: Pick<PrismaService, "piProvider" | "piProviderModel" | "piCredential">,
	): Promise<void> {
		const allowed = input.allowedModels;
		if (!allowed.some((model) => model.provider === input.defaultModel.provider && model.modelId === input.defaultModel.modelId)) {
			throw piError("PI_CONFIG_UNAVAILABLE", "默认模型必须位于允许模型列表");
		}
		const providerIds = [...new Set(allowed.map((model) => model.provider))];
		const selectedCredentialIds = input.credentialIds ?? [];
		if (providerIds.length === 0) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Profile 必须包含允许模型");
		}
		const providers = await tx.piProvider.findMany({
			where: { runtimeProviderId: { in: providerIds }, enabled: true },
			include: { models: true },
		});
		const providerByRuntimeId = new Map(providers.map((provider) => [provider.runtimeProviderId, provider]));
		if (providerByRuntimeId.size !== providerIds.length) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Profile 包含未配置或已禁用的 Provider");
		}
		const selectedCredentials = selectedCredentialIds.length
			? await tx.piCredential.findMany({
					where: { id: { in: selectedCredentialIds }, revokedAt: null },
					include: { providerConfig: true },
				})
			: [];
		if (selectedCredentialIds.length !== selectedCredentials.length || new Set(selectedCredentialIds).size !== selectedCredentialIds.length) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Profile 包含不存在、撤销或重复的凭据");
		}
		const credentialProviders = new Set(selectedCredentials.map((credential) => credential.providerConfig.runtimeProviderId));
		if (credentialProviders.size !== selectedCredentials.length || credentialProviders.size !== providerIds.length) {
			throw piError("PI_CONFIG_UNAVAILABLE", "Profile 必须为每个 Provider 关联一个有效凭据");
		}
		for (const providerId of providerIds) {
			if (!credentialProviders.has(providerId)) {
				throw piError("PI_CONFIG_UNAVAILABLE", `Provider ${providerId} 没有关联有效凭据`);
			}
		}
		for (const model of allowed) {
			const provider = providerByRuntimeId.get(model.provider);
			if (!provider || provider.protocol === null || !provider.models.some((catalogModel) => catalogModel.modelId === model.modelId)) {
				throw piError("PI_CONFIG_UNAVAILABLE", `模型 ${model.provider}/${model.modelId} 未配置或不在 Provider 目录`);
			}
		}
	}

}
