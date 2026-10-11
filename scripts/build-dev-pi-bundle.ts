/**
 * 生成 dev 用的 Pi Resource Bundle（输出到 `packages/client/pi-resources/`）。
 *
 * 与发布同构：复用统一 builder（`scripts/pi-resource-bundle.ts`）与集中资源选择输入
 * （`scripts/pi-extension-sources.ts`），只把版本号标为 `<client 版本>-dev`。
 * 用途：让本地 dev/集成测试下 Client 能按发布布局定位 Bundle
 * （见 scripts/ensure-dev-app-layout.cjs、scripts/dev-client.cjs）。
 *
 * 输出不纳入版本控制（.gitignore），每次 dev 启动重新生成，
 * 避免本机扩展源码更新后 dev Bundle 仍停留在旧 sha256 而「校验通过但内容过期」。
 *
 * 除集中资源选择输入里的公共资源外，dev 额外打入一个**验收夹具扩展**
 * （`vcp.dev-fixture`，源码取自 packages/client/src/pi/fixtures/web-extension.ts）。
 * 它注册若干命令与一个状态，用来在真实网页上逐条验收 ADR-0040 的投影语义
 * （notify/status/widget/title/editor 与宿主敏感命令的明确拒绝）。
 * 夹具只在 dev bundle 中出现，不进入发布产物——该差异由 `pi-resource-bundle.test.ts`
 * 逐字节断言（公共资源的 ID/版本/路径/sha256 必须与 release 完全一致）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_EXTENSION_SOURCES } from "./pi-extension-sources.js";
import { buildPiResourceBundle } from "./pi-resource-bundle.js";

const ROOT = resolve(__dirname, "..");
const piRoot = join(ROOT, "packages", "client", "pi-resources");
/** 夹具源码落点（.tmp 已被 gitignore，仅作 esbuild 的入口）。 */
const fixtureEntry = ".tmp/dev-fixture-extension.js";

async function main(): Promise<void> {
	const clientPkg = JSON.parse(
		readFileSync(join(ROOT, "packages", "client", "package.json"), "utf8"),
	) as { version?: string; dependencies?: Record<string, string> };
	const piSdkVersion = clientPkg.dependencies?.["@earendil-works/pi-coding-agent"];
	if (!piSdkVersion) {
		throw new Error("[dev-pi-bundle] packages/client 未声明 Pi SDK 版本");
	}

	// 夹具是「源码生成器」：先落盘再按普通扩展入口打包，与集成测试走同一份源码。
	// 用变量化动态 import 而非静态 import：scripts 的 tsconfig 只 include 自身目录，
	// 静态引入 client 源码会触发 TS6307（file not listed），而这里只需运行时取值。
	const fixtureModule = (await import(
		pathToFileURL(join(ROOT, "packages/client/src/pi/fixtures/web-extension.ts"))
			.href
	)) as { buildWebExtensionSource: (options?: { prefix?: string }) => string };
	const fixtureEntryAbs = join(ROOT, fixtureEntry);
	mkdirSync(dirname(fixtureEntryAbs), { recursive: true });
	writeFileSync(
		fixtureEntryAbs,
		fixtureModule.buildWebExtensionSource({ prefix: "fixture" }),
	);

	const manifest = await buildPiResourceBundle({
		root: piRoot,
		bundleVersion: `${clientPkg.version ?? "0.0.0"}-dev`,
		piSdkVersion,
		sources: [
			...PI_EXTENSION_SOURCES,
			{
				kind: "local",
				id: "vcp.dev-fixture",
				version: "1",
				entry: fixtureEntry,
			},
		],
	});
	console.log(
		`[dev-pi-bundle] ok: ${piRoot}（Pi SDK ${piSdkVersion}，资源：${manifest.resources
			.map((resource) => resource.id)
			.join(", ")}）`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
