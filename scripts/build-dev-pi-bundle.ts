/**
 * 生成 dev 用的 Pi Resource Bundle（输出到 `packages/client/pi-resources/`）。
 *
 * 与发布同构：复用 scripts/pack-release.ts 同一套打包函数与 manifest 生成器
 * （`bundlePiExtension` + `buildBundleManifest`），只把版本号标为 `<client 版本>-dev`。
 * 用途：让本地 dev/集成测试下 Client 能按发布布局定位 Bundle
 * （见 scripts/ensure-dev-app-layout.cjs、scripts/dev-client.cjs）。
 *
 * 输出不纳入版本控制（.gitignore），每次 dev 启动重新生成，
 * 避免本机扩展源码更新后 dev Bundle 仍停留在旧 sha256 而「校验通过但内容过期」。
 *
 * 除发布同款的 `vcp.tool-policy` 外，dev 额外打入一个**验收夹具扩展**
 * （`vcp.dev-fixture`，源码取自 packages/client/src/pi/fixtures/web-extension.ts）。
 * 它注册若干命令与一个状态，用来在真实网页上逐条验收 ADR-0040 的投影语义
 * （notify/status/widget/title/editor 与宿主敏感命令的明确拒绝）。
 * 夹具只在 dev bundle 中出现，不进入发布产物。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildBundleManifest } from "../packages/client/src/pi-bundle/manifest.js";
import { bundlePiExtension } from "./bundle-apps.js";

const ROOT = resolve(__dirname, "..");
const piRoot = join(ROOT, "packages", "client", "pi-resources");
const toolPolicyPath = "extensions/vcp-tool-policy/index.js";
const fixturePath = "extensions/vcp-dev-fixture/index.js";
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

	const toolPolicyOut = join(piRoot, toolPolicyPath);
	mkdirSync(dirname(toolPolicyOut), { recursive: true });
	await bundlePiExtension(toolPolicyOut);

	// 夹具是「源码生成器」：先落盘再按普通扩展入口打包，与集成测试走同一份源码。
	// 用变量化动态 import 而非静态 import：scripts 的 tsconfig 只 include 自身目录，
	// 静态引入 client 源码会触发 TS6307（file not listed），而这里只需运行时取值。
	const fixtureModule = (await import(
		pathToFileURL(join(ROOT, "packages/client/src/pi/fixtures/web-extension.ts"))
			.href,
	)) as { buildWebExtensionSource: (options?: { prefix?: string }) => string };
	const fixtureEntryAbs = join(ROOT, fixtureEntry);
	mkdirSync(dirname(fixtureEntryAbs), { recursive: true });
	writeFileSync(
		fixtureEntryAbs,
		fixtureModule.buildWebExtensionSource({ prefix: "fixture" }),
	);
	const fixtureOut = join(piRoot, fixturePath);
	mkdirSync(dirname(fixtureOut), { recursive: true });
	await bundlePiExtension(fixtureOut, fixtureEntry);

	const manifest = buildBundleManifest({
		bundleVersion: `${clientPkg.version ?? "0.0.0"}-dev`,
		piSdkVersion,
		resources: [
			{
				id: "vcp.tool-policy",
				kind: "extension",
				version: "3",
				path: toolPolicyPath,
				content: readFileSync(toolPolicyOut),
			},
			{
				id: "vcp.dev-fixture",
				kind: "extension",
				version: "1",
				path: fixturePath,
				content: readFileSync(fixtureOut),
			},
		],
	});
	writeFileSync(
		join(piRoot, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	console.log(
		`[dev-pi-bundle] ok: ${piRoot}（Pi SDK ${piSdkVersion}，含验收夹具 vcp.dev-fixture）`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
