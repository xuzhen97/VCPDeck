/**
 * TailnetService 单元测试（ADR-0062）。
 *
 * 只覆盖无数据库依赖的分支：拒绝顺序、摘要写入、状态投影。
 * 真实的 socket/Job/凭据联动见 tailnet.integration.test.ts。
 */
import { describe, expect, it, vi } from "vitest";
import type { TailnetSnapshot } from "@vcpdeck/shared";
import { TailnetService } from "./tailnet.service.js";

const SNAPSHOT: TailnetSnapshot = {
	installed: "yes",
	version: "1.104.5",
	service: "running",
	backend: "needs-login",
	nodeName: "node.example.ts.net",
	ipv4: ["100.64.0.1"],
	ipv6: [],
	observedAt: "2026-11-11T00:00:00.000Z",
	errorCode: null,
};

function makeService() {
	const findFirst = vi.fn();
	const findUnique = vi.fn();
	const updateMany = vi.fn();
	const issue = vi.fn();
	const prisma = {
		client: { findFirst, findUnique, updateMany },
	} as never;
	const keys = { issue } as never;
	return {
		service: new TailnetService(prisma, keys),
		findFirst,
		findUnique,
		updateMany,
		issue,
	};
}

describe("TailnetService.authorizeSecret 的拒绝顺序", () => {
	it("请求体不合法时直接拒绝，不查询 socket", async () => {
		const { service, findFirst, issue } = makeService();
		await expect(
			service.authorizeSecret("socket-1", { protocolVersion: 2 }),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });
		expect(findFirst).not.toHaveBeenCalled();
		expect(issue).not.toHaveBeenCalled();
	});

	it("socket 未映射或离线时拒绝", async () => {
		const { service, findFirst, issue } = makeService();
		findFirst.mockResolvedValue(null);
		await expect(
			service.authorizeSecret("socket-1", {
				protocolVersion: 1,
				jobId: "job-1",
				requestId: "req-1",
			}),
		).rejects.toMatchObject({ code: "TAILNET_OPERATION_MISMATCH" });
		expect(issue).not.toHaveBeenCalled();
	});
});

describe("TailnetService.recordSnapshot", () => {
	it("只写入严格解析后的摘要", async () => {
		const { service, updateMany } = makeService();
		updateMany.mockResolvedValue({ count: 1 });
		await service.recordSnapshot("client-1", SNAPSHOT);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: "client-1" },
			data: { tailnetSnapshot: JSON.stringify(SNAPSHOT) },
		});
	});

	it("夹带 Peer 的摘要被拒绝且不写库", async () => {
		const { service, updateMany } = makeService();
		await expect(
			service.recordSnapshot("client-1", {
				...SNAPSHOT,
				Peer: { private: { HostName: "must-not-upload" } },
			}),
		).rejects.toBeTruthy();
		expect(updateMany).not.toHaveBeenCalled();
	});
});

describe("TailnetService.getStatus", () => {
	it("机器不存在时返回稳定 404", async () => {
		const { service, findUnique } = makeService();
		findUnique.mockResolvedValue(null);
		await expect(service.getStatus("missing")).rejects.toMatchObject({
			code: "CLIENT_NOT_FOUND",
			statusCode: 404,
		});
	});

	it("旧 Client 未声明能力时 supported=false，但保留历史摘要", async () => {
		const { service, findUnique } = makeService();
		findUnique.mockResolvedValue({
			id: "client-1",
			online: false,
			capabilities: JSON.stringify(["exec"]),
			capabilityDetails: JSON.stringify({}),
			tailnetSnapshot: JSON.stringify(SNAPSHOT),
		});
		const status = await service.getStatus("client-1");
		expect(status.supported).toBe(false);
		expect(status.online).toBe(false);
		expect(status.snapshot).toEqual(SNAPSHOT);
	});

	it("存储的摘要损坏时不回传猜测值", async () => {
		const { service, findUnique } = makeService();
		findUnique.mockResolvedValue({
			id: "client-1",
			online: true,
			capabilities: JSON.stringify(["tailnet.manage"]),
			capabilityDetails: JSON.stringify({ tailnet: { protocolVersion: 1 } }),
			tailnetSnapshot: "{not-json",
		});
		const status = await service.getStatus("client-1");
		expect(status.supported).toBe(true);
		expect(status.snapshot).toBeNull();
	});
});
