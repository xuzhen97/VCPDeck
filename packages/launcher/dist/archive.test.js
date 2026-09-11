"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_child_process_1 = require("node:child_process");
vitest_1.vi.mock("node:child_process", () => ({
    execFileSync: vitest_1.vi.fn(),
}));
const mockedExec = vitest_1.vi.mocked(node_child_process_1.execFileSync);
const TAR = "C:\\Windows\\System32\\tar.exe";
function calls() {
    return mockedExec.mock.calls.map((c) => {
        const [bin, args] = c;
        return [bin, ...args];
    });
}
(0, vitest_1.describe)("extractArchive win32 .zip", () => {
    (0, vitest_1.afterEach)(() => {
        mockedExec.mockReset();
    });
    (0, vitest_1.it)("首选 System32 bsdtar -xf，不调用 PowerShell", async () => {
        const { extractArchive } = await import("./archive.js");
        mockedExec.mockImplementation(() => Buffer.from(""));
        await extractArchive("C:/tmp/x.zip", "C:/tmp/out");
        const cs = calls();
        (0, vitest_1.expect)(cs).toHaveLength(1);
        (0, vitest_1.expect)(cs[0][0]).toBe(TAR);
        (0, vitest_1.expect)(cs[0].slice(1)).toEqual(["-xf", "C:/tmp/x.zip", "-C", "C:/tmp/out"]);
    });
    (0, vitest_1.it)("bsdtar 缺失/失败 → 兜底 Expand-Archive 且整体成功", async () => {
        const { extractArchive } = await import("./archive.js");
        mockedExec
            .mockImplementationOnce(() => {
            throw new Error("ENOENT");
        })
            .mockImplementation(() => Buffer.from(""));
        await (0, vitest_1.expect)(extractArchive("C:/tmp/x.zip", "C:/tmp/out")).resolves.toBeUndefined();
        const cs = calls();
        (0, vitest_1.expect)(cs).toHaveLength(2);
        (0, vitest_1.expect)(cs[0][0]).toBe(TAR);
        (0, vitest_1.expect)(cs[1][0]).toBe("powershell");
        (0, vitest_1.expect)(cs[1].join(" ")).toContain("Expand-Archive");
    });
    (0, vitest_1.it)("两条路径都失败 → 抛出解压失败", async () => {
        const { extractArchive } = await import("./archive.js");
        mockedExec.mockImplementation(() => {
            throw new Error("corrupt archive");
        });
        await (0, vitest_1.expect)(extractArchive("C:/tmp/x.zip", "C:/tmp/out")).rejects.toThrow(/解压失败/);
    });
});
