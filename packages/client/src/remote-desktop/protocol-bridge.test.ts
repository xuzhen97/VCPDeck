import { describe, expect, it, vi } from "vitest";
import { Events, type RemoteDesktopCapabilityStatus } from "@vcpdeck/shared";
import type { Socket } from "socket.io-client";
import { attachRemoteDesktopBridge } from "./protocol-bridge.js";

const unavailable: RemoteDesktopCapabilityStatus = {
	protocolVersion: 1,
	hostVersion: "test",
	available: false,
	backend: "unknown",
	capture: false,
	pointer: false,
	keyboard: false,
	clipboardText: false,
	loginScreen: false,
	lockScreen: false,
	secureAttention: false,
	physicalDisplay: false,
	virtualDisplay: false,
	headless: false,
	hardwareEncoders: [],
	supportedCodecs: [],
	diagnosticCode: "REMOTE_DESKTOP_HOST_OFFLINE",
};

function socket() {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	return {
		value: {
			connected: true,
			on: vi.fn((event: string, cb: (...args: unknown[]) => void) => { listeners.set(event, cb); }),
			emit: vi.fn(),
		} as unknown as Socket,
		listeners,
	};
}

describe("attachRemoteDesktopBridge", () => {
	it("does not attach operational handlers in migration verify-only mode", () => {
		const fake = socket();
		attachRemoteDesktopBridge(fake.value, {
			clientId: "c1",
			getCapability: () => unavailable,
			probeCapability: async () => unavailable,
		}, { verifyOnly: true });
		expect(fake.value.on).not.toHaveBeenCalledWith(Events.REMOTE_DESKTOP_REQUEST, expect.anything());
	});

	it("reports a safe unavailable capability when probe fails", async () => {
		const fake = socket();
		const probe = attachRemoteDesktopBridge(fake.value, {
			clientId: "c1",
			getCapability: () => undefined,
			probeCapability: async () => unavailable,
		});
		expect(await probe.probe()).toMatchObject({ available: false, diagnosticCode: "REMOTE_DESKTOP_HOST_OFFLINE" });
	});
});
