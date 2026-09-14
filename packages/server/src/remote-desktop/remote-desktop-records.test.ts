import { describe, expect, it } from "vitest";
import {
	toRemoteDesktopAuditInfo,
	toRemoteDesktopSessionInfo,
	type RemoteDesktopAuditRecord,
	type RemoteDesktopSessionRecord,
} from "./remote-desktop-records.js";

function sessionRecord(
	overrides: Partial<RemoteDesktopSessionRecord> = {},
): RemoteDesktopSessionRecord {
	return {
		id: "session-1",
		clientId: "client-1",
		createdByIdentityId: "identity-1",
		createdByName: "admin",
		status: "ready",
		selectedDisplayId: "display-1",
		qualityProfile: "balanced",
		clipboardMode: "off",
		protocolVersion: 1,
		hostGeneration: "generation-1",
		createdAt: new Date("2026-09-11T00:00:00.000Z"),
		connectedAt: null,
		detachedAt: null,
		endedAt: null,
		safeErrorCode: null,
		safeErrorMessage: null,
		displaysJson: JSON.stringify([
			{
				id: "display-1",
				label: "Primary",
				width: 1920,
				height: 1080,
				physical: true,
				virtual: false,
				primary: true,
				rotation: 0,
				scalePercent: 100,
			},
		]),
		attachmentSecretHash: "must-not-leak",
		...overrides,
	};
}

function auditRecord(
	overrides: Partial<RemoteDesktopAuditRecord> = {},
): RemoteDesktopAuditRecord {
	return {
		id: "audit-1",
		sessionId: "session-1",
		clientId: "client-1",
		event: "session.created",
		identityId: "identity-1",
		actorName: "admin",
		attachmentId: null,
		role: null,
		result: "ok",
		reason: null,
		createdAt: new Date("2026-09-11T00:00:00.000Z"),
		...overrides,
	};
}

describe("toRemoteDesktopSessionInfo", () => {
	it("projects only safe session metadata", () => {
		const info = toRemoteDesktopSessionInfo(sessionRecord());
		expect(info).toMatchObject({
			id: "session-1",
			status: "ready",
			selectedDisplayId: "display-1",
			qualityProfile: "balanced",
		});
		expect(info).not.toHaveProperty("attachmentSecretHash");
		expect(info).not.toHaveProperty("displaysJson");
	});

	it("rejects an unknown persisted status instead of guessing", () => {
		expect(() =>
			toRemoteDesktopSessionInfo(sessionRecord({ status: "live-ish" })),
		).toThrow(/status/);
	});

	it("parses safe display metadata and preserves null lifecycle dates", () => {
		const info = toRemoteDesktopSessionInfo(
			sessionRecord({
				displaysJson: JSON.stringify([
					{
						id: "display-1",
						label: "Primary",
						width: 1920,
						height: 1080,
						physical: true,
						virtual: false,
						primary: true,
						rotation: 0,
						scalePercent: 100,
					},
				]),
			}),
		);
		expect(info.displays).toHaveLength(1);
		expect(info.createdAt).toBe("2026-09-11T00:00:00.000Z");
		expect(info.connectedAt).toBeNull();
	});
});

describe("toRemoteDesktopAuditInfo", () => {
	it("maps the allowlisted audit event and omits sensitive fields", () => {
		const info = toRemoteDesktopAuditInfo(
			auditRecord({ role: "operator", attachmentId: "attachment-1" }),
		);
		expect(info).toMatchObject({
			event: "session.created",
			role: "operator",
			attachmentId: "attachment-1",
		});
		expect(info).not.toHaveProperty("sdp");
		expect(info).not.toHaveProperty("candidate");
		expect(info).not.toHaveProperty("clipboardText");
	});

	it("rejects an unknown audit event instead of emitting a guessed event", () => {
		expect(() =>
			toRemoteDesktopAuditInfo(auditRecord({ event: "input.logged" })),
		).toThrow(/event/);
	});
});
