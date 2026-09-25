import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/** 模拟非安全上下文（明文 HTTP）：navigator.clipboard 不存在。 */
function hideClipboard(): () => void {
	const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	Object.defineProperty(navigator, "clipboard", {
		value: undefined,
		configurable: true,
	});
	return () => {
		if (original) Object.defineProperty(navigator, "clipboard", original);
		else Reflect.deleteProperty(navigator, "clipboard");
	};
}

describe("copyText", () => {
	it("安全上下文下走原生 clipboard.writeText", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		try {
			await copyText("hello");
			expect(writeText).toHaveBeenCalledWith("hello");
		} finally {
			Reflect.deleteProperty(navigator, "clipboard");
		}
	});

	it("非安全上下文下退回 execCommand 且不留残留节点", async () => {
		const restore = hideClipboard();
		const execCommand = vi.fn(() => true);
		Object.defineProperty(document, "execCommand", {
			value: execCommand,
			configurable: true,
		});
		try {
			await copyText("透传值");
			expect(execCommand).toHaveBeenCalledWith("copy");
			expect(document.querySelectorAll("textarea")).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("两条途径都不可用时抛出（不假装成功）", async () => {
		const restore = hideClipboard();
		Object.defineProperty(document, "execCommand", {
			value: undefined,
			configurable: true,
		});
		try {
			await expect(copyText("x")).rejects.toThrow();
		} finally {
			restore();
		}
	});
});
