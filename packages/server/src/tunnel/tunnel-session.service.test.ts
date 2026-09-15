import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Events, type ActorContext } from "@vcpdeck/shared";
import {
	TunnelSessionError,
	TunnelSessionService,
} from "./tunnel-session.service.js";

const ACTOR: ActorContext = {
	identityId: "op-1",
	displayName: "op",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "r1",
};
const OTHER_ACTOR: ActorContext = { ...ACTOR, identityId: "op-2" };

type ClientRow = {
	id: string;
	online: boolean;
	socketId: string | null;
	capabilityDetails: string | null;
};
function make() {
	const findUnique = vi.fn(async (): Promise<ClientRow> => ({
		id: "c1",
		online: true,
		socketId: "client-socket",
		capabilityDetails: JSON.stringify({ p2pTunnel: { available: true, protocolVersion: 1 } }),
	}));
	const prisma = { client: { findUnique } };
	const config = {
		issueIceServers: vi.fn(async () => [{ urls: ["stun:turn.example.com:3478"] }]),
	};
	const sendClient = vi.fn();
	const sendBrowser = vi.fn();
	const service = new TunnelSessionService(config as never, prisma as never);
	service.bindClientSender(sendClient);
	service.bindBrowserSender(sendBrowser);
	return { service, findUnique, config, sendClient, sendBrowser, prisma };
}

describe("TunnelSessionService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("把 offer 转发到创建时绑定的 Client lease，并向其下发 prepare", async () => {
		const { service, sendClient } = make();
		const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
		expect(sendClient).toHaveBeenCalledWith(
			"client-socket",
			Events.TUNNEL_PREPARE,
			expect.objectContaining({ sessionId: created.sessionId, targetPort: 3000 }),
		);

		await service.signalFromBrowser("browser-socket", {
			sessionId: created.sessionId,
			description: { type: "offer", sdp: "v=0\r\n" },
		});
		expect(sendClient).toHaveBeenCalledWith(
			"client-socket",
			Events.TUNNEL_SIGNAL,
			expect.objectContaining({ sessionId: created.sessionId }),
		);
	});

	it("拒绝其他 Browser socket、其他 Client 和 answer 方向伪造", async () => {
		const { service } = make();
		const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
		const offer = { sessionId: created.sessionId, description: { type: "offer" as const, sdp: "v=0" } };
		const answer = { sessionId: created.sessionId, description: { type: "answer" as const, sdp: "v=0" } };

		await expect(service.signalFromBrowser("other-browser", offer)).rejects.toMatchObject({ code: "TUNNEL_FORBIDDEN" });
		await expect(service.signalFromClient("other-client-socket", answer)).rejects.toMatchObject({ code: "TUNNEL_FORBIDDEN" });
		await expect(service.signalFromBrowser("browser-socket", answer)).rejects.toMatchObject({ code: "TUNNEL_SIGNAL_INVALID" });
	});

	it("只把 Client answer 转发给已绑定 Browser", async () => {
		const { service, sendBrowser } = make();
		const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
		await service.signalFromClient("client-socket", {
			sessionId: created.sessionId,
			description: { type: "answer", sdp: "v=0" },
		});
		expect(sendBrowser).toHaveBeenCalledWith(
			"browser-socket",
			Events.TUNNEL_SIGNAL,
			expect.objectContaining({ sessionId: created.sessionId }),
		);
	});

	it("Client failed 状态先通知 Browser 再释放 Session", async () => {
		const { service, sendBrowser } = make();
		const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
		await service.clientState("client-socket", {
			sessionId: created.sessionId,
			state: "failed",
			code: "TUNNEL_TARGET_REFUSED",
		});
		expect(sendBrowser).toHaveBeenCalledWith(
			"browser-socket",
			Events.TUNNEL_STATE,
			expect.objectContaining({ state: "failed" }),
		);
		expect(service.has(created.sessionId)).toBe(false);
	});

	it("60 秒未 attach 的 Session 被 sweep 释放，close 幂等", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
		const { service, sendClient } = make();
		const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		service.onModuleInit();
		vi.advanceTimersByTime(60_001);
		expect(service.has(created.sessionId)).toBe(false);
		await expect(service.close(created.sessionId, ACTOR)).resolves.toEqual({ closed: true });
		// 释放时向 client lease 发送 close
		expect(sendClient).toHaveBeenCalledWith("client-socket", Events.TUNNEL_CLOSE, {
			sessionId: created.sessionId,
		});
	});

	it("Client 离线 / 无 p2pTunnel 能力时创建失败", async () => {
		const { service, findUnique } = make();
		findUnique.mockResolvedValueOnce({ id: "c1", online: false, socketId: null, capabilityDetails: "{}" });
		await expect(service.create({ clientId: "c1", targetPort: 3000 }, ACTOR)).rejects.toMatchObject({
			code: "TUNNEL_CLIENT_UNAVAILABLE",
		});
		findUnique.mockResolvedValueOnce({ id: "c1", online: true, socketId: "s", capabilityDetails: "{}" });
		await expect(service.create({ clientId: "c1", targetPort: 3000 }, ACTOR)).rejects.toMatchObject({
			code: "TUNNEL_CLIENT_UNSUPPORTED",
		});
	});

	it("close 只对创建者生效，非创建者被拒绝", async () => {
		const { service } = make();
		const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		await expect(service.close(created.sessionId, OTHER_ACTOR)).rejects.toBeInstanceOf(TunnelSessionError);
		expect(service.has(created.sessionId)).toBe(true);
		await expect(service.close(created.sessionId, ACTOR)).resolves.toEqual({ closed: true });
	});

	it("Browser / Client 断线只释放匹配 lease 的 Session", async () => {
		const { service } = make();
		const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
		await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
		service.disconnectBrowser("unrelated");
		expect(service.has(created.sessionId)).toBe(true);
		service.disconnectClient("c1", "client-socket");
		expect(service.has(created.sessionId)).toBe(false);
	});
});
