"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const server_drain_js_1 = require("./server-drain.js");
function mockPrisma() {
    return {
        job: {
            count: vitest_1.vi.fn(),
        },
    };
}
(0, vitest_1.describe)("ServerDrain", () => {
    let prisma;
    let drain;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.useFakeTimers();
        prisma = mockPrisma();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        drain = new server_drain_js_1.ServerDrain(prisma, { pollIntervalMs: 1000 });
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("drain 开始时置闸门，等运行中 job 收敛到 0 后返回", async () => {
        prisma.job.count
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0);
        const phase = drain.drain(60_000);
        (0, vitest_1.expect)(drain.isDraining()).toBe(true);
        await vitest_1.vi.advanceTimersByTimeAsync(3000);
        await (0, vitest_1.expect)(phase).resolves.toBeUndefined();
        // running + waiting_input 都算运行中
        (0, vitest_1.expect)(prisma.job.count).toHaveBeenCalledWith({
            where: { status: { in: ["running", "waiting_input"] } },
        });
    });
    (0, vitest_1.it)("超时仍未收敛时抛错（含剩余数量）", async () => {
        prisma.job.count.mockResolvedValue(3);
        const phase = drain.drain(5000);
        const assertion = (0, vitest_1.expect)(phase).rejects.toThrow("仍有 3 个");
        await vitest_1.vi.advanceTimersByTimeAsync(6000);
        await assertion;
    });
    (0, vitest_1.it)("连续 drain 以先到者为准，闸门保持", async () => {
        prisma.job.count.mockResolvedValue(0);
        await drain.drain(60_000);
        (0, vitest_1.expect)(drain.isDraining()).toBe(true);
    });
});
