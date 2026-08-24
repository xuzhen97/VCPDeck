import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

const mockedExec = vi.mocked(execFileSync);

const TAR = "C:\\Windows\\System32\\tar.exe";

type ExecCall = [bin: string, args: string[]];

function calls(): string[][] {
	return mockedExec.mock.calls.map((c) => {
		const [bin, args] = c as unknown as ExecCall;
		return [bin, ...args];
	});
}

describe("extractArchive win32 .zip", () => {
	afterEach(() => {
		mockedExec.mockReset();
	});

	it("首选 System32 bsdtar -xf，不调用 PowerShell", async () => {
		const { extractArchive } = await import("./archive.js");
		mockedExec.mockImplementation(() => Buffer.from(""));

		await extractArchive("C:/tmp/x.zip", "C:/tmp/out");

		const cs = calls();
		expect(cs).toHaveLength(1);
		expect(cs[0][0]).toBe(TAR);
		expect(cs[0].slice(1)).toEqual(["-xf", "C:/tmp/x.zip", "-C", "C:/tmp/out"]);
	});

	it("bsdtar 缺失/失败 → 兜底 Expand-Archive 且整体成功", async () => {
		const { extractArchive } = await import("./archive.js");
		mockedExec
			.mockImplementationOnce(() => {
				throw new Error("ENOENT");
			})
			.mockImplementation(() => Buffer.from(""));

		await expect(
			extractArchive("C:/tmp/x.zip", "C:/tmp/out"),
		).resolves.toBeUndefined();

		const cs = calls();
		expect(cs).toHaveLength(2);
		expect(cs[0][0]).toBe(TAR);
		expect(cs[1][0]).toBe("powershell");
		expect(cs[1].join(" ")).toContain("Expand-Archive");
	});

	it("两条路径都失败 → 抛出解压失败", async () => {
		const { extractArchive } = await import("./archive.js");
		mockedExec.mockImplementation(() => {
			throw new Error("corrupt archive");
		});

		await expect(extractArchive("C:/tmp/x.zip", "C:/tmp/out")).rejects.toThrow(
			/解压失败/,
		);
	});
});
