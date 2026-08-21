import { describe, expect, it, vi } from "vitest";
import { createReleasesApi } from "./releases.js";

describe("releases", () => {
	it("创建、刷新并完成 Release 直传会话", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				mode: "direct",
				sessionId: "s/1",
				partSize: 64,
				parts: [{ partNumber: 1, url: "https://provider.example/secret" }],
				expiresAt: "2026-08-22T00:00:00.000Z",
			})
			.mockResolvedValueOnce({
				parts: [{ partNumber: 1, url: "https://provider.example/refreshed" }],
			})
			.mockResolvedValueOnce({ release: { version: "1.2.3" } });
		const api = createReleasesApi({ request, requestRaw: vi.fn() } as never);
		const input = {
			version: "1.2.3",
			platform: "linux-x64" as const,
			sha256: "a".repeat(64),
			size: 123,
		};

		await api.createUploadSession(input);
		await api.refreshUploadParts("s/1", [1]);
		await api.completeUploadSession("s/1", 123);

		expect(request.mock.calls).toEqual([
			["POST", "/api/releases/uploads", input, undefined],
			[
				"POST",
				"/api/releases/uploads/s%2F1/parts",
				{ partNumbers: [1] },
				undefined,
			],
			[
				"POST",
				"/api/releases/uploads/s%2F1/complete",
				{ uploadedBytes: 123 },
				undefined,
			],
		]);
	});

	it("通过原始 body 上传按平台归档并返回 Release", async () => {
		const release = {
			version: "1.2.3",
			archives: {},
			status: "uploaded",
			createdAt: "2026-08-18T00:00:00.000Z",
			updatedAt: "2026-08-18T00:00:00.000Z",
			clientStates: {},
		};
		const requestRaw = vi.fn(async () => ({
			data: { release },
			response: new Response(),
		}));
		const api = createReleasesApi({
			request: vi.fn(),
			requestRaw,
		} as never);

		await expect(
			api.upload({
				version: "1.2.3",
				platform: "linux-x64",
				sha256: "a".repeat(64),
				archive: "zip-bytes",
				duplex: "half",
			}),
		).resolves.toEqual({ release });
		expect(requestRaw).toHaveBeenCalledWith(
			"POST",
			`/api/releases/upload?version=1.2.3&platform=linux-x64&sha256=${"a".repeat(64)}`,
			{
				body: "zip-bytes",
				headers: { "Content-Type": "application/zip" },
				signal: undefined,
				duplex: "half",
			},
		);
	});
});
