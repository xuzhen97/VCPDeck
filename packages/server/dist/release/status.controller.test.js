"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const status_controller_js_1 = require("./status.controller.js");
function mockReleases() {
    return {
        getActiveRelease: vitest_1.vi.fn(),
    };
}
(0, vitest_1.describe)("StatusController", () => {
    let releases;
    let controller;
    (0, vitest_1.beforeEach)(() => {
        releases = mockReleases();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controller = new status_controller_js_1.StatusController(releases);
    });
    (0, vitest_1.it)("返回服务端版本与当前活动 release", async () => {
        releases.getActiveRelease.mockResolvedValue({
            version: "1.2.1",
            status: "updating_clients",
        });
        const status = await controller.get();
        (0, vitest_1.expect)(status).toMatchObject({
            serverVersion: shared_1.VERSION,
            activeRelease: { version: "1.2.1", status: "updating_clients" },
        });
    });
    (0, vitest_1.it)("无活动 release 时 activeRelease 为 null", async () => {
        releases.getActiveRelease.mockResolvedValue(null);
        const status = await controller.get();
        (0, vitest_1.expect)(status).toEqual({ serverVersion: shared_1.VERSION, activeRelease: null });
    });
});
