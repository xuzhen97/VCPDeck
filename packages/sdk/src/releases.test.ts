import { describe, expect, it, vi } from "vitest";
import { createReleasesApi } from "./releases.js";

describe("releases.upload", () => {
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
