/**
 * Tailnet 管理协议的跨运行时契约（ADR-0062）。
 *
 * 本模块只描述协议字段、固定错误码与严格解析，不代表 Tailnet 网络权威：
 * 摘要来自 Client 对官方 CLI 的只读观测，凭据正文只在短时交付通道中出现。
 */

/** 协议版本；能力协商只接受该版本。 */
export const TAILNET_PROTOCOL_VERSION = 1 as const;

/** Client 声明的管理能力名；与 `JobType.TAILNET_MANAGE` 同名但语义不同。 */
export const TAILNET_CAPABILITY = "tailnet.manage";

/**
 * Tailnet 固定错误码。
 *
 * 跨运行时只传这些常量，不透传 CLI stderr、堆栈或任意文本。
 */
export const TAILNET_ERROR_CODES = {
	CLI_MISSING: "TAILNET_CLI_MISSING",
	CLI_FAILED: "TAILNET_CLI_FAILED",
	PROBE_TIMEOUT: "TAILNET_PROBE_TIMEOUT",
	UNSUPPORTED_PLATFORM: "TAILNET_UNSUPPORTED_PLATFORM",
	INSTALL_FAILED: "TAILNET_INSTALL_FAILED",
	INSTALL_REBOOT_REQUIRED: "TAILNET_INSTALL_REBOOT_REQUIRED",
	EXISTING_CONFIG: "TAILNET_EXISTING_CONFIG",
	JOIN_FAILED: "TAILNET_JOIN_FAILED",
	SECRET_TIMEOUT: "TAILNET_SECRET_TIMEOUT",
	SECRET_DENIED: "TAILNET_SECRET_DENIED",
	SECRET_EXPIRED: "TAILNET_SECRET_EXPIRED",
	SECRET_MISMATCH: "TAILNET_SECRET_MISMATCH",
	SECRET_CLEANUP_FAILED: "TAILNET_SECRET_CLEANUP_FAILED",
	KEY_UNAVAILABLE: "TAILNET_KEY_UNAVAILABLE",
	KEY_BUSY: "TAILNET_KEY_BUSY",
	OPERATION_BUSY: "TAILNET_OPERATION_BUSY",
	OPERATION_MISMATCH: "TAILNET_OPERATION_MISMATCH",
} as const;

/** Tailnet 固定错误码联合类型。 */
export type TailnetErrorCode =
	(typeof TAILNET_ERROR_CODES)[keyof typeof TAILNET_ERROR_CODES];

const TAILNET_ERROR_CODE_VALUES: readonly TailnetErrorCode[] = Object.values(
	TAILNET_ERROR_CODES,
);

/** 判断字符串是否为 Shared 固定错误码。 */
export function isTailnetErrorCode(
	value: unknown,
): value is TailnetErrorCode {
	return (
		typeof value === "string" &&
		(TAILNET_ERROR_CODE_VALUES as readonly string[]).includes(value)
	);
}

/** 凭据导入时由操作者声明的复用方式；`unknown` 表示未声明，不推断。 */
export type TailnetReuse = "single" | "reusable" | "unknown";

/** 凭据当前可被使用的程度。 */
export type TailnetKeyUse = "available" | "reserved" | "spent" | "uncertain";

/** 导入凭据的请求；`authKey` 只允许出现在该请求与短时交付响应中。 */
export interface TailnetKeyInput {
	name: string;
	authKey: string;
	declaredReuse: TailnetReuse;
	declaredExpiresAt: string | null;
}

/** 凭据元信息；不返回 authKey、密文或掩码尾码。 */
export interface TailnetKeyInfo {
	id: string;
	name: string;
	declaredReuse: TailnetReuse;
	declaredExpiresAt: string | null;
	use: TailnetKeyUse;
	createdAt: string;
}

/**
 * Client 对官方 CLI 的只读观测摘要。
 *
 * 绝不包含 Peer 拓扑；`backend` 无法识别时收敛为 `unknown`，不猜测。
 */
export interface TailnetSnapshot {
	installed: "yes" | "no" | "unknown";
	version: string | null;
	service: "running" | "stopped" | "unknown";
	backend:
		| "running"
		| "needs-login"
		| "needs-approval"
		| "stopped"
		| "unknown";
	nodeName: string | null;
	ipv4: string[];
	ipv6: string[];
	observedAt: string;
	errorCode: TailnetErrorCode | null;
}

/** 版本化能力声明；只表示能处理该协议，不是 installed/可达性证明。 */
export interface TailnetCapability {
	protocolVersion: 1;
}

/** 持久化的 Tailnet Job 输入；严禁内联 authKey。 */
export type TailnetJobPayload =
	| { action: "inspect" }
	| { action: "ensure"; credentialId: string; installIfMissing: boolean };

/** Tailnet Job 的安全结果；只含阶段与摘要。 */
export interface TailnetJobResult {
	stage:
		| "inspected"
		| "installed"
		| "joined"
		| "existing-login"
		| "awaiting-approval"
		| "interrupted";
	snapshot: TailnetSnapshot;
}

/** Client → Server 的凭据请求；requestId 单次使用，窗口 30 秒。 */
export interface TailnetSecretRequest {
	protocolVersion: 1;
	jobId: string;
	requestId: string;
}

/** Server → Client 的凭据响应；只允许目标 socket 接收。 */
export interface TailnetSecretResponse extends TailnetSecretRequest {
	expiresAt: string;
	authKey: string;
}

/** 消费方对响应的期望；用于拒绝超期、错 jobId 或错 requestId 的正文。 */
export interface TailnetSecretExpectation {
	jobId: string;
	requestId: string;
}

/** 机器 Tailnet 状态；`snapshot: null` 表示没有历史或当前观测。 */
export interface TailnetStatus {
	clientId: string;
	online: boolean;
	supported: boolean;
	snapshot: TailnetSnapshot | null;
}

const MAX_NAME = 100;
const MAX_ID = 128;
const MAX_AUTH_KEY = 4096;
const MAX_VERSION = 100;
const MAX_NODE_NAME = 253;
const MAX_ADDRESSES = 16;

const ISO_INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const TAILNET_REUSE_VALUES: readonly TailnetReuse[] = [
	"single",
	"reusable",
	"unknown",
];
const TAILNET_KEY_USE_VALUES: readonly TailnetKeyUse[] = [
	"available",
	"reserved",
	"spent",
	"uncertain",
];
const TAILNET_INSTALLED_VALUES = ["yes", "no", "unknown"] as const;
const TAILNET_SERVICE_VALUES = ["running", "stopped", "unknown"] as const;
const TAILNET_BACKEND_VALUES = [
	"running",
	"needs-login",
	"needs-approval",
	"stopped",
	"unknown",
] as const;
const TAILNET_STAGE_VALUES = [
	"inspected",
	"installed",
	"joined",
	"existing-login",
	"awaiting-approval",
	"interrupted",
] as const;

/**
 * 每种 action 允许的持久化键集。
 *
 * 先校验 action，再按对应键集拒绝额外字段；因此 `ensure` 夹带的 `authKey`
 * 会在解析阶段失败，而不是被悄悄忽略。
 */
const TAILNET_ACTION_KEYS = {
	inspect: ["action"],
	ensure: ["action", "credentialId", "installIfMissing"],
} as const;

function requireRecord(
	value: unknown,
	label: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} 必须为对象`);
	}
	return value as Record<string, unknown>;
}

/** 严格白名单：拒绝未知字段也拒绝缺失字段；错误只报键名，不回显取值。 */
function requireExactKeys(
	value: unknown,
	label: string,
	allowed: readonly string[],
): Record<string, unknown> {
	const record = requireRecord(value, label);
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new Error(`${label} 含未知字段 ${key}`);
		}
	}
	for (const key of allowed) {
		if (!Object.hasOwn(record, key)) {
			throw new Error(`${label} 缺少字段 ${key}`);
		}
	}
	return record;
}

function requireBoundedString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength
	) {
		throw new Error(`${field} 必须为长度 1-${maxLength} 的字符串`);
	}
	return value;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${field} 必须为布尔值`);
	}
	return value;
}

function requireEnum<T extends string>(
	value: unknown,
	field: string,
	allowed: readonly T[],
): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new Error(`${field} 取值不合法`);
	}
	return value as T;
}

function requireIsoInstant(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		!ISO_INSTANT.test(value) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new Error(`${field} 必须为可解析的 ISO 时间`);
	}
	return value;
}

/** 凭据正文：1–4096 字符，且不得含 CR/LF/NUL（防止日志与文件注入）。 */
function requireAuthKey(value: unknown, field: string): string {
	const key = requireBoundedString(value, field, MAX_AUTH_KEY);
	if (/[\r\n\0]/.test(key)) {
		throw new Error(`${field} 不得包含 CR/LF/NUL`);
	}
	return key;
}

/**
 * 解析凭据导入输入；未知字段、超长、非法日期均拒绝。
 *
 * `declaredReuse: "unknown"` 原样保留，不按其他证据改写。
 */
export function parseTailnetKeyInput(value: unknown): TailnetKeyInput {
	const record = requireExactKeys(value, "tailnet key input", [
		"name",
		"authKey",
		"declaredReuse",
		"declaredExpiresAt",
	]);
	return {
		name: requireBoundedString(record.name, "name", MAX_NAME),
		authKey: requireAuthKey(record.authKey, "authKey"),
		declaredReuse: requireEnum(
			record.declaredReuse,
			"declaredReuse",
			TAILNET_REUSE_VALUES,
		),
		declaredExpiresAt:
			record.declaredExpiresAt === null
				? null
				: requireIsoInstant(record.declaredExpiresAt, "declaredExpiresAt"),
	};
}

/** 解析凭据元信息；拒绝任何形式的密钥字段。 */
export function parseTailnetKeyInfo(value: unknown): TailnetKeyInfo {
	const record = requireExactKeys(value, "tailnet key info", [
		"id",
		"name",
		"declaredReuse",
		"declaredExpiresAt",
		"use",
		"createdAt",
	]);
	return {
		id: requireBoundedString(record.id, "id", MAX_ID),
		name: requireBoundedString(record.name, "name", MAX_NAME),
		declaredReuse: requireEnum(
			record.declaredReuse,
			"declaredReuse",
			TAILNET_REUSE_VALUES,
		),
		declaredExpiresAt:
			record.declaredExpiresAt === null
				? null
				: requireIsoInstant(record.declaredExpiresAt, "declaredExpiresAt"),
		use: requireEnum(record.use, "use", TAILNET_KEY_USE_VALUES),
		createdAt: requireIsoInstant(record.createdAt, "createdAt"),
	};
}

/** 解析 Tailnet Job 输入；按 action 执行精确键集白名单。 */
export function parseTailnetJobPayload(value: unknown): TailnetJobPayload {
	const record = requireRecord(value, "tailnet job payload");
	const action = record.action;
	if (action !== "inspect" && action !== "ensure") {
		throw new Error("tailnet job payload 的 action 不合法");
	}
	requireExactKeys(record, "tailnet job payload", TAILNET_ACTION_KEYS[action]);
	if (action === "inspect") {
		return { action: "inspect" };
	}
	return {
		action: "ensure",
		credentialId: requireBoundedString(
			record.credentialId,
			"credentialId",
			MAX_ID,
		),
		installIfMissing: requireBoolean(
			record.installIfMissing,
			"installIfMissing",
		),
	};
}

/** 解析观测摘要；未知枚举、任意错误码文本与 Peer 字段一律拒绝。 */
export function parseTailnetSnapshot(value: unknown): TailnetSnapshot {
	const record = requireExactKeys(value, "tailnet snapshot", [
		"installed",
		"version",
		"service",
		"backend",
		"nodeName",
		"ipv4",
		"ipv6",
		"observedAt",
		"errorCode",
	]);
	return {
		installed: requireEnum(
			record.installed,
			"installed",
			TAILNET_INSTALLED_VALUES,
		),
		version:
			record.version === null
				? null
				: requireBoundedString(record.version, "version", MAX_VERSION),
		service: requireEnum(record.service, "service", TAILNET_SERVICE_VALUES),
		backend: requireEnum(record.backend, "backend", TAILNET_BACKEND_VALUES),
		nodeName:
			record.nodeName === null
				? null
				: requireBoundedString(record.nodeName, "nodeName", MAX_NODE_NAME),
		ipv4: requireAddresses(record.ipv4, "ipv4", 4),
		ipv6: requireAddresses(record.ipv6, "ipv6", 6),
		observedAt: requireIsoInstant(record.observedAt, "observedAt"),
		errorCode:
			record.errorCode === null
				? null
				: requireEnum(record.errorCode, "errorCode", TAILNET_ERROR_CODE_VALUES),
	};
}

/** 解析 Tailnet Job 结果；阶段必须是固定枚举。 */
export function parseTailnetJobResult(value: unknown): TailnetJobResult {
	const record = requireExactKeys(value, "tailnet job result", [
		"stage",
		"snapshot",
	]);
	return {
		stage: requireEnum(record.stage, "stage", TAILNET_STAGE_VALUES),
		snapshot: parseTailnetSnapshot(record.snapshot),
	};
}

/** 解析能力声明；只接受协议版本 1。 */
export function parseTailnetCapability(value: unknown): TailnetCapability {
	const record = requireExactKeys(value, "tailnet capability", [
		"protocolVersion",
	]);
	if (record.protocolVersion !== TAILNET_PROTOCOL_VERSION) {
		throw new Error("tailnet capability 的 protocolVersion 不合法");
	}
	return { protocolVersion: TAILNET_PROTOCOL_VERSION };
}

/** 解析凭据请求；requestId 单次使用，长度有界。 */
export function parseTailnetSecretRequest(value: unknown): TailnetSecretRequest {
	const record = requireExactKeys(value, "tailnet secret request", [
		"protocolVersion",
		"jobId",
		"requestId",
	]);
	if (record.protocolVersion !== TAILNET_PROTOCOL_VERSION) {
		throw new Error("tailnet secret request 的 protocolVersion 不合法");
	}
	return {
		protocolVersion: TAILNET_PROTOCOL_VERSION,
		jobId: requireBoundedString(record.jobId, "jobId", MAX_ID),
		requestId: requireBoundedString(record.requestId, "requestId", MAX_ID),
	};
}

/** 解析凭据响应；authKey 正文不写入异常，也不允许未知字段。 */
export function parseTailnetSecretResponse(
	value: unknown,
): TailnetSecretResponse {
	const record = requireExactKeys(value, "tailnet secret response", [
		"protocolVersion",
		"jobId",
		"requestId",
		"expiresAt",
		"authKey",
	]);
	if (record.protocolVersion !== TAILNET_PROTOCOL_VERSION) {
		throw new Error("tailnet secret response 的 protocolVersion 不合法");
	}
	return {
		protocolVersion: TAILNET_PROTOCOL_VERSION,
		jobId: requireBoundedString(record.jobId, "jobId", MAX_ID),
		requestId: requireBoundedString(record.requestId, "requestId", MAX_ID),
		expiresAt: requireIsoInstant(record.expiresAt, "expiresAt"),
		authKey: requireAuthKey(record.authKey, "authKey"),
	};
}

/**
 * 消费方守卫：响应必须属于本次请求且未过期（到期即视为失效）。
 *
 * 失败抛出带固定 `code` 的错误，正文仍只在成功路径可见。
 */
export function assertTailnetSecretUsable(
	response: TailnetSecretResponse,
	expected: TailnetSecretExpectation,
	nowMs: number = Date.now(),
): TailnetSecretResponse {
	if (
		response.jobId !== expected.jobId ||
		response.requestId !== expected.requestId
	) {
		throw codedError(
			TAILNET_ERROR_CODES.SECRET_MISMATCH,
			"tailnet secret response 与当前请求不匹配",
		);
	}
	if (Date.parse(response.expiresAt) <= nowMs) {
		throw codedError(
			TAILNET_ERROR_CODES.SECRET_EXPIRED,
			"tailnet secret response 已过期",
		);
	}
	return response;
}

/** 解析机器 Tailnet 状态；离线与缺失摘要都允许，但不做宽松猜测。 */
export function parseTailnetStatus(value: unknown): TailnetStatus {
	const record = requireExactKeys(value, "tailnet status", [
		"clientId",
		"online",
		"supported",
		"snapshot",
	]);
	return {
		clientId: requireBoundedString(record.clientId, "clientId", MAX_ID),
		online: requireBoolean(record.online, "online"),
		supported: requireBoolean(record.supported, "supported"),
		snapshot:
			record.snapshot === null ? null : parseTailnetSnapshot(record.snapshot),
	};
}

function requireAddresses(
	value: unknown,
	field: string,
	family: 4 | 6,
): string[] {
	if (!Array.isArray(value) || value.length > MAX_ADDRESSES) {
		throw new Error(`${field} 必须为不超过 ${MAX_ADDRESSES} 项的数组`);
	}
	return value.map((item) => {
		if (typeof item !== "string" || !isIpLiteral(item, family)) {
			throw new Error(`${field} 含非法 IP 地址`);
		}
		return item;
	});
}

function codedError(code: TailnetErrorCode, message: string): Error {
	const error = new Error(message) as Error & { code: TailnetErrorCode };
	error.code = code;
	return error;
}

/**
 * 跨运行时 IP 字面量校验（等价 `node:net.isIP`）。
 *
 * Shared 不引入 Node 专用依赖；只接受严格写法，不接受 zone id、前导零与 IPv4 映射简写以外的宽松形式。
 */
function isIpLiteral(value: string, family: 4 | 6): boolean {
	return family === 4 ? isIPv4Literal(value) : isIPv6Literal(value);
}

function isIPv4Literal(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	for (const part of parts) {
		if (part.length === 0 || part.length > 3) return false;
		if (!/^[0-9]+$/.test(part)) return false;
		if (part.length > 1 && part.startsWith("0")) return false;
		if (Number(part) > 255) return false;
	}
	return true;
}

function isIPv6Literal(input: string): boolean {
	if (input.length < 2 || input.length > 45) return false;
	// node:net.isIP 不接受 zone id（如 fe80::1%eth0）。
	if (input.includes("%")) return false;
	const compressionIndex = input.indexOf("::");
	if (compressionIndex === -1) {
		const groups = input.split(":");
		return countIPv6Groups(groups) === 8;
	}
	const right = input.slice(compressionIndex + 2);
	// 只允许一个 "::"；第二个压缩符必须走拒绝分支。
	if (right.includes("::")) return false;
	const leftPart = input.slice(0, compressionIndex);
	const left = leftPart === "" ? [] : leftPart.split(":");
	const tail = right === "" ? [] : right.split(":");
	const effective = countIPv6Groups([...left, ...tail]);
	// "::" 至少压缩一组；最多 7 组有效位。
	return effective >= 0 && effective <= 7;
}

/** 返回有效 16 位组数；内嵌 IPv4 占两组。非法时返回 -1。 */
function countIPv6Groups(groups: string[]): number {
	let effective = 0;
	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index]!;
		// 中间空组只能由 "::" 表达，不能出现在普通分组里。
		if (group.length === 0) return -1;
		if (group.includes(".")) {
			if (index !== groups.length - 1) return -1;
			if (!isIPv4Literal(group)) return -1;
			effective += 2;
			continue;
		}
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return -1;
		effective += 1;
	}
	return effective;
}
