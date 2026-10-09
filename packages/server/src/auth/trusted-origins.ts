/**
 * 浏览器可信 Origin 策略的唯一来源（ADR-0013）。
 *
 * 这份策略原先被抄在 4 个文件的 5 处（main.ts、app.gateway.ts、client.gateway.ts、
 * frontend-origin.adapter.ts ×2），改一次规则要记得改 5 个地方，漏一处就行为不一致。
 * 现在收敛为：一个默认值常量 + 两个配置读取 + 一个判定函数。
 *
 * 判定语义（与收敛前逐字等价）：
 * - 无 Origin：非浏览器客户端（Client SDK / CLI token），放行；
 * - Origin 等于显式配置的 `VCPDECK_FRONTEND_ORIGIN` 或 `VCPDECK_CORS_ORIGIN`，放行；
 * - Origin 等于请求 Host 推导出的同源地址，放行（页面由本 Server 提供）；
 * - 其余跨源一律拒绝（/app 走 Cookie 会话，防 CSWSH）。
 */

/** 未显式配置时的开发 Origin；与 docs/deployment.md 记载的默认值一致。 */
export const DEFAULT_DEV_ORIGIN = "http://localhost:5173";

/** REST CORS 与 `/app` 网关使用的显式跨源配置。 */
export function resolveFrontendOrigin(): string {
	return process.env.VCPDECK_FRONTEND_ORIGIN || DEFAULT_DEV_ORIGIN;
}

/** `/client` 网关使用的显式跨源配置（与 `VCPDECK_FRONTEND_ORIGIN` 互相独立）。 */
export function resolveCorsOrigin(): string {
	return process.env.VCPDECK_CORS_ORIGIN || DEFAULT_DEV_ORIGIN;
}

/** 兼容 cors 包 origin 回调与 Node IncomingMessage 的最小请求形状。 */
export interface CorsRequest {
	headers?: Record<string, string | string[] | undefined>;
	connection?: { encrypted?: boolean };
}

/** 读取首个 header 值：Node 对重复 header 给出数组，判定与回显都按首值处理。 */
export function firstHeaderValue(
	value: string | string[] | undefined,
): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/** Engine 请求 cors 判定：无 Origin（非浏览器）、显式配置跨源或同源放行。 */
export function isTrustedOrigin(
	rawOrigin: string | string[] | undefined,
	req: CorsRequest,
): boolean {
	const origin = firstHeaderValue(rawOrigin);
	if (!origin) return true; // 非浏览器客户端（Client SDK / CLI token）
	if (origin === resolveFrontendOrigin() || origin === resolveCorsOrigin()) return true;
	const host = firstHeaderValue(req.headers?.host);
	const scheme = req.connection?.encrypted ? "https" : "http";
	// 同源：页面由本 Server 提供（浏览器只会在真实访问本 Server 时发这个 Origin）
	return typeof host === "string" && origin === `${scheme}://${host}`;
}
