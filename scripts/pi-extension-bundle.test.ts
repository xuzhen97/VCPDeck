/**
 * Bundle 扩展打包边界测试（ADR-0042 决策 1、ADR-0036）。
 *
 * 两条不变量：
 * 1. **宿主提供的 Pi 模块必须保持 external**。SDK 在单文件发布形态下把
 *    `@earendil-works/pi-coding-agent`、`typebox` 等映射到内存模块；一旦被内联，
 *    产物里就会出现第二份 SDK（重复 registry / 重复类），且与宿主不是同一实例。
 * 2. **除宿主模块与 Node 内置模块外，不允许任何未打包说明符**。Release Bundle 只做
 *    逐入口文件 sha256 校验，不校验旁路依赖树，所以「产物里还有裸 import」等于
 *    运行期从目标机 node_modules 取代码，绕过受信校验。
 *
 * 运行：`pnpm exec tsx --test scripts/pi-extension-bundle.test.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { bundlePiExtension } from "./bundle-apps.js";

const ROOT = resolve(__dirname, "..");

/** 造一个临时扩展目录并打包，返回产物文本。 */
async function bundleFixture(
	files: Record<string, string>,
	entryRelative = "entry.ts",
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vcp-pi-ext-"));
	try {
		await mkdir(join(dir, "sub"), { recursive: true });
		for (const [relative, content] of Object.entries(files)) {
			await writeFile(join(dir, relative), content);
		}
		const outfile = join(dir, "out", "index.js");
		await mkdir(join(dir, "out"), { recursive: true });
		await bundlePiExtension(outfile, join(dir, entryRelative));
		return await readFile(outfile, "utf8");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("宿主 Pi 模块保持 external，包内相对依赖被内联", async () => {
	const text = await bundleFixture({
		"entry.ts": `import { VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HELPER_MARKER } from "./sub/helper.js";
export default function (pi) {
  pi.registerCommand("probe", {
    description: HELPER_MARKER + Type + VERSION,
    handler: async () => {},
  });
}
`,
		"sub/helper.ts": `export const HELPER_MARKER = "vcp-helper-marker";\n`,
	});

	assert.match(text, /from\s*"@earendil-works\/pi-coding-agent"/);
	assert.match(text, /from\s*"typebox"/);
	// 相对依赖必须已经进产物，不能再留 import 到运行期
	assert.match(text, /vcp-helper-marker/);
	assert.doesNotMatch(text, /from\s*"[^"]*helper/);
});

test("SDK 子路径说明符按白名单保留", async () => {
	const text = await bundleFixture({
		"entry.ts": `import * as providers from "@earendil-works/pi-ai/providers/all";
import * as typeboxValue from "typebox/value";
import { join } from "node:path";
export default function (pi) {
  pi.registerCommand("probe", {
    description: String(typeof providers) + String(typeof typeboxValue) + join("a", "b"),
    handler: async () => {},
  });
}
`,
	});

	assert.match(text, /from\s*"@earendil-works\/pi-ai\/providers\/all"/);
	assert.match(text, /from\s*"typebox\/value"/);
	// Node 内置模块不进产物，也不属于宿主 Pi 模块白名单
	assert.doesNotMatch(text, /node:path"[\s\S]*\n.*function join/);
});

test("非宿主裸说明符导致构建失败，不产出半成品 Bundle", async () => {
	await assert.rejects(
		() =>
			bundleFixture({
				"entry.ts": `import { thing } from "vcp-definitely-missing-package";
export default function (pi) {
  pi.registerCommand("probe", { description: String(thing), handler: async () => {} });
}
`,
			}),
	);
});
