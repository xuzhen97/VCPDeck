/**
 * Pi Resource Bundle manifest：类型与严格解析。
 *
 * Bundle 随 Client Release 发布在版本目录内（`apps/<version>/pi-resources/`），
 * Server 只引用资源 ID，不下发内容；Client 必须逐个校验路径与摘要（docs/adr/0030 决策 1）。
 * 因此这里的解析不接受任何未知键、绝对路径、逃逸片段或非法摘要。
 */
import { PI_BUNDLE_PROTOCOL_VERSION, PiProtocolError } from "./pi.js";
import {
	assertExactKeys,
	assertNonEmptyString,
	assertRecord,
} from "./parse-internal.js";

export { PI_BUNDLE_PROTOCOL_VERSION };

/** manifest 协议版本由 `pi.ts` 统一维护（与 RuntimeSpec 同一事实来源）。 */

export const PI_BUNDLE_RESOURCE_KINDS = [
	"extension",
	"skill",
	"prompt",
] as const;

export type PiBundleResourceKind = (typeof PI_BUNDLE_RESOURCE_KINDS)[number];

/** 单个资源条目：`path` 相对 Bundle 根，`sha256` 为文件内容摘要。 */
export interface PiBundleResource {
	id: string;
	kind: PiBundleResourceKind;
	version: string;
	path: string;
	sha256: string;
}

export interface PiBundleManifest {
	protocolVersion: number;
	bundleVersion: string;
	piSdkVersion: string;
	resources: PiBundleResource[];
}

const MANIFEST_KEYS = [
	"protocolVersion",
	"bundleVersion",
	"piSdkVersion",
	"resources",
] as const;

const RESOURCE_KEYS = ["id", "kind", "version", "path", "sha256"] as const;

/** 资源 ID：小写点分标识（例如 `vcp.tool-policy`） */
const RESOURCE_ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9-]+)*$/;

/** sha256：小写十六进制 64 位 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 校验资源相对路径：只接受正斜杠分隔、不含逃逸片段、不以根开头。
 * Bundle 根之外的内容一律不允许被引用。
 */
function assertRelativeResourcePath(value: unknown, what: string): string {
	assertNonEmptyString(value, what);
	if (value.startsWith("/") || value.includes("\\")) {
		throw new PiProtocolError(`${what} 必须是以正斜杠分隔的相对路径`);
	}
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") {
			throw new PiProtocolError(`${what} 含逃逸或空路径片段`);
		}
	}
	return value;
}

function parseBundleResource(value: unknown, index: number): PiBundleResource {
	const what = `manifest.resources[${index}]`;
	assertRecord(value, what);
	assertExactKeys(value, RESOURCE_KEYS, what);

	if (
		typeof value.id !== "string" ||
		!RESOURCE_ID_PATTERN.test(value.id)
	) {
		throw new PiProtocolError(`${what}.id 非法：${String(value.id)}`);
	}
	if (
		typeof value.kind !== "string" ||
		!(PI_BUNDLE_RESOURCE_KINDS as readonly string[]).includes(value.kind)
	) {
		throw new PiProtocolError(`${what}.kind 不支持：${String(value.kind)}`);
	}
	assertNonEmptyString(value.version, `${what}.version`);
	const path = assertRelativeResourcePath(value.path, `${what}.path`);
	if (
		typeof value.sha256 !== "string" ||
		!SHA256_PATTERN.test(value.sha256)
	) {
		throw new PiProtocolError(`${what}.sha256 必须是 64 位小写十六进制`);
	}

	return {
		id: value.id,
		kind: value.kind as PiBundleResourceKind,
		version: value.version,
		path,
		sha256: value.sha256,
	};
}

/** 严格解析 Bundle manifest；未知键、未知版本、非法路径与摘要一律拒绝。 */
export function parsePiBundleManifest(value: unknown): PiBundleManifest {
	assertRecord(value, "PiBundleManifest");
	assertExactKeys(value, MANIFEST_KEYS, "PiBundleManifest");

	if (value.protocolVersion !== PI_BUNDLE_PROTOCOL_VERSION) {
		throw new PiProtocolError(
			`PiBundleManifest protocolVersion 不支持：${String(value.protocolVersion)}`,
		);
	}
	assertNonEmptyString(value.bundleVersion, "PiBundleManifest.bundleVersion");
	assertNonEmptyString(value.piSdkVersion, "PiBundleManifest.piSdkVersion");
	if (!Array.isArray(value.resources)) {
		throw new PiProtocolError("PiBundleManifest.resources 必须是数组");
	}

	const seen = new Set<string>();
	const resources = value.resources.map((resource, index) => {
		const parsed = parseBundleResource(resource, index);
		if (seen.has(parsed.id)) {
			throw new PiProtocolError(`PiBundleManifest 重复资源 id：${parsed.id}`);
		}
		seen.add(parsed.id);
		return parsed;
	});

	return {
		protocolVersion: value.protocolVersion,
		bundleVersion: value.bundleVersion,
		piSdkVersion: value.piSdkVersion,
		resources,
	};
}
