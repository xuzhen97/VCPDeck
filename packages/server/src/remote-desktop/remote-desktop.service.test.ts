import { describe, expect, it, vi } from "vitest";
import type {
	ActorContext,
	RemoteDesktopClientResponse,
	RemoteDesktopSessionCreateRequest,
} from "@vcpdeck/shared";
import { RemoteDesktopService } from "./remote-desktop.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";

const actor: ActorContext = {
	identityId: "identity-1",
	displayName: "admin",
	isAdmin: true,
	credentialId: null,
	sessionId: "auth-session-1",
	source: "web",
	requestId: "request-1",
};
const createRequest: RemoteDesktopSessionCreateRequest = {
	qualityProfile: "balanced",
	clipboardMode: "off",
};

function display() {
	return {
		id: "display-1",
		label: "Primary",
		width: 1920,
		height: 1080,
		physical: true,
		virtual: false,
		primary: true,
		rotation: 0,
		scalePercent: 100,
	} as const;
}

function makePrisma() {
	const rows = new Map<string, Record<string, unknown>>();
	const clients = new Map<string, { id: string; online: boolean; socketId: string | null }>([
		["client-1", { id: "client-1", online: true, socketId: "socket-1" }],
	]);
	const client = {
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => clients.get(where.id) ?? null),
	};
	const remoteDesktopSession = {
		count: vi.fn(async ({ where }: { where: { clientId: string; status?: { in?: string[] } } }) =>
			[...rows.values()].filter((row) => {
				if (row.clientId !== where.clientId) return false;
				if (where.status?.in) return where.status.in.includes(row.status as string);
				return true;
			}).length,
		),
		create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
			const row = {
				...data,
				createdAt: new Date("2026-09-11T00:00:00.000Z"),
				connectedAt: null,
				detachedAt: null,
				endedAt: null,
				safeErrorCode: null,
				safeErrorMessage: null,
				hostGeneration: null,
			};
			rows.set(data.id as string, row);
			return row;
		}),
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
		findMany: vi.fn(async () => [...rows.values()]),
		update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
			const row = rows.get(where.id);
			if (!row) throw new Error("missing session");
			Object.assign(row, data);
			return row;
		}),
	};
	return {
		prisma: { client, remoteDesktopSession } as unknown as PrismaService,
		rows,
		clients,
		client,
		remoteDesktopSession,
	};
}

function successResponse(overrides: Partial<RemoteDesktopClientResponse> = {}): RemoteDesktopClientResponse {
	return {
		requestId: "host-request-1",
		protocolVersion: 1,
		hostGeneration: "generation-1",
		ok: true,
		result: { ready: true, displays: [display()] },
		...overrides,
	};
}

describe("RemoteDesktopService", () => {
	it("serializes create per client and allows only one active session", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const audit = { record: vi.fn(async () => undefined) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit,
		});

		const results = await Promise.allSettled([
			service.createSession("client-1", createRequest, actor),
			service.createSession("client-1", createRequest, actor),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
			reason: { code: "REMOTE_DESKTOP_SESSION_LIMIT" },
	});
		expect(broker.request).toHaveBeenCalledTimes(1);
	});

	it("prepares Host, stores only safe session metadata and returns ready", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});

		const info = await service.createSession("client-1", createRequest, actor);
		const data = fake.remoteDesktopSession.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(info).toMatchObject({ status: "ready", hostGeneration: "generation-1" });
		expect(info.displays).toHaveLength(1);
		expect(data).not.toHaveProperty("attachmentSecret");
		expect(data).not.toHaveProperty("sdp");
		expect(data).not.toHaveProperty("iceCandidate");
		expect(broker.request).toHaveBeenCalledWith(
		{ clientId: "client-1", socketId: "socket-1" },
		expect.objectContaining({
			action: "session.prepare",
			sessionId: expect.any(String),
			payload: { qualityProfile: "balanced", clipboardMode: "off" },
		}),
	);
	});

	it("marks a failed Host prepare with a stable safe error", async () => {
		const fake = makePrisma();
		const broker = {
			request: vi.fn(async () =>
				successResponse({
					ok: false,
					result: undefined,
					error: { code: "REMOTE_DESKTOP_CAPTURE_FAILED", message: "driver path leaked" },
				}),
			),
		};
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});

		await expect(service.createSession("client-1", createRequest, actor)).rejects.toMatchObject({
			code: "REMOTE_DESKTOP_CAPTURE_FAILED",
		});
		const row = [...fake.rows.values()][0];
		expect(row).toMatchObject({
			status: "error",
			safeErrorCode: "REMOTE_DESKTOP_CAPTURE_FAILED",
			safeErrorMessage: "driver path leaked",
		});
	});

	it("lists sessions with pagination and closes terminal state idempotently", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});
		const created = await service.createSession("client-1", createRequest, actor);
		const closed = await service.closeSession("client-1", created.id, actor);
		const again = await service.closeSession("client-1", created.id, actor);
		expect(closed.status).toBe("closed");
		expect(again.status).toBe("closed");
		expect(broker.request).toHaveBeenCalledTimes(2);
		const list = await service.listSessions("client-1", 1, 20);
		expect(list).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
	});

	it("fails closed when the Client lease is offline", async () => {
		const fake = makePrisma();
		fake.clients.set("client-offline", { id: "client-offline", online: false, socketId: null });
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: { request: vi.fn() } as never,
			audit: { record: vi.fn(async () => undefined) },
		});
		await expect(service.createSession("client-offline", createRequest, actor)).rejects.toMatchObject({
			code: "REMOTE_DESKTOP_HOST_OFFLINE",
		});
	});

	it("returns the per-attachment ICE config from the injected service", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const iceConfig = {
			policy: vi.fn(() => "p2p-only" as const),
			forAttachment: vi.fn(() => ({
				policy: "p2p-only" as const,
				iceServers: [{ urls: ["stun:desktop.example.test:3478"] }],
				expiresAt: null,
			})),
		};
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
			iceConfig: iceConfig as never,
		});
		const session = await service.createSession("client-1", createRequest, actor);
		const attached = await service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-1" });

		expect(iceConfig.forAttachment).toHaveBeenCalledWith(attached.attachmentId, actor.displayName);
		expect(attached.iceConfig).toEqual({
			policy: "p2p-only",
			iceServers: [{ urls: ["stun:desktop.example.test:3478"] }],
			expiresAt: null,
		});
	});

	it("assigns one operator and three viewers, supports protected reconnect, and enforces the attachment limit", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});
		const session = await service.createSession("client-1", createRequest, actor);
		const attached = await Promise.all([
			service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-1" }),
			service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-2" }),
			service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-3" }),
			service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-4" }),
		]);
		expect(attached.map((item: { role: string }) => item.role)).toEqual(["operator", "viewer", "viewer", "viewer"]);
		await expect(service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-5" })).rejects.toMatchObject({
			code: "REMOTE_DESKTOP_ATTACHMENT_LIMIT",
		});

		await service.detachBrowser({ sessionId: session.id, attachmentId: attached[0].attachmentId, socketId: "browser-1" });
		const reconnected = await service.attachBrowser({
			sessionId: session.id,
			actor,
			socketId: "browser-reconnected",
			reconnectToken: attached[0].reconnectToken,
		});
		expect(reconnected.role).toBe("operator");
	});

	it("reconciles a matching Host generation and cancels the disconnect watchdog", async () => {
		vi.useFakeTimers();
		try {
			const fake = makePrisma();
			const broker = { request: vi.fn(async () => successResponse()) };
			const service = RemoteDesktopService.withDeps({
				prisma: fake.prisma,
				broker: broker as never,
				audit: { record: vi.fn(async () => undefined) },
			});
			const session = await service.createSession("client-1", createRequest, actor);
			await service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-1" });
			await service.handleClientDisconnect("client-1", "socket-1");

			await expect(service.handleClientState("client-1", "socket-1", {
				protocolVersion: 1,
				hostGeneration: "generation-1",
				sessionId: session.id,
				status: "connected",
			})).resolves.toEqual({ accepted: true, action: "reconcile" });
			await vi.advanceTimersByTimeAsync(30_001);
			expect(broker.request).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ action: "session.close" }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("projects a connected Host state and updates the persisted generation", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});
		const session = await service.createSession("client-1", createRequest, actor);

		await expect(service.handleClientState("client-1", "socket-1", {
			protocolVersion: 1,
			hostGeneration: "generation-1",
			sessionId: session.id,
			status: "connected",
		})).resolves.toEqual({ accepted: true, action: "reconcile" });
		expect(await service.getSession("client-1", session.id)).toMatchObject({
			status: "connected",
			hostGeneration: "generation-1",
		});
	});

	it("marks persisted sessions interrupted when Host reports no active session", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});
		const session = await service.createSession("client-1", createRequest, actor);

		await expect(service.handleClientState("client-1", "socket-1", {
			protocolVersion: 1,
			hostGeneration: "generation-2",
			sessionId: null,
			status: "idle",
		})).resolves.toEqual({ accepted: true, action: "interrupted" });
		expect(await service.getSession("client-1", session.id)).toMatchObject({
			status: "interrupted",
			safeErrorCode: "REMOTE_DESKTOP_HOST_OFFLINE",
		});
	});

	it("closes a persisted session when Host reports closed", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});
		const session = await service.createSession("client-1", createRequest, actor);

		await expect(service.handleClientState("client-1", "socket-1", {
			protocolVersion: 1,
			hostGeneration: "generation-1",
			sessionId: session.id,
			status: "closed",
		})).resolves.toEqual({ accepted: true, action: "close" });
		expect(await service.getSession("client-1", session.id)).toMatchObject({ status: "closed" });
	});

	it("interrupts and clears runtime when Host generation changes", async () => {
		const fake = makePrisma();
		const broker = { request: vi.fn(async () => successResponse()) };
		const service = RemoteDesktopService.withDeps({
			prisma: fake.prisma,
			broker: broker as never,
			audit: { record: vi.fn(async () => undefined) },
		});
		const session = await service.createSession("client-1", createRequest, actor);
		await service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-1" });

		await expect(service.handleClientState("client-1", "socket-1", {
			protocolVersion: 1,
			hostGeneration: "generation-2",
			sessionId: session.id,
			status: "ready",
		})).resolves.toEqual({ accepted: true, action: "interrupted" });
		expect([...fake.rows.values()][0]).toMatchObject({
			status: "interrupted",
			safeErrorCode: "REMOTE_DESKTOP_PROTOCOL_MISMATCH",
		});
	});

	it("freezes immediately on Client disconnect and closes after the lease timeout", async () => {
		vi.useFakeTimers();
		try {
			const fake = makePrisma();
			const broker = { request: vi.fn(async () => successResponse()) };
			const service = RemoteDesktopService.withDeps({
				prisma: fake.prisma,
				broker: broker as never,
				audit: { record: vi.fn(async () => undefined) },
			});
			const session = await service.createSession("client-1", createRequest, actor);
			await service.attachBrowser({ sessionId: session.id, actor, socketId: "browser-1" });
			await service.handleClientDisconnect("client-1", "socket-1");
			expect(broker.request).toHaveBeenCalledWith(
				{ clientId: "client-1", socketId: "socket-1" },
				expect.objectContaining({ action: "session.freeze-input", sessionId: session.id }),
			);
			await vi.advanceTimersByTimeAsync(30_001);
			expect(broker.request).toHaveBeenCalledWith(
				{ clientId: "client-1", socketId: "socket-1" },
				expect.objectContaining({ action: "session.close", sessionId: session.id }),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
