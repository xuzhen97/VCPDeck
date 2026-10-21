/**
 * 生成 UUID v4。
 *
 * `crypto.randomUUID` 只在安全上下文（HTTPS / localhost）可用；VCPDeck 常以明文
 * HTTP（如 `http://<公网IP>:3001`）部署，此时浏览器里它是 `undefined`，直接调用会在
 * 发请求前抛 `TypeError`。此处退回 `crypto.getRandomValues`（非安全上下文同样可用）
 * 按 v4 规则拼装，保证 SDK 在两种上下文行为一致。
 */
export function randomUUID(): string {
	const source = globalThis.crypto;
	if (typeof source?.randomUUID === "function") {
		return source.randomUUID();
	}
	const bytes = source.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
