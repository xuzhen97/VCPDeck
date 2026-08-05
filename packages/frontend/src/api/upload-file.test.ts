import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadDirect, uploadFile } from "./upload-file";

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
		xhr.upload.onprogress?.({
			loaded: 2,
			total: 5,
			lengthComputable: true,
		} as ProgressEvent);
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

describe("uploadDirect", () => {
	const parts = [
		{ partNumber: 1, url: "https://oss.example/p1" },
		{ partNumber: 2, url: "https://oss.example/p2" },
	];

	it("按分片 PUT 到 OSS 并汇总进度", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File([new ArrayBuffer(10)], "big.bin");
		const onProgress = vi.fn();
		const promise = uploadDirect(parts, 10, file, {
			onProgress,
			refreshPartUrl: vi.fn(),
		});

		const xhrs = FakeXhr.instances;
		expect(xhrs).toHaveLength(2);
		expect(xhrs[0]!.open).toHaveBeenCalledWith(
			"PUT",
			"https://oss.example/p1",
		);
		expect(xhrs[1]!.open).toHaveBeenCalledWith(
			"PUT",
			"https://oss.example/p2",
		);
		// 片 1 进度 4/5
		xhrs[0]!.upload.onprogress?.({
			loaded: 4,
			total: 5,
			lengthComputable: true,
		} as ProgressEvent);
		xhrs[0]!.onload?.();
		// 片 2 进度 3/5
		xhrs[1]!.upload.onprogress?.({
			loaded: 3,
			total: 5,
			lengthComputable: true,
		} as ProgressEvent);
		xhrs[1]!.onload?.();

		await expect(promise).resolves.toBeUndefined();
		// 片内进度：start + event.loaded；完成汇总：5 / 10
		expect(onProgress).toHaveBeenCalledWith(4, 10);
		expect(onProgress).toHaveBeenCalledWith(8, 10);
		expect(onProgress).toHaveBeenCalledWith(10, 10);
	});

	it("分片 403 时调 refreshPartUrl 换 URL 重试", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File([new ArrayBuffer(10)], "big.bin");
		const refreshPartUrl = vi.fn().mockResolvedValue("https://oss.example/p1-new");
		const promise = uploadDirect(parts, 10, file, {
			refreshPartUrl,
		});

		const xhrs = FakeXhr.instances;
		// 片 1 第一次 403
		xhrs[0]!.status = 403;
		xhrs[0]!.onload?.();
		await vi.waitFor(() =>
			expect(refreshPartUrl).toHaveBeenCalledWith(1),
		);
		// 重试 XHR（第 3 个实例）成功后完成
		const retry = FakeXhr.instances[2]!;
		expect(retry.open).toHaveBeenCalledWith(
			"PUT",
			"https://oss.example/p1-new",
		);
		xhrs[1]!.onload?.();
		retry.onload?.();

		await expect(promise).resolves.toBeUndefined();
		expect(refreshPartUrl).toHaveBeenCalledTimes(1);
	});
});
