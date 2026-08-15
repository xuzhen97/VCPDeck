import { beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "@vcpdeck/shared";
import { StatusController } from "./status.controller.js";

function mockReleases() {
	return {
		getActiveRelease: vi.fn(),
	};
}

describe("StatusController", () => {
	let releases: ReturnType<typeof mockReleases>;
	let controller: StatusController;

	beforeEach(() => {
		releases = mockReleases();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		controller = new StatusController(releases as any);
	});

	it("返回服务端版本与当前活动 release", async () => {
		releases.getActiveRelease.mockResolvedValue({
			version: "1.2.1",
			status: "updating_clients",
		});

		const status = await controller.get();

		expect(status).toMatchObject({
			serverVersion: VERSION,
			activeRelease: { version: "1.2.1", status: "updating_clients" },
		});
	});

	it("无活动 release 时 activeRelease 为 null", async () => {
		releases.getActiveRelease.mockResolvedValue(null);

		const status = await controller.get();

		expect(status).toEqual({ serverVersion: VERSION, activeRelease: null });
	});
});
