/**
 * 复制文本到剪贴板。
 *
 * `navigator.clipboard` 只在安全上下文（HTTPS / localhost）可用，明文 HTTP 部署下为
 * `undefined`；此时退回隐藏 textarea + `execCommand("copy")`。失败时抛出，由调用方
 * 提示，不静默假装成功。
 *
 * 注意：读取剪贴板（`readText`）在非安全上下文没有任何可用替代途径，只能在调用处
 * 检测并提示用户手动粘贴。
 */
export async function copyText(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		return navigator.clipboard.writeText(text);
	}
	if (typeof document === "undefined") throw new Error("copy unsupported");

	const el = document.createElement("textarea");
	el.value = text;
	el.setAttribute("readonly", "");
	el.style.position = "fixed";
	el.style.top = "0";
	el.style.opacity = "0";
	document.body.appendChild(el);
	try {
		el.select();
		const ok =
			typeof document.execCommand === "function" && document.execCommand("copy");
		if (!ok) throw new Error("copy unsupported");
	} finally {
		document.body.removeChild(el);
	}
}
