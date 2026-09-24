/**
 * Pi Resource Bundle 的定位与逐资源校验（docs/adr/0030 决策 1）。
 *
 * 约束：
 * - Bundle 属于版本目录 `apps/<version>/pi-resources/`，由运行中 Client 从**自身模块位置**
 *   向上定位（不读 `apps/current` 或 `state.json`，避免指针与实际运行版本不一致）；
 * - 严格解析 manifest、校验每个资源的路径合法性与 sha256；
 * - 任何失败一律返回 `null`（fail closed）：不上报能力，也不加载任何资源；
 * - 校验结果只放在内存，不写任何缓存文件。
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
	parsePiBundleManifest,
	type PiBundleManifest,
} from "@vcpdeck/shared";

/** 已校验通过的 Bundle：只有这里返回的路径才允许进入资源加载面。 */
export interface VerifiedPiBundle {
	root: string;
	manifest: PiBundleManifest;
	resourceIds: string[];
	extensionPaths: string[];
}

export interface ResolveVerifiedPiBundleOptions {
	/** 运行中 Client 的模块目录（生产为 `__dirname`）。 */
	selfDir: string;
	/** 安装根目录（含 `apps/`）。 */
	appDir: string;
	/** 自身 Pi SDK 版本，必须与 manifest 声明一致。 */
	sdkVersion: string;
}

/** 判断 child 是否位于 parent 之内（含规范化分隔符）。 */
function isInside(parent: string, child: string): boolean {
	const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
	return child === parent || child.startsWith(normalizedParent);
}

/**
 * 从 `selfDir` 向上找到 `apps/<version>` 版本目录；找不到返回 null。
 * 只在「自身确实运行于版本目录内」时才认定 Bundle 可用。
 */
async function findVersionDir(
	selfDir: string,
	appsRoot: string,
): Promise<string | null> {
	const realAppsRoot = await realpath(appsRoot).catch(() => null);
	if (!realAppsRoot) return null;

	let current = resolve(selfDir);
	for (let depth = 0; depth < 8; depth += 1) {
		const realParent = await realpath(dirname(current)).catch(() => null);
		if (realParent && realParent === realAppsRoot) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * 定位并校验 Bundle。返回 null 表示「无可用 Bundle」：
 * 未找到、manifest 非法、SDK 版本不符、路径逃逸或摘要不匹配。
 */
export async function resolveVerifiedPiBundle(
	options: ResolveVerifiedPiBundleOptions,
): Promise<VerifiedPiBundle | null> {
	try {
		const appsRoot = join(options.appDir, "apps");
		const versionDir = await findVersionDir(options.selfDir, appsRoot);
		if (!versionDir) return null;

		const root = join(versionDir, "pi-resources");
		const rawManifest = await readFile(join(root, "manifest.json"), "utf8");
		const manifest = parsePiBundleManifest(JSON.parse(rawManifest));
		if (manifest.piSdkVersion !== options.sdkVersion) return null;

		const realRoot = await realpath(root);
		const resourceIds: string[] = [];
		const extensionPaths: string[] = [];

		for (const resource of manifest.resources) {
			const absolute = resolve(root, resource.path);
			// 先做字符串层面的包含判断，再用 realpath 挡住符号链接逃逸
			if (!isInside(root, absolute)) return null;
			const realPath = await realpath(absolute);
			if (!isInside(realRoot, realPath)) return null;

			const content = await readFile(realPath);
			const digest = createHash("sha256").update(content).digest("hex");
			if (digest !== resource.sha256) return null;

			resourceIds.push(resource.id);
			if (resource.kind === "extension") extensionPaths.push(realPath);
		}

		return {
			root: realRoot,
			manifest,
			resourceIds,
			extensionPaths: extensionPaths.sort(),
		};
	} catch {
		// 任何异常都按「无可用 Bundle」处理，调用方不需要区分原因。
		return null;
	}
}
