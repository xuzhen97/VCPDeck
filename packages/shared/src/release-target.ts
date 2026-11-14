/**
 * 发布目标平台与 Client 侧映射（ADR-0065）。
 *
 * 常规发布仍要求 Windows x64 与 glibc Linux x64 双平台齐备；
 * `linux-x64-musl` 是 iStoreOS/AX 等 musl + procd 设备专用的可选 Client 构件。
 */
import type { ReleasePlatform } from "./update.js";
import {
	isReleaseArchiveAvailable,
	type ReleaseArchiveAvailableInfo,
	type ReleaseInfo,
} from "./update.js";

/** 常规发布必须齐备的平台；缺任一即不能开始编排（ADR-0012）。 */
export const REQUIRED_RELEASE_PLATFORMS: readonly ReleasePlatform[] = [
	"win-x64",
	"linux-x64",
];

/** 全部已知发布目标平台；musl 变体可选，不改变双平台齐备规则。 */
export const RELEASE_PLATFORMS: readonly ReleasePlatform[] = [
	"win-x64",
	"linux-x64",
	"linux-x64-musl",
];

/** 判断任意输入是否为已知发布目标平台。 */
export function isReleasePlatform(value: unknown): value is ReleasePlatform {
	return (
		typeof value === "string" &&
		(RELEASE_PLATFORMS as readonly string[]).includes(value)
	);
}

/** 严格解析发布目标平台；未知值拒绝而非猜测。 */
export function parseReleasePlatform(value: unknown): ReleasePlatform {
	if (!isReleasePlatform(value)) {
		throw new Error("platform 必须为 win-x64、linux-x64 或 linux-x64-musl");
	}
	return value;
}

/**
 * 由 Client 上报的 OS 与实际运行平台推导发布目标。
 *
 * 旧 Client 不上报 `releasePlatform`：Windows 视为 win-x64，Linux 视为 glibc 的 linux-x64
 * （历史上 Linux 只有 glibc 构件）。平台与 OS 矛盾时返回 undefined，由调用方按错误处理。
 */
export function clientReleasePlatform(
	os: string,
	reported?: ReleasePlatform,
): ReleasePlatform | undefined {
	if (reported !== undefined && !isReleasePlatform(reported)) return undefined;
	if (os.startsWith("win32")) {
		return reported === undefined || reported === "win-x64"
			? "win-x64"
			: undefined;
	}
	if (os.startsWith("linux")) {
		if (reported === undefined) return "linux-x64";
		return reported === "win-x64" ? undefined : reported;
	}
	return undefined;
}

/** musl 私有 Node 运行时的锁定事实；只记录公开来源与字节校验值（ADR-0065）。 */
export interface MuslRuntimeLock {
	readonly version: string;
	readonly url: string;
	readonly sha256: string;
}

/** musl Client 构件随包发布的平台/角色/运行时描述，其字节必须进入签名清单。 */
export interface MuslReleaseTarget {
	readonly schema: 1;
	readonly platform: "linux-x64-musl";
	readonly role: "client";
	readonly runtime: MuslRuntimeLock;
}

/** 批准的 Node 构建来源；不同来源的 checksum 不构成等价信任，必须逐版本锁定。 */
const MUSL_RUNTIME_HOSTS = ["nodejs.org", "unofficial-builds.nodejs.org"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 要求对象字段恰好等于给定集合；未知或缺失字段一律拒绝，避免未签名语义被偷带。 */
function requireExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(`${label} 字段必须且只能是 ${keys.join("、")}`);
	}
}

/**
 * 严格解析 musl 发布目标描述。
 *
 * 只接受 Node 24 的 x64 musl tarball、批准的 https 构建源与 64 位小写十六进制 SHA；
 * 任何未知字段、错误角色或错误平台都视为构建输入被篡改。
 */
export function parseMuslReleaseTarget(value: unknown): MuslReleaseTarget {
	if (!isPlainRecord(value)) throw new Error("release-target 必须是对象");
	requireExactKeys(
		value,
		["schema", "platform", "role", "runtime"],
		"release-target",
	);
	if (value.schema !== 1) throw new Error("release-target.schema 必须为 1");
	if (value.platform !== "linux-x64-musl") {
		throw new Error("release-target.platform 必须为 linux-x64-musl");
	}
	if (value.role !== "client") {
		throw new Error("release-target.role 必须为 client");
	}
	if (!isPlainRecord(value.runtime)) {
		throw new Error("release-target.runtime 必须是对象");
	}
	requireExactKeys(
		value.runtime,
		["version", "url", "sha256"],
		"release-target.runtime",
	);
	const { version, url, sha256 } = value.runtime;
	if (typeof version !== "string" || !/^24\.\d+\.\d+$/.test(version)) {
		throw new Error("release-target.runtime.version 必须是 Node 24 版本号");
	}
	if (typeof url !== "string") {
		throw new Error("release-target.runtime.url 必须是字符串");
	}
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error("release-target.runtime.url 不是合法 URL");
	}
	const approvedHost = MUSL_RUNTIME_HOSTS.some((host) => host === parsedUrl.hostname);
	if (parsedUrl.protocol !== "https:" || !approvedHost) {
		throw new Error(
			`release-target.runtime.url 必须来自 https://${MUSL_RUNTIME_HOSTS.join(" 或 https://")} 的锁定版本`,
		);
	}
	if (parsedUrl.pathname.split("/").pop() !== `node-v${version}-linux-x64-musl.tar.gz`) {
		throw new Error(
			"release-target.runtime.url 文件名必须与锁定版本、平台一致",
		);
	}
	if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
		throw new Error(
			"release-target.runtime.sha256 必须是 64 位小写十六进制 SHA-256",
		);
	}
	return {
		schema: 1,
		platform: "linux-x64-musl",
		role: "client",
		runtime: { version, url, sha256 },
	};
}

/**
 * 按机器实际运行平台挑选 Client 可用构件。
 *
 * Server 自身仍走 platformFromOs；只有 Client 需要区分 glibc/musl。
 * 显式报告 musl 却缺 musl 构件时返回 undefined（fail closed），
 * 绝不回落到 glibc 包——跨 libc 的包在设备上必然起不来。
 */
export function selectClientReleaseArchive(
	release: ReleaseInfo,
	os: string,
	reported?: ReleasePlatform,
): ReleaseArchiveAvailableInfo | undefined {
	const platform = clientReleasePlatform(os, reported);
	const archive = platform ? release.archives?.[platform] : undefined;
	return isReleaseArchiveAvailable(archive) ? archive : undefined;
}
