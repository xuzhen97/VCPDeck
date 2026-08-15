#!/usr/bin/env node
/**
 * 构建前注入版本号：改写 packages/shared/src/version.ts。
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

const target = path.resolve(__dirname, "../packages/shared/src/version.ts");
const content = `/**
 * 全局版本号（server 与 client 共用）。
 * 由 scripts/inject-version.cjs 注入（发版构建时）。
 */
export const VERSION = "${version}";
`;
fs.writeFileSync(target, content);
console.log(`[inject-version] 已写入 ${version} → ${target}`);
