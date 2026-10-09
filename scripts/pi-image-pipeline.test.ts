// Pi 单文件 SDK 的图片链路回归门禁。
//
// 背景（实测，2026-10-09）：SDK 1.1.0 的 image resize 走「worker + Photon WASM，
// 失败回退进程内」，而 `loadPhoton()` 会 `catch {}` 吞掉错误返回 null，最终图片被
// 静默替换成 "[Image omitted: could not be resized below the inline image size limit.]"。
// 发布形态把 SDK 打成单文件（bundlePiSdk）后，Photon 一旦被内联，它按 __dirname
// 读同目录 photon_rs_bg.wasm 的定位就失效 —— 于是所有图片被丢弃，且没有任何错误码。
//
// 因此门禁验证三件事：
// 1. 单文件产物**没有内联** Photon 实现（用 photon 特有的实现标识，而不是
//    "photon_rs_bg.wasm" 字样——后者在 photon.js 自身里就有，会假阳性）；
// 2. 从产物所在目录能解析到 @silvia-odwyer/photon-node 且 wasm 就位；
// 3. 端到端：用产物创建真实 AgentSession 并带图 Prompt，模型看到的 user message
//    必须仍含 image 块（而不是省略提示）。
//
// 另有一个**内联对照组**：同配置但去掉 photon 外部化，必须复现「实现被内联 + 图片被
// 丢弃」。它保证上面的标识断言真的具有区分力，不会随上游重命名变成永真门禁。
//
// 以 `npx tsx scripts/pi-image-pipeline.test.ts` 运行（同 pack-release-deps.test.ts）。
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { bundlePiSdk, PI_PHOTON_IMPORT, PI_PHOTON_INLINED_MARKER, PI_PHOTON_PACKAGE, PI_SDK_PACKAGE } from "./bundle-apps.js";

const ROOT = resolve(__dirname, "..");
const TMP = join(ROOT, ".tmp", "pi-image-gate");
const SDK_DIR = join(TMP, "node_modules", "@earendil-works", "pi-coding-agent");
const CONTROL_DIR = join(TMP, "control", "node_modules", "@earendil-works", "pi-coding-agent");

/**
 * Photon 实现标识：只存在于 photon_rs.js 内部，内联时必然出现。
 * 与 `bundlePiSdk` 的构建期断言共用同一组标记（实测内联 = 4 次、外部化 = 0 次）。
 */
const isPhotonInlined = (text: string): boolean =>
	text.includes(PI_PHOTON_INLINED_MARKER);

let failed = 0;
async function check(desc: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		console.log(`ok - ${desc}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${desc}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** 生成 width x height 纯色 PNG（真实尺寸，避免退化图干扰判定）。 */
function makePng(width: number, height: number): Buffer {
	// 注意：累加器必须是**局部**变量。若提到函数外跨 chunk 复用，除首个 chunk 外
	// CRC 全错，Photon 会在解码时 `unreachable` panic，图片被误判为“无法缩放”。
	const crc32 = (buf: Uint8Array): number => {
		let c = ~0;
		for (const byte of buf) {
			c ^= byte;
			for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
		return ~c >>> 0;
	};
	const chunk = (type: string, data: Uint8Array): Buffer => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const typeBytes = Buffer.from(type, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
		return Buffer.concat([len, typeBytes, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (1 + width * 3);
		raw[rowStart] = 0;
		for (let x = 0; x < width; x++) {
			const p = rowStart + 1 + x * 3;
			raw[p] = 30;
			raw[p + 1] = 120;
			raw[p + 2] = 200;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	]);
}

type ProbeSdk = {
	createAgentSession: (options: unknown) => Promise<{
		session: { prompt: (text: string, options: unknown) => Promise<void>; dispose: () => void };
	}>;
	DefaultResourceLoader: new (options: unknown) => { reload: () => Promise<void> };
	SessionManager: { create: (cwd: string, dir: string) => unknown };
	SettingsManager: { inMemory: (settings: unknown) => unknown };
};

/** 用产物跑一次「带图 Prompt」，返回模型实际看到的 user content block 类型。 */
async function promptWithImage(sdk: ProbeSdk, cwd: string): Promise<string[]> {
	let seen: unknown;
	const modelRuntime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => "test-key",
		getAuth: async () => "test-key",
		streamSimple: (_model: unknown, context: unknown) => {
			seen = context;
			const response = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: "test",
				model: "test-model",
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", message: response };
				},
				result: async () => response,
			};
		},
	};
	const settingsManager = sdk.SettingsManager.inMemory({});
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
	});
	await resourceLoader.reload();
	const manager = sdk.SessionManager.create(cwd, join(cwd, "sessions"));
	const created = await sdk.createAgentSession({
		cwd,
		agentDir: cwd,
		model: {
			id: "test-model", name: "test-model", provider: "test", api: "openai-completions",
			baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000, maxTokens: 1000,
		},
		modelRuntime,
		sessionManager: manager,
		settingsManager,
		resourceLoader,
		tools: [],
	});
	try {
		await created.session.prompt("", {
			images: [
				{ type: "image", mimeType: "image/png", data: makePng(64, 64).toString("base64") },
			],
		});
	} finally {
		created.session.dispose();
	}
	const user = (
		seen as {
			messages?: Array<{ role: string; content: Array<{ type: string }> }>;
		}
	).messages?.find((message) => message.role === "user");
	return (user?.content ?? []).map((block) => block.type);
}

async function main(): Promise<void> {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(SDK_DIR, { recursive: true });
	// Photon 放到与发布布局同形的位置（client/node_modules 下，与 SDK 平级），
	// 整包拷贝：漏掉 package.json 会让包无法解析，门禁会得出错误结论。
	const photonSourceRequire = createRequire(
		join(ROOT, "packages", "client", "package.json"),
	);
	const photonEntry = photonSourceRequire.resolve("@silvia-odwyer/photon-node");
	const photonSourceDir = dirname(photonEntry);
	const photonTargetDir = join(TMP, "node_modules", "@silvia-odwyer", "photon-node");
	mkdirSync(photonTargetDir, { recursive: true });
	cpSync(photonSourceDir, photonTargetDir, { recursive: true });

	const entry = await bundlePiSdk(SDK_DIR);
	const bundleText = readFileSync(entry, "utf8");

	await check("单文件产物未内联 Photon 实现", () => {
		assert(
			!isPhotonInlined(bundleText),
			`产物中出现 ${PI_PHOTON_INLINED_MARKER}，说明 ${PI_PHOTON_PACKAGE} 被内联`,
		);
		assert(
			bundleText.includes(PI_PHOTON_IMPORT),
			`产物中未保留 ${PI_PHOTON_PACKAGE} 的动态 import`,
		);
	});

	await check("从产物目录可解析 Photon 且 wasm 就位", () => {
		const req = createRequire(entry);
		const resolved = req.resolve("@silvia-odwyer/photon-node");
		assert(existsSync(resolved), `解析到不存在的 ${resolved}`);
		assert(
			existsSync(join(photonTargetDir, "photon_rs_bg.wasm")),
			"photon_rs_bg.wasm 未随包就位",
		);
	});

	const probeCwd = join(TMP, "cwd");
	mkdirSync(probeCwd, { recursive: true });

	await check("端到端：单文件产物下带图 Prompt 仍保留 image 块", async () => {
		const sdk = (await import(pathToFileURL(entry).href)) as ProbeSdk;
		const types = await promptWithImage(sdk, probeCwd);
		assert(
			types.includes("image"),
			`图片未保留（实际 blocks=${JSON.stringify(types)}）；` +
				"这通常意味着 Photon 未能加载或又被内联",
		);
	});

	// 内联对照组：同配置去掉 photon 外部化，必须复现原始缺陷。
	// 它证明上面的实现标识断言与端到端断言确实能抓到回归（不是永真门禁）。
	mkdirSync(CONTROL_DIR, { recursive: true });
	const controlEntry = join(CONTROL_DIR, "index.mjs");
	await build({
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		tsconfig: resolve(ROOT, "packages/client/tsconfig.json"),
		absWorkingDir: ROOT,
		stdin: {
			contents: `export * from ${JSON.stringify(PI_SDK_PACKAGE)};\n`,
			resolveDir: join(ROOT, "packages/client"),
			loader: "ts",
			sourcefile: "pi-sdk-entry.ts",
		},
		outfile: controlEntry,
		define: { PI_BUNDLED_NODE: "true" },
		banner: {
			js: 'import { createRequire as __vcpCreateRequire } from "node:module"; const require = __vcpCreateRequire(import.meta.url);',
		},
		// 故意不外部化 photon：复现「实现被内联」的原始缺陷配置。
		external: ["*.node"],
		sourcemap: false,
		minify: false,
		logLevel: "warning",
	});

	await check("对照组：内联 Photon 时实现标识出现（证明门禁有区分力）", () => {
		const controlText = readFileSync(controlEntry, "utf8");
		assert(
			isPhotonInlined(controlText),
			"内联对照组未出现 Photon 实现标识，说明该标识已失去区分力",
		);
	});

	await check("对照组：内联 Photon 时图片确实被丢弃（复现原始缺陷）", async () => {
		const sdk = (await import(pathToFileURL(controlEntry).href)) as ProbeSdk;
		const controlCwd = join(TMP, "control-cwd");
		mkdirSync(controlCwd, { recursive: true });
		const types = await promptWithImage(sdk, controlCwd);
		assert(
			!types.includes("image"),
			`内联对照组竟然保留了图片（blocks=${JSON.stringify(types)}），` +
				"说明本门禁已无法复现该缺陷",
		);
	});

	rmSync(TMP, { recursive: true, force: true });

	if (failed > 0) {
		console.error(`${failed} 项失败`);
		process.exit(1);
	}
	console.log("Pi 图片链路门禁全部通过");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
