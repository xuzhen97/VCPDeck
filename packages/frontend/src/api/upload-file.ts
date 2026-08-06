interface UploadFileOptions {
	signal?: AbortSignal;
	onProgress?: (loaded: number, total: number) => void;
}

interface DirectUploadOptions extends UploadFileOptions {
	/** 服务端创建会话时使用的固定分片大小 */
	partSize: number;
	/** 分片 URL 过期（403）时重新获取新 URL */
	refreshPartUrl: (partNumber: number) => Promise<string>;
}

const DIRECT_CONCURRENCY = 3;
const DIRECT_RETRIES = 2;

/** 分片直传：按 parts 并发 PUT 到 OSS 预签名 URL，汇总进度 */
export function uploadDirect(
	parts: Array<{ partNumber: number; url: string }>,
	size: number,
	file: File,
	options: DirectUploadOptions,
): Promise<void> {
	const partSize = options.partSize;
	const queue = [...parts];
	const loadedByPart = new Map<number, number>();
	let loaded = 0;
	const active: XMLHttpRequest[] = [];

	function reportPartProgress(
		partNumber: number,
		value: number,
		partSize: number,
	) {
		const previous = loadedByPart.get(partNumber) ?? 0;
		const next = Math.max(previous, Math.min(value, partSize));
		loadedByPart.set(partNumber, next);
		loaded += next - previous;
		options.onProgress?.(Math.min(loaded, size), size);
	}

	function putPart(
		partNumber: number,
		start: number,
		end: number,
		url: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			active.push(xhr);
			xhr.upload.onprogress = (event) => {
				reportPartProgress(partNumber, event.loaded, end - start);
			};
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					reportPartProgress(partNumber, end - start, end - start);
					resolve();
				} else {
					const err = new Error(
						`分片 ${partNumber} 上传失败：HTTP ${xhr.status}`,
					) as Error & {
						status?: number;
					};
					err.status = xhr.status;
					reject(err);
				}
			};
			xhr.onerror = () => reject(new Error(`分片 ${partNumber} 上传失败`));
			xhr.ontimeout = () => reject(new Error(`分片 ${partNumber} 上传失败`));
			xhr.open("PUT", url);
			xhr.send(file.slice(start, end));
		});
	}

	async function worker() {
		while (queue.length > 0) {
			const part = queue.shift()!;
			if (options.signal?.aborted) return;
			const start = (part.partNumber - 1) * partSize;
			const end = Math.min(size, start + partSize);
			let url = part.url;
			for (let attempt = 0; ; attempt++) {
				try {
					await putPart(part.partNumber, start, end, url);
					break;
				} catch (err) {
					const status = (err as { status?: number }).status ?? 0;
					if (status === 403 && attempt < DIRECT_RETRIES) {
						url = await options.refreshPartUrl(part.partNumber);
						continue;
					}
					if (attempt < DIRECT_RETRIES) continue;
					throw err;
				}
			}
		}
	}

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			for (const xhr of active) xhr.abort();
			reject(new DOMException("Aborted", "AbortError"));
		};
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		Promise.all(
			Array.from({ length: Math.min(DIRECT_CONCURRENCY, parts.length) }, () =>
				worker(),
			),
		)
			.then(() => {
				options.signal?.removeEventListener("abort", onAbort);
				resolve();
			})
			.catch((err) => {
				options.signal?.removeEventListener("abort", onAbort);
				reject(err);
			});
	});
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
