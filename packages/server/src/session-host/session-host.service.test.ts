import type { SessionHostInstanceInfo, SessionHostStatusReport } from "@vcpdeck/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_HOST_AUDIT_EVENTS, SessionHostService } from "./session-host.service.js";

const NOW = new Date("2026-10-11T00:00:00.000Z");

interface Row {
	id: string;
	clientId: string;
	instanceId: string;
	hostId: string;
	kind: string;
	state: string;
	startedAt: Date;
	lastSeq: number;
	lastSeenAt: Date;
	endedAt: Date | null;
	endReason: string | null;
}

function row(over: Partial<Row> = {}): Row {
	return {
		id: "shi_seed",
		clientId: "c1",
		instanceId: "inst_1",
		hostId: "host-1",
		kind: "pi",
		state: "running",
		startedAt: new Date("2026-10-10T00:00:00.000Z"),
		lastSeq: 3,
		lastSeenAt: new Date("2026-10-10T00:00:00.000Z"),
		endedAt: null,
		endReason: null,
		...over,
	};
}

function info(over: Partial<SessionHostInstanceInfo> = {}): SessionHostInstanceInfo {
	return {
		instanceId: "inst_1",
		kind: "pi",
		state: "running",
		startedAt: "2026-10-10T00:00:00.000Z",
		lastSeq: 7,
		...over,
	};
}

function available(instances: SessionHostInstanceInfo[], hostId = "host-1"): SessionHostStatusReport {
	return { available: true, hostId, instances };
}

/** 内存 fake prisma：按 clientId 过滤，写入真实落库语义，避免用 vi.fn 手搓返回值。 */
function mockPrisma(seed: Row[] = []) {
	const rows: Row[] = seed.map((item) => ({ ...item }));
	const audits: Array<Record<string, unknown>> = [];
	const prisma = {
		rows,
		audits,
		sessionHostInstance: {
			findMany: vi.fn(async (args: { where?: { clientId?: string }; skip?: number; take?: number } = {}) => {
				const matched = rows.filter(
					(item) => args.where?.clientId === undefined || item.clientId === args.where.clientId,
				);
				const skip = args.skip ?? 0;
				const take = args.take ?? matched.length;
				return matched.slice(skip, skip + take).map((item) => ({ ...item }));
			}),
			count: vi.fn(async (args: { where?: { clientId?: string } } = {}) =>
				rows.filter((item) => args.where?.clientId === undefined || item.clientId === args.where.clientId).length,
			),
			create: vi.fn(async (args: { data: Row }) => {
				const created = { ...args.data };
				rows.push(created);
				return { ...created };
			}),
			update: vi.fn(async (args: { where: { id: string }; data: Partial<Row> }) => {
				const found = rows.find((item) => item.id === args.where.id);
				if (!found) throw new Error(`missing row ${args.where.id}`);
				Object.assign(found, args.data);
				return { ...found };
			}),
			delete: vi.fn(async () => {
				throw new Error("reconcile 不得删除实例行");
			}),
		},
		sessionHostAuditEvent: {
			create: vi.fn(async (args: { data: Record<string, unknown> }) => {
				audits.push(args.data);
				return { ...args.data };
			}),
		},
	};
	return prisma;
}

type MockPrisma = ReturnType<typeof mockPrisma>;

function serviceWith(prisma: MockPrisma): SessionHostService {
	let counter = 0;
	return SessionHostService.withDeps({
		prisma: prisma as never,
		now: () => NOW,
		createId: () => `shi_${++counter}`,
	});
}

let prisma: MockPrisma;
beforeEach(() => {
	prisma = mockPrisma();
});

describe("SessionHostService.reconcile：不可达不等于已退出", () => {
	it("宿主 available:false 时只落 unknown，绝不标 stopped，也不删行", async () => {
		prisma = mockPrisma([row()]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", { available: false, hostId: null, instances: [] });
		expect(result).toEqual({ unreachable: ["inst_1"], stopped: [] });
		expect(prisma.rows[0]?.state).toBe("unknown");
		expect(prisma.rows).toHaveLength(1);
		expect(prisma.sessionHostInstance.delete).not.toHaveBeenCalled();
	});

	it("已经是 unknown 时重复的不可达报告不写库也不写审计", async () => {
		prisma = mockPrisma([row({ state: "unknown" })]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", { available: false, hostId: null, instances: [] });
		expect(result.unreachable).toEqual(["inst_1"]);
		expect(prisma.sessionHostInstance.update).not.toHaveBeenCalled();
		expect(prisma.sessionHostAuditEvent.create).not.toHaveBeenCalled();
	});

	it("已确认停止的实例不会被「暂时不可达」降级成 unknown，也不再重复写审计", async () => {
		prisma = mockPrisma([row({ state: "stopped", endedAt: NOW, endReason: "host-reported-absent" })]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", { available: false, hostId: null, instances: [] });
		expect(result).toEqual({ unreachable: [], stopped: [] });
		expect(prisma.rows[0]?.state).toBe("stopped");
		expect(prisma.sessionHostInstance.update).not.toHaveBeenCalled();
		expect(prisma.sessionHostAuditEvent.create).not.toHaveBeenCalled();
	});

	it("宿主已更换（hostId 不同）时旧实例只能 unknown，不得当成已停止", async () => {
		prisma = mockPrisma([row({ hostId: "host-old" })]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", available([], "host-new"));
		expect(result).toEqual({ unreachable: ["inst_1"], stopped: [] });
		expect(prisma.rows[0]?.state).toBe("unknown");
		// 旧实例的宿主归属保持不变：不能改写成新宿主，也不能伪称已确认。
		expect(prisma.rows[0]?.hostId).toBe("host-old");
	});

	it("不可达报告不会为未知实例造行", async () => {
		prisma = mockPrisma([]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", { available: false, hostId: null, instances: [] });
		expect(result).toEqual({ unreachable: [], stopped: [] });
		expect(prisma.rows).toHaveLength(0);
		expect(prisma.sessionHostInstance.create).not.toHaveBeenCalled();
	});
});

describe("SessionHostService.reconcile：确认退出", () => {
	it("同一宿主明确不持有该实例时才标 stopped 并记结束时间", async () => {
		prisma = mockPrisma([row()]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", available([]));
		expect(result).toEqual({ unreachable: [], stopped: ["inst_1"] });
		expect(prisma.rows[0]?.state).toBe("stopped");
		expect(prisma.rows[0]?.endedAt).toEqual(NOW);
		expect(prisma.rows[0]?.endReason).toBe("host-reported-absent");
	});

	it("宿主自报 stopped 时计入 stopped 并落结束时间", async () => {
		prisma = mockPrisma([row()]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", available([info({ state: "stopped" })]));
		expect(result.stopped).toEqual(["inst_1"]);
		expect(prisma.rows[0]?.state).toBe("stopped");
		expect(prisma.rows[0]?.endedAt).toEqual(NOW);
	});

	it("宿主自报 failed 时不进入 stopped，也不覆盖为 unknown", async () => {
		prisma = mockPrisma([row()]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", available([info({ state: "failed" })]));
		expect(result).toEqual({ unreachable: [], stopped: [] });
		expect(prisma.rows[0]?.state).toBe("failed");
	});
});

describe("SessionHostService.reconcile：实例登记", () => {
	it("报告里的未知 instanceId 被登记而不是清理", async () => {
		prisma = mockPrisma([]);
		const service = serviceWith(prisma);
		await service.reconcile("c1", available([info()]));
		expect(prisma.rows).toHaveLength(1);
		expect(prisma.rows[0]?.instanceId).toBe("inst_1");
		expect(prisma.rows[0]?.clientId).toBe("c1");
		expect(prisma.rows[0]?.hostId).toBe("host-1");
		expect(prisma.sessionHostInstance.delete).not.toHaveBeenCalled();
	});

	it("已知实例按报告更新 state/lastSeq/lastSeenAt", async () => {
		prisma = mockPrisma([row({ lastSeq: 1, state: "running" })]);
		const service = serviceWith(prisma);
		await service.reconcile("c1", available([info({ lastSeq: 42, state: "running" })]));
		expect(prisma.rows[0]?.lastSeq).toBe(42);
		expect(prisma.rows[0]?.lastSeenAt).toEqual(NOW);
	});

	it("同一 instanceId 属于别的 Client 时不串账", async () => {
		prisma = mockPrisma([row({ id: "other", clientId: "c2" })]);
		const service = serviceWith(prisma);
		await service.reconcile("c1", available([info()]));
		expect(prisma.rows).toHaveLength(2);
		expect(prisma.rows.find((item) => item.id === "other")?.clientId).toBe("c2");
		expect(prisma.rows.find((item) => item.clientId === "c1")?.instanceId).toBe("inst_1");
	});

	it("空宿主无实例时既不清理也不新增", async () => {
		prisma = mockPrisma([row({ state: "stopped", endedAt: NOW })]);
		const service = serviceWith(prisma);
		const result = await service.reconcile("c1", available([]));
		// 同一宿主明确缺席：即使已经是 stopped，仍如实算作确认停止，但不重复写审计。
		expect(result).toEqual({ unreachable: [], stopped: ["inst_1"] });
		expect(prisma.sessionHostAuditEvent.create).not.toHaveBeenCalled();
	});
});

describe("SessionHostService：审计边界", () => {
	it("审计只写允许的生命周期事件", async () => {
		prisma = mockPrisma([row()]);
		const service = serviceWith(prisma);
		await service.reconcile("c1", { available: false, hostId: null, instances: [] });
		await service.reconcile("c1", available([info({ state: "failed" })]));
		expect(prisma.audits.length).toBeGreaterThan(0);
		for (const audit of prisma.audits) {
			expect(SESSION_HOST_AUDIT_EVENTS).toContain(audit.event as string);
		}
	});

	it("审计不携带工作目录、输出正文或令牌类字段", async () => {
		prisma = mockPrisma([row()]);
		const service = serviceWith(prisma);
		await service.reconcile("c1", available([info({ state: "failed" })]));
		const audit = prisma.audits[0] ?? {};
		expect(Object.keys(audit).sort()).toEqual(
			["actorName", "clientId", "createdAt", "event", "id", "identityId", "instanceId", "reason", "result", "source"].sort(),
		);
	});

	it("状态未变化的重复报告不写审计（避免每次上报刷爆审计表）", async () => {
		prisma = mockPrisma([row({ state: "running", lastSeq: 3 })]);
		const service = serviceWith(prisma);
		await service.reconcile("c1", available([info({ state: "running", lastSeq: 99 })]));
		expect(prisma.sessionHostAuditEvent.create).not.toHaveBeenCalled();
	});
});

describe("SessionHostService.list", () => {
	it("返回 PaginatedResult 并带上分页元数据", async () => {
		prisma = mockPrisma([row({ id: "a" }), row({ id: "b", instanceId: "inst_2" })]);
		const service = serviceWith(prisma);
		const page = await service.list({ clientId: "c1" }, 1, 1);
		expect(page.page).toBe(1);
		expect(page.pageSize).toBe(1);
		expect(page.total).toBe(2);
		expect(page.totalPages).toBe(2);
		expect(page.data).toHaveLength(1);
	});

	it("列表投影不包含路径或正文类字段", async () => {
		prisma = mockPrisma([row()]);
		const service = serviceWith(prisma);
		const page = await service.list({ clientId: "c1" }, 1, 20);
		expect(Object.keys(page.data[0] ?? {}).sort()).toEqual(
			["clientId", "endedAt", "endReason", "hostId", "instanceId", "kind", "lastSeenAt", "lastSeq", "startedAt", "state"].sort(),
		);
	});
});
