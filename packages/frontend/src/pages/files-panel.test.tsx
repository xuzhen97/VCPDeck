import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { FilesPanel } from "./files-panel";

function renderFiles(overrides: Record<string, unknown> = {}) {
	const files = {
		roots: vi.fn().mockResolvedValue(["D:\\"]),
		list: vi.fn().mockResolvedValue({ entries: [{ name: "README.md", kind: "file", size: 300000, mtime: "2026-07-26T00:00:00.000Z" }] }),
		stat: vi.fn().mockResolvedValue({ name: "README.md", kind: "file", size: 300000, mtime: "2026-07-26T00:00:00.000Z" }),
		readText: vi.fn().mockResolvedValue({ content: "hello", size: 5 }),
		writeText: vi.fn(), mkdir: vi.fn(), delete: vi.fn().mockResolvedValue({ path: "README.md" }), move: vi.fn(), export: vi.fn(),
		...overrides,
	};
	const client = { files, storage: { createDownloadToken: vi.fn() } } as unknown as VcpDeckClient;
	render(<SdkProvider client={client}><FilesPanel clientId="client-1" /></SdkProvider>);
	return files;
}

describe("FilesPanel", () => {
	it("loads discovered roots before listing a selected root", async () => {
		const files = renderFiles();
		expect(files.roots).toHaveBeenCalledWith("client-1", expect.any(AbortSignal));
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		expect(files.list).toHaveBeenCalledWith("client-1", "D:\\", ".", expect.any(AbortSignal));
		expect(await screen.findByText("README.md")).toBeVisible();
		expect(screen.queryByText("C:\\")).not.toBeInTheDocument();
	});

	it("handles oversized text and requires the full path for deletion", async () => {
		const files = renderFiles({ readText: vi.fn().mockRejectedValue({ errorCode: "SIZE_EXCEEDED" }) });
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		await userEvent.click(await screen.findByRole("button", { name: /^README\.md/ }));
		expect(await screen.findByText("文本超过 256 KiB，请使用导出下载")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "删除" }));
		const confirm = screen.getByRole("button", { name: "确认删除" });
		expect(confirm).toBeDisabled();
		await userEvent.type(screen.getByLabelText("输入目标以确认"), "D:\\README.md");
		await userEvent.click(confirm);
		expect(files.delete).toHaveBeenCalledWith("client-1", { rootDir: "D:\\", path: "README.md", recursive: false });
		expect(screen.queryByText(/本地上传|import/i)).not.toBeInTheDocument();
	});
});
