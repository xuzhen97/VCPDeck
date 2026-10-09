import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 防漂移守卫：测试夹具里的 SDK 版本字面量必须与 package.json 声明一致。
 *
 * 动机：升级 Pi SDK 时漏改夹具会让 bundle/capability 测试出现"看起来像真实缺陷"
 * 的假失败（例如把「本机 SDK 版本不匹配」当成 bundle 校验缺陷来查）。
 * 这里只检查"声明版本是否出现在夹具里"，不检查夹具是否还有其他版本字面量——
 * 那些是**故意的**负例，例如 `bundle.test.ts` 用 `0.85.0` 构造 SDK 版本不匹配，
 * `socket-bridge.test.ts` 用 `0.84.0` 作为与安装版本无关的状态载荷夹具。
 */
describe("Pi SDK 版本夹具一致性", () => {
	const declared = (
		JSON.parse(
			readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
		) as { dependencies: Record<string, string> }
	).dependencies["@earendil-works/pi-coding-agent"];

	const fixtures = [
		join(__dirname, "bundle.test.ts"),
		join(__dirname, "capability.test.ts"),
		join(__dirname, "pi-worker.integration.test.ts"),
		join(__dirname, "..", "pi-bundle", "manifest.test.ts"),
	];

	it("package.json 声明了 Pi SDK 精确版本", () => {
		expect(declared).toMatch(/^\d+\.\d+\.\d+/);
	});

	for (const file of fixtures) {
		it(`${file.slice(file.indexOf("packages"))} 使用声明的 SDK 版本`, () => {
			const text = readFileSync(file, "utf8");
			const versions = text.match(/\d+\.\d+\.\d+/g) ?? [];
			expect(
				versions.some((value) => value === declared),
				`未出现声明版本 ${declared}，升级 SDK 时请同步该夹具`,
			).toBe(true);
		});
	}
});
