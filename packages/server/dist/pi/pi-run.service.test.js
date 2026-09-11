"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const pi_run_service_js_1 = require("./pi-run.service.js");
const actor = {
    identityId: "user-1",
    displayName: "User",
    isAdmin: false,
    credentialId: null,
    sessionId: null,
    source: "web",
    requestId: "req-1",
};
const otherActor = { ...actor, identityId: "user-2", displayName: "Other" };
const input = { clientId: "c1", sessionId: "s1", projectKey: "k1" };
const activeStatuses = ["pending", "running", "waiting_input", "disconnected"];
function matches(value, condition) {
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        const where = condition;
        if (where.in)
            return where.in.includes(value);
    }
    return value === condition;
}
function prismaMock() {
    const jobs = [];
    const job = {
        create: vitest_1.vi.fn(async (args) => {
            if (jobs.some((candidate) => candidate.id === args.data.id)) {
                throw { code: "P2002" };
            }
            const created = {
                payload: "{}",
                progress: null,
                result: null,
                errorCode: null,
                errorMessage: null,
                startedAt: null,
                finishedAt: null,
                createdAt: new Date(),
                ...args.data,
            };
            jobs.push(created);
            return created;
        }),
        findUnique: vitest_1.vi.fn(async (args) => jobs.find((candidate) => candidate.id === args.where.id) ?? null),
        findMany: vitest_1.vi.fn(async (args) => jobs.filter((candidate) => Object.entries(args?.where ?? {}).every(([key, value]) => matches(candidate[key], value)))),
        update: vitest_1.vi.fn(async (args) => {
            const candidate = jobs.find((item) => item.id === args.where.id);
            if (!candidate)
                throw new Error("not found");
            Object.assign(candidate, args.data);
            return candidate;
        }),
        updateMany: vitest_1.vi.fn(async (args) => {
            let count = 0;
            for (const candidate of jobs) {
                if (Object.entries(args.where).every(([key, value]) => matches(candidate[key], value))) {
                    Object.assign(candidate, args.data);
                    count += 1;
                }
            }
            return { count };
        }),
    };
    return { job, _jobs: jobs };
}
function setup() {
    const prisma = prismaMock();
    const service = new pi_run_service_js_1.PiRunService(prisma);
    const current = () => prisma._jobs.find((job) => job.id === "s1");
    const ensure = () => service.ensureSession(actor, { clientId: "c1", sessionId: "s1" });
    const start = async () => {
        await ensure();
        return service.startRun(actor, input);
    };
    const running = async () => {
        const run = await start();
        (0, vitest_1.expect)(await service.accept(run.jobId, run.runId)).toBe(true);
        return run;
    };
    return { prisma, service, current, ensure, start, running };
}
function report(runs) {
    return { clientId: "c1", runs };
}
function activeReport(runId, status = "running", projectKey = "k1") {
    return { jobId: "s1", runId, sessionId: "s1", status, projectKey };
}
(0, vitest_1.describe)("PiRunService session CAS", () => {
    (0, vitest_1.it)("ensureSession 以 sessionId 幂等创建 idle agent.session", async () => {
        const { prisma, ensure } = setup();
        await ensure();
        await ensure();
        (0, vitest_1.expect)(prisma._jobs).toHaveLength(1);
        (0, vitest_1.expect)(prisma._jobs[0]).toMatchObject({
            id: "s1",
            clientId: "c1",
            type: "agent.session",
            status: "idle",
            payload: "{}",
            progress: null,
            createdByIdentityId: "user-1",
        });
    });
    (0, vitest_1.it)("并发唯一键冲突后校验 winner，不覆盖 Owner", async () => {
        const { prisma, service } = setup();
        prisma._jobs.push({
            id: "s1",
            clientId: "c1",
            type: "agent.session",
            status: "idle",
            payload: "{}",
            createdByIdentityId: "user-1",
            createdByName: "User",
        });
        prisma.job.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(prisma._jobs[0]);
        prisma.job.create.mockRejectedValueOnce({ code: "P2002" });
        await (0, vitest_1.expect)(service.ensureSession(otherActor, { clientId: "c1", sessionId: "s1" })).resolves.toBeUndefined();
        (0, vitest_1.expect)(prisma.job.update).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("每次 startRun 保持 jobId 并生成新 runId", async () => {
        const { service, start } = setup();
        const first = await start();
        await service.finishRun(first.jobId, first.runId);
        const second = await service.startRun(actor, input);
        (0, vitest_1.expect)(first.jobId).toBe("s1");
        (0, vitest_1.expect)(second.jobId).toBe("s1");
        (0, vitest_1.expect)(second.runId).not.toBe(first.runId);
    });
    (0, vitest_1.it)("snapshot 只返回安全字段与 Owner 视图", async () => {
        const { service, start } = setup();
        const { runId } = await start();
        (0, vitest_1.expect)(await service.snapshot("s1", "user-2")).toEqual({
            jobId: "s1",
            sessionId: "s1",
            status: "pending",
            runId,
            ownerName: "User",
            isOwner: false,
        });
    });
    (0, vitest_1.it)("执行完整 run 状态矩阵并保持 progress=null", async () => {
        const { service, current, running } = setup();
        const run = await running();
        (0, vitest_1.expect)(await service.waitForInput(run.jobId, run.runId)).toBe(true);
        (0, vitest_1.expect)(await service.resume(run.jobId, run.runId)).toBe(true);
        (0, vitest_1.expect)(await service.finishRun(run.jobId, run.runId)).toBe(true);
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "idle",
            payload: "{}",
            progress: null,
        });
        const next = await service.startRun(actor, input);
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "pending",
            payload: JSON.stringify({ runId: next.runId }),
            progress: null,
            result: null,
            finishedAt: null,
            errorCode: null,
            errorMessage: null,
        });
    });
    (0, vitest_1.it)("done 可重开；error 不可自动重开", async () => {
        const { service, current, ensure } = setup();
        await ensure();
        (0, vitest_1.expect)(await service.completeSession("s1")).toBe(true);
        (0, vitest_1.expect)(await service.completeSession("s1")).toBe(true);
        await (0, vitest_1.expect)(service.startRun(actor, input)).resolves.toBeDefined();
        const runId = JSON.parse(String(current().payload)).runId;
        await service.failSession("s1", runId, "PI_WORKER_EXITED");
        await (0, vitest_1.expect)(service.startRun(actor, input)).rejects.toMatchObject({
            code: "PI_PROJECT_BUSY",
        });
    });
    (0, vitest_1.it)("重复 complete 保持首次 finishedAt 不变", async () => {
        const { service, current, ensure } = setup();
        await ensure();
        (0, vitest_1.expect)(await service.completeSession("s1")).toBe(true);
        const finishedAt = current().finishedAt.getTime();
        (0, vitest_1.expect)(await service.completeSession("s1")).toBe(true);
        (0, vitest_1.expect)(current().finishedAt.getTime()).toBe(finishedAt);
    });
    (0, vitest_1.it)("无 runId complete 将 error 原子完成为 done 并清理错误字段", async () => {
        const { service, current, running } = setup();
        const run = await running();
        await service.failSession(run.jobId, run.runId, "PI_WORKER_EXITED");
        (0, vitest_1.expect)(await service.completeSession(run.jobId)).toBe(true);
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "done",
            payload: "{}",
            errorCode: null,
            errorMessage: null,
        });
        const snapshot = await service.snapshot(run.jobId, actor.identityId);
        (0, vitest_1.expect)(snapshot).not.toHaveProperty("errorCode");
        (0, vitest_1.expect)(snapshot).not.toHaveProperty("errorMessage");
    });
    (0, vitest_1.it)("complete 处理 pending/active/disconnected 且 active 必须匹配 runId", async () => {
        for (const status of activeStatuses) {
            const { service, current, start } = setup();
            const run = await start();
            current().status = status;
            (0, vitest_1.expect)(await service.completeSession(run.jobId, "wrong")).toBe(false);
            (0, vitest_1.expect)(await service.completeSession(run.jobId, run.runId)).toBe(true);
            (0, vitest_1.expect)(current()).toMatchObject({
                status: "done",
                payload: "{}",
                progress: null,
            });
        }
    });
    (0, vitest_1.it)("提前到达的 Extension 不被 accept 覆盖", async () => {
        const { service, current, start } = setup();
        const run = await start();
        (0, vitest_1.expect)(await service.waitForInput(run.jobId, run.runId)).toBe(true);
        (0, vitest_1.expect)(await service.accept(run.jobId, run.runId)).toBe(false);
        (0, vitest_1.expect)(current().status).toBe("waiting_input");
    });
    (0, vitest_1.it)("complete 与 settlement 并发时 done 不回退 idle", async () => {
        const { service, current, running } = setup();
        const run = await running();
        await service.completeSession(run.jobId, run.runId);
        (0, vitest_1.expect)(await service.finishRun(run.jobId, run.runId)).toBe(false);
        (0, vitest_1.expect)(current().status).toBe("done");
    });
    (0, vitest_1.it)("旧 run 不能修改新 run 或释放新锁", async () => {
        const { service, current, running } = setup();
        const first = await running();
        await service.finishRun(first.jobId, first.runId);
        const second = await service.startRun(actor, input);
        (0, vitest_1.expect)(await service.waitForInput(first.jobId, first.runId)).toBe(false);
        (0, vitest_1.expect)(await service.failSession(first.jobId, first.runId, "PI_WORKER_EXITED")).toBe(false);
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "pending",
            payload: JSON.stringify({ runId: second.runId }),
        });
        (0, vitest_1.expect)(service.hasLock(second.jobId, second.runId)).toBe(true);
    });
    (0, vitest_1.it)("settlement timer 由 jobId+runId 精确隔离", async () => {
        vitest_1.vi.useFakeTimers();
        try {
            const { service, running } = setup();
            const first = await running();
            await service.scheduleSettlement(first.jobId, first.runId, vitest_1.vi.fn());
            await service.finishRun(first.jobId, first.runId);
            const second = await service.startRun(actor, input);
            const onSecond = vitest_1.vi.fn();
            await service.scheduleSettlement(second.jobId, second.runId, onSecond);
            service.cancelSettlement(first.jobId, first.runId);
            await vitest_1.vi.advanceTimersByTimeAsync(30_000);
            (0, vitest_1.expect)(onSecond).toHaveBeenCalledOnce();
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)("旧 settlement callback 在新 run 后不得执行", async () => {
        vitest_1.vi.useFakeTimers();
        try {
            const { service, running } = setup();
            const first = await running();
            const onFirst = vitest_1.vi.fn();
            await service.scheduleSettlement(first.jobId, first.runId, onFirst);
            await service.finishRun(first.jobId, first.runId);
            await service.startRun(actor, input);
            await vitest_1.vi.advanceTimersByTimeAsync(30_000);
            (0, vitest_1.expect)(onFirst).not.toHaveBeenCalled();
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)("删除 reservation 仅允许静态状态并按 token rollback/commit", async () => {
        for (const status of ["idle", "done", "error"]) {
            const { service, current, ensure } = setup();
            await ensure();
            current().status = status;
            const reservation = await service.beginDelete("s1", actor.identityId);
            (0, vitest_1.expect)(reservation).toMatchObject({
                previousStatus: status,
                existingReservation: false,
            });
            (0, vitest_1.expect)(current()).toMatchObject({ status: "cancelled" });
            (0, vitest_1.expect)(await service.rollbackDelete("s1", reservation.deleteToken)).toBe(true);
            (0, vitest_1.expect)(current()).toMatchObject({ status, payload: "{}" });
            const next = await service.beginDelete("s1", actor.identityId);
            (0, vitest_1.expect)(await service.commitDelete("s1", next.deleteToken)).toBe(true);
            (0, vitest_1.expect)(current()).toMatchObject({ status: "cancelled", payload: "{}" });
        }
    });
    (0, vitest_1.it)("delete 与 startRun 竞争时只有 reservation 取得 CAS", async () => {
        const { service, ensure } = setup();
        await ensure();
        const reservation = await service.beginDelete("s1", actor.identityId);
        await (0, vitest_1.expect)(service.startRun(actor, input)).rejects.toMatchObject({
            code: "PI_PROJECT_BUSY",
        });
        (0, vitest_1.expect)(await service.commitDelete("s1", reservation.deleteToken)).toBe(true);
    });
    (0, vitest_1.it)("活动状态禁止删除，reservation 可幂等读取且不泄露 token", async () => {
        const { service, start } = setup();
        await start();
        await (0, vitest_1.expect)(service.beginDelete("s1", actor.identityId)).rejects.toMatchObject({ code: "PI_PROJECT_BUSY" });
        await service.finishRun("s1", JSON.parse(JSON.stringify((await service.snapshot("s1", actor.identityId)).runId)));
        const first = await service.beginDelete("s1", actor.identityId);
        (0, vitest_1.expect)(await service.beginDelete("s1", actor.identityId)).toEqual({
            ...first,
            existingReservation: true,
        });
        (0, vitest_1.expect)(JSON.stringify(await service.snapshot("s1", actor.identityId))).not.toContain(first.deleteToken);
    });
    (0, vitest_1.it)("畸形 run/delete payload 不得被识别或参与 CAS", async () => {
        const { service, current, running } = setup();
        const run = await running();
        current().payload = JSON.stringify({ runId: run.runId, extra: true });
        (0, vitest_1.expect)((await service.snapshot("s1", actor.identityId)).runId).toBeNull();
        (0, vitest_1.expect)(await service.listActiveByClient("c1")).toEqual([]);
        (0, vitest_1.expect)(await service.finishRun("s1", run.runId)).toBe(false);
        current().status = "cancelled";
        current().payload = JSON.stringify({
            deleteToken: "token",
            previousStatus: "running",
        });
        await (0, vitest_1.expect)(service.beginDelete("s1", actor.identityId)).rejects.toMatchObject({
            code: "PI_PROJECT_BUSY",
        });
        (0, vitest_1.expect)(await service.rollbackDelete("s1", "token")).toBe(false);
        (0, vitest_1.expect)(await service.commitDelete("s1", "token")).toBe(false);
    });
    (0, vitest_1.it)("所有新状态写均使用 updateMany CAS", async () => {
        const { prisma, service, running } = setup();
        const run = await running();
        await service.waitForInput(run.jobId, run.runId);
        await service.resume(run.jobId, run.runId);
        await service.finishRun(run.jobId, run.runId);
        (0, vitest_1.expect)(prisma.job.update).not.toHaveBeenCalled();
        for (const call of prisma.job.updateMany.mock.calls) {
            const where = call[0].where;
            (0, vitest_1.expect)(where).toHaveProperty("id", "s1");
            (0, vitest_1.expect)(where).toHaveProperty("payload");
            (0, vitest_1.expect)(where).toHaveProperty("status");
        }
    });
});
(0, vitest_1.describe)("PiRunService generation reconcile", () => {
    (0, vitest_1.it)("未 ready 或旧 socket 的 operation 抛 PI_STATE_PENDING", async () => {
        const { service } = setup();
        await service.markReconcilePending("c1", "socket-1");
        await (0, vitest_1.expect)(service.withReconciledClient("c1", async (lease) => lease.socketId)).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
        await (0, vitest_1.expect)(service.withReconciledSocket("c1", "old", async () => 1)).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
    });
    (0, vitest_1.it)("operation lease 跨 await 时新 REGISTER 排队", async () => {
        const { service } = setup();
        await service.markReconcilePending("c1", "socket-1");
        await service.reconcileGeneration("c1", "socket-1", report([]));
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const operation = service.withReconciledClient("c1", async (lease) => {
            (0, vitest_1.expect)(lease.socketId).toBe("socket-1");
            await gate;
        });
        const pending = service.markReconcilePending("c1", "socket-2");
        await Promise.resolve();
        (0, vitest_1.expect)(await Promise.race([
            pending.then(() => "switched"),
            Promise.resolve("blocked"),
        ])).toBe("blocked");
        release();
        await operation;
        await pending;
        await (0, vitest_1.expect)(service.withReconciledClient("c1", async () => 1)).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
    });
    (0, vitest_1.it)("旧 generation reconcile/disconnect 在任何写入前退出", async () => {
        const { prisma, service, running, current } = setup();
        const run = await running();
        await service.markReconcilePending("c1", "new");
        prisma.job.updateMany.mockClear();
        await (0, vitest_1.expect)(service.reconcileGeneration("c1", "old", report([activeReport(run.runId)]))).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
        (0, vitest_1.expect)(await service.disconnectGeneration("c1", "old")).toBe(false);
        (0, vitest_1.expect)(prisma.job.updateMany).not.toHaveBeenCalled();
        (0, vitest_1.expect)(current().status).toBe("running");
    });
    (0, vitest_1.it)("markRunDisconnected 只 CAS matching active run", async () => {
        const { service, current, running } = setup();
        const run = await running();
        (0, vitest_1.expect)(await service.markRunDisconnected(run.jobId, "wrong")).toBe(false);
        (0, vitest_1.expect)(current().status).toBe("running");
        (0, vitest_1.expect)(await service.markRunDisconnected(run.jobId, run.runId)).toBe(true);
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "disconnected",
            payload: JSON.stringify({ runId: run.runId }),
        });
    });
    (0, vitest_1.it)("当前 generation 断线 CAS disconnected，matching report 恢复", async () => {
        const { service, running, current } = setup();
        const run = await running();
        await service.markReconcilePending("c1", "socket-1");
        await service.reconcileGeneration("c1", "socket-1", report([activeReport(run.runId)]));
        (0, vitest_1.expect)(await service.disconnectGeneration("c1", "socket-1")).toBe(true);
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "disconnected",
            payload: JSON.stringify({ runId: run.runId }),
        });
        await service.markReconcilePending("c1", "socket-2");
        const ack = await service.reconcileGeneration("c1", "socket-2", report([activeReport(run.runId, "waiting_input")]));
        (0, vitest_1.expect)(ack).toEqual({
            acceptedRunIds: [run.runId],
            closedRunIds: [],
            reportAgain: false,
        });
        (0, vitest_1.expect)(current().status).toBe("waiting_input");
    });
    (0, vitest_1.it)("matching idle/done summary 收敛 idle 并释放锁", async () => {
        for (const status of ["idle", "done"]) {
            const { service, running, current } = setup();
            const run = await running();
            await service.markReconcilePending("c1", "socket-1");
            const ack = await service.reconcileGeneration("c1", "socket-1", report([{ jobId: "s1", runId: run.runId, sessionId: "s1", status }]));
            (0, vitest_1.expect)(ack.acceptedRunIds).toEqual([run.runId]);
            (0, vitest_1.expect)(current()).toMatchObject({
                status: "idle",
                payload: "{}",
                progress: null,
            });
            (0, vitest_1.expect)(service.hasLock("s1", run.runId)).toBe(false);
        }
    });
    (0, vitest_1.it)("matching error summary 收敛安全 error 并释放锁", async () => {
        const { service, running, current } = setup();
        const run = await running();
        await service.markReconcilePending("c1", "socket-1");
        const ack = await service.reconcileGeneration("c1", "socket-1", report([
            { jobId: "s1", runId: run.runId, sessionId: "s1", status: "error" },
        ]));
        (0, vitest_1.expect)(ack.acceptedRunIds).toEqual([run.runId]);
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "error",
            payload: "{}",
            progress: null,
            errorCode: "PI_WORKER_EXITED",
            errorMessage: "Pi worker exited unexpectedly",
        });
        (0, vitest_1.expect)(service.hasLock("s1", run.runId)).toBe(false);
    });
    (0, vitest_1.it)("DB 活动 run 未上报时安全失败，终态旧 active 要求 Client close", async () => {
        const { service, running, current } = setup();
        const run = await running();
        await service.markReconcilePending("c1", "socket-1");
        await service.reconcileGeneration("c1", "socket-1", report([]));
        (0, vitest_1.expect)(current()).toMatchObject({
            status: "error",
            payload: "{}",
            errorCode: "PI_CLIENT_RESTARTED",
            errorMessage: "Client restarted before the Pi run could be recovered",
        });
        current().status = "done";
        current().payload = "{}";
        await service.markReconcilePending("c1", "socket-2");
        const ack = await service.reconcileGeneration("c1", "socket-2", report([activeReport(run.runId)]));
        (0, vitest_1.expect)(ack).toEqual({
            acceptedRunIds: [],
            closedRunIds: [run.runId],
            reportAgain: true,
        });
        await (0, vitest_1.expect)(service.withReconciledClient("c1", async () => 1)).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
    });
    (0, vitest_1.it)("同 projectKey 冲突 run 精确失败，Client abort 后二次报告 ready", async () => {
        const { prisma, service, running } = setup();
        const first = await running();
        await service.ensureSession(actor, { clientId: "c1", sessionId: "s2" });
        const second = await service.startRun(actor, {
            clientId: "c1",
            sessionId: "s2",
            projectKey: "k2",
        });
        await service.accept(second.jobId, second.runId);
        await service.markReconcilePending("c1", "socket-1");
        const ack = await service.reconcileGeneration("c1", "socket-1", report([
            {
                jobId: "s1",
                runId: first.runId,
                sessionId: "s1",
                status: "running",
                projectKey: "same",
            },
            {
                jobId: "s2",
                runId: second.runId,
                sessionId: "s2",
                status: "running",
                projectKey: "same",
            },
        ]));
        (0, vitest_1.expect)(ack).toEqual({
            acceptedRunIds: [],
            closedRunIds: [first.runId, second.runId],
            reportAgain: true,
        });
        for (const jobId of ["s1", "s2"]) {
            (0, vitest_1.expect)(prisma._jobs.find((job) => job.id === jobId)).toMatchObject({
                status: "error",
                payload: "{}",
                errorCode: "PI_PROTOCOL_INVALID",
                errorMessage: "Pi protocol input was invalid",
            });
        }
        (0, vitest_1.expect)(service.hasLock(first.jobId, first.runId)).toBe(false);
        (0, vitest_1.expect)(service.hasLock(second.jobId, second.runId)).toBe(false);
        (0, vitest_1.expect)(await service.reconcileGeneration("c1", "socket-1", report([]))).toEqual({
            acceptedRunIds: [],
            closedRunIds: [],
            reportAgain: false,
        });
        await (0, vitest_1.expect)(service.withReconciledClient("c1", async () => "ready")).resolves.toBe("ready");
    });
    (0, vitest_1.it)("跨 client 的 duplicate/done/error 报告不收敛他人 Job 或释放锁", async () => {
        for (const status of ["duplicate", "done", "error"]) {
            const { prisma, service } = setup();
            await service.ensureSession(actor, {
                clientId: "client-B",
                sessionId: "b-session",
            });
            const run = await service.startRun(actor, {
                clientId: "client-B",
                sessionId: "b-session",
                projectKey: "b-project",
            });
            await service.accept(run.jobId, run.runId);
            await service.markReconcilePending("client-A", "socket-A");
            const reportedRun = {
                jobId: run.jobId,
                runId: run.runId,
                sessionId: "b-session",
            };
            await service.reconcileGeneration("client-A", "socket-A", {
                clientId: "client-A",
                runs: status === "duplicate"
                    ? [
                        { ...reportedRun, status: "running", projectKey: "duplicate" },
                        {
                            ...reportedRun,
                            status: "waiting_input",
                            projectKey: "duplicate",
                        },
                    ]
                    : [{ ...reportedRun, status }],
            });
            (0, vitest_1.expect)(prisma._jobs.find((job) => job.id === run.jobId)).toMatchObject({
                clientId: "client-B",
                status: "running",
                payload: JSON.stringify({ runId: run.runId }),
            });
            (0, vitest_1.expect)(service.hasLock(run.jobId, run.runId)).toBe(true);
        }
    });
    (0, vitest_1.it)("reconcileOpen 根据 agent state 精确收敛", async () => {
        const { service, running, current } = setup();
        const run = await running();
        current().status = "waiting_input";
        (0, vitest_1.expect)(await service.reconcileOpen("s1", run.runId, {
            status: "running",
            streaming: false,
            prompting: false,
            compacting: false,
            thinkingLevel: "off",
            queuedMessages: { steering: [], followUp: [] },
        })).toBe(true);
        (0, vitest_1.expect)(current().status).toBe("running");
        (0, vitest_1.expect)(await service.reconcileOpen("s1", run.runId, {
            status: "idle",
            streaming: false,
            prompting: false,
            compacting: false,
            thinkingLevel: "off",
            queuedMessages: { steering: [], followUp: [] },
        })).toBe(true);
        (0, vitest_1.expect)(current().status).toBe("idle");
    });
    (0, vitest_1.it)("reconcileOpen 在 followUp 排队时不收敛 idle", async () => {
        const { service, running, current } = setup();
        const run = await running();
        (0, vitest_1.expect)(await service.reconcileOpen("s1", run.runId, {
            status: "idle",
            streaming: false,
            prompting: false,
            compacting: false,
            thinkingLevel: "off",
            queuedMessages: { steering: [], followUp: ["follow"] },
        })).toBe(true);
        (0, vitest_1.expect)(current().status).toBe("running");
        (0, vitest_1.expect)(current().payload).toBe(JSON.stringify({ runId: run.runId }));
    });
});
(0, vitest_1.describe)("PiRunService safe failures", () => {
    (0, vitest_1.it)("safePiErrorMessage 对全部 allowlist 有固定消息，未知 code 固定 fallback", async () => {
        for (const code of shared_1.PI_ERROR_CODES) {
            const { service, running, current } = setup();
            const run = await running();
            (0, vitest_1.expect)(await service.failSession(run.jobId, run.runId, code)).toBe(true);
            (0, vitest_1.expect)(current().errorMessage).toEqual(vitest_1.expect.any(String));
            (0, vitest_1.expect)(String(current().errorMessage).length).toBeGreaterThan(0);
        }
        const { service, running, current } = setup();
        const run = await running();
        await service.failSession(run.jobId, run.runId, "UNKNOWN");
        (0, vitest_1.expect)(current().errorMessage).toBe("Pi session failed");
    });
    (0, vitest_1.it)("原始错误 sentinel 永不写入 Job", async () => {
        const { service, running, prisma, current } = setup();
        const run = await running();
        await service.failSession(run.jobId, run.runId, "PI_CLIENT_RESTARTED");
        (0, vitest_1.expect)(JSON.stringify(prisma._jobs)).not.toContain("TOKEN=abc123");
        (0, vitest_1.expect)(current().errorMessage).toBe("Client restarted before the Pi run could be recovered");
    });
});
