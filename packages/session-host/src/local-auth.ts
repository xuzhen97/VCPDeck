import { randomBytes, timingSafeEqual } from "node:crypto";

/** 令牌长度（字节）。32 字节 = 256 位，足够抵抗离线穷举。 */
const TOKEN_BYTES = 32;

/** Authorization 头前缀，大小写不敏感匹配。 */
const BEARER_PREFIX = "bearer ";

/**
 * 生成宿主启动令牌。
 *
 * 每次宿主启动都重新生成：不落盘复用、不跨重启稳定。
 * 因此旧令牌在 Client 重启后立即失效，符合 ADR-0046 的中断语义。
 */
export function generateAuthToken(createRandom: (size: number) => Buffer = randomBytes): string {
	return createRandom(TOKEN_BYTES).toString("hex");
}

/**
 * 常量时间比较令牌。
 *
 * 长度不等时直接返回 false —— 不能把长度差当成提前返回的理由，
 * 但也绝不允许 timingSafeEqual 因长度不等抛异常（那会变成可观测信号）。
 */
export function verifyAuthToken(provided: unknown, expected: string): boolean {
	if (typeof provided !== "string" || expected.length === 0) return false;
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * 从 Authorization 头解析 Bearer 令牌。
 *
 * 只接受单一 `Bearer <token>` 形式；多余段、空值、其他方案一律拒绝。
 * 刻意不从 URL 查询参数读取令牌：查询串会进入访问日志与审计。
 */
export function parseAuthorizationHeader(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length > 512) return undefined;
	const trimmed = value.trimStart();
	if (trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return undefined;
	const token = trimmed.slice(BEARER_PREFIX.length).trim();
	if (token.length === 0 || token.includes(" ")) return undefined;
	return token;
}

/** 本机请求是否可放行。header 缺失、格式错误或令牌不匹配都拒绝。 */
export function isAuthenticatedLocalRequest(
	headerValue: unknown,
	expectedToken: string,
): boolean {
	return verifyAuthToken(parseAuthorizationHeader(headerValue), expectedToken);
}
