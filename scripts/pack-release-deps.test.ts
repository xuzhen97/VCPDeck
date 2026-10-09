// node-datachannel 双平台离线装配自检（ADR-0026）。
// 以 `pnpm exec tsx scripts/pack-release-deps.test.ts` 运行（import 不触发发布构建）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIENT_EXTERNAL, PI_SDK_PACKAGE } from "./bundle-apps.js";
import {
	EXTERNAL_DEPS,
	PLATFORM_PKG_PARENT,
	VARIANT_EXCLUDES,
} from "./pack-release.js";

const ROOT = resolve(__dirname, "..");

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

// Pi SDK 必须作为单文件产物写入 node_modules，不能走依赖树安装：
// 未打包时每次文件首次打开的成本（实测带实时扫描的机器约 19.6ms）× 约 2,400 个
// ESM 图文件 = 冷加载 47.8s，会稳定超过能力探测上限而被误判为「不支持 Pi」。
check("Pi SDK 不进入依赖安装清单，由 bundlePiSdk 单文件产物代替", () => {
	assert(!EXTERNAL_DEPS.client.includes(PI_SDK_PACKAGE));
	assert(!EXTERNAL_DEPS.client.includes("@earendil-works/pi-agent-core"));
	// 运行时仍按包名解析（src 里的 import 不改），因此 esbuild 必须保留它为 external。
	assert(CLIENT_EXTERNAL.includes("@earendil-works/*"));
});

// photon-node 必须同时满足两件事：作为真实包随发行布局安装，且**不进** SDK 单文件产物。
// 仅外部化而不安装会解析失败；仅安装而不外部化会让 Photon 读不到自身的
// photon_rs_bg.wasm，图片会被静默替换为省略提示（见 pi-image-pipeline.test.ts）。
check("photon-node 进入 Client 外部依赖清单（单文件 SDK 的图片链路）", () => {
	assert(EXTERNAL_DEPS.client.includes("@silvia-odwyer/photon-node"));
	// 同一不变量必须两端成立：外部依赖清单负责「随发行布局安装」，client 声明负责
	// 为 resolveExternalDepVersions() 提供版本号。少任一端都会在发布时失败。
	const clientPkg = JSON.parse(
		readFileSync(join(ROOT, "packages/client/package.json"), "utf8"),
	) as { dependencies?: Record<string, string> };
	assert(
		typeof clientPkg.dependencies?.["@silvia-odwyer/photon-node"] === "string",
		"packages/client/package.json 必须声明 @silvia-odwyer/photon-node（否则无法解析发布版本）",
	);
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
