import { describe, expect, it, vi } from "vitest";
import type { RemoteDesktopCapabilityStatus } from "@vcpdeck/shared";
import { probeRemoteDesktopCapability } from "./capability-probe.js";

const capability: RemoteDesktopCapabilityStatus = {
	protocolVersion: 1,
	hostVersion: "0.7.0",
	available: true,
	backend: "windows",
	capture: true,
	pointer: true,
	keyboard: true,
	clipboardText: true,
	loginScreen: true,
	lockScreen: true,
	secureAttention: false,
	physicalDisplay: true,
	virtualDisplay: false,
	headless: false,
	hardwareEncoders: ["h264"],
	supportedCodecs: ["H264", "VP8"],
};

describe("probeRemoteDesktopCapability", () => {
	it("closes the short-lived probe client after a successful capability response", async () => {
		const client = {
			request: vi.fn(async () => ({
				requestId: "probe-1",
				protocolVersion: 1 as const,
				hostGeneration: "host-1",
				ok: true as const,
				result: { capability },
			})),
			close: vi.fn(),
		};

		await expect(probeRemoteDesktopCapability({
			platform: "win32",
			connect: () => client as never,
		})).resolves.toEqual(capability);
		expect(client.close).toHaveBeenCalledTimes(1);
	});

	it("does not connect on unsupported platforms", async () => {
		const connect = vi.fn();
		await expect(probeRemoteDesktopCapability({
			platform: "darwin",
			connect: connect as never,
		})).resolves.toMatchObject({
			available: false,
			diagnosticCode: "REMOTE_DESKTOP_UNSUPPORTED",
		});
		expect(connect).not.toHaveBeenCalled();
	});
});
