"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const index_js_1 = require("./index.js");
function fakeSocket() {
    const handlers = {};
    const socket = {
        on: (event, cb) => {
            if (!handlers[event])
                handlers[event] = [];
            handlers[event].push(cb);
            return socket;
        },
        emit: () => socket,
        connected: true,
        data: {},
        disconnect: () => { },
        connect: () => { },
    };
    return { socket, handlers };
}
function makeDeps() {
    const supervisor = {
        request: vitest_1.vi.fn(async () => ({ requestId: "r1", ok: true, data: {} })),
        onEvent: vitest_1.vi.fn(),
        getStateReport: vitest_1.vi.fn(() => ({ clientId: "c1", runs: [] })),
        applyStateAck: vitest_1.vi.fn(async () => ({ allClosed: false })),
    };
    return {
        supervisor,
        deps: {
            clientId: "c1",
            supervisor,
            getPiStatus: async () => undefined,
            getTerminalStatus: async () => undefined,
            getRuntimeSecurity: async () => undefined,
            getRegister: () => ({
                clientId: "c1",
                hostname: "host",
                os: "linux 1",
                cpuModel: "cpu",
                totalMemMB: 1,
                clientVersion: "1",
                capabilities: [],
            }),
            getStatusReport: () => ({ clientId: "c1", jobs: [] }),
        },
    };
}
(0, vitest_1.describe)("attachPiBridge 迁移验证模式（verifyOnly）", () => {
    (0, vitest_1.it)("verifyOnly=true：不挂载 PI_REQUEST / PI_EVENT 工作处理器", () => {
        const { socket, handlers } = fakeSocket();
        const { deps, supervisor } = makeDeps();
        (0, index_js_1.attachPiBridge)(socket, deps, { verifyOnly: true });
        (0, vitest_1.expect)(handlers[shared_1.Events.PI_REQUEST] ?? []).toHaveLength(0);
        (0, vitest_1.expect)(handlers[shared_1.Events.PI_EVENT] ?? []).toHaveLength(0);
        // supervisor 事件转发也不应被绑定。
        (0, vitest_1.expect)(supervisor.onEvent).not.toHaveBeenCalled();
        // 仍保留 ack 绑定以驱动 REGISTER 流程。
        (0, vitest_1.expect)(handlers["ack"] ?? []).toHaveLength(1);
    });
    (0, vitest_1.it)("verifyOnly 缺省（稳态）：照常挂载 PI_REQUEST 处理器", () => {
        const { socket, handlers } = fakeSocket();
        const { deps, supervisor } = makeDeps();
        (0, index_js_1.attachPiBridge)(socket, deps);
        (0, vitest_1.expect)(handlers[shared_1.Events.PI_REQUEST] ?? []).toHaveLength(1);
        (0, vitest_1.expect)(supervisor.onEvent).toHaveBeenCalledTimes(1);
    });
});
(0, vitest_1.describe)("isMigrationVerifyOnly", () => {
    (0, vitest_1.it)("VCPDECK_MIGRATION_VERIFY_ONLY=1 → true；其他 → false", () => {
        (0, vitest_1.expect)((0, index_js_1.isMigrationVerifyOnly)({ VCPDECK_MIGRATION_VERIFY_ONLY: "1" })).toBe(true);
        (0, vitest_1.expect)((0, index_js_1.isMigrationVerifyOnly)({})).toBe(false);
        (0, vitest_1.expect)((0, index_js_1.isMigrationVerifyOnly)({ VCPDECK_MIGRATION_VERIFY_ONLY: "0" })).toBe(false);
    });
});
