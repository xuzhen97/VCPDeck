import type { VcpDeckClient } from "@vcpdeck/sdk";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { FilesPanel } from "./files-panel";

function renderFiles(overrides: Record<string, unknown> = {}) {
	const files = {
		roots: vi.fn().mockResolvedValue(["D:\\"]),
		list: vi.fn().mockResolvedValue({
			entries: [
				{
					name: "README.md",
					kind: "file",
					size: 300000,
					mtime: "2026-07-26T00:00:00.000Z",
				},
			],
		}),
		stat: vi.fn().mockResolvedValue({
			name: "README.md",
			kind: "file",
			size: 300000,
			mtime: "2026-07-26T00:00:00.000Z",
		}),
		readText: vi.fn().mockResolvedValue({ content: "hello", size: 5 }),
		writeText: vi.fn(),
		mkdir: vi.fn(),
		delete: vi.fn().mockResolvedValue({ path: "README.md" }),
		move: vi.fn(),
		export: vi.fn(),
		...overrides,
	};
	const client = {
		files,
		storage: { createDownloadToken: vi.fn() },
	} as unknown as VcpDeckClient;
	render(
		<SdkProvider client={client}>
			<FilesPanel clientId="client-1" />
		</SdkProvider>,
	);
	return files;
}

describe("FilesPanel", () => {
	it("keeps the desktop file area within the viewport and scrolls long lists", async () => {
		renderFiles();
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));

		expect(screen.getByTestId("file-browser-panel")).toHaveClass(
			"h-full",
			"min-h-0",
		);
		expect(screen.getByTestId("file-browser-layout")).toHaveClass(
			"h-full",
			"min-h-[24rem]",
		);
		expect(screen.getByTestId("file-browser-layout")).not.toHaveClass(
			"lg:h-[calc(100dvh-12rem)]",
		);
		expect(screen.getByTestId("file-list-region")).toHaveClass(
			"overflow-y-auto",
			"lg:min-h-0",
		);
	});

	it("loads discovered roots before listing a selected root", async () => {
		const files = renderFiles();
		expect(files.roots).toHaveBeenCalledWith(
			"client-1",
			expect.any(AbortSignal),
		);
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		expect(files.list).toHaveBeenCalledWith(
			"client-1",
			"D:\\",
			".",
			expect.any(AbortSignal),
		);
		expect(await screen.findByText("README.md")).toBeVisible();
		expect(screen.queryByText("C:\\")).not.toBeInTheDocument();
	});

	it("shows a blocking loading overlay while changing directories", async () => {
		let resolveList!: (value: { entries: [] }) => void;
		const files = renderFiles({
			list: vi.fn().mockImplementation(
				() =>
					new Promise<{ entries: [] }>((resolve) => {
						resolveList = resolve;
					}),
			),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));

		expect(screen.getByRole("status", { name: "正在读取目录" })).toBeVisible();
		expect(screen.getByTestId("file-list-region")).toHaveClass(
			"pointer-events-none",
		);

		await act(async () => resolveList({ entries: [] }));
		expect(
			screen.queryByRole("status", { name: "正在读取目录" }),
		).not.toBeInTheDocument();
		expect(files.list).toHaveBeenCalledOnce();
	});

	it("navigates parent folders from compact breadcrumbs", async () => {
		const files = renderFiles({
			list: vi
				.fn()
				.mockResolvedValueOnce({
					entries: [
						{
							name: "projects",
							kind: "dir",
							size: 0,
							mtime: "2026-07-26T00:00:00.000Z",
						},
					],
				})
				.mockResolvedValueOnce({
					entries: [
						{
							name: "VCPDeck",
							kind: "dir",
							size: 0,
							mtime: "2026-07-26T00:00:00.000Z",
						},
					],
				})
				.mockResolvedValueOnce({ entries: [] })
				.mockResolvedValueOnce({ entries: [] }),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		await userEvent.dblClick(
			await screen.findByRole("button", { name: /^projects/ }),
		);
		await userEvent.dblClick(
			await screen.findByRole("button", { name: /^VCPDeck/ }),
		);

		await userEvent.click(
			screen.getByRole("button", { name: "转到 projects" }),
		);
		expect(files.list).toHaveBeenLastCalledWith(
			"client-1",
			"D:\\",
			"projects",
			expect.any(AbortSignal),
		);
		expect(screen.getByRole("button", { name: "上一级" })).toHaveClass("h-9");
		expect(screen.getByRole("button", { name: "刷新目录" })).toHaveClass("h-9");
	});

	it("creates a directory from the icon-triggered dialog", async () => {
		const files = renderFiles();
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));

		expect(screen.queryByLabelText("文件夹名称")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "上一级" }),
		).not.toHaveTextContent("上一级");
		expect(
			screen.getByRole("button", { name: "刷新目录" }),
		).not.toHaveTextContent("刷新");
		await userEvent.click(screen.getByRole("button", { name: "新建文件夹" }));

		const name = screen.getByLabelText("文件夹名称");
		expect(name).toHaveFocus();
		await userEvent.type(name, "reports");
		await userEvent.click(screen.getByRole("button", { name: "创建" }));
		expect(files.mkdir).toHaveBeenCalledWith("client-1", {
			rootDir: "D:\\",
			path: "reports",
		});
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("selects on click and reads text on double click", async () => {
		const files = renderFiles();
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		const file = await screen.findByRole("button", { name: /^README\.md/ });

		await userEvent.click(file);
		expect(files.readText).not.toHaveBeenCalled();

		await userEvent.dblClick(file);
		expect(files.readText).toHaveBeenCalledWith(
			"client-1",
			"D:\\",
			"README.md",
			262144,
			expect.any(AbortSignal),
		);
		expect(
			await screen.findByRole("textbox", { name: "文件内容" }),
		).toHaveValue("hello");
	});

	it("uses an opaque context menu surface", async () => {
		renderFiles();
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		fireEvent.contextMenu(
			await screen.findByRole("button", { name: /^README\.md/ }),
		);
		expect(screen.getByRole("menu")).toHaveClass("bg-background");
	});

	it("handles oversized text and requires the full path for deletion", async () => {
		const files = renderFiles({
			readText: vi.fn().mockRejectedValue({ errorCode: "SIZE_EXCEEDED" }),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		await userEvent.dblClick(
			await screen.findByRole("button", { name: /^README\.md/ }),
		);
		expect(
			await screen.findByText("文本超过 256 KiB，请使用导出下载"),
		).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "删除" }));
		const confirm = screen.getByRole("button", { name: "确认删除" });
		expect(confirm).toBeDisabled();
		await userEvent.type(
			screen.getByLabelText("输入目标以确认"),
			"D:\\README.md",
		);
		await userEvent.click(confirm);
		expect(files.delete).toHaveBeenCalledWith("client-1", {
			rootDir: "D:\\",
			path: "README.md",
			recursive: false,
		});
		expect(screen.queryByText(/本地上传|import/i)).not.toBeInTheDocument();
	});
});
