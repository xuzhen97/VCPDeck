import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserDownload } from "./download-file";

afterEach(() => vi.restoreAllMocks());

describe("startBrowserDownload", () => {
	it("用文件名与 no-referrer 触发浏览器下载后移除临时链接", () => {
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});

		startBrowserDownload(
			"/api/storage/download-redirect/aliyun-file",
			"large.zip",
		);

		const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
		expect(anchor.href).toBe(
			`${window.location.origin}/api/storage/download-redirect/aliyun-file`,
		);
		expect(anchor.download).toBe("large.zip");
		expect(anchor.referrerPolicy).toBe("no-referrer");
		expect(anchor.isConnected).toBe(false);
	});
});
