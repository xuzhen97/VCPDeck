import { describe, expect, it, vi } from "vitest";
import { RemoteDevPortService } from "./remote-dev-port.service.js";
import { ACTOR } from "./test-helpers.js";

function prismaWith(input: {
	portStatus?: string;
	sessionState?: string;
	ownerIdentityId?: string | null;
}) {
	return {
		remoteDevPort: {
			findUnique: vi.fn().mockResolvedValue({
				id: "p1",
				sessionId: "r1",
				remotePort: 3000,
				status: input.portStatus ?? "open",
			}),
		},
		remoteDevSession: {
			findUnique: vi.fn().mockResolvedValue({
				ownerIdentityId:
					input.ownerIdentityId === undefined ? ACTOR.identityId : input.ownerIdentityId,
				state: input.sessionState ?? "active",
			}),
		},
	};
}

describe("RemoteDevPortService", () => {
	it("forward token 过期后拒绝", async () => {
		const service = RemoteDevPortService.withDeps({ now: () => 1_000 });
		const token = await service.issueForwardToken("r1", "p1", ACTOR);
		expect(service.validateToken("r1", "p1", token.token, 1_000)).toBe(true);
		expect(service.validateToken("r1", "p1", token.token, 1_000 + 11 * 60_000)).toBe(false);
	});

	it("错误 token 或错误 session 拒绝", async () => {
		const service = RemoteDevPortService.withDeps({ now: () => 1_000 });
		const token = await service.issueForwardToken("r1", "p1", ACTOR);
		expect(service.validateToken("r1", "p1", "wrong", 1_000)).toBe(false);
		expect(service.validateToken("r2", "p1", token.token, 1_000)).toBe(false);
	});

	it("有 Prisma 时校验端口、会话状态与 owner", async () => {
		const service = RemoteDevPortService.withDeps({
			prisma: prismaWith({}) as never,
			now: () => 1_000,
		});
		await expect(service.issueForwardToken("r1", "p1", ACTOR)).resolves.toMatchObject({
			token: expect.any(String),
		});
	});

	it("拒绝非 owner、已关闭端口与非活动会话", async () => {
		const other = { ...ACTOR, identityId: "id-2" };
		const notOwner = RemoteDevPortService.withDeps({
			prisma: prismaWith({}) as never,
		});
		await expect(notOwner.issueForwardToken("r1", "p1", other)).rejects.toMatchObject({
			code: "RDS_OPERATOR_REQUIRED",
		});

		const closedPort = RemoteDevPortService.withDeps({
			prisma: prismaWith({ portStatus: "closed" }) as never,
		});
		await expect(
			closedPort.issueForwardToken("r1", "p1", ACTOR),
		).rejects.toMatchObject({ code: "RDS_PORT_INVALID" });

		const closedSession = RemoteDevPortService.withDeps({
			prisma: prismaWith({ sessionState: "closed" }) as never,
		});
		await expect(
			closedSession.issueForwardToken("r1", "p1", ACTOR),
		).rejects.toMatchObject({ code: "RDS_PORT_INVALID" });
	});
});
