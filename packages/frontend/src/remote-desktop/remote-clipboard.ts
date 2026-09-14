import type { RemoteDesktopClipboardMode, RemoteDesktopRole } from "@vcpdeck/shared";

const MAX_CLIPBOARD_BYTES = 262_144;

type RemoteDesktopClipboardType = "browser-to-remote" | "remote-to-browser";

export interface RemoteDesktopClipboardMessage {
	type: RemoteDesktopClipboardType;
	text: string;
}

export interface RemoteDesktopClipboardChannel {
	readonly readyState?: string;
	send(data: string): void;
}

export interface RemoteDesktopClipboardOptions {
	channel: RemoteDesktopClipboardChannel;
	mode: RemoteDesktopClipboardMode;
	role: RemoteDesktopRole;
	writeText?: (text: string) => Promise<void>;
	onRemoteText?: (text: string) => void;
}

export interface RemoteDesktopClipboard {
	sendBrowserText(text: string): void;
	handleMessage(value: unknown): boolean;
	copyRemoteText(): Promise<void>;
	remoteText(): string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textBytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/** 严格解析 WebRTC 剪贴板消息，只允许纯文本和固定字段。 */
export function parseRemoteDesktopClipboardMessage(
	value: unknown,
): RemoteDesktopClipboardMessage {
	if (!isRecord(value)) throw new Error("剪贴板消息必须是对象");
	const keys = Object.keys(value);
	if (keys.length !== 2 || !keys.includes("type") || !keys.includes("text")) {
		throw new Error("剪贴板消息包含未知字段");
	}
	if (value.type !== "browser-to-remote" && value.type !== "remote-to-browser") {
		throw new Error("剪贴板消息类型不受支持");
	}
	if (typeof value.text !== "string") throw new Error("剪贴板内容必须是文本");
	if (textBytes(value.text) > MAX_CLIPBOARD_BYTES) {
		throw new Error("剪贴板内容超过大小限制");
	}
	return { type: value.type, text: value.text };
}

function assertText(text: string): void {
	if (textBytes(text) > MAX_CLIPBOARD_BYTES) {
		throw new Error("剪贴板内容超过大小限制");
	}
}

function send(channel: RemoteDesktopClipboardChannel, message: RemoteDesktopClipboardMessage): void {
	if (channel.readyState !== undefined && channel.readyState !== "open") {
		throw new Error("剪贴板通道未连接");
	}
	channel.send(JSON.stringify(message));
}

/** 浏览器剪贴板控制器：默认不启用，且只允许已授权 Operator 使用。 */
export function createRemoteDesktopClipboard(
	options: RemoteDesktopClipboardOptions,
): RemoteDesktopClipboard {
	let remoteText: string | null = null;
	const writeText = options.writeText ?? (async (text: string) => {
		if (typeof navigator === "undefined" || !navigator.clipboard) {
			throw new Error("浏览器剪贴板不可用");
		}
		await navigator.clipboard.writeText(text);
	});

	const canSend =
		options.role === "operator" &&
		(options.mode === "browser-to-remote" || options.mode === "bidirectional");
	const canReceive = options.role === "operator" && options.mode === "bidirectional";

	return {
		sendBrowserText: (text) => {
			if (!canSend) throw new Error("当前 attachment 不允许写入远端剪贴板");
			assertText(text);
			send(options.channel, { type: "browser-to-remote", text });
		},
		handleMessage: (value) => {
			if (!isRecord(value) || value.type !== "browser-to-remote" && value.type !== "remote-to-browser") {
				return false;
			}
			const message = parseRemoteDesktopClipboardMessage(value);
			if (message.type !== "remote-to-browser" || !canReceive) return false;
			remoteText = message.text;
			options.onRemoteText?.(message.text);
			return true;
		},
		copyRemoteText: async () => {
			if (!canReceive) throw new Error("当前 attachment 不允许读取远端剪贴板");
			if (remoteText === null) throw new Error("没有可复制的远端剪贴板内容");
			await writeText(remoteText);
		},
		remoteText: () => remoteText,
	};
}
