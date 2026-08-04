import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "./upload-file";

class FakeUpload {
	onprogress: ((event: ProgressEvent) => void) | null = null;
}

class FakeXhr {
	static instances: FakeXhr[] = [];
	upload = new FakeUpload();
	status = 200;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	open = vi.fn();
	send = vi.fn();
	abort = vi.fn(() => {
		this.aborted = true;
	});
	aborted = false;

	constructor() {
		FakeXhr.instances.push(this);
	}
}

afterEach(() => {
	FakeXhr.instances = [];
	vi.unstubAllGlobals();
});

describe("uploadFile", () => {
	it("PUT 文件并报告上传进度", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File(["hello"], "a.txt", { type: "text/plain" });
		const onProgress = vi.fn();
		const promise = uploadFile("/api/storage/upload/key", file, { onProgress });
		const xhr = FakeXhr.instances[0]!;
		xhr.upload.onprogress?.({ loaded: 2, total: 5, lengthComputable: true } as ProgressEvent);
		xhr.onload?.();

		await expect(promise).resolves.toBeUndefined();
		expect(xhr.open).toHaveBeenCalledWith("PUT", "/api/storage/upload/key");
		expect(xhr.send).toHaveBeenCalledWith(file);
		expect(onProgress).toHaveBeenCalledWith(2, 5);
	});

	it("HTTP 非 2xx 时失败", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const promise = uploadFile("/upload", new File(["x"], "x.txt"));
		const xhr = FakeXhr.instances[0]!;
		xhr.status = 500;
		xhr.onload?.();

		await expect(promise).rejects.toThrow("上传失败：HTTP 500");
	});

	it("AbortSignal 会中止 XHR 并返回 AbortError", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const controller = new AbortController();
		const promise = uploadFile("/upload", new File(["x"], "x.txt"), {
			signal: controller.signal,
		});
		const xhr = FakeXhr.instances[0]!;
		controller.abort();

		expect(xhr.abort).toHaveBeenCalledOnce();
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
	});
});
