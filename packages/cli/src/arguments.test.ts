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

	it("multiValue 选项可重复并收集为数组", () => {
		const { options, multi } = parseCommandArgs(
			[
				"--arg=--profile",
				"--arg=acp",
				"--workspace-root=/repo",
				"--json",
			],
			{ multiValue: ["arg", "workspace-root"], boolean: ["json"] },
		);
		expect(multi).toEqual({
			arg: ["--profile", "acp"],
			"workspace-root": ["/repo"],
		});
		expect(options).toEqual({ json: true });
	});

	it("multiValue 选项缺值仍报错，inline 值允许以 -- 开头", () => {
		expect(() =>
			parseCommandArgs(["--arg"], { multiValue: ["arg"] }),
		).toThrow("选项缺少值");
		expect(() =>
			parseCommandArgs(["--arg", "--other"], { multiValue: ["arg"] }),
		).toThrow("选项缺少值");
		expect(
			parseCommandArgs(["--arg=--other"], { multiValue: ["arg"] }).multi.arg,
		).toEqual(["--other"]);
	});
});
