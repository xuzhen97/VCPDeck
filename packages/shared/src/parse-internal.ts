/**
 * Shared 内部严格解析助手。
 *
 * 刻意不通过 `packages/shared/src/index.ts` 导出：它们是包内 parser 的实现细节，
 * 不是跨运行时契约。断言风格与 `pi.ts` 内既有实现一致（未知键与类型不符一律抛 `PiProtocolError`）。
 */
import { PiProtocolError } from "./pi.js";

/** 断言为普通对象（拒绝 null、数组与原始值） */
export function assertRecord(
	value: unknown,
	what: string,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PiProtocolError(`${what} 必须是对象`);
	}
}

/** 断言键集合精确匹配（未知键与缺失键都拒绝） */
export function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	what: string,
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) throw new PiProtocolError(`${what} 含未知字段 ${key}`);
	}
	for (const key of allowed) {
		if (!(key in value)) throw new PiProtocolError(`${what} 缺少字段 ${key}`);
	}
}

/** 断言为非空字符串 */
export function assertNonEmptyString(
	value: unknown,
	what: string,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PiProtocolError(`${what} 必须是非空字符串`);
	}
}
