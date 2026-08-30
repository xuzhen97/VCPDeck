import { describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { ReleaseCleanupController } from "./release-cleanup.controller.js";
import { ReleaseError } from "./release.service.js";

function preview() {
	return {
		policy: {
			successfulReleaseCount: 3,
			minimumAgeDays: 30,
			uploadSessionGraceHours: 24,
		},
		candidates: [],
		expiredUploadSessions: { count: 0, bytes: 0 },
		estimatedReclaimableBytes: 0,
	};
}

describe("ReleaseCleanupController", () => {
	it("转发 preview 和 run", async () => {
		const cleanup = {
			preview: vi.fn(async () => preview()),
			run: vi.fn(async () => ({ cleanedItems: 1 })),
		};
		const controller = new ReleaseCleanupController(cleanup as never);

		expect(await controller.preview()).toEqual(preview());
		expect(await controller.run()).toEqual({ cleanedItems: 1 });
		expect(cleanup.preview).toHaveBeenCalledOnce();
		expect(cleanup.run).toHaveBeenCalledOnce();
	});

	it("清理繁忙时返回 HTTP 409 且不泄露内部信息", async () => {
		const cleanup = {
			preview: vi.fn(),
			run: vi.fn(async () => {
				throw new ReleaseError(
					"RELEASE_CLEANUP_BUSY",
					"Release 清理任务正在运行",
				);
			}),
		};
		const controller = new ReleaseCleanupController(cleanup as never);

		await expect(controller.run()).rejects.toMatchObject({
			response: {
				code: "RELEASE_CLEANUP_BUSY",
				message: "Release 清理任务正在运行",
			},
			status: 409,
		});
		await expect(controller.run()).rejects.toBeInstanceOf(ConflictException);
	});
});
