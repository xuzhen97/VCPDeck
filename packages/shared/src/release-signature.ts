/**
 * 发布声明的规范化、严格解析与约束校验（纯逻辑，无加密依赖）。
 *
 * 签名覆盖的是这里定义的**规范化字节**；Ed25519 的签名与验签在 Launcher
 * （Node 运行时）侧完成，因为 `@vcpdeck/shared` 同时被浏览器引用，不能引入
 * `node:crypto`。
 *
 * 设计基线见 [`ADR-0029`](../../docs/adr/0029-signed-privileged-release-artifacts.md)：
 * SHA-256 只保证字节完整性，来源信任由发布者签名提供；声明必须绑定平台、版本、
 * 大小、manifest 版本、最低 Supervisor 版本与构件角色，避免跨平台、降级或替换混用。
 */

export const RELEASE_DECLARATION_VERSION = 1;

/** 构件角色；决定解压位置、是否可执行以及需要哪些平台门禁。 */
export type ReleaseArtifactRole =
	| "release-archive"
	| "supervisor"
	| "migration-bootstrap"
	| "desktop-host"
	| "session-helper"
	| "virtual-display-driver"
	| "client-artifact";

const ROLES: readonly ReleaseArtifactRole[] = [
	"release-archive",
	"supervisor",
	"migration-bootstrap",
	"desktop-host",
	"session-helper",
	"virtual-display-driver",
	"client-artifact",
];

const PLATFORMS: readonly string[] = ["win-x64", "linux-x64"];

export interface ReleaseDeclarationArtifact {
	role: ReleaseArtifactRole;
	/** archive 内的相对路径；必须位于 archive 根之内。 */
	path: string;
	/** 小写十六进制 SHA-256。 */
	sha256: string;
	size: number;
	/** 是否允许带可执行位；未声明的可执行文件一律拒绝。 */
	executable: boolean;
}

export interface ReleaseDeclaration {
	declarationVersion: typeof RELEASE_DECLARATION_VERSION;
	releaseVersion: string;
	platform: string;
	manifestVersion: number;
	/** 强制执行的最低 Supervisor 版本；低于它只能走受控引导升级。 */
	launcherMinVersion: string;
	/** 签名使用的密钥 ID；用于信任根选择与轮换。 */
	keyId: string;
	artifacts: ReleaseDeclarationArtifact[];
}

/** 发布声明校验失败；消息只描述约束，不含路径细节之外的敏感内容。 */
export class ReleaseDeclarationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReleaseDeclarationError";
	}
}

function fail(message: string): never {
	throw new ReleaseDeclarationError(message);
}

// ── 规范化 ──────────────────────────────────────────────────────────────────

/**
 * 递归规范化 JSON：键排序、无多余空白、拒绝无法确定性序列化的值。
 *
 * `NaN`/`Infinity`/`undefined` 在不同平台会序列化成不同结果（或非法 JSON），
 * 若放行就会让“签名覆盖的字节”与“验证时重算的字节”不一致，因此直接拒绝。
 */
export function canonicalizeReleaseDeclaration(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) {
				return fail("声明包含非有限数字，无法确定性规范化");
			}
			return JSON.stringify(value);
		case "object":
			break;
		default:
			return fail("声明包含无法规范化的值类型");
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalizeReleaseDeclaration(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const parts: string[] = [];
	for (const key of keys) {
		const entry = record[key];
		if (entry === undefined) {
			return fail("声明包含 undefined 字段，无法确定性规范化");
		}
		parts.push(`${JSON.stringify(key)}:${canonicalizeReleaseDeclaration(entry)}`);
	}
	return `{${parts.join(",")}}`;
}

/** 规范化后的 UTF-8 字节；签名与验签都基于它。 */
export function releaseDeclarationBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalizeReleaseDeclaration(value));
}

// ── 严格解析 ────────────────────────────────────────────────────────────────

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(`${field} 含未知字段 ${key}`);
	}
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fail(`${field} 必须是对象`);
	}
	return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		return fail(`${field} 必须是非空字符串`);
	}
	return value;
}

/**
 * archive 内路径必须位于根之内。
 *
 * 反斜杠一律拒绝而不是归一化：archive 里的 `a\b` 在 Windows 上会变成目录
 * 分隔符，接受它等于让声明里的路径与实际解压路径不一致。
 */
function asSafeArchivePath(value: unknown, field: string): string {
	const path = asNonEmptyString(value, field);
	if (path.includes("\\")) fail(`${field} 不得包含反斜杠`);
	if (path.startsWith("/")) fail(`${field} 不得是绝对路径`);
	if (/^[A-Za-z]:/.test(path)) fail(`${field} 不得包含盘符`);
	const segments = path.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		fail(`${field} 含越界或空路径段`);
	}
	return path;
}

function asPositiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		fail(`${field} 必须是正整数`);
	}
	return value;
}

function asDigest(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		fail(`${field} 必须是小写十六进制 SHA-256`);
	}
	return value;
}

function parseArtifact(value: unknown, index: number): ReleaseDeclarationArtifact {
	const field = `artifacts[${index}]`;
	const record = asRecord(value, field);
	assertKeys(record, ["role", "path", "sha256", "size", "executable"], field);
	const role = record.role;
	if (typeof role !== "string" || !ROLES.includes(role as ReleaseArtifactRole)) {
		fail(`${field}.role 不受支持`);
	}
	if (typeof record.executable !== "boolean") fail(`${field}.executable 必须是布尔值`);
	return {
		role: role as ReleaseArtifactRole,
		path: asSafeArchivePath(record.path, `${field}.path`),
		sha256: asDigest(record.sha256, `${field}.sha256`),
		size: asPositiveInteger(record.size, `${field}.size`),
		executable: record.executable,
	};
}

/** 严格解析发布声明；任何未知字段、类型或取值异常都 fail closed。 */
export function parseReleaseDeclaration(value: unknown): ReleaseDeclaration {
	const record = asRecord(value, "releaseDeclaration");
	assertKeys(
		record,
		[
			"declarationVersion",
			"releaseVersion",
			"platform",
			"manifestVersion",
			"launcherMinVersion",
			"keyId",
			"artifacts",
		],
		"releaseDeclaration",
	);
	if (record.declarationVersion !== RELEASE_DECLARATION_VERSION) {
		fail("releaseDeclaration.declarationVersion 不受支持");
	}
	const platform = asNonEmptyString(record.platform, "releaseDeclaration.platform");
	if (!PLATFORMS.includes(platform)) fail("releaseDeclaration.platform 不受支持");
	if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
		fail("releaseDeclaration.artifacts 不能为空");
	}
	const artifacts = record.artifacts.map(parseArtifact);
	const seen = new Set<string>();
	for (const artifact of artifacts) {
		// 同一路径出现两次会让“验证过的构件”与“实际解压的构件”可能不是同一个。
		const key = artifact.path.toLowerCase();
		if (seen.has(key)) fail("releaseDeclaration.artifacts 含重复路径");
		seen.add(key);
	}
	return {
		declarationVersion: RELEASE_DECLARATION_VERSION,
		releaseVersion: asNonEmptyString(record.releaseVersion, "releaseDeclaration.releaseVersion"),
		platform,
		manifestVersion: asPositiveInteger(record.manifestVersion, "releaseDeclaration.manifestVersion"),
		launcherMinVersion: asNonEmptyString(
			record.launcherMinVersion,
			"releaseDeclaration.launcherMinVersion",
		),
		keyId: asNonEmptyString(record.keyId, "releaseDeclaration.keyId"),
		artifacts,
	};
}

// ── 约束校验 ────────────────────────────────────────────────────────────────

/** 校验实际构件与声明一致；哈希或大小任一不符都必须拒绝。 */
export function assertArtifactMatches(
	artifact: ReleaseDeclarationArtifact,
	actual: { sha256: string; size: number },
): void {
	if (actual.sha256 !== artifact.sha256) {
		fail(`构建 ${artifact.role} 的 SHA-256 与声明不一致`);
	}
	if (actual.size !== artifact.size) {
		fail(`构建 ${artifact.role} 的大小与声明不一致`);
	}
}

function parseVersion(value: unknown, field: string): number[] {
	if (typeof value !== "string" || !/^\d+(\.\d+)*$/.test(value)) {
		return fail(`${field} 不是合法版本号`);
	}
	return value.split(".").map((segment) => Number(segment));
}

/** 语义化比较：返回 -1/0/1。缺失的段按 0 处理。 */
export function compareVersions(left: string, right: string): number {
	const a = parseVersion(left, "left");
	const b = parseVersion(right, "right");
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * 强制执行 `launcherMinVersion`。
 *
 * 按数字段比较而不是字符串比较：字符串比较会认为 "1.9.0" 大于 "1.10.0"，
 * 从而让一台过旧的 Supervisor 通过门禁。
 */
export function assertLauncherVersionSatisfies(
	declaration: ReleaseDeclaration,
	currentVersion: string,
): void {
	if (compareVersions(currentVersion, declaration.launcherMinVersion) < 0) {
		fail(
			`Supervisor 版本低于声明要求的 ${declaration.launcherMinVersion}，必须走受控引导升级`,
		);
	}
}

export interface ArchiveEntry {
	path: string;
	executable: boolean;
}

/**
 * 校验 archive 条目集合与声明一致。
 *
 * 拒绝：越界路径、重复条目、未声明的可执行文件、缺失的声明构件，以及
 * 与声明相矛盾的可执行位。普通未声明数据文件允许存在（例如 manifest.json）。
 */
export function assertArchiveEntriesAllowed(
	declaration: ReleaseDeclaration,
	entries: readonly ArchiveEntry[],
): void {
	const declared = new Map<string, ReleaseDeclarationArtifact>();
	for (const artifact of declaration.artifacts) {
		declared.set(artifact.path.toLowerCase(), artifact);
	}
	const seen = new Set<string>();
	for (const entry of entries) {
		const path = asSafeArchivePath(entry.path, "archiveEntry.path");
		if (typeof entry.executable !== "boolean") {
			fail("archiveEntry.executable 必须是布尔值");
		}
		const key = path.toLowerCase();
		if (seen.has(key)) fail("archive 含重复条目");
		seen.add(key);
		const artifact = declared.get(key);
		if (!entry.executable) continue;
		if (!artifact) fail("archive 含未声明的可执行文件");
		if (!artifact.executable) fail("archive 条目的可执行位与声明矛盾");
	}
	for (const artifact of declaration.artifacts) {
		if (!seen.has(artifact.path.toLowerCase())) {
			fail(`archive 缺少声明的构件 ${artifact.role}`);
		}
	}
}
