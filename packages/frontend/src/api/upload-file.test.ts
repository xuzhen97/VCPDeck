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

	it("按 partNumber 顺序上传，前一片完成前不启动下一片", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File([new ArrayBuffer(13)], "big.bin");
		const promise = uploadDirect(
			[
				{ partNumber: 3, url: "https://oss.example/p3" },
				{ partNumber: 1, url: "https://oss.example/p1" },
				{ partNumber: 2, url: "https://oss.example/p2" },
			],
			13,
			file,
			{ partSize: 5, refreshPartUrl: vi.fn() },
		);

		expect(FakeXhr.instances).toHaveLength(1);
		expect(FakeXhr.instances[0]!.open).toHaveBeenCalledWith(
			"PUT",
			"https://oss.example/p1",
		);
		FakeXhr.instances[0]!.onload?.();
		await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
		expect(FakeXhr.instances[1]!.open).toHaveBeenCalledWith(
			"PUT",
			"https://oss.example/p2",
		);
		FakeXhr.instances[1]!.onload?.();
		await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(3));
		expect(FakeXhr.instances[2]!.open).toHaveBeenCalledWith(
			"PUT",
			"https://oss.example/p3",
		);
		FakeXhr.instances[2]!.onload?.();

		await expect(promise).resolves.toBeUndefined();
	});

	it("按分片 PUT 到 OSS 并汇总进度", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File([new ArrayBuffer(10)], "big.bin");
		const onProgress = vi.fn();
		const promise = uploadDirect(parts, 10, file, {
			partSize: 5,
			onProgress,
			refreshPartUrl: vi.fn(),
		});

		const xhrs = FakeXhr.instances;
		expect(xhrs).toHaveLength(1);
		expect(xhrs[0]!.open).toHaveBeenCalledWith("PUT", "https://oss.example/p1");
		// 片 1 进度 4/5
		xhrs[0]!.upload.onprogress?.({
			loaded: 4,
			total: 5,
			lengthComputable: true,
		} as ProgressEvent);
		xhrs[0]!.onload?.();
		await vi.waitFor(() => expect(xhrs).toHaveLength(2));
		expect(xhrs[1]!.open).toHaveBeenCalledWith("PUT", "https://oss.example/p2");
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

	it("按服务端分片大小切片，最后一片使用剩余字节", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File([new ArrayBuffer(13)], "big.bin");
		const promise = uploadDirect(
			[
				{ partNumber: 1, url: "https://oss.example/p1" },
				{ partNumber: 2, url: "https://oss.example/p2" },
			],
			13,
			file,
			{
				partSize: 8,
				refreshPartUrl: vi.fn(),
			},
		);

		expect(FakeXhr.instances[0]!.send).toHaveBeenCalledWith(
			expect.objectContaining({ size: 8 }),
		);
		FakeXhr.instances[0]!.onload?.();
		await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
		expect(FakeXhr.instances[1]!.send).toHaveBeenCalledWith(
			expect.objectContaining({ size: 5 }),
		);
		FakeXhr.instances[1]!.onload?.();
		await expect(promise).resolves.toBeUndefined();
	});

	it("片内进度事件回退时汇总总进度不回退", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File([new ArrayBuffer(10)], "big.bin");
		const onProgress = vi.fn();
		const promise = uploadDirect(parts, 10, file, {
			partSize: 5,
			onProgress,
			refreshPartUrl: vi.fn(),
		});

		const xhrs = FakeXhr.instances;
		xhrs[0]!.upload.onprogress?.({
			loaded: 4,
			total: 5,
			lengthComputable: true,
		} as ProgressEvent);
		xhrs[0]!.upload.onprogress?.({
			loaded: 1,
			total: 5,
			lengthComputable: true,
		} as ProgressEvent);

		expect(onProgress.mock.calls.slice(0, 2)).toEqual([
			[4, 10],
			[4, 10],
		]);
		xhrs[0]!.onload?.();
		await vi.waitFor(() => expect(xhrs).toHaveLength(2));
		xhrs[1]!.onload?.();
		await expect(promise).resolves.toBeUndefined();
		expect(onProgress).toHaveBeenLastCalledWith(10, 10);
	});

	it("分片 403 时调 refreshPartUrl 换 URL 重试", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const file = new File([new ArrayBuffer(10)], "big.bin");
		const refreshPartUrl = vi
			.fn()
			.mockResolvedValue("https://oss.example/p1-new");
		const promise = uploadDirect(parts, 10, file, {
			partSize: 5,
			refreshPartUrl,
		});

		const xhrs = FakeXhr.instances;
		// 片 1 第一次 403
		xhrs[0]!.status = 403;
		xhrs[0]!.onload?.();
		await vi.waitFor(() => expect(refreshPartUrl).toHaveBeenCalledWith(1));
		const retry = FakeXhr.instances[1]!;
		expect(retry.open).toHaveBeenCalledWith(
			"PUT",
			"https://oss.example/p1-new",
		);
		retry.onload?.();
		await vi.waitFor(() => expect(xhrs).toHaveLength(3));
		xhrs[2]!.onload?.();

		await expect(promise).resolves.toBeUndefined();
		expect(refreshPartUrl).toHaveBeenCalledTimes(1);
	});
});
