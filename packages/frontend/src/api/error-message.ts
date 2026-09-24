/**
 * 从 SDK 错误取可直接展示的安全文案。
 *
 * Server 只返回按稳定 code 收敛、已脱敏的 message，因此结构化错误（带 code）可直接展示；
 * 网络错误与非结构化 HTTP 失败没有 code，回退到调用方给的稳定中文兜底，不回显原始异常。
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
	const failure = error as { code?: unknown; message?: unknown };
	return typeof failure.code === "string" &&
		typeof failure.message === "string" &&
		failure.message.length > 0
		? failure.message
		: fallback;
}
