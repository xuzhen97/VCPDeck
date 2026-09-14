/**
 * Remote Desktop 恢复材料（reconnect token）的浏览器侧存取。
 *
 * Server 只保存 recovery token 的哈希，明文只在下发时出现一次；Browser 需要把它
 * 存到 `sessionStorage`，才能在页面刷新或 socket 短暂中断后重新 attach 原 Session。
 * 它只是「申请恢复」的凭据，不能替代 Host 的 challenge-response 授权。
 */

/** 恢复材料的存储键前缀；带命名空间避免与其它功能冲突。 */
const KEY_PREFIX = "vcpdeck:remote-desktop:reconnect:";

/**
 * 单个 token 允许的最大长度。
 * 恢复材料必须有界：写进存储前先拒绝异常大的值，避免把存储当数据通道用。
 */
export const MAX_RECONNECT_TOKEN_LENGTH = 512;

/** 生成某个 Session 的存储键。 */
export function reconnectStorageKey(sessionId: string): string {
	return `${KEY_PREFIX}${sessionId}`;
}

function resolveStorage(storage?: Storage | null): Storage | null {
	if (storage !== undefined) return storage;
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		// 隐私模式下访问 sessionStorage 本身就可能抛错。
		return null;
	}
}

function isPlausibleToken(token: unknown): token is string {
	return (
		typeof token === "string" &&
		token.trim().length > 0 &&
		token.length <= MAX_RECONNECT_TOKEN_LENGTH
	);
}

/** 保存恢复材料；不可用或非法时静默放弃，绝不能因为存储失败而中断会话。 */
export function saveReconnectToken(
	sessionId: string,
	token: string,
	storage?: Storage | null,
): void {
	const target = resolveStorage(storage);
	if (!target || !isPlausibleToken(token)) return;
	try {
		target.setItem(reconnectStorageKey(sessionId), token);
	} catch {
		// 存储配额或权限失败：恢复能力降级，但不影响当前会话。
	}
}

/** 读取恢复材料；不存在或不可信时返回 `null`。 */
export function loadReconnectToken(
	sessionId: string,
	storage?: Storage | null,
): string | null {
	const target = resolveStorage(storage);
	if (!target) return null;
	try {
		const value = target.getItem(reconnectStorageKey(sessionId));
		return isPlausibleToken(value) ? value : null;
	} catch {
		return null;
	}
}

/** 清除恢复材料；会话正常关闭或恢复失败后必须调用。 */
export function clearReconnectToken(
	sessionId: string,
	storage?: Storage | null,
): void {
	const target = resolveStorage(storage);
	if (!target) return;
	try {
		target.removeItem(reconnectStorageKey(sessionId));
	} catch {
		// 幂等清理：失败不需要向上传播。
	}
}
