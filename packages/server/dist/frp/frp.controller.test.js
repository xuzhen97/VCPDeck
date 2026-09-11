"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const vitest_1 = require("vitest");
const frp_controller_js_1 = require("./frp.controller.js");
function fixture() {
    const frpService = {
        createMapping: vitest_1.vi.fn(),
        deleteMapping: vitest_1.vi.fn(),
        listMappings: vitest_1.vi.fn(),
        getMapping: vitest_1.vi.fn(),
    };
    const gateway = { sendDispatch: vitest_1.vi.fn() };
    return {
        controller: new frp_controller_js_1.FrpController(frpService, gateway),
        frpService,
        gateway,
    };
}
(0, vitest_1.describe)("FrpController write boundary", () => {
    (0, vitest_1.it)("create 允许省略 name，并用 Shared parser 补默认值", async () => {
        const { controller, frpService, gateway } = fixture();
        frpService.createMapping.mockResolvedValue({
            mapping: { id: "fm_1", status: "provisioning", operationJobId: "job-1" },
            dispatch: { jobId: "job-1", clientId: "c1", type: "frp.create", payload: {} },
        });
        await (0, vitest_1.expect)(controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 })).resolves.toMatchObject({ status: "provisioning" });
        (0, vitest_1.expect)(frpService.createMapping).toHaveBeenCalledWith({
            clientId: "c1",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
            timeoutSeconds: 30,
        });
        (0, vitest_1.expect)(gateway.sendDispatch).toHaveBeenCalled();
    });
    (0, vitest_1.it)("create 严格拒绝未知字段并返回稳定 code", async () => {
        const { controller } = fixture();
        await (0, vitest_1.expect)(controller.create({
            clientId: "c1",
            proxyType: "tcp",
            localPort: 1919,
            secret: "x",
        })).rejects.toMatchObject({
            response: vitest_1.expect.objectContaining({ code: "FRP_PROTOCOL_INVALID" }),
        });
    });
    (0, vitest_1.it)("delete 返回 deleting 映射并传递 1–300 秒 timeout", async () => {
        const { controller, frpService, gateway } = fixture();
        frpService.deleteMapping.mockResolvedValue({
            mapping: { id: "fm_1", status: "deleting", operationJobId: "job-1" },
            dispatch: { jobId: "job-1", clientId: "c1", type: "frp.delete", payload: {} },
        });
        await (0, vitest_1.expect)(controller.delete("fm_1", "45")).resolves.toMatchObject({
            id: "fm_1",
            status: "deleting",
            operationJobId: "job-1",
        });
        (0, vitest_1.expect)(frpService.deleteMapping).toHaveBeenCalledWith("fm_1", 45);
        (0, vitest_1.expect)(gateway.sendDispatch).toHaveBeenCalled();
    });
    (0, vitest_1.it)("delete 拒绝非法 timeout", async () => {
        const { controller } = fixture();
        await (0, vitest_1.expect)(controller.delete("fm_1", "0")).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    (0, vitest_1.it)("busy 时 create 返回稳定 HTTP 409", async () => {
        const { controller, frpService } = fixture();
        frpService.createMapping.mockRejectedValue(Object.assign(new Error("FRP 映射正在恢复"), {
            code: "FRP_RECONCILE_BUSY",
            statusCode: 409,
        }));
        await (0, vitest_1.expect)(controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 })).rejects.toMatchObject({
            status: 409,
            response: { code: "FRP_RECONCILE_BUSY", message: "FRP 映射正在恢复" },
        });
    });
    (0, vitest_1.it)("busy 时 delete 返回稳定 HTTP 409", async () => {
        const { controller, frpService } = fixture();
        frpService.deleteMapping.mockRejectedValue(Object.assign(new Error("FRP 映射正在恢复"), {
            code: "FRP_RECONCILE_BUSY",
            statusCode: 409,
        }));
        await (0, vitest_1.expect)(controller.delete("fm_1")).rejects.toMatchObject({
            status: 409,
            response: { code: "FRP_RECONCILE_BUSY" },
        });
    });
    (0, vitest_1.it)("Dashboard 不可达返回 503 稳定 code", async () => {
        const { controller, frpService } = fixture();
        frpService.createMapping.mockRejectedValue(Object.assign(new Error("FRPS Dashboard 不可达"), {
            code: "FRPS_DASHBOARD_UNREACHABLE",
        }));
        await (0, vitest_1.expect)(controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 })).rejects.toMatchObject({
            status: 503,
            response: { code: "FRPS_DASHBOARD_UNREACHABLE" },
        });
    });
    (0, vitest_1.it)("未知错误返回固定 500 安全文案，不透传内部 message", async () => {
        const { controller, frpService } = fixture();
        frpService.createMapping.mockRejectedValue(new Error("token SUPER_SECRET stack..."));
        await (0, vitest_1.expect)(controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 })).rejects.toMatchObject({
            status: 500,
            response: { code: "FRP_OPERATION_FAILED", message: "FRP 操作失败" },
        });
    });
    (0, vitest_1.it)("已知 FRP 协议错误保持 400", async () => {
        const { controller, frpService } = fixture();
        frpService.createMapping.mockRejectedValue(Object.assign(new Error("超时"), { code: "FRP_PROXY_CONFIRM_TIMEOUT" }));
        await (0, vitest_1.expect)(controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 })).rejects.toMatchObject({
            status: 400,
            response: { code: "FRP_PROXY_CONFIRM_TIMEOUT" },
        });
    });
});
