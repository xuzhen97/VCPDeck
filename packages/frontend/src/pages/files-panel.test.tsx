import type { VcpDeckClient } from "@vcpdeck/sdk";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { uploadDirect, uploadFile } from "@/api/upload-file";
import { FilesPanel } from "./files-panel";

vi.mock("@/api/upload-file", () => ({
	uploadFile: vi.fn().mockResolvedValue(undefined),
	uploadDirect: vi.fn().mockResolvedValue(undefined),
}));

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
		createUploadSession: vi.fn().mockResolvedValue({
			jobId: "upload-job",
			fileId: "file-1",
			status: "waiting_input",
			upload: { kind: "proxy", url: "/api/storage/upload/key", expiresAt: 123 },
		}),
		completeUpload: vi.fn().mockResolvedValue({
			jobId: "upload-job",
			status: "running",
			type: "file.import",
		}),
		refreshUploadPartUrls: vi.fn(),
		updateUploadProgress: vi.fn().mockResolvedValue(undefined),
		import: vi.fn(),
		...overrides,
	};
	const jobs = {
		wait: vi.fn().mockResolvedValue({
			jobId: "upload-job",
			status: "done",
			type: "file.import",
			progress: { loaded: 5, total: 5 },
		}),
	};
	const storage = {
		downloadUrl: vi.fn(
			(key: string) =>
				`/api/storage/download-redirect/${encodeURIComponent(key)}`,
		),
	};
	const client = {
		files,
		jobs,
		storage,
	} as unknown as VcpDeckClient;
	(files as Record<string, unknown>).jobs = jobs;
	(files as Record<string, unknown>).storage = storage;
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
		expect(screen.getByRole("status", { name: "正在读取目录" })).toHaveClass(
			"absolute",
			"inset-0",
			"z-10",
		);
		expect(
			screen.getByTestId("file-list-region").querySelector('[role="status"]'),
		).not.toBeInTheDocument();

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

	it("keeps a bottom context menu inside the viewport", async () => {
		const rectSpy = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function (this: HTMLElement) {
				if (this.getAttribute("role") === "menu") {
					return {
						height: 180,
						width: 160,
					} as DOMRect;
				}
				return { height: 0, width: 0 } as DOMRect;
			});

		try {
			renderFiles();
			await userEvent.click(
				await screen.findByRole("button", { name: "D:\\" }),
			);
			fireEvent.contextMenu(
				await screen.findByRole("button", { name: /^README\.md/ }),
				{ clientX: 120, clientY: 740 },
			);

			const menu = screen.getByRole("menu");
			expect(menu.style.left).toBe("120px");
			expect(menu.style.top).toBe(`${window.innerHeight - 180}px`);
		} finally {
			rectSpy.mockRestore();
		}
	});

	it("uploads one file to the current remote directory", async () => {
		const files = renderFiles();
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		expect(screen.getByRole("button", { name: "上传文件" })).toHaveClass(
			"w-9",
			"px-0",
		);
		const file = new File(["hello"], "report.txt", { type: "text/plain" });

		await userEvent.upload(screen.getByLabelText("选择上传文件"), file);

		await waitFor(() =>
			expect(files.createUploadSession).toHaveBeenCalledWith(
				{
					clientId: "client-1",
					rootDir: "D:\\",
					targetPath: "report.txt",
					filename: "report.txt",
					size: 5,
					mimeType: "text/plain",
					overwrite: false,
				},
				expect.any(AbortSignal),
			),
		);
		expect(uploadFile).toHaveBeenCalledWith(
			`${window.location.origin}/api/storage/upload/key`,
			file,
			expect.objectContaining({ onProgress: expect.any(Function) }),
		);
		expect(files.completeUpload).toHaveBeenCalledWith(
			"upload-job",
			{ uploadedBytes: 5 },
			expect.any(AbortSignal),
		);
		expect((files as Record<string, any>).jobs.wait).toHaveBeenCalledWith(
			"upload-job",
			expect.objectContaining({ onUpdate: expect.any(Function) }),
		);
	});

	it("closes the completed upload notice for the current page", async () => {
		const files = renderFiles();
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		await userEvent.upload(
			screen.getByLabelText("选择上传文件"),
			new File(["hello"], "report.txt", { type: "text/plain" }),
		);

		expect(await screen.findByText("导入完成：report.txt")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "关闭上传提示" }));

		expect(screen.queryByText("导入完成：report.txt")).not.toBeInTheDocument();
		expect(files.completeUpload).toHaveBeenCalledWith(
			"upload-job",
			{ uploadedBytes: 5 },
			expect.any(AbortSignal),
		);
	});

	it("direct 会话走分片直传并在完成后 complete", async () => {
		vi.mocked(uploadFile).mockClear();
		vi.mocked(uploadDirect).mockImplementation(
			async (_parts, _size, _file, opts) => {
				opts.onProgress?.(5, 5);
			},
		);
		const files = renderFiles({
			createUploadSession: vi.fn().mockResolvedValue({
				jobId: "upload-job",
				fileId: "file-1",
				status: "waiting_input",
				upload: {
					kind: "direct",
					fileId: "aliyun-file",
					uploadId: "up-1",
					partSize: 5,
					parts: [
						{ partNumber: 1, url: "https://oss.example/p1" },
						{ partNumber: 2, url: "https://oss.example/p2" },
					],
				},
			}),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		const file = new File(["hello"], "report.txt", { type: "text/plain" });

		await userEvent.upload(screen.getByLabelText("选择上传文件"), file);

		await waitFor(() =>
			expect(uploadDirect).toHaveBeenCalledWith(
				[
					{ partNumber: 1, url: "https://oss.example/p1" },
					{ partNumber: 2, url: "https://oss.example/p2" },
				],
				5,
				file,
				expect.objectContaining({
					partSize: 5,
					onProgress: expect.any(Function),
					refreshPartUrl: expect.any(Function),
				}),
			),
		);
		expect(files.completeUpload).toHaveBeenCalledWith(
			"upload-job",
			{ uploadedBytes: 5 },
			expect.any(AbortSignal),
		);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("direct 上传完成后显示阿里云盘保存阶段", async () => {
		let resolveComplete!: (value: {
			jobId: string;
			status: string;
			type: string;
		}) => void;
		vi.mocked(uploadDirect).mockImplementation(
			async (_parts, _size, _file, opts) => {
				opts.onProgress?.(5, 5);
			},
		);
		renderFiles({
			createUploadSession: vi.fn().mockResolvedValue({
				jobId: "upload-job",
				fileId: "file-1",
				status: "waiting_input",
				upload: {
					kind: "direct",
					fileId: "aliyun-file",
					uploadId: "up-1",
					partSize: 5,
					parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
				},
			}),
			completeUpload: vi.fn().mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveComplete = resolve;
					}),
			),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));

		await userEvent.upload(
			screen.getByLabelText("选择上传文件"),
			new File(["hello"], "report.txt", { type: "text/plain" }),
		);

		expect(await screen.findByText("正在保存到阿里云盘…")).toBeVisible();
		await act(async () => {
			resolveComplete({
				jobId: "upload-job",
				status: "running",
				type: "file.import",
			});
		});
	});

	it("远程导入阶段从 0 开始并跟随 Job 进度", async () => {
		let onUpdate!: (job: {
			progress: { loaded: number; total: number } | null;
		}) => void;
		let resolveWait!: (value: {
			jobId: string;
			status: string;
			type: string;
			progress: { loaded: number; total: number };
		}) => void;
		vi.mocked(uploadDirect).mockImplementation(
			async (_parts, _size, _file, opts) => {
				opts.onProgress?.(5, 5);
			},
		);
		const files = renderFiles({
			createUploadSession: vi.fn().mockResolvedValue({
				jobId: "upload-job",
				fileId: "file-1",
				status: "waiting_input",
				upload: {
					kind: "direct",
					fileId: "aliyun-file",
					uploadId: "up-1",
					partSize: 5,
					parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
				},
			}),
		});
		(files as Record<string, any>).jobs.wait.mockImplementation(
			(_jobId: string, options: { onUpdate: typeof onUpdate }) => {
				onUpdate = options.onUpdate;
				return new Promise((resolve) => {
					resolveWait = resolve;
				});
			},
		);
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));

		await userEvent.upload(
			screen.getByLabelText("选择上传文件"),
			new File(["hello"], "report.txt", { type: "text/plain" }),
		);

		expect(
			await screen.findByText("正在导入远程机器：report.txt"),
		).toBeVisible();
		expect(screen.getByRole("progressbar")).toHaveValue(0);
		act(() => onUpdate({ progress: { loaded: 2, total: 5 } }));
		expect(screen.getByRole("progressbar")).toHaveValue(2);
		await act(async () => {
			resolveWait({
				jobId: "upload-job",
				status: "done",
				type: "file.import",
				progress: { loaded: 5, total: 5 },
			});
		});
	});

	it("direct 会话分片完成后节流上报进度", async () => {
		vi.mocked(uploadFile).mockClear();
		vi.mocked(uploadDirect).mockImplementation(
			async (_parts, _size, _file, opts) => {
				opts.onProgress?.(5, 5);
			},
		);
		const files = renderFiles({
			createUploadSession: vi.fn().mockResolvedValue({
				jobId: "upload-job",
				fileId: "file-1",
				status: "waiting_input",
				upload: {
					kind: "direct",
					fileId: "aliyun-file",
					uploadId: "up-1",
					partSize: 5,
					parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
				},
			}),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		const file = new File(["hello"], "report.txt", { type: "text/plain" });

		await userEvent.upload(screen.getByLabelText("选择上传文件"), file);

		await waitFor(() =>
			expect(files.updateUploadProgress).toHaveBeenCalledWith(
				"upload-job",
				5,
				expect.any(AbortSignal),
			),
		);
	});

	it("direct 进度上报按顺序发送，旧请求不会晚于新请求落库", async () => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let resolveFirst!: () => void;
		const updateUploadProgress = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValue(undefined);
		vi.mocked(uploadDirect).mockImplementation(
			async (_parts, _size, _file, opts) => {
				opts.onProgress?.(1, 5);
				now = 2000;
				opts.onProgress?.(4, 5);
			},
		);
		const files = renderFiles({
			updateUploadProgress,
			createUploadSession: vi.fn().mockResolvedValue({
				jobId: "upload-job",
				fileId: "file-1",
				status: "waiting_input",
				upload: {
					kind: "direct",
					fileId: "aliyun-file",
					uploadId: "up-1",
					partSize: 5,
					parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
				},
			}),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));

		await userEvent.upload(
			screen.getByLabelText("选择上传文件"),
			new File(["hello"], "report.txt", { type: "text/plain" }),
		);
		await waitFor(() => expect(updateUploadProgress).toHaveBeenCalledTimes(1));

		resolveFirst();
		await waitFor(() => expect(updateUploadProgress).toHaveBeenCalledTimes(3));
		expect(updateUploadProgress.mock.calls.map((call) => call[1])).toEqual([
			1, 4, 5,
		]);
		expect(files.completeUpload).toHaveBeenCalled();
	});

	it("同名文件先确认再传 overwrite=true", async () => {
		const files = renderFiles();
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		const file = new File(["new"], "README.md", { type: "text/markdown" });

		await userEvent.upload(screen.getByLabelText("选择上传文件"), file);
		expect(files.createUploadSession).not.toHaveBeenCalled();
		expect(screen.getByText(/覆盖当前目录中的/)).toBeVisible();

		await userEvent.click(screen.getByRole("button", { name: "确认覆盖" }));
		await waitFor(() =>
			expect(files.createUploadSession).toHaveBeenCalledWith(
				expect.objectContaining({ overwrite: true }),
				expect.any(AbortSignal),
			),
		);
	});

	it("远程写入竞态冲突时复用已上传 File 重试", async () => {
		const files = renderFiles();
		(files as Record<string, any>).jobs.wait.mockResolvedValueOnce({
			jobId: "upload-job",
			status: "error",
			type: "file.import",
			errorCode: "PATH_CONFLICT",
			errorMessage: "Destination exists; set overwrite=true",
		});
		files.import.mockResolvedValue({
			path: "report.txt",
			size: 5,
			sha256: "sha",
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		const file = new File(["hello"], "report.txt", { type: "text/plain" });

		await userEvent.upload(screen.getByLabelText("选择上传文件"), file);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "确认覆盖" })).toBeVisible(),
		);
		await userEvent.click(screen.getByRole("button", { name: "确认覆盖" }));

		await waitFor(() =>
			expect(files.import).toHaveBeenCalledWith(
				"client-1",
				{
					rootDir: "D:\\",
					targetPath: "report.txt",
					fileId: "file-1",
					overwrite: true,
				},
				expect.any(AbortSignal),
			),
		);
	});

	it("右键导出使用稳定下载地址", async () => {
		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		const files = renderFiles({
			export: vi.fn().mockResolvedValue({ key: "aliyun-file" }),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		fireEvent.contextMenu(
			await screen.findByRole("button", { name: /^README\.md/ }),
		);

		await userEvent.click(screen.getByRole("menuitem", { name: "导出下载" }));
		await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
		expect(
			(files as Record<string, any>).storage.downloadUrl,
		).toHaveBeenCalledWith("aliyun-file");
	});

	it("文件查看器导出使用稳定下载地址", async () => {
		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		const files = renderFiles({
			export: vi.fn().mockResolvedValue({ key: "aliyun-file" }),
		});
		await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
		await userEvent.dblClick(
			await screen.findByRole("button", { name: /^README\.md/ }),
		);

		await userEvent.click(
			await screen.findByRole("button", { name: "导出下载" }),
		);
		await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
		expect(
			(files as Record<string, any>).storage.downloadUrl,
		).toHaveBeenCalledWith("aliyun-file");
		expect(anchorClick.mock.instances[0]).toHaveProperty(
			"href",
			`${window.location.origin}/api/storage/download-redirect/aliyun-file`,
		);
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
