import { describe, expect, it, vi } from "vitest";
import type { DshWebCommand } from "@vcpdeck/shared";
import {
	buildDshWebUrl,
	DshWebService,
	type DshWebServiceDeps,
} from "./dsh-web.service.js";

const ONLINE_CLIENT = {
	id: "c1",
	online: true,
	socketId: "socket-1",
	capabilities: JSON.stringify(["exec", "frp", "dsh-web"]),
	dshWebState: "stopped",
	dshWebPort: null,
	dshWebUrl: null,
	dshWebFrpMappingId: null,
};

function makeService(overrides: {
	client?: Record<string, unknown> | null;
	publicUrl?: string | null;
	onSend?: (command: DshWebCommand) => void;
} = {}) {
	const updates: Array<Record<string, unknown>> = [];
	const prisma = {
		client: {
			findUnique: vi.fn().mockResolvedValue(overrides.client ?? ONLINE_CLIENT),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				updates.push(data);
				return { ...ONLINE_CLIENT, ...data };
			}),
		},
	};
	const frp = {
		createMapping: vi.fn().mockResolvedValue({
			mapping: {
				id: "m1",
				publicUrl: overrides.publicUrl ?? "frp.example.com:30123",
			},
		}),
		deleteMapping: vi.fn().mockResolvedValue(null),
	};
	const sends: DshWebCommand[] = [];
	const service = DshWebService.withDeps({
		prisma,
		frp,
		send: (socketId: string, command: DshWebCommand) => {
			void socketId;
			sends.push(command);
			overrides.onSend?.(command);
		},
		now: () => new Date(1_700_000_000_000),
		startTimeoutMs: 2_000,
	} as unknown as DshWebServiceDeps);
	return { service, prisma, frp, sends, updates };
}

describe("buildDshWebUrl", () => {
	it("TCP 地址补协议并带 token", () => {
		expect(buildDshWebUrl("frp.example.com:30123", "abc")).toBe(
			"http://frp.example.com:30123/?token=abc",
		);
		expect(buildDshWebUrl("https://dsh.example.com/", "a b")).toBe(
			"https://dsh.example.com/?token=a%20b",
		);
	});
});

describe("DshWebService 生命周期", () => {
	it("start 起进程、建映射、落库 running 与地址", async () => {
		let command: DshWebCommand | undefined;
		const { service, frp, updates } = makeService({
			onSend: (sent) => {
				command = sent;
				// 模拟 Client 回执
				void service.handleResult("socket-1", {
					requestId: sent.requestId,
					ok: true,
					port: sent.port,
					token: "tok-1",
				});
			},
		});

		const status = await service.start("c1");

		expect(command).toMatchObject({ action: "start", clientId: "c1" });
		expect(frp.createMapping).toHaveBeenCalledWith(
			expect.objectContaining({
				clientId: "c1",
				proxyType: "tcp",
				localPort: command?.port,
			}),
		);
		expect(status.state).toBe("running");
		expect(status.url).toBe(
			`http://frp.example.com:30123/?token=tok-1`,
		);
		expect(updates.at(-1)).toMatchObject({
			dshWebState: "running",
			dshWebUrl: `http://frp.example.com:30123/?token=tok-1`,
			dshWebFrpMappingId: "m1",
		});
	});

	it("Client 离线时拒绝启动", async () => {
		const { service } = makeService({
			client: { ...ONLINE_CLIENT, online: false },
		});
		await expect(service.start("c1")).rejects.toMatchObject({
			code: "DSH_WEB_CLIENT_OFFLINE",
		});
	});

	it("Client 未声明 dsh-web 能力时拒绝", async () => {
		const { service } = makeService({
			client: { ...ONLINE_CLIENT, capabilities: JSON.stringify(["exec"]) },
		});
		await expect(service.start("c1")).rejects.toMatchObject({
			code: "DSH_WEB_UNSUPPORTED",
		});
	});

	it("建映射失败时回滚进程并标 failed", async () => {
		const { service, frp, sends, updates } = makeService({
			onSend: (sent) => {
				if (sent.action === "start") {
					void service.handleResult("socket-1", {
						requestId: sent.requestId,
						ok: true,
						port: sent.port,
						token: "tok-1",
					});
				}
			},
		});
		frp.createMapping.mockRejectedValueOnce(new Error("no frps"));

		await expect(service.start("c1")).rejects.toMatchObject({
			code: "DSH_WEB_FRP_UNAVAILABLE",
		});
		// 回滚向 Client 发过 stop
		expect(sends.some((sent) => sent.action === "stop")).toBe(true);
		expect(updates.at(-1)).toMatchObject({ dshWebState: "failed" });
	});

	it("stop 停进程、删映射并清空地址", async () => {
		const { service, frp, sends, updates } = makeService({
			client: {
				...ONLINE_CLIENT,
				dshWebState: "running",
				dshWebPort: 30123,
				dshWebUrl: "http://frp.example.com:30123/?token=tok-1",
				dshWebFrpMappingId: "m1",
			},
			onSend: (sent) => {
				void service.handleResult("socket-1", {
					requestId: sent.requestId,
					ok: true,
				});
			},
		});

		const status = await service.stop("c1");

		expect(sends[0]).toMatchObject({ action: "stop", port: 30123 });
		expect(frp.deleteMapping).toHaveBeenCalledWith("m1");
		expect(status.state).toBe("stopped");
		expect(updates.at(-1)).toMatchObject({
			dshWebState: "stopped",
			dshWebUrl: null,
			dshWebPort: null,
			dshWebFrpMappingId: null,
		});
	});

	it("Client 掉线把运行中的通道标 failed 并清地址", async () => {
		const client = { ...ONLINE_CLIENT, dshWebState: "running" };
		const { service, updates } = makeService({ client });
		await service.handleClientOffline("c1");
		expect(updates.at(-1)).toMatchObject({
			dshWebState: "failed",
			dshWebUrl: null,
		});
	});

	it("Client 掉线保留端口与映射线索，供后续清理", async () => {
		const { service, updates, frp } = makeService({
			client: {
				...ONLINE_CLIENT,
				dshWebState: "running",
				dshWebPort: 30123,
				dshWebUrl: "http://frp.example.com:30123/?token=tok-1",
				dshWebFrpMappingId: "m1",
			},
		});
		await service.handleClientOffline("c1");
		const last = updates.at(-1) ?? {};
		// 清掉端口就等于把（可能仍活着的）进程永久藏起来。
		expect(last).not.toHaveProperty("dshWebPort", null);
		// 离线时删映射会留下永远 deleting 的记录，交给重连后的 stop 处理。
		expect(frp.deleteMapping).not.toHaveBeenCalled();
		expect(last).not.toHaveProperty("dshWebFrpMappingId", null);
	});

	it("failed 态再点停止：仍按残留端口让 Client 清理并清空字段", async () => {
		const { service, sends, updates } = makeService({
			client: {
				...ONLINE_CLIENT,
				dshWebState: "failed",
				dshWebPort: 30123,
				dshWebUrl: null,
				dshWebFrpMappingId: null,
			},
			onSend: (sent) => {
				void service.handleResult("socket-1", {
					requestId: sent.requestId,
					ok: true,
				});
			},
		});

		const status = await service.stop("c1");

		expect(sends[0]).toMatchObject({ action: "stop", port: 30123 });
		expect(status.state).toBe("stopped");
		expect(updates.at(-1)).toMatchObject({
			dshWebState: "stopped",
			dshWebPort: null,
		});
	});

	it("外部托管：start 直接拒绝，不代起第二个实例", async () => {
		const { service, sends, frp } = makeService({
			client: {
				...ONLINE_CLIENT,
				dshWebState: "external",
				dshWebMode: "external",
				dshWebUrl: "https://dsh.example.com/?token=tok",
			},
		});

		await expect(service.start("c1")).rejects.toMatchObject({
			code: "DSH_WEB_EXTERNAL_MANAGED",
			statusCode: 409,
		});
		expect(sends).toHaveLength(0);
		expect(frp.createMapping).not.toHaveBeenCalled();
	});

	it("外部托管：stop 只解除登记，不发命令不删映射", async () => {
		const { service, sends, frp, updates } = makeService({
			client: {
				...ONLINE_CLIENT,
				dshWebState: "external",
				dshWebMode: "external",
				dshWebUrl: "https://dsh.example.com/?token=tok",
				dshWebFrpMappingId: null,
			},
		});

		const status = await service.stop("c1");

		expect(sends).toHaveLength(0);
		expect(frp.deleteMapping).not.toHaveBeenCalled();
		expect(status).toMatchObject({ state: "stopped", url: null, mode: "managed" });
		expect(updates.at(-1)).toMatchObject({
			dshWebState: "stopped",
			dshWebUrl: null,
			dshWebMode: "managed",
		});
	});

	it("status 回传归属模式", async () => {
		const { service } = makeService({
			client: {
				...ONLINE_CLIENT,
				dshWebState: "external",
				dshWebMode: "external",
				dshWebUrl: "https://dsh.example.com/?token=tok",
			},
		});
		const status = await service.status("c1");
		expect(status.mode).toBe("external");
		expect(status.state).toBe("external");
	});
});
