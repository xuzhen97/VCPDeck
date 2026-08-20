#!/usr/bin/env node
/**
 * 更新发布版本：同步 Shared 运行时版本与 SDK/Shared/CLI 包版本。
 * 由 pack-release（pnpm release）在构建前调用。
 *
 * 用法:
 *   node scripts/inject-version.cjs 1.2.1
 */
const fs = require("node:fs");
const path = require("node:path");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(
		"[inject-version] 用法: node scripts/inject-version.cjs <x.y.z>",
	);
	process.exit(1);
}

try {
	const packageNames = ["shared", "sdk", "cli"];
	for (const name of packageNames) {
		const target = path.resolve(__dirname, `../packages/${name}/package.json`);
		const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
		manifest.version = version;
		if (name === "sdk") manifest.peerDependencies["@vcpdeck/shared"] = version;
		fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
	}

	const target = path.resolve(__dirname, "../packages/shared/src/version.ts");
	const content = `/**
 * 全局版本号（server 与 client 共用）。
 * 由 scripts/inject-version.cjs 注入（发版构建时）。
 */
export const VERSION = "${version}";
`;
	fs.writeFileSync(target, content);
	console.log(`[inject-version] 已同步发布版本 ${version}`);
} catch (error) {
	console.error(
		`[inject-version] 更新失败: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}
