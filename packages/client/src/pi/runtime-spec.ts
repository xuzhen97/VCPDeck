/** Client 侧 RuntimeSpec v4 接纳与模型解析；不读用户 ~/.pi。 */
import { join } from "node:path";
import {
	PI_BUILTIN_TOOL_IDS,
	parsePiRuntimeSpecMessageV4,
	type PiToolExecutionMode,
	type PiToolPolicy,
	type PiConfigState,
	type PiCredentialLeaseV2,
	type PiErrorCode,
	type PiModelRef,
	type PiRuntimeSpecMessageV4,
	type PiRuntimeSpecV4,
} from "@vcpdeck/shared";
import { resolveVcpPiRuntimePaths } from "./runtime-paths.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
let sdkPromise: Promise<PiSdk> | null = null;
function getSdk(): Promise<PiSdk> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

export interface PiRuntimeModelDefinition {
	id: string;
	name: string;
	api?: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
	baseUrl?: string;
	[key: string]: unknown;
}

export interface ModelRuntimeLike {
	getAvailable(): Promise<Array<{ provider: string; id: string }>>;
	/** 读取 SDK 内置模型定义：catalog 来源模型由它解析真实元数据。 */
	getModel?(providerId: string, modelId: string): PiRuntimeModelDefinition | undefined;
	registerProvider?(providerId: string, config: Record<string, unknown>): void;
	setRuntimeApiKey?(providerId: string, apiKey: string): Promise<void>;
}

/**
 * 工具集合计算（docs/adr/0030 决策 2 + ADR-0033 执行模式）：
 *
 * - `approval` / `auto`：`tools = allow ∪ confirm`（SDK 语义：只启用列出的工具），
 *   `excludeTools = deny`（纵深防御）；两者差别只在 Tool Policy 扩展是否询问操作者；
 * - `yolo`：不再用策略三桶缩小内置工具集合，也不应用 `deny`，暴露当前 Runtime 实际支持的
 *   内置工具全集。共享已知工具目录是上限，平台不存在的工具（如非 Windows 的 `powershell`）
 *   由 SDK/平台自然不可用。
 *
 * YOLO 不扩大资源加载面：项目/用户资源与未启用 Bundle 仍由 `bundleLoaderOptions` 排除。
 */
export function toolSetsFor(
	policy: PiToolPolicy,
	mode: PiToolExecutionMode,
): {
	tools: string[];
	excludeTools: string[];
} {
	if (mode === "yolo") {
		return { tools: [...PI_BUILTIN_TOOL_IDS].sort(), excludeTools: [] };
	}
	return {
		tools: [...new Set([...policy.allow, ...policy.confirm])].sort(),
		excludeTools: [...new Set(policy.deny)].sort(),
	};
}

export interface PiUnavailableModel {
	provider: string;
	modelId: string;
	reason: string;
}

export interface PiRuntimeConfig {
	spec: PiRuntimeSpecV4;
	credentialEntries: PiCredentialLeaseV2["entries"];
	resolvedModels: PiModelRef[];
	unavailableModels: PiUnavailableModel[];
	/** 已校验通过的 Bundle 扩展入口（不落盘，只存在于进程内）。 */
	bundleExtensionPaths: string[];
}

export interface PiRuntimeConfigState {
	configState: PiConfigState;
	reasonCode?: PiErrorCode;
	runtimeRevision: string | null;
	config: PiRuntimeConfig | null;
}

export function pendingRuntimeConfigState(): PiRuntimeConfigState {
	return { configState: "pending", runtimeRevision: null, config: null };
}

/**
 * 把 Server 模型条目解析为 Pi 注册所需的完整定义。
 *
 * - catalog：从 SDK 内置目录取完整定义（保留 baseUrl/compat/thinkingLevelMap/promptCache
 *   与真实成本），仅按 Server 配置覆盖 baseUrl；本机目录缺失时该模型单项 fail closed。
 * - explicit：直接用 Server 提供的元数据。
 *
 * 调用方必须对 `registers` 中 models 为空的 Provider 不注册：
 * Pi 的 registerProvider 在未提供 models 时会保留该 Provider 的全量内置目录，
 * 从而把可用面扩大到 modelPolicy 之外。
 */
export function resolveModelRegistrations(
	runtime: ModelRuntimeLike,
	providers: PiRuntimeSpecV4["providers"],
): {
	registers: Array<{ providerId: string; config: Record<string, unknown> }>;
	missingCatalogModels: PiModelRef[];
} {
	const registers: Array<{ providerId: string; config: Record<string, unknown> }> = [];
	const missingCatalogModels: PiModelRef[] = [];
	for (const provider of providers) {
		const models: PiRuntimeModelDefinition[] = [];
		for (const model of provider.models) {
			let definition: PiRuntimeModelDefinition | undefined;
			if (model.metadataSource === "explicit") {
				definition = { ...model.metadata };
			} else {
				definition = runtime.getModel?.(provider.providerId, model.id);
				if (!definition) {
					missingCatalogModels.push({
						provider: provider.providerId,
						modelId: model.id,
					});
					continue;
				}
			}
			models.push({
				...definition,
				baseUrl: provider.baseUrl ?? definition.baseUrl,
			});
		}
		if (models.length === 0) continue;
		registers.push({
			providerId: provider.providerId,
			config: {
				name: provider.name,
				api: provider.protocol,
				...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
				headers: provider.headers,
				models,
			},
		});
	}
	return { registers, missingCatalogModels };
}

/** 使用 Server Provider 配置注册模型，再以内存 lease 注入 Key。 */
export async function createModelRuntimeWithLease(
	lease: PiCredentialLeaseV2,
	providers: PiRuntimeSpecV4["providers"] = [],
): Promise<{
	runtime: ModelRuntimeLike;
	missingCatalogModels: PiModelRef[];
}> {
	const { ModelRuntime } = await getSdk();
	const paths = resolveVcpPiRuntimePaths();
	const runtime = (await ModelRuntime.create({
		modelsPath: null,
		authPath: join(paths.agentDir, "absent-auth.json"),
		allowModelNetwork: false,
	})) as unknown as ModelRuntimeLike;
	const { registers, missingCatalogModels } = resolveModelRegistrations(
		runtime,
		providers,
	);
	for (const register of registers) {
		runtime.registerProvider?.(register.providerId, register.config);
	}
	for (const entry of lease.entries) {
		await runtime.setRuntimeApiKey?.(entry.providerId, entry.apiKey);
	}
	return { runtime, missingCatalogModels };
}

export function effectiveDefaultModel(
	config: PiRuntimeConfig,
): { provider: string; modelId: string } {
	const preferred = config.spec.modelPolicy.defaultModel;
	if (config.resolvedModels.some((model) => model.provider === preferred.provider && model.modelId === preferred.modelId)) return preferred;
	const first = config.resolvedModels[0];
	return first ? { provider: first.provider, modelId: first.modelId } : preferred;
}

/** 严格解析 v4；失败或模型无交集都 fail closed（v4 之前的协议不接纳）。 */
export async function evaluateRuntimeSpec(
	message: unknown,
	deps: {
		createModelRuntime?: (
			lease: PiCredentialLeaseV2,
			providers: PiRuntimeSpecV4["providers"],
		) => Promise<{
			runtime: ModelRuntimeLike;
			missingCatalogModels: PiModelRef[];
		}>;
		/** 已校验 Bundle 的扩展入口（由调用方先用 `resolveVerifiedPiBundle` 得到）。 */
		bundleExtensionPaths?: string[];
		/** 本地已校验通过的资源 ID；用于对 `requiredBundle` 做防御性二次校验。 */
		bundleResourceIds?: string[];
	} = {},
): Promise<PiRuntimeConfigState> {
	if (message === null || message === undefined) return pendingRuntimeConfigState();
	let envelope: PiRuntimeSpecMessageV4;
	try {
		envelope = parsePiRuntimeSpecMessageV4(message);
	} catch {
		return { configState: "incompatible", reasonCode: "PI_RUNTIME_SPEC_INCOMPATIBLE", runtimeRevision: null, config: null };
	}
	const { spec, credentials } = envelope;
	// 防御性二次校验：下发决定权在 Server，但本地资源缺失时绝不静默降级（设计 §4.4）。
	if (
		spec.requiredBundle &&
		!spec.requiredBundle.resourceIds.every((id) =>
			(deps.bundleResourceIds ?? []).includes(id),
		)
	) {
		return {
			configState: "incompatible",
			reasonCode: "PI_BUNDLE_UNAVAILABLE",
			runtimeRevision: spec.runtimeRevision,
			config: null,
		};
	}
	const providers = new Set(spec.providers.map((provider) => provider.providerId));
	if (providers.size !== credentials.entries.length || credentials.entries.some((entry) => !providers.has(entry.providerId))) {
		return { configState: "incompatible", reasonCode: "PI_RUNTIME_SPEC_INCOMPATIBLE", runtimeRevision: spec.runtimeRevision, config: null };
	}
	let available: Set<string>;
	let missingCatalogModels: PiModelRef[] = [];
	try {
		const created = await (deps.createModelRuntime ?? createModelRuntimeWithLease)(credentials, spec.providers);
		missingCatalogModels = created.missingCatalogModels;
		available = new Set((await created.runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`));
	} catch {
		return { configState: "incompatible", reasonCode: "PI_CREDENTIAL_UNAVAILABLE", runtimeRevision: spec.runtimeRevision, config: null };
	}
	const missing = new Set(missingCatalogModels.map((model) => `${model.provider}/${model.modelId}`));
	const resolvedModels: PiModelRef[] = [];
	const unavailableModels: PiUnavailableModel[] = [];
	for (const model of spec.modelPolicy.allowedModels) {
		const key = `${model.provider}/${model.modelId}`;
		if (missing.has(key)) unavailableModels.push({ provider: model.provider, modelId: model.modelId, reason: "model_not_in_catalog" });
		else if (available.has(key)) resolvedModels.push(model);
		else unavailableModels.push({ provider: model.provider, modelId: model.modelId, reason: "model_unavailable" });
	}
	const preferred = spec.modelPolicy.defaultModel;
	if (!resolvedModels.some((model) => model.provider === preferred.provider && model.modelId === preferred.modelId) && !unavailableModels.some((model) => model.provider === preferred.provider && model.modelId === preferred.modelId)) {
		unavailableModels.push({ provider: preferred.provider, modelId: preferred.modelId, reason: "default_model_unavailable" });
	}
	if (resolvedModels.length === 0) return { configState: "incompatible", reasonCode: "PI_CREDENTIAL_UNAVAILABLE", runtimeRevision: spec.runtimeRevision, config: null };
	return { configState: "ready", runtimeRevision: spec.runtimeRevision, config: { spec, credentialEntries: credentials.entries, resolvedModels, unavailableModels, bundleExtensionPaths: [...(deps.bundleExtensionPaths ?? [])] } };
}
