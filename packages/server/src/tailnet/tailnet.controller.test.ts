/**
 * TailnetController 单元测试（ADR-0062）。
 *
 * 验证 REST 入口的输入边界、状态码映射与 dispatch 交接；
 * 不启动 Nest、不连接数据库。
 */
import { BadRequestException, HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@vcpdeck/shared";
import { EventsModule } from "../events/events.module.js";
import { JobModule } from "../job/job.module.js";
import { TailnetModule } from "./tailnet.module.js";
import { TailnetController } from "./tailnet.controller.js";

const ACTOR: ActorContext = {
	identityId: "identity-1",
	displayName: "tester",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	requestId: "actor-request-1",
	source: "web",
};

function makeController() {
	const keys = {
		importKey: vi.fn(),
		listKeys: vi.fn(),
		deleteKey: vi.fn(),
	};
	const tailnet = { getStatus: vi.fn() };
	const jobs = { create: vi.fn() };
	const gateway = { sendDispatch: vi.fn() };
	const controller = new TailnetController(
		keys as never,
		tailnet as never,
		jobs as never,
		gateway as never,
	);
	return { controller, keys, tailnet, jobs, gateway };
}

describe("TailnetController 密钥入口", () => {
	it("拒绝带控制字符的 authKey", async () => {
		const { controller, keys } = makeController();
		const error = await controller
			.importKey({
				name: "key-1",
				authKey: "tskey-auth-\n1",
				declaredReuse: "single",
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BadRequestException);
		expect((error as BadRequestException).getResponse()).toMatchObject({
			code: "INVALID_TAILNET_INPUT",
		});
		expect(keys.importKey).not.toHaveBeenCalled();
	});

	it("合法输入透传给服务", async () => {
		const { controller, keys } = makeController();
		keys.importKey.mockResolvedValue({ id: "key-1" });
		await expect(
			controller.importKey({
				name: "key-1",
				authKey: "tskey-auth-1",
				declaredReuse: "reusable",
				declaredExpiresAt: "2026-12-31T00:00:00.000Z",
			}),
		).resolves.toEqual({ id: "key-1" });
		expect(keys.importKey).toHaveBeenCalledWith({
			name: "key-1",
			authKey: "tskey-auth-1",
			declaredReuse: "reusable",
			declaredExpiresAt: "2026-12-31T00:00:00.000Z",
		});
	});

	it("pageSize 越界时收敛到 1–100", async () => {
		const { controller, keys } = makeController();
		keys.listKeys.mockResolvedValue({
			data: [],
			total: 0,
			page: 1,
			pageSize: 100,
			totalPages: 0,
		});
		await controller.listKeys("1", "500");
		expect(keys.listKeys).toHaveBeenLastCalledWith(1, 100);
		await controller.listKeys("-3", "0");
		expect(keys.listKeys).toHaveBeenLastCalledWith(1, 1);
	});

	it("reserved 冲突映射为 409 且保留稳定 code", async () => {
		const { controller, keys } = makeController();
		keys.deleteKey.mockRejectedValue(
			Object.assign(new Error("凭据仍被任务占用"), {
				code: "TAILNET_KEY_BUSY",
				statusCode: 409,
			}),
		);
		const error = await controller.deleteKey("key-1").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HttpException);
		expect((error as HttpException).getStatus()).toBe(409);
		expect((error as HttpException).getResponse()).toMatchObject({
			code: "TAILNET_KEY_BUSY",
		});
	});
});

describe("TailnetController 状态与任务入口", () => {
	it("机器不存在映射为 404", async () => {
		const { controller, tailnet } = makeController();
		tailnet.getStatus.mockRejectedValue(
			Object.assign(new Error("机器不存在"), {
				code: "CLIENT_NOT_FOUND",
				statusCode: 404,
			}),
		);
		const error = await controller.status("missing").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HttpException);
		expect((error as HttpException).getStatus()).toBe(404);
	});

	it("任务载荷夹带 authKey 时 400 且不创建任务", async () => {
		const { controller, jobs } = makeController();
		await expect(
			controller.manage(
				"client-1",
				{ action: "ensure", credentialId: "key-1", installIfMissing: true, authKey: "x" },
				ACTOR,
			),
		).rejects.toBeInstanceOf(BadRequestException);
		expect(jobs.create).not.toHaveBeenCalled();
	});

	it("合法 ensure 任务交给 JobService 并派发", async () => {
		const { controller, jobs, gateway } = makeController();
		const dispatch = { jobId: "job-1" };
		const result = { jobId: "job-1", status: "pending", type: "tailnet.manage" };
		jobs.create.mockResolvedValue({ result, dispatch });
		await expect(
			controller.manage(
				"client-1",
				{ action: "ensure", credentialId: "key-1", installIfMissing: false },
				ACTOR,
			),
		).resolves.toEqual(result);
		expect(jobs.create).toHaveBeenCalledWith(
			{
				clientId: "client-1",
				type: "tailnet.manage",
				payload: { action: "ensure", credentialId: "key-1", installIfMissing: false },
			},
			ACTOR,
		);
		expect(gateway.sendDispatch).toHaveBeenCalledWith(dispatch);
	});
});

describe("Tailnet 模块装配", () => {
	it("EventsModule 注册 Tailnet 控制器并导入 TailnetModule", () => {
		const controllers = Reflect.getMetadata("controllers", EventsModule) as unknown[];
		expect(controllers).toContain(TailnetController);
		const imports = Reflect.getMetadata("imports", EventsModule) as unknown[];
		expect(imports).toContain(TailnetModule);
	});

	it("JobModule 导入 TailnetModule，JobService 才能拿到 TailnetKeyService", () => {
		// JobService 用 @Optional() @Inject(TailnetKeyService) 注入；缺少这条导入时
		// Nest 会把依赖解析成 undefined，Tailnet Job 一律以 TAILNET_KEY_UNAVAILABLE 失败。
		const imports = Reflect.getMetadata("imports", JobModule) as unknown[];
		expect(imports).toContain(TailnetModule);
	});

	it("TailnetModule 只导出凭据与状态服务", () => {
		const providers = Reflect.getMetadata("providers", TailnetModule) as unknown[];
		const exports = Reflect.getMetadata("exports", TailnetModule) as unknown[];
		expect(providers).toHaveLength(2);
		expect(exports).toHaveLength(2);
		const imports = Reflect.getMetadata("imports", TailnetModule) as unknown[];
		expect(imports).toHaveLength(1);
	});
});
