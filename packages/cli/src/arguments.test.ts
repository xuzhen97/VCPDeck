import { describe, expect, it } from "vitest";
import { parseCommandArgs } from "./arguments.js";

describe("parseCommandArgs", () => {
	it("解析长选项、布尔选项与位置参数", () => {
		const { positionals, options } = parseCommandArgs(
			["run", "--env=prod", "--wait", "x"],
			{ value: ["env"], boolean: ["wait"] },
		);
		expect(positionals).toEqual(["run", "x"]);
		expect(options).toEqual({ env: "prod", wait: true });
	});

	it("裸 -- 分隔符后的参数原样作为位置参数，不再解析为选项", () => {
		const { positionals, options } = parseCommandArgs(
			["run", "--wait", "--", "git", "status", "--porcelain", "-z"],
			{ value: [], boolean: ["wait"] },
		);
		expect(positionals).toEqual(["run", "git", "status", "--porcelain", "-z"]);
		expect(options).toEqual({ wait: true });
	});

	it("分隔符前未知选项仍然报错；分隔符后不再校验", () => {
		expect(() => parseCommandArgs(["--nope", "--", "x"])).toThrow("未知选项");
		const { positionals } = parseCommandArgs(["--", "--nope"], {});
		expect(positionals).toEqual(["--nope"]);
	});
});
