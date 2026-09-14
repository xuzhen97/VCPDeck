import { describe, expect, it, vi } from "vitest";
import { RemoteDesktopAuditService } from "./remote-desktop-audit.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";

type FakeRemoteDesktopAuditPrisma = {
	remoteDesktopAuditEvent: {
		create: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
		count: ReturnType<typeof vi.fn>;
	};
};

function makePrisma(): PrismaService & FakeRemoteDesktopAuditPrisma {
	const create = vi.fn();
	const findMany = vi.fn();
	const count = vi.fn();
	return {
		remoteDesktopAuditEvent: { create, findMany, count },
	} as unknown as PrismaService & FakeRemoteDesktopAuditPrisma;
}

describe("RemoteDesktopAuditService", () => {
	it("records only allowlisted lifecycle metadata", async () => {
		const prisma = makePrisma();
		const service = new RemoteDesktopAuditService(prisma);
		await service.record({
			sessionId: "session-1",
			clientId: "client-1",
			event: "session.created",
			identityId: "identity-1",
			actorName: "admin",
			attachmentId: null,
			role: null,
			result: "ok",
			reason: undefined,
			// @ts-expect-error 附加敏感字段不属于窄请求
			clipboardText: "secret",
		});
		const data = prisma.remoteDesktopAuditEvent.create.mock.calls[0]?.[0]?.data;
		expect(data).toEqual({
			id: expect.any(String),
			sessionId: "session-1",
			clientId: "client-1",
			event: "session.created",
			identityId: "identity-1",
			actorName: "admin",
			attachmentId: null,
			role: null,
			result: "ok",
			reason: null,
		});
		expect(JSON.stringify(data)).not.toContain("secret");
	});

	it("rejects unknown events", async () => {
		const prisma = makePrisma();
		const service = new RemoteDesktopAuditService(prisma);
		await expect(
			service.record({
				sessionId: "s",
				clientId: "c",
				event: "input.logged" as never,
				identityId: null,
				actorName: null,
				attachmentId: null,
				role: null,
				result: "ok",
			}),
		).rejects.toThrow();
		expect(prisma.remoteDesktopAuditEvent.create).not.toHaveBeenCalled();
	});

	it("lists with parallel count and safe projection", async () => {
		const prisma = makePrisma();
		prisma.remoteDesktopAuditEvent.findMany.mockResolvedValue([
			{
				id: "a1",
				sessionId: "s1",
				clientId: "c1",
				event: "session.created",
				identityId: null,
				actorName: null,
				attachmentId: null,
				role: null,
				result: "ok",
				reason: null,
				createdAt: new Date("2026-09-11T00:00:00.000Z"),
			},
		]);
		prisma.remoteDesktopAuditEvent.count.mockResolvedValue(1);
		const service = new RemoteDesktopAuditService(prisma);
		const result = await service.list({ sessionId: "s1", clientId: "c1" }, 1, 20);
		expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
		expect(result.data[0]).not.toHaveProperty("clipboardText");
		expect(prisma.remoteDesktopAuditEvent.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
			where: { sessionId: "s1", clientId: "c1" },
			orderBy: { createdAt: "desc" },
			skip: 0,
			take: 20,
		}),
	);
	});
});
