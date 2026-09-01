import { describe, expect, it, vi } from "vitest";
import { FrpReconciliationService } from "./frp-reconciliation.service.js";

/** 测试用 FRPS 实例（getById 返回）。 */
const instance = {
	id: "frps_1",
	serverAddr: "frps.example.com",
	serverPort: 7000,
	authToken: "frps-token",
};

interface MappingRow {
	id: string;
	clientId: string;
	frpsInstanceId: string | null;
	name: string;
	proxyType: string;
	localIp: string;
	localPort: number;
	remotePort: number | null;
	customDomain: string | null;
	status: string;
	errorCode: string | null;
	errorMessage: string | null;
}

function mappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
	return {
		id: "fm_1",
		clientId: "c1",
		frpsInstanceId: "frps_1",
		name: "tcp-1919",
		proxyType: "tcp",
		localIp: "127.0.0.1",
		localPort: 1919,
		remotePort: 20000,
		customDomain: null,
		status: "inactive",
		errorCode: null,
		errorMessage: null,
		...overrides,
	};
}

function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		mappingId: "fm_1",
		name: "tcp-1919",
		proxyType: "tcp",
		localIp: "127.0.0.1",
		localPort: 1919,
		remotePort: 20000,
		customDomain: null,
		...overrides,
	};
}

function stateReport(overrides: Record<string, unknown> = {}) {
	return {
		clientId: "c1",
		connectionGeneration: "conn-1",
		runtimeGeneration: 0,
		status: "stopped",
		processRunning: false,
		recoveryOwner: null,
		attempt: 0,
		frpsEndpoint: { serverAddr: "frps.example.com", serverPort: 7000 },
		mappings: [] as unknown[],
		...overrides,
	};
}

function dashboardWith(...proxies: Array<{ proxyType: string; name: string; remotePort?: number | null; status?: "online" | "offline" }>) {
	return {
		total: proxies.length,
		byType: { tcp: 0, http: 0, https: 0 },
		// 默认 online（FRPS 已建立隧道）；需要残留条目时传 status: "offline"。
		list: proxies.map((p) => ({ status: "online", remotePort: null, ...p })),
		usedPorts: proxies
			.filter((p) => (p.status ?? "online") === "online")
			.map((p) => p.remotePort)
			.filter((p): p is number => typeof p === "number"),
	};
}

function localResult(loadedIds: string[], connectionGeneration = "conn-1", runtimeGeneration = 1) {
	return {
		connectionGeneration,
		runtimeGeneration,
		status: "running",
		loadedMappingIds: loadedIds,
	};
}

interface TimerEntry {
	delay: number;
	run: () => Promise<void>;
}

function setup() {
	const jobs = new Map<string, Record<string, unknown>>();
	const prisma = {
		client: {
			findUnique: vi.fn().mockResolvedValue({
				id: "c1",
				capabilityDetails: JSON.stringify({
					frp: { available: true, reconcileProtocolVersion: 1 },
				}),
			}),
		},
		frpMapping: {
			findMany: vi.fn().mockResolvedValue([] as MappingRow[]),
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			update: vi.fn().mockResolvedValue({}),
			create: vi.fn(),
		},
		job: {
			create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
				jobs.set(data.id as string, { ...data });
				return { ...data };
			}),
			findUnique: vi
				.fn()
				.mockImplementation(async ({ where }: { where: { id: string } }) =>
					jobs.get(where.id) ?? null,
				),
			update: vi
				.fn()
				.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
					const row = jobs.get(where.id);
					if (row) Object.assign(row, data);
					return row ?? null;
				}),
		},
	};
	const instances = {
		getById: vi.fn().mockResolvedValue(instance),
		listDashboardProxies: vi.fn().mockResolvedValue(dashboardWith()),
	};
	const timers: TimerEntry[] = [];
	const service = new FrpReconciliationService(prisma as never, instances as never, {
		schedule: (delay, run) => {
			timers.push({ delay, run: () => Promise.resolve(run()) });
		},
		log: vi.fn(),
	});
	const dispatcher = vi.fn();
	service.bindDispatcher(dispatcher);
	return { service, prisma, instances, timers, dispatcher, jobs };
}

describe("FrpReconciliationService 三方比较", () => {
	it("三方一致时保持 active 且不重启 frpc", async () => {
		const { service, prisma, instances, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", status: "active" }),
		]);
		instances.listDashboardProxies.mockResolvedValue(
			dashboardWith({ proxyType: "tcp", name: "tcp-1919", remotePort: 20000 }),
		);

		const ack = await service.handleState(
			"c1",
			"socket-1",
			stateReport({ status: "running", processRunning: true, mappings: [snapshot()] }),
		);

		expect(ack).toMatchObject({ accepted: true, action: "none" });
		expect(dispatcher).not.toHaveBeenCalled();
		expect(prisma.frpMapping.updateMany).not.toHaveBeenCalled();
	});

	it("只选择 inactive；error/deleting/provisioning 不进入 payload", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_inactive", name: "tcp-1919" }),
			mappingRow({ id: "fm_error", status: "error" }),
			mappingRow({ id: "fm_deleting", status: "deleting" }),
			mappingRow({ id: "fm_provisioning", status: "provisioning" }),
		]);

		const ack = await service.handleState("c1", "socket-1", stateReport());

		expect(ack).toMatchObject({ accepted: true, action: "server-reconciling" });
		expect(service.isBusy("c1")).toBe(true);
		expect(dispatcher).toHaveBeenCalledTimes(1);
		const [socketId, dispatch] = dispatcher.mock.calls[0];
		expect(socketId).toBe("socket-1");
		expect(dispatch).toMatchObject({
			clientId: "c1",
			type: "frp.reconcile",
			payload: expect.objectContaining({
				attempt: 0,
				mappings: [expect.objectContaining({ mappingId: "fm_inactive" })],
			}),
		});
		// 目标仅 inactive 一条；排除状态不进入 payload
		expect((dispatch.payload as { mappings: unknown[] }).mappings).toHaveLength(1);
		// system Job 审计字段
		expect(prisma.job.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: "frp.reconcile",
					status: "running",
					createdVia: "system:frp-reconcile",
					createdByIdentityId: null,
					createdByName: null,
				}),
			}),
		);
		// 目标被标记 reconciling 并指向该 Job
		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_inactive"] } },
				data: expect.objectContaining({
					status: "reconciling",
					operationJobId: dispatch.jobId,
				}),
			}),
		);
	});

	it("active 不一致先降为 inactive 再进入 reconciling", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", status: "active" }),
		]);
		// Dashboard 无此 proxy → active 不一致

		const ack = await service.handleState(
			"c1",
			"socket-1",
			stateReport({ status: "running", processRunning: true, mappings: [snapshot()] }),
		);

		expect(ack).toMatchObject({ action: "server-reconciling" });
		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1"] } },
				data: expect.objectContaining({ status: "inactive" }),
			}),
		);
		expect(dispatcher).toHaveBeenCalledTimes(1);
	});

	it("同一 Client 多个 FRPS 实例时本轮失败关闭", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_a", frpsInstanceId: "frps_1" }),
			mappingRow({ id: "fm_b", frpsInstanceId: "frps_2" }),
		]);

		const ack = await service.handleState("c1", "socket-1", stateReport());

		expect(ack).toMatchObject({ accepted: true, action: "none" });
		expect(dispatcher).not.toHaveBeenCalled();
		expect(prisma.frpMapping.updateMany).not.toHaveBeenCalled();
	});

	it("Client 本地 orphan 快照保留为 preservedMappings，不导入也不删除", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);

		const ack = await service.handleState(
			"c1",
			"socket-1",
			stateReport({
				mappings: [
					snapshot({ mappingId: "fm_orphan", name: "orphan-9999", localPort: 9999, remotePort: null }),
				],
			}),
		);

		expect(ack).toMatchObject({ action: "server-reconciling" });
		const dispatch = dispatcher.mock.calls[0]![1];
		const payload = dispatch.payload as { mappings: { mappingId: string }[]; preservedMappings: { mappingId: string }[] };
		// orphan 只在 preservedMappings 中保留
		expect(payload.preservedMappings.map((m) => m.mappingId)).toEqual(["fm_orphan"]);
		expect(payload.mappings.map((m) => m.mappingId)).toEqual(["fm_1"]);
		// 不自动导入：不创建 DB 记录；不自动删除：无针对 orphan 的写
		expect(prisma.frpMapping.create).not.toHaveBeenCalled();
		expect(prisma.frpMapping.updateMany.mock.calls.every((call) => {
			const where = (call[0] as { where: { id?: { in: string[] } } }).where;
			return !where?.id?.in?.includes("fm_orphan");
		})).toBe(true);
	});

	it("orphan 与期望配置冲突时本轮 FRP_RUNTIME_STATE_INVALID 失败关闭", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", name: "tcp-1919", localPort: 1919, remotePort: 20000 }),
		]);
		// orphan 复用了期望条目的 name/port
		const ack = await service.handleState(
			"c1",
			"socket-1",
			stateReport({
				mappings: [
					snapshot({ mappingId: "fm_orphan", name: "tcp-1919", localPort: 1919, remotePort: 20000 }),
				],
			}),
		);

		expect(ack).toMatchObject({ accepted: true, action: "none" });
		expect(dispatcher).not.toHaveBeenCalled();
		expect(prisma.frpMapping.updateMany).not.toHaveBeenCalled();
	});

	it("Dashboard 未知 proxy 不自动导入 DB", async () => {
		const { service, prisma, instances, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);
		instances.listDashboardProxies.mockResolvedValue(
			dashboardWith(
				{ proxyType: "tcp", name: "stray-2222", remotePort: 22222 },
			),
		);

		await service.handleState("c1", "socket-1", stateReport());

		// 派发照常（orphan 只是不导入），但不为未知 proxy 建/改记录
		expect(dispatcher).toHaveBeenCalledTimes(1);
		expect(prisma.frpMapping.create).not.toHaveBeenCalled();
		expect(prisma.frpMapping.updateMany.mock.calls.every((call) => {
			const where = (call[0] as { where: { id?: { in: string[] } } }).where;
			return !where?.id?.in?.includes("fm_stray");
		})).toBe(true);
	});
});

describe("FrpReconciliationService reconcile 结果与重试槽位", () => {
	async function beginTwoMappingReconcile(service: FrpReconciliationService, prisma: ReturnType<typeof setup>["prisma"]) {
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", name: "tcp-one", remotePort: 20001 }),
			mappingRow({ id: "fm_2", name: "tcp-two", remotePort: 20002 }),
		]);
		await service.handleState("c1", "socket-1", stateReport());
	}

	it("Dashboard 部分确认：确认者 active，其余耗尽 5s/30s 后回 inactive", async () => {
		const { service, prisma, instances, timers, dispatcher } = setup();
		await beginTwoMappingReconcile(service, prisma);
		const firstDispatch = dispatcher.mock.calls[0]![1];
		const jobId = firstDispatch.jobId;

		// Client 本地 running，但 Dashboard 只确认了 tcp-one
		instances.listDashboardProxies.mockResolvedValue(
			dashboardWith({ proxyType: "tcp", name: "tcp-one", remotePort: 20001 }),
		);
		await service.handleLocalResult(jobId, localResult(["fm_1", "fm_2"], "conn-1", 1));

		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1"] } },
				data: expect.objectContaining({ status: "active" }),
			}),
		);
		// 未确认目标仍在周期内：5s/30s 槽位已排定
		expect(timers.map((timer) => timer.delay)).toContain(5_000);

		await timers.find((timer) => timer.delay === 5_000)!.run();
		await timers.find((timer) => timer.delay === 30_000)!.run();

		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_2"] } },
				data: expect.objectContaining({ status: "inactive", errorCode: "FRP_RECONCILE_FAILED" }),
			}),
		);
		// 耗尽后周期结束，不再 busy
		expect(service.isBusy("c1")).toBe(false);
	});

	it("全部确认后立即结束周期，不再排定失败", async () => {
		const { service, prisma, instances, timers, dispatcher } = setup();
		await beginTwoMappingReconcile(service, prisma);
		const jobId = dispatcher.mock.calls[0]![1].jobId;
		instances.listDashboardProxies.mockResolvedValue(
			dashboardWith(
				{ proxyType: "tcp", name: "tcp-one", remotePort: 20001 },
				{ proxyType: "tcp", name: "tcp-two", remotePort: 20002 },
			),
		);
		await service.handleLocalResult(jobId, localResult(["fm_1", "fm_2"], "conn-1", 1));

		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1", "fm_2"] } },
				data: expect.objectContaining({ status: "active" }),
			}),
		);
		expect(service.isBusy("c1")).toBe(false);
		// 槽位触发时周期已结束：不应再产生写
		const writesBefore = prisma.frpMapping.updateMany.mock.calls.length;
		await timers.find((timer) => timer.delay === 5_000)!.run();
		expect(prisma.frpMapping.updateMany.mock.calls.length).toBe(writesBefore);
	});

	it("旧 socket 的旧 job 结果不覆盖新 generation 周期", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", status: "inactive" }),
		]);
		await service.handleState("c1", "socket-old", stateReport({ connectionGeneration: "conn-old" }));
		const oldJobId = dispatcher.mock.calls[0]![1].jobId;
		// 新连接接管：取消旧周期，开启新周期
		await service.handleState("c1", "socket-new", stateReport({ connectionGeneration: "conn-new" }));
		expect(service.isBusy("c1")).toBe(true);

		await service.handleLocalResult(oldJobId, localResult(["fm_1"], "conn-old", 1));

		// 旧 Job 的结果不产生任何 active 写
		expect(prisma.frpMapping.updateMany.mock.calls.every((call) => {
			const data = call[0]?.data as { status?: string };
			return data?.status !== "active";
		})).toBe(true);
	});

	it("Client 本地失败结果交给重试槽位，最终耗尽回 inactive", async () => {
		const { service, prisma, timers, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);
		await service.handleState("c1", "socket-1", stateReport());
		const jobId = dispatcher.mock.calls[0]![1].jobId;

		await service.handleLocalResult(
			jobId,
			{ ...localResult([], "conn-1", 1), status: "failed" },
		);
		// 本地失败：Job 结算为 error，映射保持 reconciling
		const job = dispatcher.mock.calls[0]![1];
		await timers.find((timer) => timer.delay === 5_000)!.run();
		await timers.find((timer) => timer.delay === 30_000)!.run();
		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1"] } },
				data: expect.objectContaining({ status: "inactive", errorCode: "FRP_RECONCILE_FAILED" }),
			}),
		);
		expect(job.jobId).toBeTruthy();
	});

	it("Job 本地错误码走 handleLocalFailure，结算后由槽位决定耗尽", async () => {
		const { service, prisma, timers, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);
		await service.handleState("c1", "socket-1", stateReport());
		const jobId = dispatcher.mock.calls[0]![1].jobId;

		await service.handleLocalFailure(jobId, "FRPC_START_FAILED");

		await timers.find((timer) => timer.delay === 5_000)!.run();
		await timers.find((timer) => timer.delay === 30_000)!.run();
		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1"] } },
				data: expect.objectContaining({ status: "inactive", errorCode: "FRP_RECONCILE_FAILED" }),
			}),
		);
	});
});

describe("FrpReconciliationService Client-owned 重试", () => {
	it("retrying 上报只标 reconciling 并确认 Dashboard，不下发 Server retry", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", status: "inactive" }),
		]);

		const ack = await service.handleState(
			"c1",
			"socket-1",
			stateReport({ status: "retrying", recoveryOwner: "client", attempt: 1, mappings: [snapshot()] }),
		);

		expect(ack).toMatchObject({ accepted: true, action: "client-retrying" });
		expect(service.isBusy("c1")).toBe(true);
		expect(dispatcher).not.toHaveBeenCalled();
		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1"] } },
				data: expect.objectContaining({ status: "reconciling" }),
			}),
		);
	});

	it("Client-owned 周期：running 且 Dashboard 确认后 active，failed 回 inactive", async () => {
		const { service, prisma, instances } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", status: "inactive" }),
		]);
		instances.listDashboardProxies.mockResolvedValue(
			dashboardWith({ proxyType: "tcp", name: "tcp-1919", remotePort: 20000 }),
		);
		const retryReport = stateReport({
			status: "retrying",
			recoveryOwner: "client",
			attempt: 1,
			mappings: [snapshot()],
		});
		await service.handleState("c1", "socket-1", retryReport);

		// 最终 running 上报：Dashboard 确认 → active，周期结束
		await service.handleState(
			"c1",
			"socket-1",
			stateReport({ status: "running", processRunning: true, recoveryOwner: null, attempt: 1, mappings: [snapshot()] }),
		);

		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1"] } },
				data: expect.objectContaining({ status: "active" }),
			}),
		);
		expect(service.isBusy("c1")).toBe(false);
	});

	it("Client-owned 周期：failed 终局回 inactive + FRP_RECONCILE_FAILED", async () => {
		const { service, prisma, instances } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", status: "inactive" }),
		]);
		instances.listDashboardProxies.mockResolvedValue(dashboardWith());
		const retryReport = stateReport({
			status: "retrying",
			recoveryOwner: "client",
			attempt: 1,
			mappings: [snapshot()],
		});
		await service.handleState("c1", "socket-1", retryReport);

		await service.handleState(
			"c1",
			"socket-1",
			stateReport({ status: "failed", recoveryOwner: "client", attempt: 2, mappings: [snapshot()] }),
		);

		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["fm_1"] } },
				data: expect.objectContaining({ status: "inactive", errorCode: "FRP_RECONCILE_FAILED" }),
			}),
		);
		expect(service.isBusy("c1")).toBe(false);
	});

	it("Client-owned 周期期间 stopped 上报不触发 Server 派发", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([
			mappingRow({ id: "fm_1", status: "inactive" }),
		]);
		await service.handleState(
			"c1",
			"socket-1",
			stateReport({ status: "retrying", recoveryOwner: "client", attempt: 1, mappings: [snapshot()] }),
		);

		const ack = await service.handleState("c1", "socket-1", stateReport());

		expect(ack).toMatchObject({ accepted: true, action: "none" });
		expect(dispatcher).not.toHaveBeenCalled();
		expect(service.isBusy("c1")).toBe(true);
	});
});

describe("FrpReconciliationService 生命周期与守卫", () => {
	it("无 v1 reconcile capability 的 Client 不进入新流程", async () => {
		const { service, prisma, dispatcher } = setup();
		prisma.client.findUnique.mockResolvedValue({
			id: "c1",
			capabilityDetails: JSON.stringify({
				frp: { available: true, reconcileProtocolVersion: 2 },
			}),
		});
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);

		const ack = await service.handleState("c1", "socket-1", stateReport());

		expect(ack).toMatchObject({ accepted: true, action: "none" });
		expect(dispatcher).not.toHaveBeenCalled();
		expect(service.isBusy("c1")).toBe(false);
	});

	it("无效 report 被拒绝为 stale ack，不派发", async () => {
		const { service, dispatcher } = setup();
		const ack = await service.handleState(
			"c1",
			"socket-1",
			{ ...stateReport(), authToken: "secret" },
		);
		expect(ack).toMatchObject({ accepted: false, action: "stale" });
		expect(dispatcher).not.toHaveBeenCalled();
	});

	it("clientId 不匹配的 report 被拒绝", async () => {
		const { service, dispatcher } = setup();
		const ack = await service.handleState(
			"c1",
			"socket-1",
			stateReport({ clientId: "c2" }),
		);
		expect(ack).toMatchObject({ accepted: false, action: "stale" });
		expect(dispatcher).not.toHaveBeenCalled();
	});

	it("recoverInterrupted 只把 reconciling 映射回到 inactive", async () => {
		const { service, prisma } = setup();
		await service.recoverInterrupted();
		expect(prisma.frpMapping.updateMany).toHaveBeenCalledWith({
			where: { status: "reconciling" },
			data: expect.objectContaining({ status: "inactive", operationJobId: null }),
		});
	});

	it("busy 期间 assertWritable 抛 FRP_RECONCILE_BUSY/409；周期结束后放行", async () => {
		const { service, prisma, timers } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);
		await service.handleState("c1", "socket-1", stateReport());

		expect(() => service.assertWritable("c1")).toThrowError(
			expect.objectContaining({ code: "FRP_RECONCILE_BUSY", statusCode: 409 }),
		);
		// 耗尽周期后恢复可写
		await timers.find((timer) => timer.delay === 5_000)!.run();
		await timers.find((timer) => timer.delay === 30_000)!.run();
		expect(service.isBusy("c1")).toBe(false);
		expect(() => service.assertWritable("c1")).not.toThrow();
	});

	it("disconnect 只回收匹配 socket 的周期，取消 timer 后不再派发", async () => {
		const { service, prisma, timers, dispatcher } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);
		await service.handleState("c1", "socket-1", stateReport());
		expect(service.isBusy("c1")).toBe(true);

		// 其他 socket 的断开不影响本周期
		service.disconnect("c1", "socket-2");
		expect(service.isBusy("c1")).toBe(true);

		// 匹配 socket 断开：取消周期与 timer
		service.disconnect("c1", "socket-1");
		expect(service.isBusy("c1")).toBe(false);
		const dispatches = dispatcher.mock.calls.length;
		const writes = prisma.frpMapping.updateMany.mock.calls.length;
		await timers[0].run();
		await timers[1].run();
		expect(dispatcher.mock.calls.length).toBe(dispatches);
		expect(prisma.frpMapping.updateMany.mock.calls.length).toBe(writes);
	});

	it("onModuleDestroy 清空周期与 timer", () => {
		const { service, prisma } = setup();
		prisma.frpMapping.findMany.mockResolvedValue([mappingRow({ id: "fm_1" })]);
		// 同步触发 handleState 的同步部分即可建立周期（dispatch 异步）
		void service.handleState("c1", "socket-1", stateReport()).then(() => {
			service.onModuleDestroy();
			expect(service.isBusy("c1")).toBe(false);
		});
	});
});
