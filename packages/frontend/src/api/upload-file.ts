interface UploadFileOptions {
	signal?: AbortSignal;
	onProgress?: (loaded: number, total: number) => void;
}

/** 使用浏览器原生 XHR 将单个文件直传到签名 Storage URL。 */
export function uploadFile(
	url: string,
	file: File,
	options: UploadFileOptions = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		let settled = false;

		const cleanup = () => {
			options.signal?.removeEventListener("abort", onAbort);
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => {
			xhr.abort();
			settle(() => reject(new DOMException("Aborted", "AbortError")));
		};

		xhr.upload.onprogress = (event) => {
			if (settled) return;
			options.onProgress?.(
				event.loaded,
				event.lengthComputable ? event.total : file.size,
			);
		};
		xhr.onload = () => {
			settle(() => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(new Error(`上传失败：HTTP ${xhr.status}`));
				}
			});
		};
		xhr.onerror = () => settle(() => reject(new Error("上传失败")));
		xhr.ontimeout = () => settle(() => reject(new Error("上传失败")));

		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		xhr.open("PUT", url);
		xhr.send(file);
	});
}
