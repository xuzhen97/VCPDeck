"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const common_1 = require("@nestjs/common");
const release_cleanup_controller_js_1 = require("./release-cleanup.controller.js");
const release_service_js_1 = require("./release.service.js");
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
(0, vitest_1.describe)("ReleaseCleanupController", () => {
    (0, vitest_1.it)("转发 preview 和 run", async () => {
        const cleanup = {
            preview: vitest_1.vi.fn(async () => preview()),
            run: vitest_1.vi.fn(async () => ({ cleanedItems: 1 })),
        };
        const controller = new release_cleanup_controller_js_1.ReleaseCleanupController(cleanup);
        (0, vitest_1.expect)(await controller.preview()).toEqual(preview());
        (0, vitest_1.expect)(await controller.run()).toEqual({ cleanedItems: 1 });
        (0, vitest_1.expect)(cleanup.preview).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(cleanup.run).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("清理繁忙时返回 HTTP 409 且不泄露内部信息", async () => {
        const cleanup = {
            preview: vitest_1.vi.fn(),
            run: vitest_1.vi.fn(async () => {
                throw new release_service_js_1.ReleaseError("RELEASE_CLEANUP_BUSY", "Release 清理任务正在运行");
            }),
        };
        const controller = new release_cleanup_controller_js_1.ReleaseCleanupController(cleanup);
        await (0, vitest_1.expect)(controller.run()).rejects.toMatchObject({
            response: {
                code: "RELEASE_CLEANUP_BUSY",
                message: "Release 清理任务正在运行",
            },
            status: 409,
        });
        await (0, vitest_1.expect)(controller.run()).rejects.toBeInstanceOf(common_1.ConflictException);
    });
});
