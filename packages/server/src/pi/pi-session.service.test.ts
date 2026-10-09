/**
 * PiSessionService / 独立 AgentRun CAS 的行为测试(ADR-0041 Task 3)。
 *
 * 单元部分使用 mock Prisma 面与既有 pi-run.service.test.ts 同构;
 * 另有一个真实临时 SQLite 用例验证 CAS 事务,不以 mock 单独证明。
 */
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@vcpdeck/shared";
import { PiSessionService } from "./pi-session.service.js";
import { PiRunService } from "./pi-run.service.js";

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
const input = { clientId: "c1", sessionId: "s1", projectKey: "k1" };

/** AgentSession/AgentRun/AgentAuditEvent 的最小 Prisma mock(事务可重入)。 */
function prismaMock() {
	const sessions: Array<Record<string, unknown>> = [];
	const runs: Array<Record<string, unknown>> = [];
	const audits: Array<Record<string, unknown>> = [];
	let inTransaction = false;

	function tx() {
		return {
			agentSession: {
				findUnique: async (args: { where: { id: string } }) =>
					sessions.find((s) => s.id === args.where.id) ?? null,
				updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
					let count = 0;
					for (const s of sessions) {
						if (Object.entries(args.where).every(([k, v]) => matches(s[k], v))) {
							Object.assign(s, args.data);
							count++;
						}
					}
					return { count };
				},
				update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
					const s = sessions.find((c) => c.id === args.where.id);
					if (!s) throw new Error("not found");
					Object.assign(s, args.data);
					return s;
				},
				create: async (args: { data: Record<string, unknown> }) => {
					if (sessions.some((s) => s.id === args.data.id)) throw { code: "P2002" };
					const created = {
						updatedAt: new Date(),
						...args.data,
					};
					sessions.push(created);
					return created;
				},
			},
			agentRun: {
				create: async (args: { data: Record<string, unknown> }) => {
					const created = { createdAt: new Date(), ...args.data };
					runs.push(created);
					return created;
				},
				findUnique: async (args: { where: { id: string } }) =>
					runs.find((r) => r.id === args.where.id) ?? null,
				updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
					let count = 0;
					for (const r of runs) {
						if (Object.entries(args.where).every(([k, v]) => matches(r[k], v))) {
							Object.assign(r, args.data);
							count++;
						}
					}
					return { count };
				},
			},
			agentAuditEvent: {
				create: async (args: { data: Record<string, unknown> }) => {
					// 真实 schema 有 @@unique([operationId,event,result]);mock 必须等价,
					// 否则"幂等不重复写审计"无法被证伪(SQLite 对 NULL 视为互不相同)。
					const d = args.data;
					if (
						d.operationId != null &&
						audits.some(
							(a) =>
								a.operationId === d.operationId &&
								a.event === d.event &&
								a.result === d.result,
						)
					) {
						throw { code: "P2002" };
					}
					audits.push({ createdAt: new Date(), ...d });
					return d;
				},
			},
			job: {
				create: vi.fn(),
				findUnique: vi.fn(),
				findMany: vi.fn(),
				updateMany: vi.fn(),
			},
		};
	}

	const prisma = {
		...tx(),
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
			if (inTransaction) return fn(prisma);
			inTransaction = true;
			const snapshot = structuredClone({ sessions, runs, audits });
			try {
				return await fn(tx());
			} catch (error) {
				sessions.length = 0; sessions.push(...snapshot.sessions);
				runs.length = 0; runs.push(...snapshot.runs);
				audits.length = 0; audits.push(...snapshot.audits);
				throw error;
			} finally {
				inTransaction = false;
			}
		},
		_sessions: sessions,
		_runs: runs,
		_audits: audits,
	};
	return prisma;
}

function matches(value: unknown, condition: unknown): boolean {
	// Prisma 语义:缺失的可空列视为 NULL;mock 必须等价,否则 CAS 条件永不命中。
	if (condition === null) return value === null || value === undefined;
	if (typeof condition === "object") {
		const c = condition as { in?: unknown[]; not?: unknown; notIn?: unknown[] };
		if (c.in) return c.in.includes(value);
		if (c.notIn) return !c.notIn.includes(value);
		if ("not" in c) return value !== c.not;
	}
	return value === condition;
}

function setup() {
	const prisma = prismaMock();
	const runtime = {
		assertReady: vi.fn(),
		effectiveExecutionMode: vi.fn(async () => "supervised" as const),
	};
	const sessions = new PiSessionService(prisma as never, runtime as never);
	const runs = new PiRunService(prisma as never, runtime as never);
	return {
		prisma,
		sessions,
		runs,
		session: () => prisma._sessions.find((s) => s.id === "s1")!,
		run: (id: string) => prisma._runs.find((r) => r.id === id),
	};
}

describe("PiSessionService 会话生命周期", () => {
	it("ensureSession 幂等创建可用会话并写 created 审计", async () => {
		const { sessions, prisma } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1" });
		expect(prisma._sessions).toHaveLength(1);
		expect(prisma._sessions[0]).toMatchObject({ id: "s1", status: "available", ownerIdentityId: "user-1" });
		const created = prisma._audits.filter((a) => a.event === "created");
		expect(created).toHaveLength(1);
	});

	it("owner 拒绝非 Owner 控制与 null Owner 抢占", async () => {
		const { sessions } = setup();
		// 无身份的会话创建者不被记录为 Owner,任何身份都不能据此控制。
		const anonymous = { ...actor, identityId: undefined } as unknown as ActorContext;
		await sessions.ensureSession(anonymous, { clientId: "c1", sessionId: "s1" });
		await expect(sessions.setArchived(otherActor, { clientId: "c1", sessionId: "s1", archived: true }))
			.rejects.toMatchObject({ code: "PI_CONTROL_FORBIDDEN" });
	});

	it("归档/恢复幂等且不重复写审计", async () => {
		const { sessions, prisma } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		await sessions.setArchived(actor, { clientId: "c1", sessionId: "s1", archived: true });
		await sessions.setArchived(actor, { clientId: "c1", sessionId: "s1", archived: true });
		expect(prisma._sessions[0].status).toBe("archived");
		const archived = prisma._audits.filter((a) => a.event === "archived");
		expect(archived).toHaveLength(1);
		await sessions.setArchived(actor, { clientId: "c1", sessionId: "s1", archived: false });
		expect(prisma._sessions[0].status).toBe("available");
		expect(prisma._audits.filter((a) => a.event === "restored")).toHaveLength(1);
	});

	it("执行模式变更写入前后值审计", async () => {
		const { sessions, prisma } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const changed = await sessions.setExecutionMode(actor, { ...input, mode: "automatic" });
		expect(changed.executionModeOverride).toBe("automatic");
		const audits = prisma._audits.filter((a) => a.event === "execution_mode_changed");
		expect(audits).toHaveLength(1);
	});

	it("删除预约与确认分别写 requested/ok 审计,并保留稳定 operationId", async () => {
		const { sessions, prisma } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const reservation = await sessions.beginDelete("s1", actor.identityId, { actor });
		const requested = prisma._audits.filter((a) => a.event === "deleted" && a.result === "requested");
		expect(requested).toHaveLength(1);
		expect(requested[0]).toMatchObject({
			sessionId: "s1",
			clientId: "c1",
			operationId: reservation.deleteToken,
			actorName: "User",
		});

		// 重复预约(结果不确定时的幂等重试)不得重复记账。
		const retry = await sessions.beginDelete("s1", actor.identityId, { actor });
		expect(retry.existingReservation).toBe(true);
		expect(
			prisma._audits.filter((a) => a.event === "deleted" && a.result === "requested"),
		).toHaveLength(1);

		await sessions.commitDelete("s1", reservation.deleteToken, { actor });
		const confirmed = prisma._audits.filter((a) => a.event === "deleted" && a.result === "ok");
		expect(confirmed).toHaveLength(1);
		expect(confirmed[0]).toMatchObject({
			clientId: "c1",
			operationId: reservation.deleteToken,
		});
		expect(prisma._sessions[0]).toMatchObject({ status: "deleted", deleteToken: null });
	});

	it("删除明确失败时写 failed 并只保留安全错误码", async () => {
		const { sessions, prisma } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const reservation = await sessions.beginDelete("s1", actor.identityId, { actor });
		await sessions.rollbackDelete("s1", reservation.deleteToken, {
			actor,
			errorCode: "PI_PROJECT_BUSY",
		});
		const failed = prisma._audits.filter((a) => a.event === "deleted" && a.result === "failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			operationId: reservation.deleteToken,
			errorCode: "PI_PROJECT_BUSY",
		});
		// 回滚后会话仍可用:未确认删除不得宣称成功。
		expect(prisma._sessions[0]).toMatchObject({ status: "available", deleteToken: null });
		expect(prisma._audits.filter((a) => a.event === "deleted" && a.result === "ok")).toHaveLength(0);
	});

	it("快照暴露 activeRun 与 Owner,不使用 Job 生命周期", async () => {
		const { sessions } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const snapshot = await sessions.snapshot("s1", actor.identityId);
		expect(snapshot).toMatchObject({
			sessionId: "s1",
			status: "available",
			activeRun: null,
			isOwner: true,
		});
	});
});

describe("PiRunService 独立 Run CAS", () => {
	it("两轮自动结算,不写 Job,旧轮不结算新轮", async () => {
		const { sessions, runs, prisma } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const a = await runs.startRun(actor, { ...input, kind: "prompt" });
		expect(await runs.accept("s1", a.runId)).toBe(true);
		expect(await runs.settleRun("s1", a.runId, { status: "succeeded" })).toBe(true);
		const b = await runs.startRun(actor, { ...input, kind: "prompt" });
		// 旧 run 迟到失败不能结算新轮
		expect(await runs.settleRun("s1", a.runId, { status: "failed", errorCode: "PI_WORKER_EXITED" })).toBe(false);
		const snapshot = await sessions.snapshot("s1", actor.identityId);
		expect(snapshot.activeRun?.runId).toBe(b.runId);
		expect(prisma.job.create).not.toHaveBeenCalled();
	});

	it("同会话并发只允许一个 winner", async () => {
		const { sessions, runs } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const [a, b] = await Promise.allSettled([
			runs.startRun(actor, { ...input, kind: "prompt" }),
			runs.startRun(actor, { ...input, kind: "prompt" }),
		]);
		const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
		expect(fulfilled).toHaveLength(1);
	});

	it("失败一轮后会话仍可发起新 Run", async () => {
		const { sessions, runs } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const a = await runs.startRun(actor, { ...input, kind: "prompt" });
		await runs.accept("s1", a.runId);
		await runs.settleRun("s1", a.runId, { status: "failed", errorCode: "PI_WORKER_EXITED" });
		const b = await runs.startRun(actor, { ...input, kind: "prompt" });
		expect(b.runId).not.toBe(a.runId);
	});

	it("Run 记录只保存安全元数据,不落 payload/result/prompt", async () => {
		const { sessions, runs, prisma } = setup();
		await sessions.ensureSession(actor, { clientId: "c1", sessionId: "s1", event: "created" });
		const run = await runs.startRun(actor, { ...input, kind: "prompt" });
		await runs.accept("s1", run.runId);
		await runs.settleRun("s1", run.runId, { status: "succeeded" });
		const record = prisma._runs.find((r) => r.id === run.runId)!;
		for (const banned of ["payload", "result", "progress", "prompt", "cwd", "errorMessage"]) {
			expect(record).not.toHaveProperty(banned);
		}
		expect(record).toMatchObject({ status: "succeeded", kind: "prompt", sessionId: "s1" });
		expect(record.finishedAt).not.toBeNull();
	});
});