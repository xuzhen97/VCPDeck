"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const common_1 = require("@nestjs/common");
const terminal_controller_js_1 = require("./terminal.controller.js");
const ACTOR = { identityId: "id1", displayName: "admin", isAdmin: true, credentialId: null, sessionId: null, source: "web", requestId: "r" };
function sessionInfo(overrides = {}) {
    return {
        sessionId: "s1",
        clientId: "c1",
        shellId: "bash",
        shellLabel: "bash",
        status: "detached",
        cols: 80,
        rows: 24,
        createdByIdentityId: null,
        createdByName: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        lastAttachedAt: null,
        detachedAt: null,
        expiresAt: null,
        endedAt: null,
        endReason: null,
        errorCode: null,
        ...overrides,
    };
}
function makeController() {
    const service = {
        listShells: vitest_1.vi.fn(),
        listSessions: vitest_1.vi.fn(),
        getSession: vitest_1.vi.fn(),
        createSession: vitest_1.vi.fn(),
        closeSession: vitest_1.vi.fn(),
        listAudit: vitest_1.vi.fn(),
    };
    const audit = { list: vitest_1.vi.fn() };
    const controller = new terminal_controller_js_1.TerminalController(service, audit);
    return { controller, service, audit };
}
function err(code, message = "boom") {
    return Object.assign(new Error(message), { code });
}
(0, vitest_1.describe)("TerminalController", () => {
    (0, vitest_1.it)("GET shells 透传 actor 范围并返回安全 DTO", async () => {
        const { controller, service } = makeController();
        service.listShells.mockResolvedValue([{ id: "bash", label: "bash", kind: "bash", isDefault: true }]);
        const result = await controller.shells("c1", ACTOR);
        (0, vitest_1.expect)(result).toEqual([{ id: "bash", label: "bash", kind: "bash", isDefault: true }]);
        (0, vitest_1.expect)(service.listShells).toHaveBeenCalledWith("c1");
    });
    (0, vitest_1.it)("GET sessions 分页参数安全解析（NaN→默认，pageSize 上限 100）", async () => {
        const { controller, service } = makeController();
        service.listSessions.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
        await controller.list("c1", "abc", "9999", ACTOR);
        (0, vitest_1.expect)(service.listSessions).toHaveBeenCalledWith("c1", 1, 100);
    });
    (0, vitest_1.it)("POST create 手动校验并透传", async () => {
        const { controller, service } = makeController();
        service.createSession.mockResolvedValue(sessionInfo());
        const result = await controller.create("c1", { shellId: "bash", cols: 100, rows: 40 }, ACTOR);
        (0, vitest_1.expect)(result.sessionId).toBe("s1");
        (0, vitest_1.expect)(service.createSession).toHaveBeenCalledWith("c1", { shellId: "bash", cols: 100, rows: 40 }, ACTOR);
    });
    (0, vitest_1.it)("POST create 非法尺寸/缺字段返回 400", async () => {
        const { controller, service } = makeController();
        await (0, vitest_1.expect)(controller.create("c1", { shellId: "bash", cols: 10, rows: 40 }, ACTOR)).rejects.toBeInstanceOf(common_1.BadRequestException);
        await (0, vitest_1.expect)(controller.create("c1", { cols: 80, rows: 40 }, ACTOR)).rejects.toBeInstanceOf(common_1.BadRequestException);
        (0, vitest_1.expect)(service.createSession).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("POST create 额外 executable/cwd/env 被拒绝", async () => {
        const { controller, service } = makeController();
        await (0, vitest_1.expect)(controller.create("c1", { shellId: "bash", cols: 80, rows: 24, executable: "/bin/sh" }, ACTOR)).rejects.toBeInstanceOf(common_1.BadRequestException);
        await (0, vitest_1.expect)(controller.create("c1", { shellId: "bash", cols: 80, rows: 24, cwd: "/root" }, ACTOR)).rejects.toBeInstanceOf(common_1.BadRequestException);
        (0, vitest_1.expect)(service.createSession).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("稳定错误码映射 HTTP 状态", async () => {
        const { controller, service } = makeController();
        service.listShells.mockRejectedValue(err("TERMINAL_CLIENT_OFFLINE"));
        await (0, vitest_1.expect)(controller.shells("c1", ACTOR)).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        service.createSession.mockRejectedValue(err("TERMINAL_SESSION_LIMIT_REACHED"));
        await (0, vitest_1.expect)(controller.create("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR)).rejects.toBeInstanceOf(common_1.ConflictException);
        service.getSession.mockRejectedValue(err("TERMINAL_SESSION_NOT_FOUND"));
        await (0, vitest_1.expect)(controller.get("c1", "nope", ACTOR)).rejects.toBeInstanceOf(common_1.NotFoundException);
    });
    (0, vitest_1.it)("未知错误映射为 500 安全文案", async () => {
        const { controller, service } = makeController();
        service.listShells.mockRejectedValue(new Error("secret internal: /home/admin/.ssh/id_rsa"));
        await (0, vitest_1.expect)(controller.shells("c1", ACTOR)).rejects.toMatchObject({
            message: "Terminal operation failed",
        });
    });
    (0, vitest_1.it)("DELETE close 幂等并透传", async () => {
        const { controller, service } = makeController();
        service.closeSession.mockResolvedValue(sessionInfo({ status: "closed", endedAt: "2026-08-12T00:01:00.000Z" }));
        const result = await controller.remove("c1", "s1", ACTOR);
        (0, vitest_1.expect)(result.status).toBe("closed");
        (0, vitest_1.expect)(service.closeSession).toHaveBeenCalledWith("c1", "s1", ACTOR);
    });
    (0, vitest_1.it)("GET audit 分页透传", async () => {
        const { controller, audit } = makeController();
        audit.list.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
        await controller.audit("c1", "s1", "2", "50", ACTOR);
        (0, vitest_1.expect)(audit.list).toHaveBeenCalledWith({ sessionId: "s1", clientId: "c1" }, 2, 50);
    });
});
