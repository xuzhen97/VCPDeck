import { describe, expect, it, vi } from "vitest";
import { RemoteDesktopSignalingService } from "./remote-desktop-signaling.service.js";

describe("RemoteDesktopSignalingService", () => {
	it("limits cumulative signaling bytes, candidates and message rate per attachment", () => {
		let now = 1_000;
		const service = new RemoteDesktopSignalingService(() => now);
		service.acceptBrowserSignal("attachment-1", {
			kind: "offer",
			sdp: "v=0\\r\\n",
		});
		for (let index = 0; index < 256; index += 1) {
			now += 1_001;
			service.acceptBrowserSignal("attachment-1", {
				kind: "ice",
				candidate: `candidate:${index}`,
			});
		}
		now += 1_001;
		expect(() => service.acceptBrowserSignal("attachment-1", {
			kind: "ice",
			candidate: "candidate:overflow",
		})).toThrowError(/candidate|signal/i);
	});

	it("allows only browser offers and host answers while allowing ICE both ways", () => {
		const service = new RemoteDesktopSignalingService(() => 1_000);
		service.acceptBrowserSignal("attachment-1", { kind: "offer", sdp: "offer" });
		service.acceptBrowserSignal("attachment-1", { kind: "ice", candidate: "candidate:1" });
		service.acceptHostSignal("attachment-1", { kind: "answer", sdp: "answer" });
		service.acceptHostSignal("attachment-1", { kind: "ice", candidate: "candidate:2" });
		expect(() => service.acceptBrowserSignal("attachment-1", { kind: "answer", sdp: "forged" })).toThrowError(/direction/i);
		expect(() => service.acceptHostSignal("attachment-1", { kind: "offer", sdp: "forged" })).toThrowError(/direction/i);
	});

	it("resets detached attachment counters", () => {
		const service = new RemoteDesktopSignalingService(() => 1_000);
		service.acceptBrowserSignal("attachment-1", { kind: "offer", sdp: "offer" });
		service.reset("attachment-1");
		for (let index = 0; index < 30; index += 1) {
			service.acceptBrowserSignal("attachment-1", { kind: "ice", candidate: `candidate:${index}` });
		}
		expect(() => service.acceptBrowserSignal("attachment-1", { kind: "ice", candidate: "candidate:31" })).toThrowError(/rate/i);
	});
});
