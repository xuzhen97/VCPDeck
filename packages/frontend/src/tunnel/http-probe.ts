const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 2048;
const DEFAULT_TIMEOUT_MS = 15_000;

/** HTTP probe 结果：仅 statusLine 与文本 body（不注入 DOM）。 */
export interface HttpProbeResult {
	statusLine: string;
	body: string;
}

/** 最小 DataChannel 接口（浏览器 RTCDataChannel 满足）。 */
export interface ProbeChannel {
	send(data: Uint8Array): void;
	onmessage: ((e: { data: ArrayBuffer | Uint8Array }) => void) | null;
	onclose: (() => void) | null;
	onerror: ((e?: unknown) => void) | null;
	close(): void;
}

/**
 * 通过已建立的隧道 DataChannel 对目标回环 HTTP 服务发起一次固定 GET。
 * 只允许 `/` 开头、≤2048、不含 CR/LF 的 path；不发送 Accept-Encoding；累计 ≤1 MiB；
 * 以单个 TextDecoder 解码并在首个 `\r\n\r\n` 分割 statusLine 与 body。15s 超时。
 */
export function probeHttp(
	channel: ProbeChannel,
	path: string,
	opts: { timeoutMs?: number } = {},
): Promise<HttpProbeResult> {
	if (
		typeof path !== "string" ||
		!path.startsWith("/") ||
		path.length > MAX_PATH_BYTES ||
		path.includes("\r") ||
		path.includes("\n")
	) {
		return Promise.reject(Object.assign(new Error("path 非法"), { code: "TUNNEL_HTTP_PATH_INVALID" }));
	}

	const requestBytes = new TextEncoder().encode(
		`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
	);
	const decoder = new TextDecoder();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let done = false;

	return new Promise<HttpProbeResult>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			cleanup();
			reject(Object.assign(new Error("probe 超时"), { code: "TUNNEL_HTTP_TIMEOUT" }));
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		((timer as unknown) as { unref?: () => void }).unref?.();

		const cleanup = (): void => {
			clearTimeout(timer);
			channel.onmessage = null;
			channel.onclose = null;
			channel.onerror = null;
		};

		const decodeAll = (): string => {
			let out = "";
			for (const c of chunks) out += decoder.decode(c, { stream: true });
			out += decoder.decode();
			return out;
		};

		const finish = (): void => {
			if (done) return;
			done = true;
			cleanup();
			const text = decodeAll();
			const idx = text.indexOf("\r\n\r\n");
			if (idx === -1) {
				if (text.length === 0) {
					reject(Object.assign(new Error("空响应"), { code: "TUNNEL_HTTP_EMPTY" }));
				} else {
					resolve({ statusLine: text, body: "" });
				}
				return;
			}
			const head = text.slice(0, idx);
			const statusLine = head.split("\r\n")[0] ?? "";
			const body = text.slice(idx + 4);
			resolve({ statusLine, body });
		};

		channel.onmessage = (e: { data: ArrayBuffer | Uint8Array }) => {
			if (done) return;
			const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : (e.data as Uint8Array);
			chunks.push(data);
			total += data.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				done = true;
				cleanup();
				reject(Object.assign(new Error("响应超限"), { code: "TUNNEL_HTTP_RESPONSE_TOO_LARGE" }));
				return;
			}
		};
		channel.onclose = () => finish();
		channel.onerror = () => {
			if (done) return;
			done = true;
			cleanup();
			reject(Object.assign(new Error("通道错误"), { code: "TUNNEL_HTTP_ERROR" }));
		};

		channel.send(requestBytes);
	});
}
