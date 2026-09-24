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
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildBundleManifest } from "../packages/client/src/pi-bundle/manifest.js";
import { bundlePiExtension } from "./bundle-apps.js";

const ROOT = resolve(__dirname, "..");
const piRoot = join(ROOT, "packages", "client", "pi-resources");
const resourcePath = "extensions/vcp-tool-policy/index.js";

async function main(): Promise<void> {
	const clientPkg = JSON.parse(
		readFileSync(join(ROOT, "packages", "client", "package.json"), "utf8"),
	) as { version?: string; dependencies?: Record<string, string> };
	const piSdkVersion = clientPkg.dependencies?.["@earendil-works/pi-coding-agent"];
	if (!piSdkVersion) {
		throw new Error("[dev-pi-bundle] packages/client 未声明 Pi SDK 版本");
	}

	const outfile = join(piRoot, resourcePath);
	mkdirSync(dirname(outfile), { recursive: true });
	await bundlePiExtension(outfile);

	const manifest = buildBundleManifest({
		bundleVersion: `${clientPkg.version ?? "0.0.0"}-dev`,
		piSdkVersion,
		resources: [
			{
				id: "vcp.tool-policy",
				kind: "extension",
				version: "1",
				path: resourcePath,
				content: readFileSync(outfile),
			},
		],
	});
	writeFileSync(
		join(piRoot, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	console.log(`[dev-pi-bundle] ok: ${piRoot}（Pi SDK ${piSdkVersion}）`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
