/**
 * PiSessionService / PiRunService 行为测试(ADR-0041 Task 3)。
 *
 * 覆盖意图沿用旧 Session-Job 测试:Run CAS、旧轮隔离、settlement 隔离、
 * 删除预约、CAS 写、generation 对账与安全错误消息;改为独立实体语义。
 */
import { describe, expect, it, vi } from "vitest";
import { PI_ERROR_CODES, type ActorContext, type PiStateReport } from "@vcpdeck/shared";
import { PiRunService, safePiErrorMessage } from "./pi-run.service.js";
import { PiSessionService } from "./pi-session.service.js";

const actor: ActorContext = {
	identityId: "user-1",
	displayName: "User",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "req-1",
};
const otherActor = { ...actor, identityId: "user-2", displayName: "Other" };
const input = { clientId: "c1", sessionId: "s1", projectKey: "k1", kind: "prompt" as const };

interface Db {
	sessions: Array<Record<string, any>>;
	runs: Array<Record<string, any>>;
	audits: Array<Record<string, any>>;
}

function makePrisma() {
	const db: Db = { sessions: [], runs: [], audits: [] };
	let transactionDepth = 0;

	function scoped() {
		return {
			agentSession: {
				findUnique: async (args: { where: { id: string } }) =>
					db.sessions.find((s) => s.id === args.where.id) ?? null,
				create: async (args: { data: Record<string, any> }) => {
					if (db.sessions.some((s) => s.id === args.data.id)) throw { code: "P2002" };
					const row = { activeRunId: null, executionModeNeedsConfirmation: false, ...args.data };
					db.sessions.push(row);
					return row;
				},
				updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
					let count = 0;
					for (const row of db.sessions) {
						if (matches(row, args.where)) { Object.assign(row, args.data); count++; }
					}
					return { count };
				}),
				update: vi.fn(async () => { throw new Error("snapshot.update is forbidden; use updateMany CAS"); }),
			},
			agentRun: {
				create: async (args: { data: Record<string, any> }) => {
					const row = { createdAt: new Date(), ...args.data };
					db.runs.push(row);
					return row;
				},
				findUnique: async (args: { where: { id: string } }) =>
					db.runs.find((r) => r.id === args.where.id) ?? null,
				findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
					db.runs.filter((r) => matches(r, args?.where ?? {}))),
				count: vi.fn(async (args: { where?: Record<string, unknown> }) =>
					db.runs.filter((r) => matches(r, args?.where ?? {})).length),
				updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
					let count = 0;
					for (const row of db.runs) {
						if (matches(row, args.where)) { Object.assign(row, args.data); count++; }
					}
					return { count };
				}),
				update: vi.fn(async () => { throw new Error("snapshot.update is forbidden; use updateMany CAS"); }),
			},
			agentAuditEvent: {
				create: async (args: { data: Record<string, any> }) => {
					const key = `${args.data.operationId}:${args.data.event}:${args.data.result}`;
					if (args.data.operationId !== null && args.data.operationId !== undefined
						&& db.audits.some((a) => `${a.operationId}:${a.event}:${a.result}` === key)) {
						throw { code: "P2002" };
					}
					db.audits.push({ createdAt: new Date(), ...args.data });
					return args.data;
				},
				findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
					db.audits.filter((a) => matches(a, args?.where ?? {}))),
				count: vi.fn(async (args: { where?: Record<string, unknown> }) =>
					db.audits.filter((a) => matches(a, args?.where ?? {})).length),
			},
		};
	}

	const prisma = {
		...scoped(),
		$transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
			if (transactionDepth > 0) return fn(scoped());
			transactionDepth++;
			const snapshot: Db = structuredClone(db);
			try {
				return await fn(scoped());
			} catch (error) {
				db.sessions = snapshot.sessions;
				db.runs = snapshot.runs;
				db.audits = snapshot.audits;
				throw error;
			} finally {
				transactionDepth--;
			}
		},
		_db: db,
	};
	return prisma;
}

function matches(row: Record<string, any>, where: Record<string, unknown>): boolean {
	for (const [key, condition] of Object.entries(where)) {
		const value = row[key];
		// Prisma 语义:缺失的可空列视为 NULL;mock 必须等价,否则 CAS 条件永不命中。
		if (condition === null) {
			if (value !== null && value !== undefined) return false;
			continue;
		}
		if (typeof condition === "object" && !Array.isArray(condition)) {
			const c = condition as { in?: unknown[]; not?: unknown };
			if (c.in) { if (!c.in.includes(value)) return false; continue; }
			if ("not" in c) { if (value === c.not) return false; continue; }
		}
		if (value !== condition) return false;
	}
	return true;
}

function setup() {
	const prisma = makePrisma();
	const runtime = {
		assertReady: vi.fn(),
		effectiveExecutionMode: vi.fn(async () => "supervised" as const),
	};
	const sessions = new PiSessionService(prisma as never, runtime as never);
	const runs = new PiRunService(prisma as never, runtime as never);
	const ensure = () => sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
	const start = async () => {
		await ensure();
		return runs.startRun(actor, input);
	};
	const running = async () => {
		const run = await start();
		expect(await runs.accept("s1", run.runId)).toBe(true);
		return run;
	};
	return {
		prisma,
		sessions,
		runs,
		ensure,
		start,
		running,
		runtime,
		session: () => prisma._db.sessions.find((s) => s.id === "s1")!,
		runRow: (id: string) => prisma._db.runs.find((r) => r.id === id),
	};
}

function report(runs: PiStateReport["runs"]): PiStateReport {
	return { clientId: "c1", runs, runtimeRevision: null, configState: "pending" };
}

function activeReport(runId: string, status: "running" | "waiting_input" = "running", projectKey = "k1") {
	return { runId, sessionId: "s1", status, projectKey } as const;
}

const idleState = {
	status: "idle" as const,
	streaming: false,
	prompting: false,
	compacting: false,
	thinkingLevel: "off" as const,
	queuedMessages: { steering: [], followUp: [] },
};

describe("PiRunService 独立 Run CAS", () => {
	it("每轮 startRun 生成新 runId 且不创建 Job", async () => {
		const { runs, start, session } = setup();
		const first = await start();
		expect(first.executionMode).toBe("supervised");
		await runs.settleRun("s1", first.runId, { status: "succeeded" });
		const second = await runs.startRun(actor, input);
		expect(second.runId).not.toBe(first.runId);
		expect(session().activeRunId).toBe(second.runId);
	});

	it("旧轮迟到失败不能结算新轮或释放新锁", async () => {
		const { runs, running, session } = setup();
		const first = await running();
		await runs.settleRun("s1", first.runId, { status: "succeeded" });
		const second = await runs.startRun(actor, input);
		expect(await runs.waitForInput("s1", first.runId)).toBe(false);
		expect(await runs.failRun("s1", first.runId, "PI_WORKER_EXITED")).toBe(false);
		expect(session().activeRunId).toBe(second.runId);
		expect(runs.hasLock("s1", second.runId)).toBe(true);
		expect(runs.hasLock("s1", first.runId)).toBe(false);
	});

	it("同会话并发只允许一个 winner", async () => {
		const { sessions, runs } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const results = await Promise.allSettled([
			runs.startRun(actor, input),
			runs.startRun(actor, input),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({
			reason: { code: "PI_PROJECT_BUSY" },
		});
	});

	it("完整状态矩阵:waiting_input/resume/settled 自动结算", async () => {
		const { runs, running, session, runRow } = setup();
		const run = await running();
		expect(await runs.waitForInput("s1", run.runId)).toBe(true);
		expect(runRow(run.runId)!.status).toBe("waiting_input");
		expect(await runs.resume("s1", run.runId)).toBe(true);
		expect(runRow(run.runId)!.status).toBe("running");
		expect(await runs.settleRun("s1", run.runId, { status: "succeeded" })).toBe(true);
		expect(runRow(run.runId)).toMatchObject({ status: "succeeded", errorCode: null });
		expect(runRow(run.runId)!.finishedAt).toBeInstanceOf(Date);
		expect(session().activeRunId).toBeNull();
	});

	it("提前到达的 Extension 不被 accept 覆盖", async () => {
		const { runs, start, runRow } = setup();
		const run = await start();
		expect(await runs.waitForInput("s1", run.runId)).toBe(true);
		expect(await runs.accept("s1", run.runId)).toBe(false);
		expect(runRow(run.runId)!.status).toBe("waiting_input");
	});

	it("失败一轮后会话仍可继续,失败保留安全错误码", async () => {
		const { runs, running, runRow } = setup();
		const first = await running();
		expect(await runs.failRun("s1", first.runId, "PI_WORKER_EXITED")).toBe(true);
		expect(runRow(first.runId)).toMatchObject({
			status: "failed",
			errorCode: "PI_WORKER_EXITED",
		});
		const second = await runs.startRun(actor, input);
		expect(second.runId).not.toBe(first.runId);
	});

	it("successful 结算不带 errorCode;failed 缺码时按 Worker 异常", async () => {
		const { runs, running, runRow } = setup();
		const a = await running();
		await runs.settleRun("s1", a.runId, { status: "succeeded" });
		expect(runRow(a.runId)!.errorCode).toBeNull();
		const b = await runs.startRun(actor, input);
		await runs.accept("s1", b.runId);
		await runs.settleRun("s1", b.runId, { status: "failed" });
		expect(runRow(b.runId)).toMatchObject({ status: "failed", errorCode: "PI_WORKER_EXITED" });
	});

	it("settlement timer 按 sessionId+runId 精确隔离", async () => {
		vi.useFakeTimers();
		try {
			const { runs, running } = setup();
			const first = await running();
			await runs.scheduleSettlement("s1", first.runId, vi.fn());
			await runs.settleRun("s1", first.runId, { status: "succeeded" });
			const second = await runs.startRun(actor, input);
			const onSecond = vi.fn();
			await runs.scheduleSettlement("s1", second.runId, onSecond);
			runs.cancelSettlement("s1", first.runId);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(onSecond).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("旧 settlement callback 在新 run 后不执行", async () => {
		vi.useFakeTimers();
		try {
			const { runs, running } = setup();
			const first = await running();
			const onFirst = vi.fn();
			await runs.scheduleSettlement("s1", first.runId, onFirst);
			await runs.settleRun("s1", first.runId, { status: "succeeded" });
			await runs.startRun(actor, input);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(onFirst).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("Run 记录只保存安全元数据", async () => {
		const { running, runRow } = setup();
		const run = await running();
		const row = runRow(run.runId)!;
		for (const banned of ["payload", "result", "progress", "prompt", "cwd", "errorMessage", "stderr"]) {
			expect(row).not.toHaveProperty(banned);
		}
		expect(row).toMatchObject({ sessionId: "s1", kind: "prompt", executionMode: "supervised" });
	});

	it("活动状态写全部走 updateMany CAS", async () => {
		const { prisma, runs, running } = setup();
		const run = await running();
		await runs.waitForInput("s1", run.runId);
		await runs.resume("s1", run.runId);
		await runs.settleRun("s1", run.runId, { status: "succeeded" });
		expect(prisma.agentRun.update).not.toHaveBeenCalled();
		expect(prisma.agentSession.update).not.toHaveBeenCalled();
		for (const call of prisma.agentRun.updateMany.mock.calls) {
			expect(call[0].where).toHaveProperty("id", run.runId);
			expect(call[0].where).toHaveProperty("sessionId", "s1");
			expect(call[0].where).toHaveProperty("status");
		}
		for (const call of prisma.agentSession.updateMany.mock.calls) {
			expect(call[0].where).toHaveProperty("id", "s1");
		}
	});
});

describe("PiSessionService 删除预约", () => {
	it("仅静态状态可预约,rollback/commit 按 token", async () => {
		const { sessions, ensure, session } = setup();
		await ensure();
		const reservation = await sessions.beginDelete("s1", actor.identityId);
		expect(reservation).toMatchObject({ previousStatus: "available", existingReservation: false });
		expect(session().deleteToken).toBe(reservation.deleteToken);
		expect(await sessions.rollbackDelete("s1", reservation.deleteToken)).toBe(true);
		expect(session().deleteToken).toBeNull();
		const next = await sessions.beginDelete("s1", actor.identityId);
		expect(await sessions.commitDelete("s1", next.deleteToken)).toBe(true);
		expect(session()).toMatchObject({ status: "deleted" });
		expect(session().deletedAt).toBeInstanceOf(Date);
	});

	it("删除预约阻塞新一轮 startRun", async () => {
		const { sessions, runs, ensure } = setup();
		await ensure();
		const reservation = await sessions.beginDelete("s1", actor.identityId);
		await expect(runs.startRun(actor, input)).rejects.toMatchObject({ code: "PI_PROJECT_BUSY" });
		expect(await sessions.commitDelete("s1", reservation.deleteToken)).toBe(true);
	});

	it("活动 Run 禁止删除;预约幂等且快照不泄露 token", async () => {
		const { sessions, runs, running } = setup();
		const run = await running();
		await expect(sessions.beginDelete("s1", actor.identityId)).rejects.toMatchObject({ code: "PI_PROJECT_BUSY" });
		await runs.settleRun("s1", run.runId, { status: "succeeded" });
		const first = await sessions.beginDelete("s1", actor.identityId);
		const second = await sessions.beginDelete("s1", actor.identityId);
		expect(second).toEqual({ ...first, existingReservation: true });
		expect(JSON.stringify(await sessions.snapshot("s1", actor.identityId))).not.toContain(first.deleteToken);
	});

	it("确认删除保留 Run 与审计,并写入 deleted 事件", async () => {
		const { sessions, runs, running, prisma } = setup();
		const run = await running();
		await runs.settleRun("s1", run.runId, { status: "succeeded" });
		const reservation = await sessions.beginDelete("s1", actor.identityId);
		await sessions.commitDelete("s1", reservation.deleteToken);
		expect(prisma._db.runs).toHaveLength(1);
		expect(prisma._db.audits.filter((a) => a.event === "created")).toHaveLength(1);
	});
});

describe("PiRunService generation reconcile", () => {
	it("未 ready 或旧 socket 的 operation 抛 PI_STATE_PENDING", async () => {
		const { runs } = setup();
		await runs.markReconcilePending("c1", "socket-1");
		await expect(runs.withReconciledClient("c1", async (lease) => lease.socketId))
			.rejects.toMatchObject({ code: "PI_STATE_PENDING" });
		await expect(runs.withReconciledSocket("c1", "old", async () => 1))
			.rejects.toMatchObject({ code: "PI_STATE_PENDING" });
	});

	it("operation lease 跨 await 时新 REGISTER 排队", async () => {
		const { runs } = setup();
		await runs.markReconcilePending("c1", "socket-1");
		await runs.reconcileGeneration("c1", "socket-1", report([]));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const operation = runs.withReconciledClient("c1", async (lease) => {
			expect(lease.socketId).toBe("socket-1");
			await gate;
		});
		const pending = runs.markReconcilePending("c1", "socket-2");
		await Promise.resolve();
		expect(await Promise.race([pending.then(() => "switched"), Promise.resolve("blocked")])).toBe("blocked");
		release();
		await operation;
		await pending;
		await expect(runs.withReconciledClient("c1", async () => 1)).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
	});

	it("旧 generation reconcile/disconnect 在任何写入前退出", async () => {
		const { prisma, runs, running, runRow } = setup();
		const run = await running();
		await runs.markReconcilePending("c1", "new");
		prisma.agentRun.updateMany.mockClear();
		await expect(runs.reconcileGeneration("c1", "old", report([activeReport(run.runId)])))
			.rejects.toMatchObject({ code: "PI_STATE_PENDING" });
		expect(await runs.disconnectGeneration("c1", "old")).toBe(false);
		expect(prisma.agentRun.updateMany).not.toHaveBeenCalled();
		expect(runRow(run.runId)!.status).toBe("running");
	});

	it("markRunDisconnected 只 CAS matching active run", async () => {
		const { runs, running, runRow } = setup();
		const run = await running();
		expect(await runs.markRunDisconnected("s1", "wrong")).toBe(false);
		expect(runRow(run.runId)!.status).toBe("running");
		expect(await runs.markRunDisconnected("s1", run.runId)).toBe(true);
		expect(runRow(run.runId)!.status).toBe("disconnected");
	});

	it("当前 generation 断线 CAS disconnected,matching report 恢复", async () => {
		const { runs, running, runRow } = setup();
		const run = await running();
		await runs.markReconcilePending("c1", "socket-1");
		await runs.reconcileGeneration("c1", "socket-1", report([activeReport(run.runId)]));
		expect(await runs.disconnectGeneration("c1", "socket-1")).toBe(true);
		expect(runRow(run.runId)!.status).toBe("disconnected");
		await runs.markReconcilePending("c1", "socket-2");
		const ack = await runs.reconcileGeneration("c1", "socket-2", report([activeReport(run.runId, "waiting_input")]));
		expect(ack).toEqual({ acceptedRunIds: [run.runId], closedRunIds: [], reportAgain: false });
		expect(runRow(run.runId)!.status).toBe("waiting_input");
	});

	it("matching succeeded/aborted 摘要收敛终态并释放锁", async () => {
		for (const status of ["succeeded", "aborted"] as const) {
			const { runs, running, runRow } = setup();
			const run = await running();
			await runs.markReconcilePending("c1", "socket-1");
			const ack = await runs.reconcileGeneration("c1", "socket-1", report([{ runId: run.runId, sessionId: "s1", status }]));
			expect(ack.acceptedRunIds).toEqual([run.runId]);
			expect(runRow(run.runId)!.status).toBe(status);
			expect(runs.hasLock("s1", run.runId)).toBe(false);
		}
	});

	it("matching failed 摘要收敛安全错误码并释放锁", async () => {
		const { runs, running, runRow } = setup();
		const run = await running();
		await runs.markReconcilePending("c1", "socket-1");
		const ack = await runs.reconcileGeneration("c1", "socket-1", report([
			{ runId: run.runId, sessionId: "s1", status: "failed", errorCode: "PI_WORKER_EXITED" },
		]));
		expect(ack.acceptedRunIds).toEqual([run.runId]);
		expect(runRow(run.runId)).toMatchObject({ status: "failed", errorCode: "PI_WORKER_EXITED" });
		expect(runs.hasLock("s1", run.runId)).toBe(false);
	});

	it("DB 活动 run 未上报时安全失败,终态旧 active 要求 Client close", async () => {
		const { runs, running, runRow } = setup();
		const run = await running();
		await runs.markReconcilePending("c1", "socket-1");
		await runs.reconcileGeneration("c1", "socket-1", report([]));
		expect(runRow(run.runId)).toMatchObject({ status: "failed", errorCode: "PI_CLIENT_RESTARTED" });
		// 已终态 Run 再次上报为 active:要求 Client close,不重新激活
		await runs.markReconcilePending("c1", "socket-2");
		const ack = await runs.reconcileGeneration("c1", "socket-2", report([activeReport(run.runId)]));
		expect(ack).toEqual({ acceptedRunIds: [], closedRunIds: [run.runId], reportAgain: true });
		await expect(runs.withReconciledClient("c1", async () => 1)).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
	});

	it("同 projectKey 冲突 run 精确失败,Client abort 后二次报告 ready", async () => {
		const { prisma, sessions, runs, running, runRow } = setup();
		const first = await running();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s2" });
		const second = await runs.startRun(actor, { clientId: "c1", sessionId: "s2", projectKey: "k2", kind: "prompt" });
		await runs.accept("s2", second.runId);
		await runs.markReconcilePending("c1", "socket-1");
		const ack = await runs.reconcileGeneration("c1", "socket-1", {
			clientId: "c1",
			runtimeRevision: null,
			configState: "pending",
			runs: [
				{ runId: first.runId, sessionId: "s1", status: "running", projectKey: "same" },
				{ runId: second.runId, sessionId: "s2", status: "running", projectKey: "same" },
			],
		});
		expect(ack).toEqual({ acceptedRunIds: [], closedRunIds: [first.runId, second.runId], reportAgain: true });
		for (const runId of [first.runId, second.runId]) {
			expect(runRow(runId)).toMatchObject({ status: "failed", errorCode: "PI_PROTOCOL_INVALID" });
		}
		expect(runs.hasLock("s1", first.runId)).toBe(false);
		expect(runs.hasLock("s2", second.runId)).toBe(false);
		expect(await runs.reconcileGeneration("c1", "socket-1", report([]))).toEqual({
			acceptedRunIds: [], closedRunIds: [], reportAgain: false,
		});
		await expect(runs.withReconciledClient("c1", async () => "ready")).resolves.toBe("ready");
		void prisma;
	});

	it("跨 client 的摘要不收敛他人 Run 或释放锁", async () => {
		const { sessions, runs, runRow } = setup();
		await sessions.ensureSession(actor, { clientId: "client-B", sessionId: "b-session" });
		const run = await runs.startRun(actor, { clientId: "client-B", sessionId: "b-session", projectKey: "b-project", kind: "prompt" });
		await runs.accept("b-session", run.runId);
		await runs.markReconcilePending("client-A", "socket-A");
		await runs.reconcileGeneration("client-A", "socket-A", {
			clientId: "client-A",
			runtimeRevision: null,
			configState: "pending",
			runs: [{ runId: run.runId, sessionId: "b-session", status: "succeeded" }],
		});
		expect(runRow(run.runId)!.status).toBe("running");
		expect(runs.hasLock("b-session", run.runId)).toBe(true);
	});

	it("reconcileOpen 按权威 agent state 精确收敛", async () => {
		const { runs, running, runRow } = setup();
		const run = await running();
		await runs.markRunDisconnected("s1", run.runId);
		expect(await runs.reconcileOpen("s1", run.runId, {
			...idleState, status: "running",
		})).toBe(true);
		expect(runRow(run.runId)!.status).toBe("running");
		expect(await runs.reconcileOpen("s1", run.runId, idleState)).toBe(true);
		expect(runRow(run.runId)!.status).toBe("succeeded");
	});

	it("reconcileOpen 在 followUp 排队时不收敛终态", async () => {
		const { runs, running, runRow } = setup();
		const run = await running();
		expect(await runs.reconcileOpen("s1", run.runId, {
			...idleState,
			queuedMessages: { steering: [], followUp: ["follow"] },
		})).toBe(true);
		expect(runRow(run.runId)!.status).toBe("running");
	});

	it("listActiveRuns/countActiveRuns 只统计非终态", async () => {
		const { runs, running } = setup();
		const run = await running();
		expect(await runs.countActiveRuns()).toBe(1);
		expect((await runs.listActiveRuns("c1"))[0]).toMatchObject({ id: run.runId, sessionId: "s1" });
		await runs.settleRun("s1", run.runId, { status: "succeeded" });
		expect(await runs.countActiveRuns()).toBe(0);
	});
});

describe("PiRunService safe failures", () => {
	it("safePiErrorMessage 对全部 allowlist 有固定安全消息", () => {
		for (const code of PI_ERROR_CODES) {
			const message = safePiErrorMessage(code);
			expect(typeof message).toBe("string");
			expect(message.length).toBeGreaterThan(0);
		}
		expect(safePiErrorMessage("UNKNOWN")).toBe("Pi session failed");
	});

	it("原始错误 sentinel 永不写入 Run", async () => {
		const { runs, running, prisma } = setup();
		const run = await running();
		await runs.failRun("s1", run.runId, "PI_CLIENT_RESTARTED");
		expect(JSON.stringify(prisma._db.runs)).not.toContain("TOKEN=abc123");
		expect(prisma._db.runs.find((r) => r.id === run.runId)!.errorCode).toBe("PI_CLIENT_RESTARTED");
	});

	it("未 ready 的 Runtime 使 startRun fail closed", async () => {
		const prisma = makePrisma();
		const runs = new PiRunService(prisma as never);
		const sessions = new PiSessionService(prisma as never);
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1" });
		await expect(runs.startRun(actor, input)).rejects.toMatchObject({ code: "PI_CONFIG_UNAVAILABLE" });
	});
});
