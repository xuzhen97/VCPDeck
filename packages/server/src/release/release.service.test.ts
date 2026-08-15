import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ReleaseClientState, ReleaseStatus } from "@vcpdeck/shared";
import { ReleaseService } from "./release.service.js";

function mockPrisma() {
	return {
		release: {
			findUnique: vi.fn(),
			findFirst: vi.fn(),
			findMany: vi.fn(),
			count: vi.fn(),
			create: vi.fn(),
			updateMany: vi.fn(),
			update: vi.fn(),
		},
	};
}

function dbRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "rel_1",
		version: "1.2.1",
		sha256: "abc",
		fileName: "vcpdeck-1.2.1.zip",
		size: 1024,
		status: "uploaded",
		clientStates: "{}",
		errorMessage: null,
		createdByName: null,
		createdVia: null,
		createdAt: new Date("2026-06-15T00:00:00Z"),
		updatedAt: new Date("2026-06-15T00:00:00Z"),
		...overrides,
	};
}

describe("ReleaseService", () => {
	let prisma: ReturnType<typeof mockPrisma>;
	let service: ReleaseService;

	beforeEach(() => {
		prisma = mockPrisma();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		service = new ReleaseService(prisma as any);
	});

	describe("create", () => {
		it("新版本创建成功，status 为 uploaded（含操作者）", async () => {
			prisma.release.findUnique.mockResolvedValue(null);
			prisma.release.create.mockResolvedValue(dbRow());

			const info = await service.create({
				version: "1.2.1",
				sha256: "abc",
				fileName: "vcpdeck-1.2.1.zip",
				size: 1024,
				createdByName: "Admin",
				createdVia: "web",
			});

			expect(info.status).toBe(ReleaseStatus.UPLOADED);
			expect(info.clientStates).toEqual({});
			expect(prisma.release.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					version: "1.2.1",
					sha256: "abc",
					status: "uploaded",
					createdByName: "Admin",
					createdVia: "web",
				}),
			});
		});

		it("版本重复抛出 RELEASE_DUPLICATE_VERSION", async () => {
			prisma.release.findUnique.mockResolvedValue(dbRow());

			await expect(
				service.create({
					version: "1.2.1",
					sha256: "abc",
					fileName: "vcpdeck-1.2.1.zip",
					size: 1024,
				}),
			).rejects.toMatchObject({ code: "RELEASE_DUPLICATE_VERSION" });
			expect(prisma.release.create).not.toHaveBeenCalled();
		});
	});

	describe("transitionStatus", () => {
		it("合法流转 uploaded → updating_server 成功", async () => {
			prisma.release.findUnique.mockResolvedValue(
				dbRow({ status: "uploaded" }),
			);
			prisma.release.updateMany.mockResolvedValue({ count: 1 });

			await expect(
				service.transitionStatus("1.2.1", ReleaseStatus.UPDATING_SERVER),
			).resolves.toBeUndefined();

			expect(prisma.release.updateMany).toHaveBeenCalledWith({
				where: { version: "1.2.1", status: "uploaded" },
				data: expect.objectContaining({ status: "updating_server" }),
			});
		});

		it("非法流转抛出 RELEASE_INVALID_TRANSITION", async () => {
			prisma.release.updateMany.mockResolvedValue({ count: 0 });
			prisma.release.findUnique.mockResolvedValue(dbRow({ status: "done" }));

			await expect(
				service.transitionStatus("1.2.1", ReleaseStatus.UPDATING_CLIENTS),
			).rejects.toMatchObject({ code: "RELEASE_INVALID_TRANSITION" });
		});

		it("release 不存在抛出 RELEASE_NOT_FOUND", async () => {
			prisma.release.updateMany.mockResolvedValue({ count: 0 });
			prisma.release.findUnique.mockResolvedValue(null);

			await expect(
				service.transitionStatus("9.9.9", ReleaseStatus.UPDATING_SERVER),
			).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });
		});
	});

	describe("markClientState", () => {
		it("合并写入条目（state+at），兼容旧格式并保留其他客户端", async () => {
			prisma.release.findUnique.mockResolvedValue(
				dbRow({ clientStates: '{"client_a":"pending"}' }),
			);
			prisma.release.update.mockResolvedValue(dbRow());

			const states = await service.markClientState(
				"1.2.1",
				"client_b",
				ReleaseClientState.UPDATING,
			);

			expect(states.client_a).toMatchObject({ state: "pending" });
			expect(states.client_b).toMatchObject({
				state: "updating",
				at: expect.any(String),
			});
			const written = (prisma.release.update.mock.calls[0]?.[0] as {
				data: { clientStates: string };
			}).data.clientStates;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(written) as Record<string, unknown>;
			} catch (e) {
				throw new Error(`clientStates 写入值非法 JSON: ${e instanceof Error ? e.message : String(e)}`);
			}
			expect(parsed.client_a).toMatchObject({ state: "pending" });
			expect(parsed.client_b).toMatchObject({
				state: "updating",
				at: expect.any(String),
			});
		});

		it("failed 状态带失败原因与时间落库", async () => {
			prisma.release.findUnique.mockResolvedValue(dbRow());
			prisma.release.update.mockResolvedValue(dbRow());

			const states = await service.markClientState(
				"1.2.1",
				"c1",
				ReleaseClientState.FAILED,
				"校验失败",
			);

			expect(states.c1).toMatchObject({
				state: "failed",
				reason: "校验失败",
				at: expect.any(String),
			});
		});
	});

	describe("list", () => {
		it("分页返回 data/total/totalPages", async () => {
			prisma.release.findMany.mockResolvedValue([dbRow()]);
			prisma.release.count.mockResolvedValue(1);

			const result = await service.list(1, 20);

			expect(result).toMatchObject({
				total: 1,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			});
			expect(result.data[0].version).toBe("1.2.1");
		});
	});

	describe("getActiveRelease", () => {
		it("返回 updating_server/updating_clients 状态的 release", async () => {
			prisma.release.findFirst.mockResolvedValue(
				dbRow({ status: "updating_server" }),
			);

			const active = await service.getActiveRelease();

			expect(active?.status).toBe(ReleaseStatus.UPDATING_SERVER);
			expect(prisma.release.findFirst).toHaveBeenCalledWith({
				where: { status: { in: ["updating_server", "updating_clients"] } },
				orderBy: { createdAt: "desc" },
			});
		});

		it("无活动 release 时返回 null", async () => {
			prisma.release.findFirst.mockResolvedValue(null);
			await expect(service.getActiveRelease()).resolves.toBeNull();
		});
	});

	describe("getLatestActiveTarget", () => {
		it("返回最近一条 updating_clients/done 状态的 release", async () => {
			prisma.release.findFirst.mockResolvedValue(
				dbRow({ status: "updating_clients" }),
			);

			const target = await service.getLatestActiveTarget();

			expect(target?.status).toBe(ReleaseStatus.UPDATING_CLIENTS);
			expect(prisma.release.findFirst).toHaveBeenCalledWith({
				where: { status: { in: ["updating_clients", "done"] } },
				orderBy: { createdAt: "desc" },
			});
		});

		it("无活动 release 时返回 null", async () => {
			prisma.release.findFirst.mockResolvedValue(null);
			await expect(service.getLatestActiveTarget()).resolves.toBeNull();
		});
	});

	describe("verifyZipSha256", () => {
		let dir: string;

		beforeEach(async () => {
			dir = await mkdtemp(join(tmpdir(), "release-test-"));
		});

		afterEach(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		it("文件哈希与期望值匹配返回 true", async () => {
			const file = join(dir, "a.zip");
			const content = Buffer.from("hello release");
			await writeFile(file, content);
			const expected = createHash("sha256").update(content).digest("hex");

			await expect(service.verifyZipSha256(file, expected)).resolves.toBe(true);
		});

		it("哈希不匹配返回 false", async () => {
			const file = join(dir, "a.zip");
			await writeFile(file, "hello release");

			await expect(service.verifyZipSha256(file, "deadbeef")).resolves.toBe(
				false,
			);
		});

		it("文件不存在返回 false", async () => {
			await expect(
				service.verifyZipSha256(join(dir, "missing.zip"), "deadbeef"),
			).resolves.toBe(false);
		});
	});
});
