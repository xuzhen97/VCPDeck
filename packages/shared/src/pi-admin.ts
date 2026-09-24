/**
 * 远程 Pi 集中配置的 Server ↔ Frontend 协议（Plan 1：Profile / Credential / Binding）。
 *
 * 本模块自包含，不 import 同包其他模块。
 * 安全约束（设计 §6.3）：本模块的任何类型都不得携带凭据密文或明文；
 * 所有跨信任边界输入（Controller 请求体）必须经此处 parser 严格校验。
 */
import {
	isPiToolExecutionMode,
	parsePiToolPolicy,
	type PiBundleCapability,
	type PiModelRef,
	type PiProviderModel,
	type PiProviderModelInfo,
	type PiProviderProtocol,
	type PiToolExecutionMode,
	type PiToolPolicy,
} from "./pi.js";

/** 列表接口统一分页结果（与仓库约定一致） */
export interface PaginatedPiResult<T> {
	data: T[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

/** Profile 对外投影（不含任何凭据材料） */
export interface PiProfileInfo {
	id: string;
	name: string;
	enabled: boolean;
	defaultModel: { provider: string; modelId: string };
	allowedModels: PiModelRef[];
	defaultThinkingLevel: string;
	/** 该 Profile 允许加载的 Bundle 资源 ID（无 Bundle 需求时为空数组）。 */
	enabledResourceIds: string[];
	/** 工具策略：未出现在任何桶的工具默认拒绝。 */
	toolPolicy: PiToolPolicy;
	/** 工具执行模式：Approval / Auto / YOLO（ADR-0033）。 */
	toolExecutionMode: PiToolExecutionMode;
	revision: number;
	credentialIds: string[];
	boundClientIds: string[];
}

/** Provider 对外投影（不含凭据材料）。 */
export interface PiProviderInfo {
	id: string;
	name: string;
	runtimeProviderId: string;
	protocol: PiProviderProtocol | null;
	baseUrl: string | null;
	headers: Record<string, string>;
	enabled: boolean;
	revision: number;
	models: PiProviderModel[];
	credentialIds: string[];
	boundProfileIds: string[];
	configurationState: "ready" | "needs_configuration";
}

/** 接入 Provider 时可选同时创建的凭据：明文只允许出现在请求体。 */
export interface PiProviderCredentialInput {
	name?: string;
	apiKey: string;
}

export interface PiProviderCreateInput {
	name: string;
	runtimeProviderId: string;
	protocol: PiProviderProtocol;
	baseUrl?: string | null;
	headers?: Record<string, string>;
	models?: PiProviderModel[];
	enabled?: boolean;
	/** 提供时在同一事务内一并创建绑定凭据。 */
	credential?: PiProviderCredentialInput;
}

export interface PiProviderUpdateInput {
	name?: string;
	runtimeProviderId?: string;
	protocol?: PiProviderProtocol;
	baseUrl?: string | null;
	headers?: Record<string, string>;
	models?: PiProviderModel[];
	enabled?: boolean;
}

/**
 * 瞬时模型发现请求：目标尚未持久化，apiKey 只存在于一次 HTTP 请求的内存中。
 */
export interface PiProviderDiscoveryInput {
	protocol: PiProviderProtocol;
	baseUrl: string;
	headers?: Record<string, string>;
	apiKey: string;
	/** 用于推断建议来源；缺省一律建议显式元数据。 */
runtimeProviderId?: string;
}

/** 发现结果：只回模型 id/name，不含端点原始正文。 */
export interface PiProviderDiscoveryResult {
	models: Array<{ id: string; name: string }>;
	recommendedMetadataSource: "catalog" | "explicit";
	catalogSdkVersion: string | null;
}

/** Credential 对外投影：只暴露安全元数据。 */
export interface PiCredentialInfo {
	id: string;
	name: string;
	providerConfigId: string;
	providerName: string;
	runtimeProviderId: string;
	protocol: PiProviderProtocol | null;
	fingerprint: string;
	keyVersion: number;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	configurationState: "ready" | "needs_configuration";
}

/** Client → Profile 绑定投影 */
export interface PiClientBindingInfo {
	clientId: string;
	profileId: string;
	updatedAt: string;
}

/**
 * 某 Client 的 Pi 运行时状态投影（Server 内存 + Client ACK/STATE 对账）。
 * 不含 Secret；用于前端展示与诊断（设计 §17）。
 */
export interface PiRuntimeStatus {
	clientId: string;
	specId: string | null;
	desiredRuntimeRevision: string | null;
	activeRuntimeRevision: string | null;
	configState: "pending" | "ready" | "incompatible" | "stale";
	reasonCode: string | null;
	piSdkVersion: string | null;
	runtimeSpecProtocolVersion: number | null;
	/** 缺失 = 该 Client 未上报可用 Bundle（未找到、校验失败或版本不符）。 */
	bundle?: PiBundleCapability;
	providers: Array<{
		providerId: string;
		name: string;
		runtimeProviderId: string;
		protocol: PiProviderProtocol;
		modelCount: number;
	}>;
	unavailableModels: Array<{
		provider: string;
		modelId: string;
		reason: string;
	}>;
}

export interface PiProfileCreateInput {
	name: string;
	defaultModel: { provider: string; modelId: string };
	allowedModels: PiModelRef[];
	defaultThinkingLevel: string;
	enabled?: boolean;
	credentialIds?: string[];
	/** 省略 = 不启用任何 Bundle 资源。 */
	enabledResourceIds?: string[];
	/** 省略 = 空策略（未列出工具全部拒绝）。 */
	toolPolicy?: PiToolPolicy;
	/** 省略 = Server 保守默认 approval（产品新建默认由 Frontend 显式提交）。 */
	toolExecutionMode?: PiToolExecutionMode;
}

export type PiProfileUpdateInput = Partial<PiProfileCreateInput>;

export interface PiCredentialCreateInput {
	name: string;
	providerConfigId: string;
	apiKey: string;
}

export interface PiCredentialUpdateInput {
	name?: string;
	apiKey?: string;
}

/** 协议输入错误：Controller 统一映射为 400 + 稳定 code。 */
export class PiAdminProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiAdminProtocolError";
	}
}

const MAX_NAME = 128;
const MAX_ID = 128;
const MAX_API_KEY = 4096;
const MAX_BASE_URL = 2048;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE = 4096;
const MAX_PROVIDER_MODELS = 256;
const PROVIDER_PROTOCOLS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;
const PROVIDER_KEYS = new Set([
	"name",
	"runtimeProviderId",
	"protocol",
	"baseUrl",
	"headers",
	"models",
	"enabled",
	"credential",
]);
const PROVIDER_CREDENTIAL_KEYS = new Set(["name", "apiKey"]);
const PROVIDER_MODEL_KEYS = new Set([
	"id",
	"name",
	"metadataSource",
	"metadata",
]);
const PROVIDER_MODEL_METADATA_KEYS = new Set([
	"id",
	"name",
	"api",
	"reasoning",
	"input",
	"contextWindow",
	"maxTokens",
	"cost",
	"compat",
]);
const DISCOVERY_KEYS = new Set([
	"protocol",
	"baseUrl",
	"headers",
	"apiKey",
	"runtimeProviderId",
]);
const MODEL_COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const MAX_ALLOWED_MODELS = 64;
const MAX_CREDENTIAL_IDS = 16;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"];
const MODEL_REF_KEYS = new Set(["provider", "modelId", "maxThinkingLevel"]);
const PROFILE_CREATE_KEYS = new Set([
	"name",
	"defaultModel",
	"allowedModels",
	"defaultThinkingLevel",
	"enabled",
	"credentialIds",
	"enabledResourceIds",
	"toolPolicy",
	"toolExecutionMode",
]);
const DEFAULT_MODEL_KEYS = new Set(["provider", "modelId"]);
/** 单个 Profile 可启用的 Bundle 资源数量上限 */
const MAX_RESOURCE_IDS = 64;
const PROFILE_UPDATE_KEYS = PROFILE_CREATE_KEYS;
const CREDENTIAL_CREATE_KEYS = new Set(["name", "providerConfigId", "apiKey"]);
const CREDENTIAL_UPDATE_KEYS = new Set(["name", "apiKey"]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, what: string, max = MAX_NAME): string {
	if (typeof v !== "string" || v.length === 0) {
		throw new PiAdminProtocolError(`${what} 必须是非空字符串`);
	}
	if (v.length > max) {
		throw new PiAdminProtocolError(`${what} 长度超过上限 ${max}`);
	}
	return v;
}

function requireOptionalString(
	v: unknown,
	what: string,
	max = MAX_NAME,
): string | undefined {
	if (v === undefined) return undefined;
	return requireString(v, what, max);
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: Set<string>,
	what: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new PiAdminProtocolError(`${what} 含未知字段 ${key}`);
		}
	}
}

function parseProviderProtocol(value: unknown, what: string): PiProviderProtocol {
	const protocol = requireString(value, what, MAX_NAME);
	if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(protocol)) {
		throw new PiAdminProtocolError(`${what} 不受支持`);
	}
	return protocol as PiProviderProtocol;
}

function parseProviderBaseUrl(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return null;
	const baseUrl = requireString(value, "baseUrl", MAX_BASE_URL);
	if(/[\u0000-\u0020]/.test(baseUrl)) {
		throw new PiAdminProtocolError("baseUrl 含控制字符或空白");
	}
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new PiAdminProtocolError("baseUrl 必须是合法 URL");
	}
	if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new PiAdminProtocolError("baseUrl 只允许无凭据的 http(s) URL");
	}
	return baseUrl.replace(/\/$/, "");
}

function parseProviderHeaders(value: unknown): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value) || Object.keys(value).length > MAX_HEADERS) {
		throw new PiAdminProtocolError(`headers 必须是最多 ${MAX_HEADERS} 项的对象`);
	}
	const out: Record<string, string> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /authorization|x-api-key|api-key|token|secret|password/i.test(name)) {
			throw new PiAdminProtocolError(`Header ${name} 含秘密字段或格式非法`);
		}
		out[name] = requireString(raw, `headers.${name}`, MAX_HEADER_VALUE);
	}
	return out;
}

function parseProviderModelMetadata(value: unknown, label: string): PiProviderModelInfo {
	if (!isRecord(value)) throw new PiAdminProtocolError(`${label} 必须为对象`);
	rejectUnknownKeys(value, PROVIDER_MODEL_METADATA_KEYS, label);
	const id = requireString(value.id, `${label}.id`, MAX_ID);
	const name = value.name === undefined ? id : requireString(value.name, `${label}.name`);
	const api = value.api === undefined ? undefined : parseProviderProtocol(value.api, `${label}.api`);
	if (typeof value.reasoning !== "boolean") throw new PiAdminProtocolError(`${label}.reasoning 必须为 boolean`);
	if (!Array.isArray(value.input) || value.input.length === 0 || value.input.some((item) => item !== "text" && item !== "image")) {
		throw new PiAdminProtocolError(`${label}.input 非法`);
	}
	const positive = (raw: unknown, field: string) => {
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new PiAdminProtocolError(`${label}.${field} 必须为正整数`);
		return raw;
	};
	if (!isRecord(value.cost)) throw new PiAdminProtocolError(`${label}.cost 必须为对象`);
	rejectUnknownKeys(value.cost, MODEL_COST_KEYS, `${label}.cost`);
	const cost = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((key) => {
		const raw = (value.cost as Record<string, unknown>)[key];
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new PiAdminProtocolError(`${label}.cost.${key} 非法`);
		return [key, raw];
	})) as PiProviderModelInfo["cost"];
	const compat = value.compat === undefined ? {} : value.compat;
	if (!isRecord(compat)) throw new PiAdminProtocolError(`${label}.compat 必须为对象`);
	return {
		id,
		name,
		...(api ? { api } : {}),
		reasoning: value.reasoning,
		input: [...value.input] as Array<"text" | "image">,
		contextWindow: positive(value.contextWindow, "contextWindow"),
		maxTokens: positive(value.maxTokens, "maxTokens"),
		cost,
		compat: { ...compat } as PiProviderModelInfo["compat"],
	};
}

function parseProviderModel(value: unknown, index: number): PiProviderModel {
	const label = `models[${index}]`;
	if (!isRecord(value)) throw new PiAdminProtocolError(`${label} 必须为对象`);
	rejectUnknownKeys(value, PROVIDER_MODEL_KEYS, label);
	const id = requireString(value.id, `${label}.id`, MAX_ID);
	const name = value.name === undefined ? id : requireString(value.name, `${label}.name`);
	if (value.metadataSource === "catalog") {
		if (value.metadata !== undefined) {
			throw new PiAdminProtocolError(`${label} catalog 模型不得携带 metadata`);
		}
		return { id, name, metadataSource: "catalog" };
	}
	if (value.metadataSource !== "explicit") {
		throw new PiAdminProtocolError(`${label}.metadataSource 必须是 catalog 或 explicit`);
	}
	const metadata = parseProviderModelMetadata(value.metadata, `${label}.metadata`);
	if (metadata.id !== id) {
		throw new PiAdminProtocolError(`${label}.metadata.id 与 id 不一致`);
	}
	return { id, name, metadataSource: "explicit", metadata };
}

function parseProviderModels(value: unknown): PiProviderModel[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_PROVIDER_MODELS) throw new PiAdminProtocolError(`models 必须是最多 ${MAX_PROVIDER_MODELS} 项的数组`);
	const models = value.map((item, index) => parseProviderModel(item, index));
	if (new Set(models.map((model) => model.id)).size !== models.length) throw new PiAdminProtocolError("models 存在重复项");
	return models;
}

function parseProviderCredential(value: unknown): PiProviderCredentialInput {
	if (!isRecord(value)) throw new PiAdminProtocolError("credential 必须为对象");
	rejectUnknownKeys(value, PROVIDER_CREDENTIAL_KEYS, "credential");
	const input: PiProviderCredentialInput = {
		apiKey: requireString(value.apiKey, "credential.apiKey", MAX_API_KEY),
	};
	if (value.name !== undefined) {
		input.name = requireString(value.name, "credential.name", MAX_NAME);
	}
	return input;
}

/** 严格解析瞬时模型发现请求；apiKey 必填且不会被持久化。 */
export function parsePiProviderDiscoveryInput(
	value: unknown,
): PiProviderDiscoveryInput {
	if (!isRecord(value)) throw new PiAdminProtocolError("发现请求必须为对象");
	rejectUnknownKeys(value, DISCOVERY_KEYS, "发现请求");
	const baseUrl = parseProviderBaseUrl(value.baseUrl);
	if (!baseUrl) throw new PiAdminProtocolError("baseUrl 为必填");
	const input: PiProviderDiscoveryInput = {
		protocol: parseProviderProtocol(value.protocol, "protocol"),
		baseUrl,
		apiKey: requireString(value.apiKey, "apiKey", MAX_API_KEY),
	};
	if (value.headers !== undefined) input.headers = parseProviderHeaders(value.headers);
	if (value.runtimeProviderId !== undefined) {
		input.runtimeProviderId = requireString(
			value.runtimeProviderId,
			"runtimeProviderId",
			MAX_ID,
		);
	}
	return input;
}

function parseProviderInput(value: unknown, partial: boolean): PiProviderCreateInput | PiProviderUpdateInput {
	if (!isRecord(value)) throw new PiAdminProtocolError("Provider 必须为对象");
	rejectUnknownKeys(value, PROVIDER_KEYS, "Provider");
	const input: PiProviderCreateInput | PiProviderUpdateInput = {};
	if (value.name !== undefined) input.name = requireString(value.name, "name");
	if (value.runtimeProviderId !== undefined) input.runtimeProviderId = requireString(value.runtimeProviderId, "runtimeProviderId", MAX_ID);
	if (value.protocol !== undefined) input.protocol = parseProviderProtocol(value.protocol, "protocol");
	if (value.baseUrl !== undefined) input.baseUrl = parseProviderBaseUrl(value.baseUrl);
	if (value.headers !== undefined) input.headers = parseProviderHeaders(value.headers);
	if (value.models !== undefined) input.models = parseProviderModels(value.models);
	if (value.credential !== undefined) {
		if (partial) throw new PiAdminProtocolError("Provider 更新不接受 credential");
		(input as PiProviderCreateInput).credential = parseProviderCredential(
			value.credential,
		);
	}
	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") throw new PiAdminProtocolError("enabled 必须为 boolean");
		input.enabled = value.enabled;
	}
	if (!partial) {
		if (!input.name || !input.runtimeProviderId || !input.protocol) throw new PiAdminProtocolError("Provider 缺少必填字段");
		input.baseUrl ??= null;
		input.headers ??= {};
		input.models ??= [];
	}
	if (partial && Object.keys(input).length === 0) throw new PiAdminProtocolError("Provider 更新至少需要一个字段");
	return input;
}

/** 严格解析 Provider 创建请求。 */
export function parsePiProviderCreateInput(value: unknown): PiProviderCreateInput {
	return parseProviderInput(value, false) as PiProviderCreateInput;
}

/** 严格解析 Provider 更新请求。 */
export function parsePiProviderUpdateInput(value: unknown): PiProviderUpdateInput {
	return parseProviderInput(value, true) as PiProviderUpdateInput;
}
function parseAllowedModels(value: unknown): PiModelRef[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALLOWED_MODELS) {
		throw new PiAdminProtocolError(
			`allowedModels 数量必须在 1-${MAX_ALLOWED_MODELS} 之间`,
		);
	}
	const models = value.map((item, index) => {
		const label = `allowedModels[${index}]`;
		if (!isRecord(item)) throw new PiAdminProtocolError(`${label} 必须为对象`);
		rejectUnknownKeys(item, MODEL_REF_KEYS, label);
		const ref: PiModelRef = {
			provider: requireString(item.provider, `${label}.provider`),
			modelId: requireString(item.modelId, `${label}.modelId`),
		};
		if (item.maxThinkingLevel !== undefined) {
			const level = requireString(
				item.maxThinkingLevel,
				`${label}.maxThinkingLevel`,
			);
			if (!THINKING_LEVELS.includes(level)) {
				throw new PiAdminProtocolError(`${label}.maxThinkingLevel 非法`);
			}
			ref.maxThinkingLevel = level;
		}
		return ref;
	});
	if (
		new Set(models.map((m) => `${m.provider}/${m.modelId}`)).size !== models.length
	) {
		throw new PiAdminProtocolError("allowedModels 存在重复项");
	}
	return models;
}

function parseThinkingLevel(value: unknown): string {
	const level = requireString(value, "defaultThinkingLevel");
	if (!THINKING_LEVELS.includes(level)) {
		throw new PiAdminProtocolError("defaultThinkingLevel 非法");
	}
	return level;
}

function parseCredentialIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_CREDENTIAL_IDS) {
		throw new PiAdminProtocolError(
			`credentialIds 必须为长度 0-${MAX_CREDENTIAL_IDS} 的数组`,
		);
	}
	return value.map((id, index) =>
		requireString(id, `credentialIds[${index}]`, MAX_ID),
	);
}

function parseDefaultModel(value: unknown): { provider: string; modelId: string } {
	if (!isRecord(value)) throw new PiAdminProtocolError("defaultModel 必须为对象");
	rejectUnknownKeys(value, DEFAULT_MODEL_KEYS, "defaultModel");
	return {
		provider: requireString(value.provider, "defaultModel.provider"),
		modelId: requireString(value.modelId, "defaultModel.modelId"),
	};
}

/** 严格解析 Profile 创建请求 */
export function parsePiProfileCreateInput(value: unknown): PiProfileCreateInput {
	if (!isRecord(value)) throw new PiAdminProtocolError("Profile 必须为对象");
	rejectUnknownKeys(value, PROFILE_CREATE_KEYS, "Profile");
	const input: PiProfileCreateInput = {
		name: requireString(value.name, "name"),
		defaultModel: parseDefaultModel(value.defaultModel),
		allowedModels: parseAllowedModels(value.allowedModels),
		defaultThinkingLevel: parseThinkingLevel(value.defaultThinkingLevel),
	};
	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") {
			throw new PiAdminProtocolError("enabled 必须为 boolean");
		}
		input.enabled = value.enabled;
	}
	if (value.credentialIds !== undefined) {
		input.credentialIds = parseCredentialIds(value.credentialIds);
	}
	if (value.enabledResourceIds !== undefined) {
		input.enabledResourceIds = parseResourceIds(value.enabledResourceIds);
	}
	if (value.toolPolicy !== undefined) {
		input.toolPolicy = parseProfileToolPolicy(value.toolPolicy);
	}
	if (value.toolExecutionMode !== undefined) {
		input.toolExecutionMode = parseProfileToolExecutionMode(value.toolExecutionMode);
	}
	return input;
}

/**
 * 解析 Profile 的工具执行模式：未知值一律拒绝（400），不静默回退。
 * 持久化与迁移的默认值由 Server 选择，不在协议层猜。
 */
function parseProfileToolExecutionMode(value: unknown): PiToolExecutionMode {
	if (!isPiToolExecutionMode(value)) {
		throw new PiAdminProtocolError(
			"toolExecutionMode 必须是 approval/auto/yolo",
		);
	}
	return value;
}

/**
 * 解析 Profile 的工具策略：把共享 parser 的 `PiProtocolError` 统一为边界错误类型，
 * 使 Controller 映射为 400 而不是 500（请求体错误属于协议错误）。
 */
function parseProfileToolPolicy(value: unknown): PiToolPolicy {
	try {
		return parsePiToolPolicy(value);
	} catch (error) {
		throw new PiAdminProtocolError((error as Error).message);
	}
}

/** 资源 ID 列表：非空字符串、去重、数量受限（Bundle 资源 ID，非路径）。 */
function parseResourceIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_RESOURCE_IDS) {
		throw new PiAdminProtocolError(
			`enabledResourceIds 数量必须在 0-${MAX_RESOURCE_IDS} 之间`,
		);
	}
	const ids = value.map((item, index) =>
		requireString(item, `enabledResourceIds[${index}]`),
	);
	if (new Set(ids).size !== ids.length) {
		throw new PiAdminProtocolError("enabledResourceIds 存在重复项");
	}
	return ids;
}

/** 严格解析 Profile 更新请求（至少一个字段，未知字段拒绝） */
export function parsePiProfileUpdateInput(value: unknown): PiProfileUpdateInput {
	if (!isRecord(value)) throw new PiAdminProtocolError("Profile 必须为对象");
	rejectUnknownKeys(value, PROFILE_UPDATE_KEYS, "Profile");
	const input: PiProfileUpdateInput = {};
	if (value.name !== undefined) input.name = requireString(value.name, "name");
	if (value.defaultModel !== undefined) {
		input.defaultModel = parseDefaultModel(value.defaultModel);
	}
	if (value.allowedModels !== undefined) {
		input.allowedModels = parseAllowedModels(value.allowedModels);
	}
	if (value.defaultThinkingLevel !== undefined) {
		input.defaultThinkingLevel = parseThinkingLevel(value.defaultThinkingLevel);
	}
	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") {
			throw new PiAdminProtocolError("enabled 必须为 boolean");
		}
		input.enabled = value.enabled;
	}
	if (value.credentialIds !== undefined) {
		input.credentialIds = parseCredentialIds(value.credentialIds);
	}
	if (value.enabledResourceIds !== undefined) {
		input.enabledResourceIds = parseResourceIds(value.enabledResourceIds);
	}
	if (value.toolPolicy !== undefined) {
		input.toolPolicy = parseProfileToolPolicy(value.toolPolicy);
	}
	if (value.toolExecutionMode !== undefined) {
		input.toolExecutionMode = parseProfileToolExecutionMode(value.toolExecutionMode);
	}
	if (Object.keys(input).length === 0) {
		throw new PiAdminProtocolError("Profile 更新至少需要一个字段");
	}
	return input;
}

/** 严格解析 Credential 创建请求（明文只在此处读取一次） */
export function parsePiCredentialCreateInput(
	value: unknown,
): PiCredentialCreateInput {
	if (!isRecord(value)) throw new PiAdminProtocolError("Credential 必须为对象");
	rejectUnknownKeys(value, CREDENTIAL_CREATE_KEYS, "Credential");
	return {
		name: requireString(value.name, "name"),
		providerConfigId: requireString(value.providerConfigId, "providerConfigId", MAX_ID),
		apiKey: requireString(value.apiKey, "apiKey", MAX_API_KEY),
	};
}

/** 严格解析 Credential 更新请求（改名或轮换 key） */
export function parsePiCredentialUpdateInput(
	value: unknown,
): PiCredentialUpdateInput {
	if (!isRecord(value)) throw new PiAdminProtocolError("Credential 必须为对象");
	rejectUnknownKeys(value, CREDENTIAL_UPDATE_KEYS, "Credential");
	const input: PiCredentialUpdateInput = {};
	const name = requireOptionalString(value.name, "name");
	if (name !== undefined) input.name = name;
	if (value.apiKey !== undefined) {
		input.apiKey = requireString(value.apiKey, "apiKey", MAX_API_KEY);
	}
	if (Object.keys(input).length === 0) {
		throw new PiAdminProtocolError("Credential 更新至少需要一个字段");
	}
	return input;
}
