/**
 * 传输层错误展开（Server 与 Client 共用）。
 *
 * undici 只暴露 `TypeError: fetch failed`，真正的 errno 藏在 `cause` 链里；
 * 只记外层消息会让「连不上」与「连接被重置」无法区分，事后无法定位。
 */

/** cause 链最多展开几层：undici 的 fetch failed 常把真实 errno 藏在第二层。 */
const TRANSPORT_CAUSE_DEPTH = 3;

/** 把 fetch 等传输层异常压成一行（保留 code 优先，其次 message）。 */
export function describeTransportError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const parts: string[] = [error.message];
	let cause: unknown = (error as { cause?: unknown }).cause;
	for (let depth = 0; depth < TRANSPORT_CAUSE_DEPTH && cause; depth += 1) {
		const row = cause as { code?: unknown; message?: unknown; cause?: unknown };
		const detail =
			typeof row.code === "string"
				? row.code
				: typeof row.message === "string"
					? row.message
					: null;
		if (detail !== null) parts.push(detail);
		cause = row.cause;
	}
	return parts.join(" / ");
}
