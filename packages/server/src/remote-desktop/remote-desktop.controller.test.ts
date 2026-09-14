import { describe, expect, it, vi } from "vitest";
import {
	BadRequestException,
	ConflictException,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { ActorContext } from "@vcpdeck/shared";
import { RemoteDesktopController } from "./remote-desktop.controller.js";

const ACTOR: ActorContext = {
	identityId: "identity-1",
	displayName: "admin",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "request-1",
};

function sessionInfo(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "session-1",
		clientId: "client-1",
		createdByIdentityId: "identity-1",
		createdByName: "admin",
		status: "ready",
		selectedDisplayId: "display-1",
		displays: [],
		qualityProfile: "balanced",
		clipboardMode: "off",
		protocolVersion: 1,
		hostGeneration: "generation-1",
		createdAt: "2026-09-11T00:00:00.000Z",
		connectedAt: null,
		detachedAt: null,
		endedAt: null,
		safeErrorCode: null,
		safeErrorMessage: null,
		...overrides,
	};
}

function makeController() {
	const service = {
		listSessions: vi.fn(),
		getSession: vi.fn(),
		createSession: vi.fn(),
		closeSession: vi.fn(),
	};
	const audit = { list: vi.fn() };
	return {
		controller: new RemoteDesktopController(service as never, audit as never),
		service,
		audit,
	};
}

function err(code: string, message = "boom") {
	return Object.assign(new Error(message), { code });
}

describe("RemoteDesktopController", () => {
	it("GET sessions uses safe pagination and machine scope", async () => {
		const { controller, service } = makeController();
		service.listSessions.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
		await controller.list("client-1", "bad", "999", ACTOR);
		expect(service.listSessions).toHaveBeenCalledWith("client-1", 1, 100);
	});

	it("POST create strictly parses allowed options and passes actor", async () => {
		const { controller, service } = makeController();
		service.createSession.mockResolvedValue(sessionInfo());
		await controller.create(
			"client-1",
			{ qualityProfile: "low-bandwidth", clipboardMode: "browser-to-remote" },
			ACTOR,
		);
		expect(service.createSession).toHaveBeenCalledWith(
			"client-1",
			{ qualityProfile: "low-bandwidth", clipboardMode: "browser-to-remote" },
			ACTOR,
		);
	});

	it("POST create rejects unknown fields and unsupported options", async () => {
		const { controller, service } = makeController();
		await expect(controller.create("client-1", { qualityProfile: "balanced", secret: "x" }, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
		await expect(controller.create("client-1", { qualityProfile: "ultra" }, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
		expect(service.createSession).not.toHaveBeenCalled();
	});

	it("maps stable service errors and hides unknown details", async () => {
		const { controller, service } = makeController();
		service.createSession.mockRejectedValue(err("REMOTE_DESKTOP_SESSION_LIMIT"));
		await expect(controller.create("client-1", {}, ACTOR)).rejects.toBeInstanceOf(ConflictException);
		service.getSession.mockRejectedValue(err("REMOTE_DESKTOP_NO_ACTIVE_SESSION"));
		await expect(controller.get("client-1", "session-1", ACTOR)).rejects.toBeInstanceOf(NotFoundException);
		service.listSessions.mockRejectedValue(err("REMOTE_DESKTOP_HOST_OFFLINE"));
		await expect(controller.list("client-1", undefined, undefined, ACTOR)).rejects.toBeInstanceOf(ServiceUnavailableException);
		service.listSessions.mockRejectedValue(new Error("secret /root/.ssh/id_rsa"));
		await expect(controller.list("client-1", undefined, undefined, ACTOR)).rejects.toMatchObject({
			message: "Remote Desktop operation failed",
		});
	});

	it("GET detail, DELETE close and audit stay machine/session scoped", async () => {
		const { controller, service, audit } = makeController();
		service.getSession.mockResolvedValue(sessionInfo());
		service.closeSession.mockResolvedValue(sessionInfo({ status: "closed" }));
		audit.list.mockResolvedValue({ data: [], total: 0, page: 2, pageSize: 50, totalPages: 0 });
		await controller.get("client-1", "session-1", ACTOR);
		await controller.remove("client-1", "session-1", ACTOR);
		await controller.audit("client-1", "session-1", "2", "50", ACTOR);
		expect(service.getSession).toHaveBeenCalledWith("client-1", "session-1");
		expect(service.closeSession).toHaveBeenCalledWith("client-1", "session-1", ACTOR);
		expect(audit.list).toHaveBeenCalledWith({ sessionId: "session-1", clientId: "client-1" }, 2, 50);
	});
});
