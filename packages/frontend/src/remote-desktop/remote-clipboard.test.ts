import { describe, expect, it, vi } from "vitest";
import {
	createRemoteDesktopClipboard,
	parseRemoteDesktopClipboardMessage,
} from "./remote-clipboard.js";

function channel() {
	const sent: string[] = [];
	return { sent, readyState: "open", send: (value: string) => sent.push(value) };
}

describe("remote desktop clipboard", () => {
	it("strictly parses clipboard messages and rejects unknown fields or oversized text", () => {
		expect(parseRemoteDesktopClipboardMessage({
			type: "remote-to-browser",
			text: "hello",
		})).toEqual({ type: "remote-to-browser", text: "hello" });
		expect(() => parseRemoteDesktopClipboardMessage({
			type: "remote-to-browser",
			text: "hello",
			forged: true,
		})).toThrow();
		expect(() => parseRemoteDesktopClipboardMessage({
			type: "browser-to-remote",
			text: "x".repeat(262_145),
		})).toThrow();
	});

	it("sends browser text only for an operator and an allowed clipboard mode", () => {
		const control = channel();
		const clipboard = createRemoteDesktopClipboard({
			channel: control,
			mode: "browser-to-remote",
			role: "operator",
		});
		clipboard.sendBrowserText("hello");
		expect(control.sent).toEqual([
			JSON.stringify({ type: "browser-to-remote", text: "hello" }),
		]);
		expect(() => createRemoteDesktopClipboard({
			channel: channel(),
			mode: "off",
			role: "operator",
		}).sendBrowserText("blocked")).toThrow();
		expect(() => createRemoteDesktopClipboard({
			channel: channel(),
			mode: "bidirectional",
			role: "viewer",
		}).sendBrowserText("blocked")).toThrow();
	});

	it("ignores non-clipboard control messages", () => {
		const clipboard = createRemoteDesktopClipboard({
			channel: channel(),
			mode: "bidirectional",
			role: "operator",
		});
		expect(clipboard.handleMessage({
			type: "challenge",
			nonce: Array(32).fill(1),
			attachment_id: "a1",
		})).toBe(false);
		expect(clipboard.handleMessage({ type: "release-all" })).toBe(false);
	});

	it("stores remote text and writes it only after an explicit copy action", async () => {
		const writeText = vi.fn(async (_text: string) => undefined);
		const onRemoteText = vi.fn();
		const clipboard = createRemoteDesktopClipboard({
			channel: channel(),
			mode: "bidirectional",
			role: "operator",
			writeText,
			onRemoteText,
		});
		expect(clipboard.handleMessage({ type: "remote-to-browser", text: "remote" })).toBe(true);
		expect(onRemoteText).toHaveBeenCalledWith("remote");
		expect(writeText).not.toHaveBeenCalled();
		await clipboard.copyRemoteText();
		expect(writeText).toHaveBeenCalledWith("remote");
	});
});
