"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const job_scheduler_js_1 = require("./job.scheduler.js");
function prismaMock() {
    return {
        job: {
            count: vitest_1.vi.fn().mockResolvedValue(0),
            findFirst: vitest_1.vi.fn().mockResolvedValue(null),
            update: vitest_1.vi.fn().mockResolvedValue({}),
        },
    };
}
(0, vitest_1.describe)("JobScheduler", () => {
    (0, vitest_1.it)("普通 pending Job 正常调度", async () => {
        const prisma = {
            job: {
                count: vitest_1.vi.fn().mockResolvedValue(0),
                findFirst: vitest_1.vi.fn().mockResolvedValue({
                    id: "j1",
                    clientId: "c1",
                    type: "exec",
                    payload: "{}",
                    timeout: null,
                }),
                update: vitest_1.vi.fn().mockResolvedValue({}),
            },
        };
        const scheduler = new job_scheduler_js_1.JobScheduler(prisma);
        const dispatch = await scheduler.tryDispatch("c1");
        (0, vitest_1.expect)(dispatch?.type).toBe("exec");
        (0, vitest_1.expect)(prisma.job
            .findFirst).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            where: {
                clientId: "c1",
                status: "pending",
                type: { notIn: ["agent.run", "agent.session"] },
            },
        }));
    });
    (0, vitest_1.it)("agent.run 不进入普通调度", async () => {
        const prisma = {
            job: {
                count: vitest_1.vi.fn().mockResolvedValue(0),
                // 模拟 DB：只有 agent.run pending，findFirst（排除 agent.run）返回 null
                findFirst: vitest_1.vi.fn().mockResolvedValue(null),
                update: vitest_1.vi.fn().mockResolvedValue({}),
            },
        };
        const scheduler = new job_scheduler_js_1.JobScheduler(prisma);
        const dispatch = await scheduler.tryDispatch("c1");
        (0, vitest_1.expect)(dispatch).toBeNull();
        (0, vitest_1.expect)(prisma.job
            .findFirst).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            where: {
                clientId: "c1",
                status: "pending",
                type: { notIn: ["agent.run", "agent.session"] },
            },
        }));
        (0, vitest_1.expect)(prisma.job.update).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("Session Job 不计入普通任务并发额度", async () => {
        const prisma = prismaMock();
        const scheduler = new job_scheduler_js_1.JobScheduler(prisma);
        await scheduler.tryDispatch("c1");
        (0, vitest_1.expect)(prisma.job.count).toHaveBeenCalledWith({
            where: {
                clientId: "c1",
                status: "running",
                type: { notIn: ["agent.run", "agent.session"] },
            },
        });
    });
    (0, vitest_1.it)("并发上限仍生效", async () => {
        const prisma = {
            job: {
                count: vitest_1.vi.fn().mockResolvedValue(3),
                findFirst: vitest_1.vi.fn(),
                update: vitest_1.vi.fn(),
            },
        };
        const scheduler = new job_scheduler_js_1.JobScheduler(prisma);
        const dispatch = await scheduler.tryDispatch("c1");
        (0, vitest_1.expect)(dispatch).toBeNull();
        (0, vitest_1.expect)(prisma.job
            .findFirst).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("优雅停机闸门开启时不派发", async () => {
        const prisma = prismaMock();
        const drainMock = { isDraining: vitest_1.vi.fn().mockReturnValue(true) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scheduler = new job_scheduler_js_1.JobScheduler(prisma, drainMock);
        const dispatch = await scheduler.tryDispatch("c1");
        (0, vitest_1.expect)(dispatch).toBeNull();
        (0, vitest_1.expect)(prisma.job.findFirst).not.toHaveBeenCalled();
    });
});
void prismaMock;
