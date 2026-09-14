import { describe, expect, it, vi } from "vitest";
import {
	clearReconnectToken,
	loadReconnectToken,
	reconnectStorageKey,
	saveReconnectToken,
} from "./remote-desktop-reconnect.js";

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key: string) => map.get(key) ?? null,
		key: (index: number) => [...map.keys()][index] ?? null,
		removeItem: (key: string) => void map.delete(key),
		setItem: (key: string, value: string) => void map.set(key, value),
	} as Storage;
}

describe("remote desktop reconnect token storage", () => {
	it("round-trips a token per session without leaking across sessions", () => {
		const storage = memoryStorage();
		saveReconnectToken("s1", "token-1", storage);
		saveReconnectToken("s2", "token-2", storage);
		expect(loadReconnectToken("s1", storage)).toBe("token-1");
		expect(loadReconnectToken("s2", storage)).toBe("token-2");
		expect(loadReconnectToken("s3", storage)).toBeNull();
	});

	it("clears only the targeted session", () => {
		const storage = memoryStorage();
		saveReconnectToken("s1", "token-1", storage);
		saveReconnectToken("s2", "token-2", storage);
		clearReconnectToken("s1", storage);
		expect(loadReconnectToken("s1", storage)).toBeNull();
		expect(loadReconnectToken("s2", storage)).toBe("token-2");
	});

	it("namespaces the key so it cannot collide with unrelated entries", () => {
		expect(reconnectStorageKey("s1")).toContain("s1");
		expect(reconnectStorageKey("s1")).not.toBe("s1");
	});

	it("refuses to store empty or oversized tokens", () => {
		const storage = memoryStorage();
		saveReconnectToken("s1", "", storage);
		expect(loadReconnectToken("s1", storage)).toBeNull();
		// 恢复材料必须有界，避免把异常大的值写进存储。
		saveReconnectToken("s1", "x".repeat(4096), storage);
		expect(loadReconnectToken("s1", storage)).toBeNull();
	});

	it("degrades safely when storage is unavailable or throws", () => {
		// 隐私模式或 SSR 下 sessionStorage 可能整体不可用。
		expect(loadReconnectToken("s1", null)).toBeNull();
		expect(() => saveReconnectToken("s1", "token", null)).not.toThrow();
		expect(() => clearReconnectToken("s1", null)).not.toThrow();

		const throwing = {
			getItem: vi.fn(() => {
				throw new Error("denied");
			}),
			setItem: vi.fn(() => {
				throw new Error("denied");
			}),
			removeItem: vi.fn(() => {
				throw new Error("denied");
			}),
		} as unknown as Storage;
		expect(loadReconnectToken("s1", throwing)).toBeNull();
		expect(() => saveReconnectToken("s1", "token", throwing)).not.toThrow();
		expect(() => clearReconnectToken("s1", throwing)).not.toThrow();
	});

	it("ignores a stored value that is not a plausible token", () => {
		const storage = memoryStorage();
		storage.setItem(reconnectStorageKey("s1"), "   ");
		expect(loadReconnectToken("s1", storage)).toBeNull();
	});
});
