import { describe, expect, it, vi } from "vitest";
import { HEADERS_METADATA } from "@nestjs/common/constants";
import type { ActorContext } from "@vcpdeck/shared";
import { ReleaseUploadController } from "./release-upload.controller.js";
import { ReleaseUploadError } from "./release-upload.service.js";

const actor: ActorContext = {
	identityId: "identity-1",
	displayName: "Operator",
	isAdmin: false,
	credentialId: "credential-1",
	sessionId: null,
	source: "cli",
	requestId: "request-1",
};

function service() {
	return {
		createSession: vi.fn(async () => ({ mode: "server" as const })),
		refreshParts: vi.fn(async () => ({
			parts: [{ partNumber: 1, url: "https://provider.invalid/secret" }],
		})),
		completeSession: vi.fn(async () => ({ release: { version: "0.2.1" } })),
	};
}

async function catchHttpError(promise: Promise<unknown>) {
	try {
		await promise;
		throw new Error("预期请求失败");
	} catch (error) {
		return error as { getStatus: () => number; getResponse: () => unknown };
	}
}

describe("ReleaseUploadController", () => {
	it("严格解析创建输入并传递 actor", async () => {
		const mock = service();
		const controller = new ReleaseUploadController(mock as never);
		const body = {
			version: "0.2.1",
			platform: "linux-x64",
			sha256: "a".repeat(64),
			size: 123,
		};
		await controller.create(body, actor);
		expect(mock.createSession).toHaveBeenCalledWith(body, actor);

		const error = await catchHttpError(
			controller.create({ ...body, providerUrl: "secret" }, actor),
		);
		expect(error.getStatus()).toBe(400);
		expect(mock.createSession).toHaveBeenCalledTimes(1);
	});

	it("刷新分片严格拒绝重复编号", async () => {
		const mock = service();
		const controller = new ReleaseUploadController(mock as never);
		const error = await catchHttpError(
			controller.refreshParts("session-1", { partNumbers: [1, 1] }),
		);
		expect(error.getStatus()).toBe(400);
		expect(mock.refreshParts).not.toHaveBeenCalled();
	});

	it("完成字节数不匹配映射稳定 400 错误", async () => {
		const mock = service();
		mock.completeSession.mockRejectedValue(
			new ReleaseUploadError(
				"RELEASE_UPLOAD_SIZE_MISMATCH",
				"上传字节数与声明值不一致",
			),
		);
		const controller = new ReleaseUploadController(mock as never);
		const error = await catchHttpError(
			controller.complete("session-1", { uploadedBytes: 123 }),
		);
		expect(error.getStatus()).toBe(400);
		expect(error.getResponse()).toEqual({
			code: "RELEASE_UPLOAD_SIZE_MISMATCH",
			message: "上传字节数与声明值不一致",
		});
	});

	it("Provider 失败只返回安全摘要", async () => {
		const mock = service();
		mock.refreshParts.mockRejectedValue(
			new ReleaseUploadError(
				"RELEASE_UPLOAD_PROVIDER_FAILED",
				"外部存储操作失败，请稍后重试",
			),
		);
		const controller = new ReleaseUploadController(mock as never);
		const error = await catchHttpError(
			controller.refreshParts("session-1", { partNumbers: [1] }),
		);
		expect(error.getStatus()).toBe(502);
		expect(JSON.stringify(error.getResponse())).not.toContain("provider.invalid");
	});

	it("创建、刷新、完成响应均声明 no-store", () => {
		for (const method of [
			ReleaseUploadController.prototype.create,
			ReleaseUploadController.prototype.refreshParts,
			ReleaseUploadController.prototype.complete,
		]) {
			expect(Reflect.getMetadata(HEADERS_METADATA, method)).toContainEqual({
				name: "Cache-Control",
				value: "no-store",
			});
		}
	});
});
