/**
 * Pi Resource Bundle manifest 生成（纯函数，供 Release 构建使用）。
 *
 * 生成必须**确定性**：资源按 `id` 排序、字段顺序固定，保证同一输入得到字节一致的 manifest；
 * manifest 不携带文件内容，只声明相对路径与 sha256（docs/adr/0030 决策 1）。
 */
import { createHash } from "node:crypto";
import {
	PI_BUNDLE_PROTOCOL_VERSION,
	type PiBundleManifest,
	type PiBundleResource,
	type PiBundleResourceKind,
} from "@vcpdeck/shared";

export interface PiBundleResourceInput {
	id: string;
	kind: PiBundleResourceKind;
	version: string;
	/** 相对 Bundle 根的路径（正斜杠分隔）。 */
	path: string;
	content: Buffer;
}

export interface BuildBundleManifestInput {
	bundleVersion: string;
	piSdkVersion: string;
	resources: PiBundleResourceInput[];
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** 生成 manifest；资源按 id 升序排列，字段顺序固定。 */
export function buildBundleManifest(
	input: BuildBundleManifestInput,
): PiBundleManifest {
	const resources: PiBundleResource[] = [...input.resources]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((resource) => ({
			id: resource.id,
			kind: resource.kind,
			version: resource.version,
			path: resource.path,
			sha256: sha256(resource.content),
		}));

	return {
		protocolVersion: PI_BUNDLE_PROTOCOL_VERSION,
		bundleVersion: input.bundleVersion,
		piSdkVersion: input.piSdkVersion,
		resources,
	};
}
