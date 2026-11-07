import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerDrain } from "./server-drain.js";

function mockPrisma() {
	return {
		job: {
			count: vi.fn(async () => 0),
			findMany: vi.fn(async () => [] as unknown[]),
		},
		agentRun: {
			count: vi.fn(async () => 0),
		},
	};
}

describe("ServerDrain", () => {
	let prisma: ReturnType<typeof mockPrisma>;
	let drain: ServerDrain;

	beforeEach(() => {
		vi.useFakeTimers();
		prisma = mockPrisma();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		drain = new ServerDrain(prisma as any, { pollIntervalMs: 1000 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("drain 开始时置闸门，等运行中 job 收敛到 0 后返回", async () => {
		prisma.job.count
			.mockResolvedValueOnce(2)
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(0);

		const phase = drain.drain(60_000);
		expect(drain.isDraining()).toBe(true);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(phase).resolves.toBeUndefined();

		// 只等 running：waiting_input 是等调用方补字节的业务等待，从未派发
		expect(prisma.job.count).toHaveBeenCalledWith({
			where: { status: "running" },
		});
	});

	it("超时时带上现场：Job id、类型、Client 与已运行时长", async () => {
		prisma.job.count.mockResolvedValue(1);
		prisma.job.findMany.mockResolvedValue([
			{
				id: "job-zombie",
				type: "exec",
				clientId: "client-1",
				startedAt: new Date(Date.now() - 90 * 60_000),
				createdAt: new Date(Date.now() - 91 * 60_000),
			},
		]);

		const phase = drain.drain(5000);
		const assertion = expect(phase).rejects.toThrow(
			/job-zombie\(exec@client-1, 已运行 90 分钟\)/,
		);
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
	});

	it("现场超过 5 条时只列前 5 条并标注「等」", async () => {
		prisma.job.count.mockResolvedValue(9);
		prisma.job.findMany.mockResolvedValue(
			Array.from({ length: 5 }, (_, index) => ({
				id: `job-${index}`,
				type: "exec",
				clientId: "client-1",
				startedAt: new Date(Date.now() - 60_000),
				createdAt: new Date(Date.now() - 60_000),
			})),
		);

		const phase = drain.drain(5000);
		const assertion = expect(phase).rejects.toThrow(/job-4\(exec@client-1.*\) 等$/);
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
	});

	it("超时仍未收敛时抛错(含剩余数量)", async () => {
		prisma.job.count.mockResolvedValue(3);

		const phase = drain.drain(5000);
		const assertion = expect(phase).rejects.toThrow("仍有 3 个");
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
	});

	it("超时抛错后闸门自动解除，Job 派发恢复(回归:2026-10-07 生产死锁)", async () => {
		prisma.job.count.mockResolvedValue(3);

		const phase = drain.drain(5000);
		// 先挂 handler 再推定时器:否则 reject 发生在推进期间会被记为未处理拒绝。
		const assertion = expect(phase).rejects.toThrow("仍有 3 个");
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;

		// 编排器只 markFailed、进程继续存活；闸门若不解除，
		// tryDispatch 会永久拒绝派发，只有重启 Server 才能恢复。
		expect(drain.isDraining()).toBe(false);
	});

	it("意外异常(如 DB 查询失败)同样恢复闸门", async () => {
		prisma.job.count.mockRejectedValue(new Error("db down"));

		await expect(drain.drain(60_000)).rejects.toThrow("db down");
		expect(drain.isDraining()).toBe(false);
	});

	it("成功收敛后闸门保持(进程即将被 launcher 接管)", async () => {
		prisma.job.count.mockResolvedValue(0);

		await drain.drain(60_000);
		expect(drain.isDraining()).toBe(true);
	});

	it("连续 drain 以先到者为准，闸门保持", async () => {
		prisma.job.count.mockResolvedValue(0);

		await drain.drain(60_000);
		expect(drain.isDraining()).toBe(true);
	});
});

describe("ServerDrain 与 Agent Run(ADR-0041)", () => {
	let prisma: ReturnType<typeof mockPrisma>;
	let drain: ServerDrain;

	beforeEach(() => {
		vi.useFakeTimers();
		prisma = mockPrisma();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		drain = new ServerDrain(prisma as any, { pollIntervalMs: 1000 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("Agent Run 未收敛时 drain 继续等待", async () => {
		prisma.job.count.mockResolvedValue(0);
		prisma.agentRun.count
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(0);
		const phase = drain.drain(60_000);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(phase).resolves.toBeUndefined();
		// disconnected 的 Agent Run 不会自行收敛，由对账收尾，不该阻塞发布
		expect(prisma.agentRun.count).toHaveBeenCalledWith({
			where: { status: { in: ["pending", "running", "waiting_input"] } },
		});
	});

	it("活跃 Agent 回合超时同样解除闸门(不制造永久降级)", async () => {
		prisma.job.count.mockResolvedValue(0);
		prisma.agentRun.count.mockResolvedValue(1);
		const phase = drain.drain(5000);
		const assertion = expect(phase).rejects.toThrow("仍有 1 个");
		await vi.advanceTimersByTimeAsync(6000);
		await assertion;
		expect(drain.isDraining()).toBe(false);
	});
});
