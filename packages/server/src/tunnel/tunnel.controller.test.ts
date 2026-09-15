import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@vcpdeck/shared";
import { HttpException } from "@nestjs/common";
import { TunnelController } from "./tunnel.controller.js";
import { TunnelSessionError } from "./tunnel-session.service.js";

const ACTOR: ActorContext = {
	identityId: "op-1",
	displayName: "op",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "r1",
};

function make(overrides: { config?: Record<string, unknown>; sessions?: Record<string, unknown> } = {}) {
	const config = {
		get: vi.fn(async () => ({
			stunUrls: ["stun:turn.example.com:3478"],
			turnUrls: ["turn:turn.example.com:3478"],
			realm: "turn.example.com",
			turnSecretConfigured: true,
			updatedAt: null,
		})),
		update: vi.fn(),
		...overrides.config,
	};
	const sessions = {
		create: vi.fn(async () => ({
			sessionId: "tn_1",
			clientId: "c1",
			targetPort: 3000,
			attachDeadline: "2026-09-11T00:01:00.000Z",
			iceServers: [{ urls: ["stun:turn.example.com:3478"] }],
		})),
		close: vi.fn(async () => ({ closed: true as const })),
		...overrides.sessions,
	};
	const controller = new TunnelController(config as never, sessions as never);
	return { controller, config, sessions };
}

describe("TunnelController", () => {
	it("GET config 返回脱敏摘要，不含 secret 内容", async () => {
		const { controller } = make();
		const info = await controller.getConfig();
		expect(info.turnSecretConfigured).toBe(true);
		expect(JSON.stringify(info)).not.toContain("shared-secret");
	});

	it("POST create 委托 service 并透传 actor", async () => {
		const { controller, sessions } = make();
		await controller.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		expect(sessions.create).toHaveBeenCalledWith({ clientId: "c1", targetPort: 3000 }, ACTOR);
	});

	it("DELETE close 委托 service 并透传 actor", async () => {
		const { controller, sessions } = make();
		await controller.close("tn_1", ACTOR);
		expect(sessions.close).toHaveBeenCalledWith("tn_1", ACTOR);
	});

	it("domain 错误映射为带稳定 code 的 HttpException（409 不支持）", async () => {
		const { controller } = make({
			sessions: {
				create: vi.fn(async () => {
					throw new TunnelSessionError("TUNNEL_CLIENT_UNSUPPORTED", "目标 Client 不支持", 409);
				}),
				close: vi.fn(),
			},
		});
		const err = await controller.create({ clientId: "c1", targetPort: 3000 }, ACTOR).catch((e) => e);
		expect(err).toBeInstanceOf(HttpException);
		expect((err as HttpException).getStatus()).toBe(409);
		expect((err as HttpException).getResponse()).toMatchObject({ code: "TUNNEL_CLIENT_UNSUPPORTED" });
	});

	it("非法请求体映射为 400 TUNNEL_REQUEST_INVALID", async () => {
		const { controller } = make({
			config: {
				get: vi.fn(),
				update: vi.fn(async () => {
					throw new Error("boom");
				}),
			},
		});
		const err = await controller.updateConfig({ stunUrls: [], turnUrls: [], realm: "x", extra: 1 }).catch((e) => e);
		expect(err).toBeInstanceOf(HttpException);
		expect((err as HttpException).getStatus()).toBe(400);
		expect((err as HttpException).getResponse()).toMatchObject({ code: "TUNNEL_REQUEST_INVALID" });
	});

	it("HttpException 原样透传", async () => {
		const original = new HttpException({ code: "AUTH_REQUIRED" }, 401);
		const { controller } = make({
			sessions: {
				create: vi.fn(async () => {
					throw original;
				}),
				close: vi.fn(),
			},
		});
		await expect(controller.create({}, ACTOR)).rejects.toBe(original);
	});
});
