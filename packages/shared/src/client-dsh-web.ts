/**
 * 远程 DSH WebUI 地址（ADR-0059）。
 *
 * 这是"操作者登记的、经 FRP/内网暴露的目标机 `dsh web` 入口"，不是秘密：
 * 但它可能带一次性 token，因此只经 API 按需下发，不写日志、不进 DB 明文之外的副本。
 */

/** 地址长度上限（含协议与查询串）。 */
export const DSH_WEB_URL_MAX_LENGTH = 2048;

/**
 * 严格解析操作者提交的远程 DSH 地址。
 *
 * `null` 表示清除登记；字符串必须是 `http/https` 且不带用户名口令，
 * 避免把凭据塞进一个会被渲染成链接的字段。
 */
export function parseClientDshWebUrl(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string") {
		throw new Error("dshWebUrl 必须为字符串或 null");
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > DSH_WEB_URL_MAX_LENGTH) {
		throw new Error(`dshWebUrl 不能超过 ${DSH_WEB_URL_MAX_LENGTH} 字符`);
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("dshWebUrl 不是合法 URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("dshWebUrl 只允许 http/https");
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new Error("dshWebUrl 不能包含用户名或口令");
	}
	return parsed.toString();
}
