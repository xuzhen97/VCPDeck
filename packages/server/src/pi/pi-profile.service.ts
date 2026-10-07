/**
 * Pi Profile 与 Client→Profile 绑定（Server 权威持久化）。
 *
 * 设计来源：docs/design/remote-pi-control-plane.md §6.1/§6.3/§6.4。
 * 本 Service 不接触任何凭据明文；凭据解析在 PiCredentialService。
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
	isPiLegacyToolExecutionMode,
	isPiToolExecutionMode,
	parsePiToolPolicy,
	type LegacyPiToolPolicy,
	type PaginatedResult,
	type PiClientBindingInfo,
	type PiExecutionConfiguration,
	type PiLegacyToolExecutionMode,
	type PiModelRef,
	type PiProfileCreateInput,
	type PiProfileInfo,
	type PiProfileUpdateInput,
	type PiToolExecutionMode,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { PiRuntimeRegistry } from "./pi-runtime-registry.service.js";
import {
	ensurePiExecutionMigration,
	type PiExecutionMigrationDb,
} from "./pi-execution-migration.js";

/**
 * 执行模式扩展依赖：两模式都靠它读取内存桥接并在监督模式下逐次审批，
 * 因此它是**宿主必需资源**，不能像业务扩展一样被随意移除。
 */
export const PI_TOOL_POLICY_RESOURCE_ID = "vcp.tool-policy";

/** 本地错误工具（与仓库既有 pi-*.ts 约定一致） */
function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * Profile 行投影。
 *
 * `executionModeNeedsConfirmation` / `legacyExecutionConfigJson` 声明为可选：
 * 它们是 ADR-0039 新增的列，存在旧二进制写入的行或不同模块解析（本地生成的
 * Prisma Client vs node_modules 空壳）时可能缺失。缺失一律按“未标记待确认”处理，
 * 而实际是否待确认由 `toolExecutionMode` 是否是新枚举共同决定（见
 * `toExecutionConfiguration`），因此可选化不会放宽任何授权。
 */
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
	executionModeNeedsConfirmation?: boolean;
	legacyExecutionConfigJson?: string | null;
	revision: number;
}

/**
 * 防御性读取「待确认」标记。
 *
 * 该列由 ADR-0039 新增：当读取方解析到的 Prisma Client 尚未包含它（例如本地生成
 * 产物与 node_modules 空壳不一致），直接访问会得到 undefined。这里显式收敛为
 * 布尔值，并且 **缺失一律当作未待确认**——真正的门控仍由 `toolExecutionMode`
 * 是否仍是旧枚举决定（见 `toExecutionConfiguration`），因此不会放宽授权。
 */
function isPendingConfirmation(row: PiProfileRow): boolean {
	return row.executionModeNeedsConfirmation === true;
}

/** 迁移与 API 缺省的保守默认：新建 Profile 缺省监督模式（ADR-0039 决策 1）。 */
const DEFAULT_TOOL_EXECUTION_MODE: PiToolExecutionMode = "supervised";

/**
 * 读取执行模式列：只接受两个合法值；未知值抛 PI_CONFIG_UNAVAILABLE，
 * 不静默回退为默认，否则损坏数据会被解释成更宽松或更保守的权限语义而不被察觉。
 */
function parseToolExecutionModeColumn(
	raw: string | null | undefined,
): PiToolExecutionMode | null {
	if (raw === null || raw === undefined) return null;
	if (!isPiToolExecutionMode(raw)) {
		throw piError(
			"PI_CONFIG_UNAVAILABLE",
			`Profile 工具执行模式列非法：${String(raw)}`,
		);
	}
	return raw;
}

/**
 * 读取旧策略列（仅迁移展示用）。
 *
 * 它不再是授权来源：ADR-0039 删除了逐工具限制。损坏时返回 null，
 * 界面据此提示人工确认，而不是把无法解释的 JSON 当作有效限制展示。
 */
function parseLegacyToolPolicyColumn(raw: string | null | undefined): LegacyPiToolPolicy | null {
	if (raw === null || raw === undefined) return null;
	try {
		return parsePiToolPolicy(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** 读取旧迁移说明列：`{ mode, policy }`；形状非法时返回 null（只影响展示文案）。 */
function parseLegacyExecutionConfigColumn(raw: string | null | undefined): {
	legacyMode: PiLegacyToolExecutionMode;
	legacyPolicy: LegacyPiToolPolicy | null;
} | null {
	if (raw === null || raw === undefined) return null;
	try {
		const parsed = JSON.parse(raw) as {
			mode?: unknown;
			policy?: unknown;
		};
		if (!isPiLegacyToolExecutionMode(parsed.mode)) return null;
		let policy: LegacyPiToolPolicy | null = null;
		if (parsed.policy !== null && parsed.policy !== undefined) {
			try {
				policy = parsePiToolPolicy(parsed.policy);
			} catch {
				policy = null;
			}
		}
		return { legacyMode: parsed.mode, legacyPolicy: policy };
	} catch {
		return null;
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

@Injectable()
export class PiProfileService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		/** 可选注入：Bundle 资源的已上报集合用于配置校验（旧测试构造保持兼容）。 */
		@Optional()
		@Inject(PiRuntimeRegistry)
		private readonly registry?: PiRuntimeRegistry,
	) {}

	/**
	 * 读取前确保存量行已转为新语义。
	 *
	 * 旧行带的是 `approval/auto/yolo` 与三桶列；若不先转换，本 Service 就会用
	 * 旧枚举解释新协议。失败时向上抛，调用方以稳定错误码判定 Pi 不可用。
	 */
	private async ensureMigrated(): Promise<void> {
		// SAFETY: `PrismaService` 继承自生成客户端，结构上满足 `PiExecutionMigrationDb`
		// （piProfile.findMany/update + job.findMany/updateMany + $transaction）。
		// 迁移只读写已存在于 schema 的列，且不依赖泛型返回类型，故此处 cast 安全；
		// 类型若漂移，`PiExecutionMigrationRow` 的列名会在运行时表现为 undefined 并 fail closed。
		await ensurePiExecutionMigration(this.prisma as unknown as PiExecutionMigrationDb);
	}

	private toExecutionConfiguration(row: PiProfileRow): PiExecutionConfiguration {
		// 待确认标记与旧枚举双条件：只有两者都指向旧语义时才要求显式确认。
		// 标记缺失但枚举仍是新值时说明该行已迁移完成，按 ready 处理。
		if (isPendingConfirmation(row)) {
			const legacy = parseLegacyExecutionConfigColumn(row.legacyExecutionConfigJson);
			return {
				state: "needs_confirmation",
				legacyMode: legacy?.legacyMode ?? "approval",
				legacyPolicy: legacy?.legacyPolicy ?? parseLegacyToolPolicyColumn(row.toolPolicyJson) ?? { allow: [], confirm: [], deny: [] },
			};
		}
		const mode = parseToolExecutionModeColumn(row.toolExecutionMode);
		return mode === null
			? {
					state: "needs_confirmation",
					legacyMode: "approval",
					legacyPolicy: parseLegacyToolPolicyColumn(row.toolPolicyJson) ?? { allow: [], confirm: [], deny: [] },
				}
			: { state: "ready", mode };
	}

	private async toInfo(row: PiProfileRow): Promise<PiProfileInfo> {
		const [links, bindings] = await Promise.all([
			this.prisma.piProfileCredential.findMany({ where: { profileId: row.id } }),
			this.prisma.piClientBinding.findMany({ where: { profileId: row.id } }),
		]);
		const executionConfiguration = this.toExecutionConfiguration(row);
		return {
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			defaultModel: { provider: row.defaultProvider, modelId: row.defaultModelId },
			allowedModels: parseAllowedModelsColumn(row.allowedModels),
			defaultThinkingLevel: row.defaultThinkingLevel,
			enabledResourceIds: parseResourceIdsColumn(row.enabledResourceIds),
			executionConfiguration,
			toolExecutionMode:
				executionConfiguration.state === "ready" ? executionConfiguration.mode : null,
			revision: row.revision,
			credentialIds: links.map((link) => link.credentialId),
			boundClientIds: bindings.map((binding) => binding.clientId),
		};
	}

	async create(input: PiProfileCreateInput): Promise<PiProfileInfo> {
		await this.ensureMigrated();
		const enabledResourceIds = input.enabledResourceIds ?? [];
		this.assertExecutionResource(enabledResourceIds);
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
		await this.ensureMigrated();
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
			if (input.toolExecutionMode !== undefined) {
				// 待确认迁移时拒绝普通 PATCH：移除逐工具限制必须经专用确认入口，
				// 否则界面改一个下拉框就能静默完成 ADR-0039 要求的显式确认。
				// SAFETY: `existing` 是 Prisma 推断行，其列集合与本文件的投影 `PiProfileRow`
			// 一一对应（`PiProfileRow` 只是把两个新列标为可选）。这里断言只为读待确认标记，
			// 不改变任何其他字段的语义；列缺失时 `undefined === true` 为假，按未待确认处理。
			if (isPendingConfirmation(existing as PiProfileRow)) {
					throw piError(
						"PI_EXECUTION_CONFIRMATION_REQUIRED",
						`Profile "${id}" 需先确认新的执行语义`,
					);
				}
				data.toolExecutionMode = input.toolExecutionMode;
			}
			const next = {
				defaultModel: input.defaultModel ?? { provider: existing.defaultProvider, modelId: existing.defaultModelId },
				allowedModels: input.allowedModels ?? parseAllowedModelsColumn(existing.allowedModels),
				credentialIds: input.credentialIds ?? (await tx.piProfileCredential.findMany({ where: { profileId: id } })).map((link) => link.credentialId),
			};
			await this.assertProfileConfiguration(next, tx);
			// 资源：省略时保留既有值；提供时先校验再落库（fail closed）。
			if (input.enabledResourceIds !== undefined) {
				const nextResources = input.enabledResourceIds;
				this.assertExecutionResource(nextResources);
				data.enabledResourceIds =
					nextResources.length > 0 ? JSON.stringify(nextResources) : null;
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
		await this.ensureMigrated();
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
		await this.ensureMigrated();
		const row = await this.prisma.piProfile.findUnique({ where: { id } });
		if (!row) throw piError("PI_CONFIG_UNAVAILABLE", `Profile "${id}" 不存在`);
		return this.toInfo(row);
	}

	async list(page = 1, pageSize = 20): Promise<PaginatedResult<PiProfileInfo>> {
		await this.ensureMigrated();
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
		await this.ensureMigrated();
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
	 * 校验资源启用项。
	 *
	 * 1. 执行模式扩展 `vcp.tool-policy` 是**宿主必需资源**：两模式都靠它读内存桥接，
	 *    监督模式的逐次审批也由它执行；缺它就没有任何执行门控，因此不可移除。
	 * 2. 其余资源：仅当已有 Client 上报 Bundle 时校验 ID 存在性
	 *    （下发时的门控才是权威 fail closed 点）。
	 */
	private assertExecutionResource(enabledResourceIds: string[]): void {
		if (!enabledResourceIds.includes(PI_TOOL_POLICY_RESOURCE_ID)) {
			throw piError(
				"PI_CONFIG_UNAVAILABLE",
				`必须启用 ${PI_TOOL_POLICY_RESOURCE_ID} 资源以提供执行模式门控`,
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

	/**
	 * 确认新的执行语义（ADR-0039 决策 3）。
	 *
	 * 这是**唯一**能解除待确认门控的入口：以显式选择新模式的方式移除逐工具三桶，
	 * 并清空一次性迁移材料。按 id + revision + pending 做 CAS，配置已并发变化时拒绝
	 * 旧确认，避免覆盖别人刚提交的配置。
	 */
	async confirmExecutionMigration(
		id: string,
		input: { expectedRevision: number; mode: PiToolExecutionMode },
	): Promise<PiProfileInfo> {
		await this.ensureMigrated();
		const row = await this.prisma.$transaction(async (tx) => {
			const existing = await tx.piProfile.findUnique({ where: { id } });
			if (!existing) throw piError("PI_CONFIG_UNAVAILABLE", `Profile "${id}" 不存在`);
			if (existing.revision !== input.expectedRevision) {
				throw piError(
					"PI_CONFIG_UNAVAILABLE",
					`Profile "${id}" 配置已变化，请重新加载后再确认`,
				);
			}
			if (!isPendingConfirmation(existing as PiProfileRow)) {
				throw piError(
					"PI_CONFIG_UNAVAILABLE",
					`Profile "${id}" 不处于待确认状态`,
				);
			}
			return tx.piProfile.update({
				where: { id },
				data: {
					toolExecutionMode: input.mode,
					executionModeNeedsConfirmation: false,
					legacyExecutionConfigJson: null,
					toolPolicyJson: null,
					revision: { increment: 1 },
				},
			});
		});
		return this.toInfo(row);
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
