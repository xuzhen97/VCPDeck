/**
 * 功能条目契约（ADR-0056）。
 *
 * 条目是操作者/Agent 的声明，不是 Client 上报事实；`status` 是意图，
 * `lastVerified*` 是证据，`active` 只能由一次成功验证产生。
 */

/** 条目作用域：generic = 产出与机器无关，machine = 产物是该机器自身状态。 */
export const FEATURE_SCOPES = ["generic", "machine"] as const;
export type FeatureScope = (typeof FEATURE_SCOPES)[number];

/** 条目意图状态；active 只能由成功验证产生，不可手写。 */
export const FEATURE_STATUSES = ["draft", "active", "retired"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/** 证据新鲜度：读取时计算，不落库、不隐式改变 status。 */
export type FeatureFreshness = "never" | "fresh" | "stale";

/** 超过该天数视为证据过期。 */
export const FEATURE_STALE_AFTER_DAYS = 14;

/** 验证上报来源；Server 只记录，不亲测。 */
export const FEATURE_VERIFICATION_SOURCES = ["cli", "agent", "api"] as const;
export type FeatureVerificationSource =
	(typeof FEATURE_VERIFICATION_SOURCES)[number];

const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_CLIENT_ID = 128;
const MAX_SLUG = 63;
const MAX_NAME = 120;
const MAX_SUMMARY = 500;
const MAX_COMMAND = 4_000;
const MAX_URL = 2_048;
const MAX_OUTPUT = 2_000;
const MAX_NOTES = 8_000;
const MAX_EVIDENCE = 2_000;
const MAX_INPUTS = 20;
const MAX_INPUT_DESCRIPTION = 200;
const MAX_EXAMPLE = 200;
const MAX_OPTIONS = 20;
const MAX_OPTION_LENGTH = 120;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** 功能条目协议错误；Server 映射为 400 INVALID_FEATURE_INPUT。 */
export class FeatureProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FeatureProtocolError";
	}
}

/** 功能目录稳定错误码。 */
export const FEATURE_ERROR_CODES = [
	"FEATURE_NOT_FOUND",
	"FEATURE_SLUG_TAKEN",
	"INVALID_FEATURE_INPUT",
	"INVALID_FEATURE_STATUS_TRANSITION",
	"FEATURE_CLIENT_UNKNOWN",
] as const;
export type FeatureErrorCode = (typeof FEATURE_ERROR_CODES)[number];

/** 调用契约：command 在 host 上执行，http 由调用方直连。 */
export type FeatureInvocation =
	| { kind: "command"; command: string; timeoutSeconds: number }
	| {
			kind: "http";
			method: "GET" | "POST";
			url: string;
			timeoutSeconds: number;
	  };

/** 参数表条目；仅用于向 Agent 描述契约，不做运行时校验。 */
export interface FeatureInputParam {
	name: string;
	type: "string" | "number" | "boolean" | "enum" | "path";
	required: boolean;
	description: string;
	example?: string;
	options?: string[];
}

/** 一次验证上报。 */
export interface FeatureVerification {
	ok: boolean;
	durationMs?: number;
	evidence?: string;
	via: FeatureVerificationSource;
}

/** 创建条目入参（已归一化）。 */
export interface FeatureCreateInput {
	clientId: string;
	slug: string;
	name: string;
	summary: string;
	scope: FeatureScope;
	invoke: FeatureInvocation;
	verify: FeatureInvocation;
	inputs: FeatureInputParam[];
	output: string;
	notes: string;
	sourceJobId: string | null;
	verification?: FeatureVerification;
}

/** 更新条目入参；slug/clientId/active 一律不可改。 */
export interface FeatureUpdateInput {
	name?: string;
	summary?: string;
	scope?: FeatureScope;
	invoke?: FeatureInvocation;
	verify?: FeatureInvocation;
	inputs?: FeatureInputParam[];
	output?: string;
	notes?: string;
	/** 只允许人工降级为 draft 或退役。 */
	status?: "draft" | "retired";
}

/** REST 投影：契约 + 意图 + 证据 + 新鲜度。 */
export interface FeatureInfo {
	id: string;
	slug: string;
	name: string;
	summary: string;
	clientId: string;
	clientName: string | null;
	scope: FeatureScope;
	invoke: FeatureInvocation;
	verify: FeatureInvocation;
	inputs: FeatureInputParam[];
	output: string;
	notes: string;
	status: FeatureStatus;
	freshness: FeatureFreshness;
	lastVerifiedAt: string | null;
	lastVerifiedOk: boolean | null;
	lastVerifyEvidence: string | null;
	verifiedVia: string | null;
	sourceJobId: string | null;
	createdByName: string | null;
	createdVia: string | null;
	createdAt: string;
	updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(
	value: Record<string, unknown>,
	allowed: readonly string[],
	field: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new FeatureProtocolError(`${field} 含未知字段 ${key}`);
		}
	}
}

/** 拒绝 C0 控制字符（允许换行、回车、制表）。 */
function hasControlCharacters(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			code === 0x7f
		) {
			return true;
		}
	}
	return false;
}

function parseText(
	value: unknown,
	field: string,
	maxLength: number,
	allowEmpty = false,
): string {
	if (typeof value !== "string") {
		throw new FeatureProtocolError(`${field} 必须为字符串`);
	}
	const trimmed = value.trim();
	if (!allowEmpty && trimmed.length === 0) {
		throw new FeatureProtocolError(`${field} 不能为空`);
	}
	if (trimmed.length > maxLength) {
		throw new FeatureProtocolError(`${field} 不能超过 ${maxLength} 字符`);
	}
	if (hasControlCharacters(trimmed)) {
		throw new FeatureProtocolError(`${field} 不能包含控制字符`);
	}
	return trimmed;
}

function parseTimeout(value: unknown): number {
	if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
	if (
		!Number.isInteger(value) ||
		(value as number) < 1 ||
		(value as number) > MAX_TIMEOUT_SECONDS
	) {
		throw new FeatureProtocolError(
			`timeoutSeconds 必须是 1-${MAX_TIMEOUT_SECONDS} 的整数`,
		);
	}
	return value as number;
}

function parseUrl(value: unknown, field: string): string {
	const url = parseText(value, field, MAX_URL);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new FeatureProtocolError(`${field} 不是合法 URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new FeatureProtocolError(`${field} 只支持 http/https`);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new FeatureProtocolError(`${field} 不得包含 userinfo（user:pass@）`);
	}
	return url;
}

/** 严格解析调用契约；command 型给 command，http 型给 method + url。 */
export function parseFeatureInvocation(
	value: unknown,
	field = "invoke",
): FeatureInvocation {
	if (!isRecord(value)) {
		throw new FeatureProtocolError(`${field} 必须为对象`);
	}
	if (value.kind === "command") {
		rejectUnknown(value, ["kind", "command", "timeoutSeconds"], field);
		return {
			kind: "command",
			command: parseText(value.command, `${field}.command`, MAX_COMMAND),
			timeoutSeconds: parseTimeout(value.timeoutSeconds),
		};
	}
	if (value.kind === "http") {
		rejectUnknown(value, ["kind", "method", "url", "timeoutSeconds"], field);
		if (value.method !== "GET" && value.method !== "POST") {
			throw new FeatureProtocolError(`${field}.method 必须是 GET 或 POST`);
		}
		return {
			kind: "http",
			method: value.method,
			url: parseUrl(value.url, `${field}.url`),
			timeoutSeconds: parseTimeout(value.timeoutSeconds),
		};
	}
	throw new FeatureProtocolError(`${field}.kind 必须是 command 或 http`);
}

function parseOptionalText(
	value: unknown,
	field: string,
	maxLength: number,
): string | undefined {
	return value === undefined ? undefined : parseText(value, field, maxLength);
}

/** 严格解析参数表；name 唯一，options 仅 enum 可用且必填。 */
export function parseFeatureInputs(value: unknown): FeatureInputParam[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new FeatureProtocolError("inputs 必须为数组");
	}
	if (value.length > MAX_INPUTS) {
		throw new FeatureProtocolError(`inputs 最多 ${MAX_INPUTS} 项`);
	}
	const seen = new Set<string>();
	return value.map((raw, index) => {
		const field = `inputs[${index}]`;
		if (!isRecord(raw)) {
			throw new FeatureProtocolError(`${field} 必须为对象`);
		}
		rejectUnknown(
			raw,
			["name", "type", "required", "description", "example", "options"],
			field,
		);
		const name = typeof raw.name === "string" ? raw.name : "";
		if (!INPUT_NAME_PATTERN.test(name)) {
			throw new FeatureProtocolError(`${field}.name 格式无效`);
		}
		if (seen.has(name)) {
			throw new FeatureProtocolError(`inputs 含重复 name: ${name}`);
		}
		seen.add(name);
		const type = raw.type;
		if (
			type !== "string" &&
			type !== "number" &&
			type !== "boolean" &&
			type !== "enum" &&
			type !== "path"
		) {
			throw new FeatureProtocolError(
				`${field}.type 必须是 string/number/boolean/enum/path`,
			);
		}
		if (typeof raw.required !== "boolean") {
			throw new FeatureProtocolError(`${field}.required 必须为 boolean`);
		}
		const param: FeatureInputParam = {
			name,
			type,
			required: raw.required,
			description: parseText(
				raw.description,
				`${field}.description`,
				MAX_INPUT_DESCRIPTION,
			),
		};
		const example = parseOptionalText(raw.example, `${field}.example`, MAX_EXAMPLE);
		if (example !== undefined) param.example = example;
		let options: string[] | undefined;
		if (raw.options !== undefined) {
			if (type !== "enum") {
				throw new FeatureProtocolError(`${field}.options 仅 enum 可用`);
			}
			if (
				!Array.isArray(raw.options) ||
				raw.options.length === 0 ||
				raw.options.length > MAX_OPTIONS
			) {
				throw new FeatureProtocolError(
					`${field}.options 必须为 1-${MAX_OPTIONS} 项数组`,
				);
			}
			options = raw.options.map((option, optionIndex) =>
				parseText(
					option,
					`${field}.options[${optionIndex}]`,
					MAX_OPTION_LENGTH,
				),
			);
		}
		if (type === "enum" && options === undefined) {
			throw new FeatureProtocolError(`${field}.options 在 enum 类型下必填`);
		}
		if (options !== undefined) param.options = options;
		return param;
	});
}

/** 严格解析一次验证上报；证据落库前截断到 2000 字符。 */
export function parseFeatureVerificationReport(
	value: unknown,
): FeatureVerification {
	if (!isRecord(value)) {
		throw new FeatureProtocolError("verification 必须为对象");
	}
	rejectUnknown(value, ["ok", "durationMs", "evidence", "via"], "verification");
	if (typeof value.ok !== "boolean") {
		throw new FeatureProtocolError("verification.ok 必须为 boolean");
	}
	if (value.via !== "cli" && value.via !== "agent" && value.via !== "api") {
		throw new FeatureProtocolError("verification.via 必须是 cli/agent/api");
	}
	const report: FeatureVerification = { ok: value.ok, via: value.via };
	if (value.durationMs !== undefined) {
		if (!Number.isInteger(value.durationMs) || (value.durationMs as number) < 0) {
			throw new FeatureProtocolError("verification.durationMs 必须为非负整数");
		}
		report.durationMs = value.durationMs as number;
	}
	if (value.evidence !== undefined) {
		if (typeof value.evidence !== "string") {
			throw new FeatureProtocolError("verification.evidence 必须为字符串");
		}
		const evidence = value.evidence.slice(0, MAX_EVIDENCE);
		if (hasControlCharacters(evidence.replace(/[\n\r\t]/g, " "))) {
			throw new FeatureProtocolError("verification.evidence 不能包含控制字符");
		}
		report.evidence = evidence;
	}
	return report;
}

/** 严格解析创建请求；未知字段拒绝，缺省文本归一化为空串。 */
export function parseFeatureCreateInput(value: unknown): FeatureCreateInput {
	if (!isRecord(value)) {
		throw new FeatureProtocolError("功能条目必须是对象");
	}
	rejectUnknown(
		value,
		[
			"clientId",
			"slug",
			"name",
			"summary",
			"scope",
			"invoke",
			"verify",
			"inputs",
			"output",
			"notes",
			"sourceJobId",
			"verification",
		],
		"feature",
	);
	const slug = typeof value.slug === "string" ? value.slug : "";
	if (slug.length > MAX_SLUG || !SLUG_PATTERN.test(slug)) {
		throw new FeatureProtocolError("slug 必须为 1-63 位小写 kebab-case");
	}
	if (value.scope !== "generic" && value.scope !== "machine") {
		throw new FeatureProtocolError("scope 必须是 generic 或 machine");
	}
	const input: FeatureCreateInput = {
		clientId: parseText(value.clientId, "clientId", MAX_CLIENT_ID),
		slug,
		name: parseText(value.name, "name", MAX_NAME),
		summary: parseText(value.summary, "summary", MAX_SUMMARY),
		scope: value.scope,
		invoke: parseFeatureInvocation(value.invoke, "invoke"),
		verify: parseFeatureInvocation(value.verify, "verify"),
		inputs: parseFeatureInputs(value.inputs),
		output:
			value.output === undefined
				? ""
				: parseText(value.output, "output", MAX_OUTPUT, true),
		notes:
			value.notes === undefined
				? ""
				: parseText(value.notes, "notes", MAX_NOTES, true),
		sourceJobId:
			value.sourceJobId === undefined || value.sourceJobId === null
				? null
				: parseText(value.sourceJobId, "sourceJobId", MAX_CLIENT_ID),
	};
	if (value.verification !== undefined) {
		input.verification = parseFeatureVerificationReport(value.verification);
	}
	return input;
}

/** 严格解析更新请求；slug/clientId/active 一律拒绝。 */
export function parseFeatureUpdateInput(value: unknown): FeatureUpdateInput {
	if (!isRecord(value)) {
		throw new FeatureProtocolError("更新请求必须是对象");
	}
	if (Object.keys(value).length === 0) {
		throw new FeatureProtocolError("更新请求不能为空对象");
	}
	rejectUnknown(
		value,
		[
			"name",
			"summary",
			"scope",
			"invoke",
			"verify",
			"inputs",
			"output",
			"notes",
			"status",
		],
		"feature",
	);
	const input: FeatureUpdateInput = {};
	if (value.name !== undefined) input.name = parseText(value.name, "name", MAX_NAME);
	if (value.summary !== undefined) {
		input.summary = parseText(value.summary, "summary", MAX_SUMMARY);
	}
	if (value.scope !== undefined) {
		if (value.scope !== "generic" && value.scope !== "machine") {
			throw new FeatureProtocolError("scope 必须是 generic 或 machine");
		}
		input.scope = value.scope;
	}
	if (value.invoke !== undefined) {
		input.invoke = parseFeatureInvocation(value.invoke, "invoke");
	}
	if (value.verify !== undefined) {
		input.verify = parseFeatureInvocation(value.verify, "verify");
	}
	if (value.inputs !== undefined) input.inputs = parseFeatureInputs(value.inputs);
	if (value.output !== undefined) {
		input.output = parseText(value.output, "output", MAX_OUTPUT, true);
	}
	if (value.notes !== undefined) {
		input.notes = parseText(value.notes, "notes", MAX_NOTES, true);
	}
	if (value.status !== undefined) {
		if (value.status !== "draft" && value.status !== "retired") {
			throw new FeatureProtocolError(
				"status 只能改为 draft 或 retired；active 只能由验证产生",
			);
		}
		input.status = value.status;
	}
	return input;
}

/** 解析 DB 中存储的契约 JSON；结构损坏抛出，由调用方决定降级投影。 */
export function parseFeatureContract(
	invoke: unknown,
	verify: unknown,
	inputs: unknown,
): {
	invoke: FeatureInvocation;
	verify: FeatureInvocation;
	inputs: FeatureInputParam[];
} {
	return {
		invoke: parseFeatureInvocation(invoke, "invoke"),
		verify: parseFeatureInvocation(verify, "verify"),
		inputs: parseFeatureInputs(inputs),
	};
}

/** 按证据年龄计算新鲜度；stale 不改变 status。 */
export function getFeatureFreshness(
	lastVerifiedAt: string | null,
	now = new Date(),
): FeatureFreshness {
	if (lastVerifiedAt === null) return "never";
	const verifiedAt = new Date(lastVerifiedAt).getTime();
	if (Number.isNaN(verifiedAt)) return "never";
	return now.getTime() - verifiedAt > FEATURE_STALE_AFTER_DAYS * DAY_MS
		? "stale"
		: "fresh";
}
