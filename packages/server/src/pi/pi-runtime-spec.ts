/** Pi RuntimeSpec v4 构建与 revision 计算（纯函数，无 IO）。 */
import { createHash, randomUUID } from "node:crypto";
import {
	PI_BUNDLE_PROTOCOL_VERSION,
	PI_RUNTIME_SPEC_PROTOCOL_VERSION,
	type PiModelRef,
	type PiProfileInfo,
	type PiProviderInfo,
	type PiRuntimeSpecV1,
	type PiRuntimeSpecV4,
} from "@vcpdeck/shared";

export interface PiCredentialMeta {
	id: string;
	updatedAt: Date;
}

export function computeRuntimeRevision(input: {
	profileId: string;
	profileRevision: number;
	providers?: PiProviderInfo[];
	credentials: PiCredentialMeta[];
}): string {
	const canonical = JSON.stringify([
		PI_RUNTIME_SPEC_PROTOCOL_VERSION,
		input.profileId,
		input.profileRevision,
		(input.providers ?? [])
			.map((provider) =>
				JSON.stringify({
					id: provider.id,
					revision: provider.revision,
					protocol: provider.protocol,
					baseUrl: provider.baseUrl,
					headers: provider.headers,
					models: provider.models,
				}),
			)
			.sort(),
		input.credentials
			.map((credential) => `${credential.id}:${credential.updatedAt.toISOString()}`)
			.sort(),
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * 构造 v4 RuntimeSpec：只输入非秘密 Provider、凭据元数据与目标 Client 的 Bundle 版本。
 * 策略与执行模式均随 Spec 下发（ADR-0033）；`requiredBundle` 仅在 Profile 启用了资源时出现，
 * 未提供 `bundleVersion` 时不构造该字段（下发前的门控已保证需要资源时必然存在已上报的 Bundle 版本）。
 */
export function buildPiRuntimeSpecV4(
	profile: PiProfileInfo,
	providers: PiProviderInfo[],
	credentials: PiCredentialMeta[],
	bundleVersion?: string,
): PiRuntimeSpecV4 {
	const requiredBundle =
		profile.enabledResourceIds.length > 0 && bundleVersion
			? {
					protocolVersion: PI_BUNDLE_PROTOCOL_VERSION,
					bundleVersion,
					resourceIds: [...profile.enabledResourceIds],
				}
			: undefined;
	return {
		schemaVersion: 4,
		specId: randomUUID(),
		profileId: profile.id,
		profileRevision: profile.revision,
		providers: providers.map((provider) => ({
			providerId: provider.runtimeProviderId,
			name: provider.name,
			protocol: provider.protocol as Exclude<typeof provider.protocol, null>,
			...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
			headers: { ...provider.headers },
			models: provider.models.map((model) => ({ ...model })),
		})),
		modelPolicy: {
			defaultModel: { ...profile.defaultModel },
			allowedModels: profile.allowedModels.map((model) => ({ ...model })),
			defaultThinkingLevel: profile.defaultThinkingLevel,
		},
		toolPolicy: {
			allow: [...profile.toolPolicy.allow],
			confirm: [...profile.toolPolicy.confirm],
			deny: [...profile.toolPolicy.deny],
		},
		toolExecutionMode: profile.toolExecutionMode,
		...(requiredBundle ? { requiredBundle } : {}),
		runtimeRevision: computeRuntimeRevision({
			profileId: profile.id,
			profileRevision: profile.revision,
			providers,
			credentials,
		}),
	};
}

/** 保留 v1 builder，供既有读取测试和迁移诊断使用；新下发路径使用 v4。 */
export function buildPiRuntimeSpec(
	profile: PiProfileInfo,
	credentials: PiCredentialMeta[],
): PiRuntimeSpecV1 {
	return {
		schemaVersion: 1,
		specId: randomUUID(),
		profileId: profile.id,
		profileRevision: profile.revision,
		modelPolicy: {
			defaultModel: { ...profile.defaultModel },
			allowedModels: profile.allowedModels.map((model) => ({ ...model })),
			defaultThinkingLevel: profile.defaultThinkingLevel,
		},
		runtimeRevision: computeRuntimeRevision({
			profileId: profile.id,
			profileRevision: profile.revision,
			credentials,
		}),
	};
}

/** 读取 allowedModels 列；损坏或元素形状非法时 fail closed。 */
export function parseAllowedModelsColumn(raw: string): PiModelRef[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const models: PiModelRef[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) return [];
		const candidate = item as Partial<PiModelRef>;
		if (
			typeof candidate.provider !== "string" ||
			candidate.provider.length === 0 ||
			typeof candidate.modelId !== "string" ||
			candidate.modelId.length === 0
		) return [];
		models.push(
			candidate.maxThinkingLevel !== undefined
				? { provider: candidate.provider, modelId: candidate.modelId, maxThinkingLevel: candidate.maxThinkingLevel }
			: { provider: candidate.provider, modelId: candidate.modelId },
		);
	}
	return models;
}
