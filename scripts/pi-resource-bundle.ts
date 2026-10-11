/**
 * Pi Resource Bundle 的统一构建器（ADR-0042 决策 2/3）。
 *
 * 职责边界：
 * - **构建期**：用官方 SDK 的公开 `DefaultPackageManager.resolveExtensionSources()`
 *   解析已审查的标准 Pi 包，校验版本/路径/入口唯一性，再打成自包含 ESM 单文件，
 *   最后生成带 sha256 的 manifest；
 * - **不做**：运行期安装、在线拉取、读取用户 `~/.pi`、扫描项目资源、新增协议字段。
 *
 * 为什么要复用官方解析器：标准包的资源发现规则（`pi` 清单、约定目录、glob、排除）
 * 属于上游语义，自己再实现一遍必然漂移；官方解析器只读文件、不执行 extension factory。
 *
 * 校验事实来源是 shared 的 `parsePiBundleManifest`，这里不重复定义 manifest 结构。
 * 直接引用 shared 源码而非 `dist`：发布脚本经 tsx 运行，不依赖 shared 先构建。
 */
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePiBundleManifest, type PiBundleManifest } from "../packages/shared/src/pi-bundle.js";
import { buildBundleManifest } from "../packages/client/src/pi-bundle/manifest.js";
import { bundlePiExtension } from "./bundle-apps.js";
import {
	PI_EXTENSION_SOURCES,
	type PiExtensionSource,
} from "./pi-extension-sources.js";

const ROOT = resolve(__dirname, "..");
const CLIENT_DIR = join(ROOT, "packages", "client");
const SDK_PACKAGE_DIR = join(
	CLIENT_DIR,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
);

/** 已解析、可打包的扩展资源。 */
export interface ResolvedPiExtension {
	id: string;
	version: string;
	/** 入口源码绝对路径。 */
	entry: string;
	/** 许可原文绝对路径（社区包必须提供）。 */
	licenseFile?: string;
}

export interface BuildPiResourceBundleOptions {
	/** Bundle 根目录（`apps/<version>/pi-resources/` 或 dev 的 `packages/client/pi-resources/`）。 */
	root: string;
	bundleVersion: string;
	piSdkVersion: string;
	/** 默认使用集中选择输入；dev 用它追加自己的验收夹具。 */
	sources?: readonly PiExtensionSource[];
}

interface PiSdkPackageJson {
	main?: string;
	exports?: Record<string, { import?: string } | string>;
}

interface PiSdkModule {
	DefaultPackageManager: new (options: {
		cwd: string;
		agentDir: string;
		settingsManager: unknown;
	}) => {
		resolveExtensionSources(
			sources: string[],
		): Promise<{ extensions: Array<{ path: string; enabled: boolean }> }>;
	};
	SettingsManager: { inMemory(settings?: Record<string, unknown>): unknown };
}

/**
 * 加载 **Client 锁定的** Pi SDK。
 *
 * 不按包名 import：SDK 是 ESM-only 且根 workspace 未声明它；按 `packages/client` 的
 * 安装位置解析，才能保证构建期解析规则与运行期 Client 实际使用的 SDK 完全一致。
 */
async function loadPiSdk(): Promise<PiSdkModule> {
	const pkg = JSON.parse(
		await readFile(join(SDK_PACKAGE_DIR, "package.json"), "utf8"),
	) as PiSdkPackageJson;
	const entryExport = pkg.exports?.["."];
	const entry =
		(typeof entryExport === "string" ? entryExport : entryExport?.import) ??
		pkg.main;
	if (!entry) {
		throw new Error("[pi-resource-bundle] Pi SDK 未声明入口");
	}
	return (await import(
		pathToFileURL(join(SDK_PACKAGE_DIR, entry)).href
	)) as PiSdkModule;
}

/** child 是否位于 parent 之内（含规范化分隔符）。 */
function isInside(parent: string, child: string): boolean {
	const normalized = parent.endsWith(sep) ? parent : `${parent}${sep}`;
	return child === parent || child.startsWith(normalized);
}

/**
 * 解析一个标准 Pi 包，返回它声明的**唯一** extension 入口绝对路径。
 *
 * 拒绝条件（全部 fail closed，不猜测、不降级）：
 * - 包版本与期望版本不一致（防止锁文件漂移后静默换代码）；
 * - 没有任何 extension 资源（不能把包根目录当扩展入口）；
 * - 多个启用入口（本期一资源一入口，多入口选择需要单独设计）；
 * - 入口不存在或经符号链接逃出包目录。
 */
export async function resolveLocalPiPackage(
	root: string,
	expectedVersion: string,
	scratchRoot: string,
): Promise<string[]> {
	const realRoot = await realpath(root);
	const pkgJson = JSON.parse(
		await readFile(join(realRoot, "package.json"), "utf8"),
	) as { version?: unknown };
	const actualVersion =
		typeof pkgJson.version === "string" ? pkgJson.version : "";
	if (actualVersion !== expectedVersion) {
		throw new Error(
			`[pi-resource-bundle] 包版本不一致：期望 ${expectedVersion}，实际 ${actualVersion || "(未声明)"}`,
		);
	}

	const sdk = await loadPiSdk();
	const manager = new sdk.DefaultPackageManager({
		cwd: scratchRoot,
		agentDir: join(scratchRoot, "agent"),
		settingsManager: sdk.SettingsManager.inMemory(),
	});
	const resolved = await manager.resolveExtensionSources([realRoot]);

	const entries: string[] = [];
	for (const item of resolved.extensions) {
		if (!item.enabled) continue;
		const real = await realpath(item.path).catch(() => null);
		if (!real) {
			throw new Error(
				`[pi-resource-bundle] extension 入口不存在：${item.path}`,
			);
		}
		// 包内既无清单也无约定目录时，SDK 会把包根目录本身当成扩展资源。
		if (real === realRoot) continue;
		if (!isInside(realRoot, real)) {
			throw new Error(
				`[pi-resource-bundle] extension 入口逃出包目录：${item.path}`,
			);
		}
		entries.push(real);
	}

	if (entries.length === 0) {
		throw new Error(
			`[pi-resource-bundle] 包未声明任何 extension 资源：${realRoot}`,
		);
	}
	if (entries.length > 1) {
		throw new Error(
			`[pi-resource-bundle] 包声明了多个 extension 入口（${entries.length} 个），本期一资源一入口`,
		);
	}
	return entries;
}

/** 解析已安装包的根目录（不执行该包的任何脚本）。 */
function resolveInstalledPackageRoot(packageName: string): string {
	const require = createRequire(join(ROOT, "package.json"));
	try {
		return dirname(require.resolve(`${packageName}/package.json`));
	} catch {
		// 包声明了 `exports` 且未导出 `package.json` 时，从主入口逐级上溯找到包根。
		// 不能只取 dirname：主入口常在 `dist/` 下，直接取会得到子目录而不是包根。
		let current = dirname(require.resolve(packageName));
		for (let depth = 0; depth < 8; depth += 1) {
			if (existsSync(join(current, "package.json"))) return current;
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		throw new Error(
			`[pi-resource-bundle] 无法定位包根目录：${packageName}`,
		);
	}
}

/**
 * 解析集中选择输入，得到可打包的资源清单。
 *
 * 同一资源 ID 出现两次直接拒绝：重复 ID 会让 manifest 出现两个同 ID 资源，
 * 而 Profile 只按 ID 引用，运行期无法表达「到底加载哪一个」。
 */
export async function resolvePiExtensionSources(
	sources: readonly PiExtensionSource[],
	scratchRoot: string,
): Promise<ResolvedPiExtension[]> {
	const seen = new Set<string>();
	const resolved: ResolvedPiExtension[] = [];

	for (const source of sources) {
		if (seen.has(source.id)) {
			throw new Error(`[pi-resource-bundle] 资源 ID 重复：${source.id}`);
		}
		seen.add(source.id);

		if (source.kind === "local") {
			const entry = resolve(ROOT, source.entry);
			if (!existsSync(entry)) {
				throw new Error(
					`[pi-resource-bundle] 本地扩展入口不存在：${source.entry}`,
				);
			}
			// vendor 进仓库的第三方源码同样需要保留许可原文（见 pi-extension-sources.ts）。
			const licenseFile = source.licenseFile
				? resolve(ROOT, source.licenseFile)
				: undefined;
			if (licenseFile && !existsSync(licenseFile)) {
				throw new Error(
					`[pi-resource-bundle] 缺少本地扩展许可原文：${source.licenseFile}`,
				);
			}
			resolved.push({
				id: source.id,
				version: source.version,
				entry,
				...(licenseFile ? { licenseFile } : {}),
			});
			continue;
		}

		const licenseFile = resolve(ROOT, source.licenseFile);
		if (!existsSync(licenseFile)) {
			throw new Error(
				`[pi-resource-bundle] 缺少社区包许可原文：${source.licenseFile}`,
			);
		}
		const packageRoot = resolveInstalledPackageRoot(source.packageName);
		const [entry] = await resolveLocalPiPackage(
			packageRoot,
			source.version,
			scratchRoot,
		);
		if (!entry) {
			throw new Error(
				`[pi-resource-bundle] 包未解析出 extension 入口：${source.packageName}`,
			);
		}
		resolved.push({
			id: source.id,
			version: source.version,
			entry,
			licenseFile,
		});
	}

	return resolved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 生成完整 Bundle：打包扩展、复制许可、写 manifest。
 *
 * 失败语义：manifest 先被删除，失败时再删一次。这样「旧 manifest + 新残缺产物」
 * 不可能同时存在——Client 的校验只认 manifest，留着它等于掩盖构建失败。
 */
export async function buildPiResourceBundle(
	options: BuildPiResourceBundleOptions,
): Promise<PiBundleManifest> {
	const { root, bundleVersion, piSdkVersion } = options;
	const sources = options.sources ?? PI_EXTENSION_SOURCES;
	const manifestPath = join(root, "manifest.json");

	await rm(manifestPath, { force: true });
	await mkdir(join(ROOT, ".tmp"), { recursive: true });
	const scratch = await mkdtemp(join(ROOT, ".tmp", "pi-resolve-"));
	try {
		const resolved = await resolvePiExtensionSources(sources, scratch);

		// 清掉上一轮的产物目录，避免被移除的资源留下可加载的孤儿文件。
		await rm(join(root, "extensions"), { recursive: true, force: true });
		await rm(join(root, "licenses"), { recursive: true, force: true });

		const resources = [];
		for (const item of resolved) {
			const relativePath = `extensions/${item.id}/index.js`;
			const outfile = join(root, relativePath);
			await mkdir(dirname(outfile), { recursive: true });
			await bundlePiExtension(outfile, item.entry);
			resources.push({
				id: item.id,
				kind: "extension" as const,
				version: item.version,
				path: relativePath,
				content: await readFile(outfile),
			});
			if (item.licenseFile) {
				const licenseOut = join(
					root,
					"licenses",
					`${item.id}-LICENSE.txt`,
				);
				await mkdir(dirname(licenseOut), { recursive: true });
				await copyFile(item.licenseFile, licenseOut);
			}
		}

		const manifest = buildBundleManifest({
			bundleVersion,
			piSdkVersion,
			resources,
		});
		// 用 shared 的严格 parser 自校验：构建产物必须能被 Client 接受。
		parsePiBundleManifest(manifest);
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		return manifest;
	} catch (error) {
		await rm(manifestPath, { force: true });
		throw error;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
