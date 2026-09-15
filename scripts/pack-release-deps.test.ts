// node-datachannel 双平台离线装配自检（ADR-0026）。
// 以 `pnpm exec tsx scripts/pack-release-deps.test.ts` 运行（import 不触发发布构建）。
import assert from "node:assert/strict";
import { CLIENT_EXTERNAL } from "./bundle-apps.js";
import {
	EXTERNAL_DEPS,
	PLATFORM_PKG_PARENT,
	VARIANT_EXCLUDES,
} from "./pack-release.js";

let failed = 0;
function check(desc: string, fn: () => void): void {
	try {
		fn();
		console.log(`ok - ${desc}`);
	} catch (e) {
		failed++;
		console.error(
			`FAIL - ${desc}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

check("Client 保留 node-datachannel 与双平台预编译包", () => {
	assert(EXTERNAL_DEPS.client.includes("node-datachannel"));
	assert(EXTERNAL_DEPS.client.includes("@node-datachannel/win32-x64-msvc"));
	assert(EXTERNAL_DEPS.client.includes("@node-datachannel/linux-x64-gnu"));
	assert.strictEqual(
		PLATFORM_PKG_PARENT["@node-datachannel/win32-x64-msvc"],
		"node-datachannel",
	);
	assert.strictEqual(
		PLATFORM_PKG_PARENT["@node-datachannel/linux-x64-gnu"],
		"node-datachannel",
	);
});

check("esbuild client external 保留原生包（不吞进 bundle）", () => {
	assert(CLIENT_EXTERNAL.includes("node-datachannel"));
	assert(CLIENT_EXTERNAL.includes("node-datachannel/*"));
});

check("win/linux zip 平台裁剪：互斥保留对方平台的 native 包", () => {
	assert(
		VARIANT_EXCLUDES["win-x64"].includes(
			"client/node_modules/@node-datachannel/linux-x64-gnu",
		),
	);
	assert(
		VARIANT_EXCLUDES["linux-x64"].includes(
			"client/node_modules/@node-datachannel/win32-x64-msvc",
		),
	);
	assert(
		!VARIANT_EXCLUDES["win-x64"].includes("client/node_modules/node-datachannel"),
	);
	assert(
		!VARIANT_EXCLUDES["linux-x64"].includes("client/node_modules/node-datachannel"),
	);
});

if (failed > 0) {
	console.error(`${failed} 项检查失败`);
	process.exit(1);
}
console.log("pack-release node-datachannel 依赖检查全部通过");
