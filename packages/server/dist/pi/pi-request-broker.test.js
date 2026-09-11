"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const pi_request_broker_js_1 = require("./pi-request-broker.js");
function makeRequest(overrides = {}) {
    return {
        requestId: "req-1",
        action: "sessions.list",
        cwdRef: { rootDir: "C:\\", relativePath: "x" },
        ...overrides,
    };
}
(0, vitest_1.describe)("PiRequestBroker", () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)("request 精确投递 lease socket 并关联响应", async () => {
        const broker = new pi_request_broker_js_1.PiRequestBroker();
        const emitted = [];
        broker.bindEmitter((socketId, request) => emitted.push({ socketId, request }));
        const promise = broker.request({ clientId: "c1", socketId: "socket-2" }, makeRequest());
        (0, vitest_1.expect)(emitted).toEqual([{ socketId: "socket-2", request: makeRequest() }]);
        broker.resolve("socket-1", { requestId: "req-1", ok: true, data: { evil: true } });
        broker.resolve("socket-2", { requestId: "req-1", ok: true, data: { sessions: [] } });
        await (0, vitest_1.expect)(promise).resolves.toMatchObject({ ok: true, data: { sessions: [] } });
    });
    (0, vitest_1.it)("响应乱序也能正确关联", async () => {
        const broker = new pi_request_broker_js_1.PiRequestBroker();
        broker.bindEmitter(() => { });
        const lease = { clientId: "c1", socketId: "socket-1" };
        const p1 = broker.request(lease, makeRequest({ requestId: "r1" }));
        const p2 = broker.request(lease, makeRequest({ requestId: "r2" }));
        broker.resolve("socket-1", { requestId: "r2", ok: true, data: { n: 2 } });
        broker.resolve("socket-1", { requestId: "r1", ok: true, data: { n: 1 } });
        (0, vitest_1.expect)(await p1).toMatchObject({ data: { n: 1 } });
        (0, vitest_1.expect)(await p2).toMatchObject({ data: { n: 2 } });
    });
    (0, vitest_1.it)("超时返回 PI_REQUEST_TIMEOUT", async () => {
        vitest_1.vi.useFakeTimers();
        const broker = new pi_request_broker_js_1.PiRequestBroker();
        broker.bindEmitter(() => { });
        const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest(), 100);
        promise.catch(() => { }); // 防 fake-timer 边界 unhandled rejection
        await vitest_1.vi.advanceTimersByTimeAsync(150);
        await (0, vitest_1.expect)(promise).rejects.toMatchObject({ code: "PI_REQUEST_TIMEOUT" });
    });
    (0, vitest_1.it)("断线只失败该 socket 的 pending 请求", async () => {
        const broker = new pi_request_broker_js_1.PiRequestBroker();
        broker.bindEmitter(() => { });
        const oldPromise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest({ requestId: "old" }));
        const newPromise = broker.request({ clientId: "c1", socketId: "socket-2" }, makeRequest({ requestId: "new" }));
        broker.disconnect("socket-1");
        await (0, vitest_1.expect)(oldPromise).rejects.toMatchObject({ code: "PI_CLIENT_DISCONNECTED" });
        broker.resolve("socket-2", { requestId: "new", ok: true, data: { n: 2 } });
        await (0, vitest_1.expect)(newPromise).resolves.toMatchObject({ data: { n: 2 } });
    });
    (0, vitest_1.it)("其他 socket 的伪造响应被拒绝", async () => {
        vitest_1.vi.useFakeTimers();
        const broker = new pi_request_broker_js_1.PiRequestBroker();
        broker.bindEmitter(() => { });
        const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest(), 100);
        promise.catch(() => { }); // 防 fake-timer 边界 unhandled rejection
        broker.resolve("socket-2", { requestId: "req-1", ok: true, data: { evil: true } });
        await vitest_1.vi.advanceTimersByTimeAsync(150);
        await (0, vitest_1.expect)(promise).rejects.toMatchObject({ code: "PI_REQUEST_TIMEOUT" });
    });
    (0, vitest_1.it)("重复响应忽略", async () => {
        const broker = new pi_request_broker_js_1.PiRequestBroker();
        broker.bindEmitter(() => { });
        const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, makeRequest());
        broker.resolve("socket-1", { requestId: "req-1", ok: true, data: { n: 1 } });
        broker.resolve("socket-1", { requestId: "req-1", ok: false, error: { code: "PI_PROJECT_BUSY", message: "x" } });
        const result = (await promise);
        (0, vitest_1.expect)(result).toMatchObject({ ok: true, data: { n: 1 } });
    });
});
