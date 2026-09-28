import { describe, expect, it, vi } from "vitest";
import { PiAttachmentService } from "./pi-attachment.service.js";

function makeService() {
	const files = {
		createPending: vi.fn(async (_jobId: string | undefined, _clientId: string, meta: { filename: string; mimeType?: string; size: number }, _options?: unknown) => ({
			fileId: `f-${meta.filename}`,
			key: `k-${meta.filename}`,
			uploadUrl: `/api/storage/upload/k-${meta.filename}?sig=x`,
			expiresAt: Date.now() + 900_000,
		})),
		delete: vi.fn(async () => {}),
	};
	const storage = {
		createDownloadToken: vi.fn(async (key: string) => ({
			url: `/api/storage/download/${key}?sig=x`,
			expiresAt: Date.now() + 600_000,
		})),
	};
	const filesDb: Array<Record<string, unknown>> = [];
	const prisma = {
		file: {
			findUnique: vi.fn(async (args: { where: { id: string } }) =>
				filesDb.find((f) => f.id === args.where.id) ?? null,
			),
		},
	};
	const service = new PiAttachmentService(
		files as never,
		storage as never,
		prisma as never,
	);
	const addFile = (f: Record<string, unknown>) => filesDb.push(f);
	return { service, files, storage, prisma, addFile };
}

const img = (name: string, size = 1024) => ({
	filename: name,
	size,
	mimeType: "image/png",
});

describe("PiAttachmentService", () => {
	it("创建 pi_prompt 附件（purpose + 15 分钟 TTL + 无 jobId）", async () => {
		const { service, files } = makeService();
		const result = await service.createPromptUploads("c1", [img("a.png"), img("b.png")]);
		expect(result).toHaveLength(2);
		expect(files.createPending).toHaveBeenNthCalledWith(
			1,
			undefined,
			"c1",
			expect.objectContaining({ filename: "a.png", mimeType: "image/png" }),
			expect.objectContaining({ purpose: "pi_prompt" }),
		);
	});

	it("超过 10 张拒绝", async () => {
		const { service } = makeService();
		const many = Array.from({ length: 11 }, (_, i) => img(`m${i}.png`));
		await expect(service.createPromptUploads("c1", many)).rejects.toMatchObject({
			code: "PI_IMAGE_INVALID",
		});
	});

	it("单图超过 10 MiB 拒绝", async () => {
		const { service } = makeService();
		await expect(
			service.createPromptUploads("c1", [img("big.png", 11 * 1024 * 1024)]),
		).rejects.toMatchObject({ code: "PI_IMAGE_TOO_LARGE" });
	});

	it("总量超过 100 MiB 拒绝", async () => {
		const { service } = makeService();
		const many = Array.from({ length: 10 }, () => img("m.png", 11 * 1024 * 1024));
		await expect(service.createPromptUploads("c1", many)).rejects.toMatchObject({
			code: "PI_IMAGE_TOO_LARGE",
		});
	});

	it("非白名单 MIME 拒绝", async () => {
		const { service } = makeService();
		await expect(
			service.createPromptUploads("c1", [{ filename: "x.exe", size: 10, mimeType: "application/x-msdownload" }]),
		).rejects.toMatchObject({ code: "PI_IMAGE_INVALID" });
	});

	it("complete 校验 purpose/client/status 并返回下载 ref", async () => {
		const { service, storage, addFile } = makeService();
		addFile({
			id: "f1",
			key: "k1",
			jobId: null,
			clientId: "c1",
			filename: "a.png",
			mimeType: "image/png",
			size: 1024,
			sha256: "abc",
			status: "completed",
			storageKind: "local",
			purpose: "pi_prompt",
			expiresAt: null,
			createdAt: new Date(),
		});
		const ref = await service.completePromptUpload("f1", "c1");
		expect(ref).toMatchObject({
			fileId: "f1",
			sha256: "abc",
			mimeType: "image/png",
		});
		expect(storage.createDownloadToken).toHaveBeenCalledWith("k1");
	});

	it("complete 拒绝未完成上传", async () => {
		const { service, addFile } = makeService();
		addFile({
			id: "f1",
			key: "k1",
			clientId: "c1",
			filename: "a.png",
			mimeType: "image/png",
			size: 1024,
			sha256: "",
			status: "pending",
			storageKind: "local",
			purpose: "pi_prompt",
		});
		await expect(service.completePromptUpload("f1", "c1")).rejects.toMatchObject({
			code: "PI_IMAGE_INVALID",
		});
	});

	it("deleteAttachment 只清理目标 client 的文件", async () => {
		const { service, files, addFile } = makeService();
		addFile({ id: "f1", clientId: "c1", purpose: "pi_prompt" });
		await service.deleteAttachment("f1", "c2");
		expect(files.delete).not.toHaveBeenCalled();
		await service.deleteAttachment("f1", "c1");
		expect(files.delete).toHaveBeenCalledWith("f1");
	});

	it("历史媒体 prepare/complete 用 pi_history purpose", async () => {
		const { service, files, addFile, storage } = makeService();
		const session = await service.prepareHistoryUpload("c1", img("hist.png", 2048));
		expect(session.fileId).toBe("f-hist.png");
		expect(files.createPending).toHaveBeenCalledWith(
			undefined,
			"c1",
			expect.objectContaining({ size: 2048 }),
			expect.objectContaining({ purpose: "pi_history" }),
		);
		addFile({
			id: "f-hist.png",
			key: "k-hist.png",
			clientId: "c1",
			filename: "hist.png",
			mimeType: "image/png",
			size: 2048,
			sha256: "h",
			status: "completed",
			storageKind: "local",
			purpose: "pi_history",
		});
		const ref = await service.completeHistoryUpload("f-hist.png", "c1");
		expect(ref.url).toContain("/api/storage/download/");
		expect(storage.createDownloadToken).toHaveBeenCalledWith("k-hist.png");
	});
});

/** prompt 图片引用：只在完成、未过期且属于同一 client 时接受，且不信任调用方元数据。 */
describe("PiAttachmentService.validatePromptRefs", () => {
	const completed = (overrides: Record<string, unknown> = {}) => ({
		id: "f1",
		key: "k1",
		clientId: "c1",
		filename: "a.png",
		mimeType: "image/png",
		size: 1024,
		sha256: "sha-1",
		status: "completed",
		purpose: "pi_prompt",
		expiresAt: new Date(Date.now() + 60_000),
		...overrides,
	});
	const ref = (overrides: Record<string, unknown> = {}) => ({
		fileId: "f1",
		sha256: "sha-1",
		size: 1024,
		mimeType: "image/png",
		url: "https://evil.test/forged",
		expiresAt: Date.now() + 60_000,
		...overrides,
	});

	it("接受同 client 的已完成图片并换成服务端签发的下载凭证", async () => {
		const { service, addFile, storage } = makeService();
		addFile(completed());

		const [descriptor] = await service.validatePromptRefs("c1", [ref()]);

		expect(descriptor).toMatchObject({
			fileId: "f1",
			sha256: "sha-1",
			size: 1024,
			mimeType: "image/png",
		});
		expect(descriptor?.url).toContain("/api/storage/download/");
		expect(descriptor?.url).not.toContain("evil.test");
		expect(storage.createDownloadToken).toHaveBeenCalledWith("k1");
	});

	it.each([
		["空数组", []],
		["非数组", "f1"],
		["缺 fileId", [ref({ fileId: undefined })]],
		["未知字段", [{ ...ref(), extra: true }]],
		["非白名单 MIME", [ref({ mimeType: "image/svg+xml" })]],
		["负数 size", [ref({ size: -1 })]],
		["超过 10 张", Array.from({ length: 11 }, (_, i) => ref({ fileId: `f${i}` }))],
	])("%s 直接拒绝", async (_name, refs) => {
		const { service, prisma } = makeService();
		await expect(service.validatePromptRefs("c1", refs)).rejects.toMatchObject({
			code: "PI_IMAGE_INVALID",
		});
		expect(prisma.file.findUnique).not.toHaveBeenCalled();
	});

	it("单图超过 10 MiB 拒绝", async () => {
		const { service } = makeService();
		await expect(
			service.validatePromptRefs("c1", [ref({ size: 11 * 1024 * 1024 })]),
		).rejects.toMatchObject({ code: "PI_IMAGE_TOO_LARGE" });
	});

	it.each([
		["未完成上传", completed({ status: "pending" })],
		["过期", completed({ expiresAt: new Date(Date.now() - 1) })],
		["属于其他 client", completed({ clientId: "c2" })],
		["非 prompt 用途", completed({ purpose: "pi_history" })],
	])("%s 拒绝", async (_name, row) => {
		const { service, addFile } = makeService();
		addFile(row);
		await expect(service.validatePromptRefs("c1", [ref()])).rejects.toMatchObject({
			code: "PI_IMAGE_INVALID",
		});
	});

	it("文件不存在、重复 fileId 或元数据与 DB 不一致都拒绝", async () => {
		const missing = makeService();
		await expect(missing.service.validatePromptRefs("c1", [ref()])).rejects.toMatchObject({
			code: "PI_IMAGE_INVALID",
		});

		for (const overrides of [
			{ sha256: "forged" },
			{ mimeType: "image/webp" },
			{ size: 2048 },
		]) {
			const { service, addFile } = makeService();
			addFile(completed());
			await expect(
				service.validatePromptRefs("c1", [ref(overrides)]),
			).rejects.toMatchObject({ code: "PI_IMAGE_INVALID" });
		}

		const { service, addFile } = makeService();
		addFile(completed());
		await expect(
			service.validatePromptRefs("c1", [ref(), ref()]),
		).rejects.toMatchObject({ code: "PI_IMAGE_INVALID" });
	});
});
