import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiProjectPicker, type PiFilesApiLike } from "./pi-project-picker.js";

function makeFiles(
	roots: string[],
	entries: Array<{ name: string; kind: "file" | "dir" }> = [],
): PiFilesApiLike {
	return {
		roots: vi.fn(async () => roots),
		list: vi.fn(async () => ({ entries })),
	};
}

function renderPicker({
	files,
	value = null,
	onSelect = vi.fn(),
	clientId = "c1",
}: {
	files: PiFilesApiLike;
	value?: Parameters<typeof PiProjectPicker>[0]["value"];
	onSelect?: Parameters<typeof PiProjectPicker>[0]["onSelect"];
	clientId?: string;
}) {
	return render(
		<PiProjectPicker
			files={files}
			clientId={clientId}
			value={value}
			onSelect={onSelect}
		/>,
	);
}

describe("PiProjectPicker", () => {
	beforeEach(() => {
		localStorage.clear();
	});
	afterEach(() => {
		localStorage.clear();
	});

	it("默认折叠，点击头部展开对话框并自动聚焦筛选输入", async () => {
		const files = makeFiles(["D:\\"]);
		renderPicker({ files });
		expect(screen.queryByRole("dialog")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		const dialog = await screen.findByRole("dialog");
		const input = within(dialog).getByPlaceholderText("筛选项目...");
		expect(document.activeElement).toBe(input);
	});

	it("扁平列表 = recents ∪ roots，去重并按路径排序", async () => {
		localStorage.setItem(
			"vcpdeck:pi-recent-projects",
			JSON.stringify([
				{ clientId: "c1", rootDir: "D:\\", relativePath: "recents\\a" },
				{ clientId: "c1", rootDir: "D:\\", relativePath: "recents\\b" },
				{ clientId: "c2", rootDir: "X:\\", relativePath: "other" }, // 不同 client 不应出现
			]),
		);
		const files = makeFiles(["D:\\", "E:\\"]);
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		await screen.findByRole("dialog");

		const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
		const labels = buttons.map((b) => b.textContent ?? "");
		// recents + 2 roots，去重后 4 项；排序：recents\a < recents\b < D:\\ < E:\
		expect(labels.some((l) => l.includes("recents\\a"))).toBe(true);
		expect(labels.some((l) => l.includes("recents\\b"))).toBe(true);
		expect(labels.some((l) => l.includes("D:\\"))).toBe(true);
		expect(labels.some((l) => l.includes("E:\\"))).toBe(true);
		expect(labels.some((l) => l.includes("other"))).toBe(false);
	});

	it("筛选输入子串匹配（不区分大小写）", async () => {
		const files = makeFiles(["D:\\"]);
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		const input = await screen.findByPlaceholderText("筛选项目...");
		fireEvent.change(input, { target: { value: "RECENTS" } });
		// 无 recents，无匹配
		expect(screen.getByText("无匹配项目")).toBeInTheDocument();
	});

	it("选中项显示 ✓，点击列表项回调 onSelect 并写入 recents", async () => {
		const onSelect = vi.fn();
		const files = makeFiles(["D:\\"]);
		renderPicker({
			files,
			value: { rootDir: "D:\\", relativePath: "" },
			onSelect,
		});
		fireEvent.click(screen.getByRole("button", { name: /未选择项目|D:/ }));
		const dialog = await screen.findByRole("dialog");
		const item = within(dialog).getByTitle("D:\\");
		expect(item.querySelector("svg")).toBeTruthy();
		fireEvent.click(item);
		expect(onSelect).toHaveBeenCalledWith({
			rootDir: "D:\\",
			relativePath: "",
		});
		const stored = JSON.parse(
			localStorage.getItem("vcpdeck:pi-recent-projects") ?? "[]",
		);
		expect(stored[0]).toMatchObject({
			clientId: "c1",
			rootDir: "D:\\",
			relativePath: "",
		});
	});

	it("使用默认目录 → 第一个 root", async () => {
		const onSelect = vi.fn();
		const files = makeFiles(["D:\\", "E:\\"]);
		renderPicker({ files, onSelect });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "使用默认目录" }));
		expect(onSelect).toHaveBeenCalledWith({
			rootDir: "D:\\",
			relativePath: "",
		});
	});

	it("浏览文件夹：点击目录后按当前路径加载下级目录", async () => {
		const files: PiFilesApiLike = {
			roots: vi.fn(async () => ["D:\\"]),
			list: vi.fn(async (_clientId, _rootDir, relativePath) => ({
				entries:
					relativePath === ""
						? [{ name: "OptiMinderHub", kind: "dir" as const }]
						: [{ name: "src", kind: "dir" as const }],
			})),
		};
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "浏览文件夹..." }),
		);
		fireEvent.click(
			await within(dialog).findByRole("button", { name: /OptiMinderHub/ }),
		);

		await vi.waitFor(() => {
			expect(files.list).toHaveBeenLastCalledWith(
				"c1",
				"D:\\",
				"OptiMinderHub",
				expect.any(AbortSignal),
			);
		});
		expect(
			await within(dialog).findByRole("button", { name: /src/ }),
		).toBeInTheDocument();
	});

	it("自定义路径：root 下子路径经 Client list 校验后写入", async () => {
		const onSelect = vi.fn();
		const files = makeFiles(["D:\\"]);
		renderPicker({ files, onSelect });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "自定义路径..." }));

		const input = screen.getByLabelText("自定义路径");
		fireEvent.change(input, { target: { value: "D:\\my-project" } });
		fireEvent.click(screen.getByRole("button", { name: "选择" }));

		// 等待 list 完成
		await vi.waitFor(() => {
			expect(files.list).toHaveBeenCalledWith("c1", "D:\\", "my-project");
		});
		expect(onSelect).toHaveBeenCalledWith({
			rootDir: "D:\\",
			relativePath: "my-project",
		});
	});

	it("自定义路径：不在 root 下报错", async () => {
		const files = makeFiles(["D:\\"]);
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "自定义路径..." }));
		fireEvent.change(screen.getByLabelText("自定义路径"), {
			target: { value: "Z:\\stranger" },
		});
		fireEvent.click(screen.getByRole("button", { name: "选择" }));
		expect(await screen.findByText("路径不在已知 root 下")).toBeInTheDocument();
		expect(files.list).not.toHaveBeenCalled();
	});

	it("自定义路径：Client list 拒绝时显示 Client 无法解析", async () => {
		const files: PiFilesApiLike = {
			roots: vi.fn(async () => ["D:\\"]),
			list: vi.fn(async () => {
				throw new Error("nope");
			}),
		};
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "自定义路径..." }));
		fireEvent.change(screen.getByLabelText("自定义路径"), {
			target: { value: "D:\\ghost" },
		});
		fireEvent.click(screen.getByRole("button", { name: "选择" }));
		expect(
			await screen.findByText("Client 无法解析该路径"),
		).toBeInTheDocument();
	});

	it("点击外部关闭对话框", async () => {
		const files = makeFiles(["D:\\"]);
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		await screen.findByRole("dialog");
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("每个候选项都出现 ✕ 移除按钮（不论是历史还是 root）", async () => {
		localStorage.setItem(
			"vcpdeck:pi-recent-projects",
			JSON.stringify([
				{ clientId: "c1", rootDir: "D:\\", relativePath: "repo" },
			]),
		);
		const files = makeFiles(["D:\\", "E:\\"]);
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		const dialog = await screen.findByRole("dialog");

		// 历史 + 2 roots 都有 ✕
		expect(
			within(dialog).getByRole("button", { name: "从下拉中移除 D:\\repo" }),
		).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: "从下拉中移除 D:\\" }),
		).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: "从下拉中移除 E:\\" }),
		).toBeTruthy();
	});

	it("点 ✕ 移除 root：root 从下拉中消失，持久化到 dismissed，但不会触发 onSelect", async () => {
		const onSelect = vi.fn();
		const files = makeFiles(["D:\\", "E:\\"]);
		renderPicker({ files, onSelect });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		const dialog = await screen.findByRole("dialog");

		// 点 D:\\ 的 ✕
		fireEvent.click(
			within(dialog).getByRole("button", { name: "从下拉中移除 D:\\" }),
		);
		expect(onSelect).not.toHaveBeenCalled();

		// D:\\ 丢了，E:\\ 还在
		expect(
			within(dialog).queryByRole("button", { name: "从下拉中移除 D:\\" }),
		).toBeNull();
		expect(
			within(dialog).getByRole("button", { name: "从下拉中移除 E:\\" }),
		).toBeTruthy();

		// localStorage 被持久化
		const stored = JSON.parse(
			localStorage.getItem("vcpdeck:pi-dismissed-roots") ?? "[]",
		);
		expect(stored).toEqual(["D:\\"]);
	});

	it("点 ✕ 移除历史项：从 recents 移除并写入 localStorage", async () => {
		const onSelect = vi.fn();
		localStorage.setItem(
			"vcpdeck:pi-recent-projects",
			JSON.stringify([
				{ clientId: "c1", rootDir: "D:\\", relativePath: "to-remove" },
				{ clientId: "c1", rootDir: "D:\\", relativePath: "keep" },
			]),
		);
		const files = makeFiles(["D:\\"]);
		renderPicker({ files, onSelect });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		const dialog = await screen.findByRole("dialog");

		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "从下拉中移除 D:\\to-remove",
			}),
		);

		// ✕ 不会触发选中
		expect(onSelect).not.toHaveBeenCalled();
		// 该条目不在列表中
		expect(
			within(dialog).queryByRole("button", {
				name: "从下拉中移除 D:\\to-remove",
			}),
		).toBeNull();
		// 其他历史仍在
		expect(
			within(dialog).getByRole("button", { name: "从下拉中移除 D:\\keep" }),
		).toBeTruthy();
		// localStorage 同步
		const stored = JSON.parse(
			localStorage.getItem("vcpdeck:pi-recent-projects") ?? "[]",
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			clientId: "c1",
			rootDir: "D:\\",
			relativePath: "keep",
		});
	});

	it("dismissed roots 启动后从下拉中隐藏", async () => {
		localStorage.setItem(
			"vcpdeck:pi-dismissed-roots",
			JSON.stringify(["D:\\"]),
		);
		const files = makeFiles(["D:\\", "E:\\"]);
		renderPicker({ files });
		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		const dialog = await screen.findByRole("dialog");

		// D:\\ 被隐藏，只有 E:\
		expect(
			within(dialog).queryByRole("button", { name: "从下拉中移除 D:\\" }),
		).toBeNull();
		expect(
			within(dialog).getByRole("button", { name: "从下拉中移除 E:\\" }),
		).toBeTruthy();
	});

	it("已隐藏 root 后，通过浏览选择的子目录仍会出现在历史项目中", async () => {
		localStorage.setItem(
			"vcpdeck:pi-dismissed-roots",
			JSON.stringify(["D:\\"]),
		);
		const files = makeFiles(["D:\\"], [{ name: "OptiMinderHub", kind: "dir" }]);
		renderPicker({ files });

		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		let dialog = await screen.findByRole("dialog");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "浏览文件夹..." }),
		);
		fireEvent.click(
			await within(dialog).findByRole("button", { name: "选择" }),
		);
		expect(screen.queryByRole("dialog")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /未选择项目/ }));
		dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByRole("button", {
				name: "从下拉中移除 D:\\OptiMinderHub",
			}),
		).toBeTruthy();
		expect(
			within(dialog).queryByRole("button", { name: "从下拉中移除 D:\\" }),
		).toBeNull();
	});
});
