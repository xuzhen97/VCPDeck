import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseController, releaseZipPath } from "./release.controller.js";
import { ReleaseError } from "./release.service.js";

function mockService() {
	return {
		create: vi.fn(),
		list: vi.fn(),
		findByVersion: vi.fn(),
		verifyZipSha256: vi.fn(),
	};
}

function mockRes() {
	return { sendFile: vi.fn() };
}

function mockOrchestrator() {
	return { startRelease: vi.fn() };
}

/** 捕获 Promise 拒绝并断言 HTTP 错误形态 */
async function catchHttpError(p: Promise<unknown>): Promise<{
	getStatus: () => number;
	getResponse: () => unknown;
}> {
	try {
		await p;
		throw new Error("预期被拒绝，但调用成功了");
	} catch (e) {
		return e as { getStatus: () => number; getResponse: () => unknown };
	}
}

describe("ReleaseController", () => {
	let service: ReturnType<typeof mockService>;
	let orchestrator: ReturnType<typeof mockOrchestrator>;
	let controller: ReleaseController;
	let dir: string;
	let releasesDir: string;

	beforeEach(async () => {
		service = mockService();
		orchestrator = mockOrchestrator();
		orchestrator.startRelease.mockResolvedValue(undefined);
		dir = await mkdtemp(join(tmpdir(), "release-ctrl-"));
		releasesDir = join(dir, "releases");
		process.env.VCPDECK_RELEASES_DIR = releasesDir;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		controller = new ReleaseController(service as any, orchestrator as any);
	});

	afterEach(async () => {
		delete process.env.VCPDECK_RELEASES_DIR;
		await rm(dir, { recursive: true, force: true });
	});

	describe("upload", () => {
		const zipBytes = Buffer.from("zip-bytes");
		const fakeReq = (): IncomingMessage =>
			Readable.from([zipBytes]) as unknown as IncomingMessage;

		it("校验通过后落盘并创建 release（无 actor 时操作者为空）", async () => {
			service.verifyZipSha256.mockResolvedValue(true);
			service.create.mockResolvedValue({ version: "1.2.1" });

			const result = await controller.upload(
				fakeReq(),
				"1.2.1",
				"a".repeat(64),
			);

			expect(service.verifyZipSha256).toHaveBeenCalledWith(
				expect.stringContaining("vcpdeck-release-upload"),
				"a".repeat(64),
			);
			expect(service.create).toHaveBeenCalledWith({
				version: "1.2.1",
				sha256: "a".repeat(64),
				fileName: "vcpdeck-1.2.1.zip",
				size: zipBytes.length,
				createdByName: undefined,
				createdVia: undefined,
			});
			expect(result.release).toEqual({ version: "1.2.1" });
			// 已移动到最终存储路径
			await expect(access(releaseZipPath("1.2.1"))).resolves.toBeUndefined();
			// 上传即触发编排
			expect(orchestrator.startRelease).toHaveBeenCalledWith("1.2.1");
		});

		it("sha256 不匹配返回 400 RELEASE_SHA256_MISMATCH", async () => {
			service.verifyZipSha256.mockResolvedValue(false);

			const err = await catchHttpError(
				controller.upload(fakeReq(), "1.2.1", "a".repeat(64)),
			);

			expect(err.getStatus()).toBe(400);
			expect(err.getResponse()).toMatchObject({
				code: "RELEASE_SHA256_MISMATCH",
			});
			expect(service.create).not.toHaveBeenCalled();
		});

		it("版本号格式非法返回 400", async () => {
			const err = await catchHttpError(
				controller.upload(fakeReq(), "not-a-version", "a".repeat(64)),
			);

			expect(err.getStatus()).toBe(400);
			expect(service.create).not.toHaveBeenCalled();
		});

		it("版本重复返回 409 RELEASE_DUPLICATE_VERSION", async () => {
			service.verifyZipSha256.mockResolvedValue(true);
			service.create.mockRejectedValue(
				new ReleaseError("RELEASE_DUPLICATE_VERSION", "版本已存在"),
			);

			const err = await catchHttpError(
				controller.upload(fakeReq(), "1.2.1", "a".repeat(64)),
			);

			expect(err.getStatus()).toBe(409);
			expect(err.getResponse()).toMatchObject({
				code: "RELEASE_DUPLICATE_VERSION",
			});
		});

		it("actor 注入时记录操作者", async () => {
			service.verifyZipSha256.mockResolvedValue(true);
			service.create.mockResolvedValue({ version: "1.2.1" });
			const actor = {
				identityId: "i1",
				displayName: "Admin",
				isAdmin: true,
				credentialId: null,
				sessionId: "s1",
				source: "web" as const,
				requestId: "r1",
			};

			await controller.upload(fakeReq(), "1.2.1", "a".repeat(64), actor);

			expect(service.create).toHaveBeenCalledWith(
				expect.objectContaining({
					createdByName: "Admin",
					createdVia: "web",
				}),
			);
		});
	});

	describe("list", () => {
		it("page/pageSize 解析并做边界收敛", async () => {
			service.list.mockResolvedValue({ data: [], total: 0 });

			await controller.list("0", "999");

			expect(service.list).toHaveBeenCalledWith(1, 100);
		});

		it("缺省参数透传 undefined", async () => {
			service.list.mockResolvedValue({ data: [], total: 0 });

			await controller.list(undefined, undefined);

			expect(service.list).toHaveBeenCalledWith(undefined, undefined);
		});
	});

	describe("download", () => {
		it("release 不存在返回 404", async () => {
			service.findByVersion.mockResolvedValue(null);

			const err = await catchHttpError(
				controller.download("9.9.9", mockRes() as never),
			);

			expect(err.getStatus()).toBe(404);
		});

		it("存在时 sendFile 到最终存储路径", async () => {
			service.findByVersion.mockResolvedValue({ version: "1.2.1" });
			const res = mockRes();

			await controller.download("1.2.1", res as never);

			expect(res.sendFile).toHaveBeenCalledWith(
				releaseZipPath("1.2.1"),
				expect.objectContaining({
					headers: expect.objectContaining({
						"content-type": "application/zip",
					}),
				}),
				expect.any(Function),
			);
		});
	});
});
