/** 公网地址声明；三个字段都由操作者提供，空值表示明确没有。 */
export interface ClientPublicAddress {
	/** 公网 IPv4，最多 4 个。 */
	v4: string[];
	/** 公网 IPv6，最多 4 个。 */
	v6: string[];
	/** 稳定公网域名或 DDNS；没有则为 null。 */
	host: string | null;
}

/**
 * 操作者声明的 Client 注解（ADR-0055）。
 *
 * 与 Client 上报事实分离：由 Server 持有，注册/心跳/重连不得覆盖。
 * `publicAddress === null` 表示“补充过但公网情况未声明”；
 * 对象内三个字段全空表示“明确没有公网地址”。
 */
export interface ClientAnnotations {
	publicAddress: ClientPublicAddress | null;
	notes: string | null;
	/** Server 写入时间（ISO 8601）；调用方不得伪造。 */
	updatedAt: string;
}

/** 操作者可写的注解字段（不含 Server 元数据）。 */
export type ClientAnnotationsInput = Pick<
	ClientAnnotations,
	"publicAddress" | "notes"
>;

const MAX_PUBLIC_ADDRESSES = 4;
const MAX_HOST_LENGTH = 253;
const MAX_NOTES_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIPv4(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	return parts.every(
		(part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
	);
}

function isIPv6(value: string): boolean {
	if (
		!value.includes(":") ||
		value.includes("%") ||
		value.length > 45 ||
		!/^[0-9A-Fa-f:.]+$/.test(value)
	) {
		return false;
	}
	try {
		// 先由字符白名单排除 ]、/、?、空白等提前闭合方括号的输入，
		// 再用 WHATWG URL 解析器做分组/压缩等结构校验。
		const parsed = new URL(`http://[${value}]/`);
		return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
	} catch {
		return false;
	}
}

function isHostname(value: string): boolean {
	if (value.length === 0 || value.length > MAX_HOST_LENGTH) return false;
	return value.split(".").every(
		(label) =>
			label.length >= 1 &&
			label.length <= 63 &&
			/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
	);
}

function parseAddressList(
	value: unknown,
	field: "v4" | "v6",
	validator: (candidate: string) => boolean,
	label: string,
): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(`annotations.publicAddress.${field} 必须为数组`);
	}
	if (value.length > MAX_PUBLIC_ADDRESSES) {
		throw new Error(
			`annotations.publicAddress.${field} 最多 ${MAX_PUBLIC_ADDRESSES} 个`,
		);
	}
	const result: string[] = [];
	for (const candidate of value) {
		if (typeof candidate !== "string") {
			throw new Error(`annotations.publicAddress.${field} 的元素必须为字符串`);
		}
		const normalized = candidate.trim();
		if (!validator(normalized)) {
			throw new Error(
				`annotations.publicAddress.${field} 含非法 ${label} 地址：${normalized}`,
			);
		}
		if (result.includes(normalized)) {
			throw new Error(`annotations.publicAddress.${field} 不能包含重复地址`);
		}
		result.push(normalized);
	}
	return result;
}

function parseHost(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("annotations.publicAddress.host 必须为字符串或 null");
	}
	const normalized = value.trim().toLowerCase().replace(/\.$/, "");
	if (normalized.length === 0) return null;
	if (!isHostname(normalized)) {
		throw new Error("annotations.publicAddress.host 不是合法域名");
	}
	return normalized;
}

function parseNotes(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("annotations.notes 必须为字符串或 null");
	}
	const normalized = value.trim();
	if (normalized.length === 0) return null;
	if (normalized.length > MAX_NOTES_LENGTH) {
		throw new Error(`annotations.notes 不能超过 ${MAX_NOTES_LENGTH} 字符`);
	}
	if (hasControlCharacters(normalized)) {
		throw new Error("annotations.notes 不能包含控制字符");
	}
	return normalized;
}

/** 允许换行、回车与制表符；其余 C0 控制字符与 DEL 拒绝。 */
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

function parsePublicAddress(value: unknown): ClientPublicAddress | null {
	if (value === undefined || value === null) return null;
	if (!isRecord(value)) {
		throw new Error("annotations.publicAddress 必须为对象或 null");
	}
	for (const key of Object.keys(value)) {
		if (key !== "v4" && key !== "v6" && key !== "host") {
			throw new Error(`annotations.publicAddress 含未知字段 ${key}`);
		}
	}
	return {
		v4: parseAddressList(value.v4, "v4", isIPv4, "IPv4"),
		v6: parseAddressList(value.v6, "v6", isIPv6, "IPv6"),
		host: parseHost(value.host),
	};
}

/** 严格解析操作者提交的注解；未知字段拒绝，缺省字段归一化为空。 */
export function parseClientAnnotationsInput(
	value: unknown,
): ClientAnnotationsInput {
	if (!isRecord(value)) {
		throw new Error("annotations 必须为对象");
	}
	for (const key of Object.keys(value)) {
		if (key !== "publicAddress" && key !== "notes") {
			throw new Error(`annotations 含未知字段 ${key}`);
		}
	}
	return {
		publicAddress: parsePublicAddress(value.publicAddress),
		notes: parseNotes(value.notes),
	};
}

/** 是否存在需要持久化的内容；全空的 `publicAddress` 也算明确声明。 */
export function hasClientAnnotations(input: ClientAnnotationsInput): boolean {
	return input.publicAddress !== null || input.notes !== null;
}

/**
 * 严格解析 Server 存储的注解读模型。
 * `{}` 返回 null；结构损坏时抛出，由调用方决定是否 fail closed。
 */
export function parseClientAnnotations(
	value: unknown,
): ClientAnnotations | null {
	if (!isRecord(value)) {
		throw new Error("annotations 必须为对象");
	}
	if (Object.keys(value).length === 0) return null;
	for (const key of Object.keys(value)) {
		if (key !== "publicAddress" && key !== "notes" && key !== "updatedAt") {
			throw new Error(`annotations 含未知字段 ${key}`);
		}
	}
	const publicAddress = parsePublicAddress(value.publicAddress);
	const notes = parseNotes(value.notes);
	if (
		typeof value.updatedAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T/.test(value.updatedAt) ||
		Number.isNaN(Date.parse(value.updatedAt))
	) {
		throw new Error("annotations.updatedAt 必须为 ISO 时间字符串");
	}
	if (publicAddress === null && notes === null) return null;
	return {
		publicAddress,
		notes,
		updatedAt: new Date(value.updatedAt).toISOString(),
	};
}
