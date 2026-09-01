import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FrpController } from "./frp.controller.js";

function fixture() {
	const frpService = {
		createMapping: vi.fn(),
		deleteMapping: vi.fn(),
		listMappings: vi.fn(),
		getMapping: vi.fn(),
	};
	const gateway = { sendDispatch: vi.fn() };
	return {
		controller: new FrpController(frpService as never, gateway as never),
		frpService,
		gateway,
	};
}

describe("FrpController write boundary", () => {
	it("create 允许省略 name，并用 Shared parser 补默认值", async () => {
		const { controller, frpService, gateway } = fixture();
		frpService.createMapping.mockResolvedValue({
			mapping: { id: "fm_1", status: "provisioning", operationJobId: "job-1" },
			dispatch: { jobId: "job-1", clientId: "c1", type: "frp.create", payload: {} },
		});
		await expect(
			controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 }),
		).resolves.toMatchObject({ status: "provisioning" });
		expect(frpService.createMapping).toHaveBeenCalledWith({
			clientId: "c1",
			proxyType: "tcp",
			localIp: "127.0.0.1",
			localPort: 1919,
			timeoutSeconds: 30,
		});
		expect(gateway.sendDispatch).toHaveBeenCalled();
	});

	it("create 严格拒绝未知字段并返回稳定 code", async () => {
		const { controller } = fixture();
		await expect(
			controller.create({
				clientId: "c1",
				proxyType: "tcp",
				localPort: 1919,
				secret: "x",
			} as never),
		).rejects.toMatchObject({
			response: expect.objectContaining({ code: "FRP_PROTOCOL_INVALID" }),
		});
	});

	it("delete 返回 deleting 映射并传递 1–300 秒 timeout", async () => {
		const { controller, frpService, gateway } = fixture();
		frpService.deleteMapping.mockResolvedValue({
			mapping: { id: "fm_1", status: "deleting", operationJobId: "job-1" },
			dispatch: { jobId: "job-1", clientId: "c1", type: "frp.delete", payload: {} },
		});
		await expect(controller.delete("fm_1", "45")).resolves.toMatchObject({
			id: "fm_1",
			status: "deleting",
			operationJobId: "job-1",
		});
		expect(frpService.deleteMapping).toHaveBeenCalledWith("fm_1", 45);
		expect(gateway.sendDispatch).toHaveBeenCalled();
	});

	it("delete 拒绝非法 timeout", async () => {
		const { controller } = fixture();
		await expect(controller.delete("fm_1", "0")).rejects.toBeInstanceOf(
			BadRequestException,
		);
	});

	it("busy 时 create 返回稳定 HTTP 409", async () => {
		const { controller, frpService } = fixture();
		frpService.createMapping.mockRejectedValue(
			Object.assign(new Error("FRP 映射正在恢复"), {
				code: "FRP_RECONCILE_BUSY",
				statusCode: 409,
			}),
		);
		await expect(
			controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 }),
		).rejects.toMatchObject({
			status: 409,
			response: { code: "FRP_RECONCILE_BUSY", message: "FRP 映射正在恢复" },
		});
	});

	it("busy 时 delete 返回稳定 HTTP 409", async () => {
		const { controller, frpService } = fixture();
		frpService.deleteMapping.mockRejectedValue(
			Object.assign(new Error("FRP 映射正在恢复"), {
				code: "FRP_RECONCILE_BUSY",
				statusCode: 409,
			}),
		);
		await expect(controller.delete("fm_1")).rejects.toMatchObject({
			status: 409,
			response: { code: "FRP_RECONCILE_BUSY" },
		});
	});

	it("Dashboard 不可达返回 503 稳定 code", async () => {
		const { controller, frpService } = fixture();
		frpService.createMapping.mockRejectedValue(
			Object.assign(new Error("FRPS Dashboard 不可达"), {
				code: "FRPS_DASHBOARD_UNREACHABLE",
			}),
		);
		await expect(
			controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 }),
		).rejects.toMatchObject({
			status: 503,
			response: { code: "FRPS_DASHBOARD_UNREACHABLE" },
		});
	});

	it("未知错误返回固定 500 安全文案，不透传内部 message", async () => {
		const { controller, frpService } = fixture();
		frpService.createMapping.mockRejectedValue(
			new Error("token SUPER_SECRET stack..."),
		);
		await expect(
			controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 }),
		).rejects.toMatchObject({
			status: 500,
			response: { code: "FRP_OPERATION_FAILED", message: "FRP 操作失败" },
		});
	});

	it("已知 FRP 协议错误保持 400", async () => {
		const { controller, frpService } = fixture();
		frpService.createMapping.mockRejectedValue(
			Object.assign(new Error("超时"), { code: "FRP_PROXY_CONFIRM_TIMEOUT" }),
		);
		await expect(
			controller.create({ clientId: "c1", proxyType: "tcp", localPort: 1919 }),
		).rejects.toMatchObject({
			status: 400,
			response: { code: "FRP_PROXY_CONFIRM_TIMEOUT" },
		});
	});
});
