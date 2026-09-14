import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	REMOTE_DESKTOP_ERROR_CODES,
	REMOTE_DESKTOP_PROTOCOL_VERSION,
	RemoteDesktopProtocolError,
	type RemoteDesktopSessionStatus,
	parseRemoteDesktopBrowserAttach,
	parseRemoteDesktopBrowserAttached,
	parseRemoteDesktopBrowserDetach,
	parseRemoteDesktopBrowserSignal,
	parseRemoteDesktopBrowserTakeover,
	parseRemoteDesktopCapabilityStatus,
	parseRemoteDesktopControlMessage,
	parseRemoteDesktopHostControlMessage,
	parseRemoteDesktopClipboardMessage,
	parseRemoteDesktopSignal,
	type RemoteDesktopCapabilityStatus,
} from "./remote-desktop.js";
import { parseMachineRegister } from "./machine-register.js";

interface ProtocolFixture {
	cases: Array<{ kind: string; valid: boolean; payload: unknown }>;
}

const fixture = JSON.parse(
	readFileSync("protocol-fixtures/remote-desktop-v1.json", "utf8"),
) as ProtocolFixture;

describe("Remote Desktop protocol", () => {
	it("keeps the shared fixture control and clipboard cases strict", () => {
		const cases = fixture.cases.filter((entry) => entry.kind === "control" || entry.kind === "clipboard");
		expect(cases).toHaveLength(8);
		for (const entry of cases) {
			const parser = entry.kind === "control" ? parseRemoteDesktopControlMessage : parseRemoteDesktopClipboardMessage;
			if (entry.valid) expect(() => parser(entry.payload)).not.toThrow();
			else expect(() => parser(entry.payload)).toThrow(RemoteDesktopProtocolError);
		}
	});

	it("strictly parses a v1 offer and rejects unknown fields", () => {
		expect(parseRemoteDesktopSignal({ kind: "offer", sdp: "v=0\r\n" })).toEqual({
			kind: "offer",
			sdp: "v=0\r\n",
		});
		expect(() =>
			parseRemoteDesktopSignal({ kind: "offer", sdp: "v=0\r\n", actorId: "forged" }),
		).toThrow(RemoteDesktopProtocolError);
	});

	it("enforces signal byte and candidate limits", () => {
		expect(() =>
			parseRemoteDesktopSignal({ kind: "offer", sdp: "x".repeat(262_145) }),
		).toThrow(/字节/);
		expect(() =>
			parseRemoteDesktopSignal({
				kind: "ice",
				candidate: "candidate:1",
				sdpMid: "0",
				sdpMLineIndex: 0,
				candidateCount: 2,
			} as unknown),
		).toThrow(RemoteDesktopProtocolError);
	});

	it("uses canonical camelCase fields for control input and rejects snake_case drift", () => {
		expect(parseRemoteDesktopControlMessage({
			type: "input",
			event: { kind: "wheel", deltaX: 4, deltaY: -12 },
		})).toEqual({
			type: "input",
			event: { kind: "wheel", deltaX: 4, deltaY: -12 },
		});
		expect(parseRemoteDesktopControlMessage({
			type: "input",
			event: { kind: "key", keyCode: 65, pressed: true },
		})).toEqual({
			type: "input",
			event: { kind: "key", keyCode: 65, pressed: true },
		});
		expect(parseRemoteDesktopControlMessage({ type: "release-all" })).toEqual({
			type: "release-all",
		});
		expect(parseRemoteDesktopControlMessage({ type: "secure-attention" })).toEqual({
			type: "secure-attention",
		});
		// Ctrl+Alt+Del 不能作为普通 keyCode 下发，只能走这条专用消息。
		expect(() => parseRemoteDesktopControlMessage({
			type: "secure-attention",
			keyCode: 46,
		})).toThrow(RemoteDesktopProtocolError);
		expect(() => parseRemoteDesktopControlMessage({
			type: "secure_attention",
		})).toThrow(RemoteDesktopProtocolError);
		expect(() => parseRemoteDesktopControlMessage({
			type: "release-all",
			extra: 1,
		})).toThrow(RemoteDesktopProtocolError);
		expect(() => parseRemoteDesktopControlMessage({
			type: "input",
			event: { kind: "wheel", delta_x: 4, delta_y: -12 },
		})).toThrow(RemoteDesktopProtocolError);
		expect(() => parseRemoteDesktopControlMessage({
			type: "input",
			event: { kind: "key", key_code: 65, pressed: true },
		})).toThrow(RemoteDesktopProtocolError);
	});

	it("strictly parses display commands and host layout updates", () => {
		expect(parseRemoteDesktopControlMessage({
			type: "display-select",
			displayId: "display-2",
		})).toEqual({ type: "display-select", displayId: "display-2" });
		expect(parseRemoteDesktopControlMessage({
			type: "layout-confirm",
			layoutGeneration: 8,
		})).toEqual({ type: "layout-confirm", layoutGeneration: 8 });
		expect(parseRemoteDesktopHostControlMessage({
			type: "layout-update",
			layoutGeneration: 8,
			displayId: "display-2",
			width: 1920,
			height: 1080,
		})).toEqual({
			type: "layout-update",
			layoutGeneration: 8,
			displayId: "display-2",
			width: 1920,
			height: 1080,
		});
		expect(() => parseRemoteDesktopControlMessage({
			type: "display-select",
			display_id: "display-2",
		})).toThrow(RemoteDesktopProtocolError);
		expect(() => parseRemoteDesktopHostControlMessage({
			type: "layout-update",
			layoutGeneration: 8,
			displayId: "display-2",
			width: 1920,
			height: 1080,
			forged: true,
		})).toThrow(RemoteDesktopProtocolError);
	});

	it("strictly parses browser attachment lifecycle messages", () => {
		expect(parseRemoteDesktopBrowserAttached({
			sessionId: "session-1",
			attachmentId: "attachment-1",
			role: "operator",
			reconnectToken: "token",
			controlProtectedUntil: null,
			iceConfig: { policy: "p2p-only", iceServers: [], expiresAt: null },
		})).toEqual({
			sessionId: "session-1",
			attachmentId: "attachment-1",
			role: "operator",
			reconnectToken: "token",
			controlProtectedUntil: null,
			iceConfig: { policy: "p2p-only", iceServers: [], expiresAt: null },
		});
		expect(() => parseRemoteDesktopBrowserAttached({
			sessionId: "session-1",
			attachmentId: "attachment-1",
			role: "operator",
			reconnectToken: "token",
			controlProtectedUntil: null,
			iceConfig: { policy: "p2p-only", iceServers: [], expiresAt: null },
			forged: true,
		})).toThrow(RemoteDesktopProtocolError);
		expect(parseRemoteDesktopBrowserAttach({ sessionId: "session-1", reconnectToken: "token" })).toEqual({
			sessionId: "session-1",
			reconnectToken: "token",
		});
		expect(parseRemoteDesktopBrowserDetach({ sessionId: "session-1", attachmentId: "attachment-1" })).toEqual({
			sessionId: "session-1",
			attachmentId: "attachment-1",
		});
		expect(parseRemoteDesktopBrowserSignal({
			sessionId: "session-1",
			attachmentId: "attachment-1",
			signal: { kind: "offer", sdp: "v=0\\r\\n" },
		})).toEqual({
			sessionId: "session-1",
			attachmentId: "attachment-1",
			signal: { kind: "offer", sdp: "v=0\\r\\n" },
		});
		expect(parseRemoteDesktopBrowserTakeover({ sessionId: "session-1", attachmentId: "attachment-1" })).toEqual({
			sessionId: "session-1",
			attachmentId: "attachment-1",
		});
	});

	it("rejects forged browser attachment fields and malformed signal payloads", () => {
		expect(() => parseRemoteDesktopBrowserDetach({
			sessionId: "session-1",
			attachmentId: "attachment-1",
			role: "operator",
		})).toThrow(RemoteDesktopProtocolError);
		expect(() => parseRemoteDesktopBrowserSignal({
			sessionId: "session-1",
			attachmentId: "attachment-1",
			signal: { kind: "answer", sdp: "v=0\\r\\n", actorId: "forged" },
		})).toThrow(RemoteDesktopProtocolError);
	});

	it("requires self-consistent headless capability", () => {
		const value: RemoteDesktopCapabilityStatus = {
			protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
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
			physicalDisplay: false,
			virtualDisplay: false,
			headless: true,
			hardwareEncoders: [],
			supportedCodecs: ["H264", "VP8"],
		};
		expect(() => parseRemoteDesktopCapabilityStatus(value)).toThrow(/headless/);
	});

	it("keeps secure attention capability explicit and driven by the backend", () => {
		// Ctrl+Alt+Del 无法用普通按键注入送达，必须由平台 API 完成，
		// 因此能力必须显式声明；未声明时 Browser 不得展示该动作。
		const base = {
			protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
			hostVersion: "0.7.0",
			available: true,
			backend: "windows" as const,
			capture: true,
			pointer: true,
			keyboard: true,
			clipboardText: true,
			loginScreen: true,
			lockScreen: true,
			physicalDisplay: true,
			virtualDisplay: false,
			headless: false,
			hardwareEncoders: [],
			supportedCodecs: ["H264"] as const,
		};
		// 未声明 secureAttention 时一律视为不支持，不能默认为 true。
		expect(parseRemoteDesktopCapabilityStatus({ ...base }).secureAttention).toBe(false);
		expect(
			parseRemoteDesktopCapabilityStatus({ ...base, secureAttention: true }).secureAttention,
		).toBe(true);
		expect(() =>
			parseRemoteDesktopCapabilityStatus({ ...base, secureAttention: "yes" }),
		).toThrow(RemoteDesktopProtocolError);
	});

	it("rejects capability protocol mismatch and unknown fields", () => {
		expect(() =>
			parseRemoteDesktopCapabilityStatus({
				protocolVersion: 2,
				hostVersion: "0.7.0",
				available: false,
				backend: "x11",
				capture: false,
				pointer: false,
				keyboard: false,
				clipboardText: false,
				loginScreen: false,
				lockScreen: false,
				physicalDisplay: false,
				virtualDisplay: false,
				headless: false,
				hardwareEncoders: [],
				supportedCodecs: [],
				extra: true,
			}),
		).toThrow(RemoteDesktopProtocolError);
	});

	it("parses strict machine registration capability and final installation mode", () => {
		const parsed = parseMachineRegister({
			clientId: "client-1",
			hostname: "host",
			os: "win32",
			cpuModel: "cpu",
			totalMemMB: 1024,
			clientVersion: "0.7.0",
			capabilities: ["exec"],
			capabilityDetails: {
				remoteDesktop: {
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
					physicalDisplay: true,
					virtualDisplay: true,
					headless: true,
					hardwareEncoders: ["h264"],
					supportedCodecs: ["H264", "VP8"],
				},
			},
			installation: { mode: "system-supervisor" },
		});
		expect(parsed.capabilityDetails?.remoteDesktop?.backend).toBe("windows");
		expect(parsed.installation).toEqual({ mode: "system-supervisor" });
	});

	it("exposes stable errors and statuses", () => {
		expect(REMOTE_DESKTOP_ERROR_CODES).toContain("REMOTE_DESKTOP_INPUT_FROZEN");
		const status: RemoteDesktopSessionStatus = "interrupted";
		expect(status).toBe("interrupted");
	});
});
