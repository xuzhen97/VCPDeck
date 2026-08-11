import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PiSessionSidebar } from "./pi-session-sidebar.js";

const sessions = [
	{
		id: "s1",
		name: "owned",
		firstMessage: null,
		messageCount: 1,
		modified: new Date().toISOString(),
		running: false,
	},
	{
		id: "s2",
		name: "observed",
		firstMessage: null,
		messageCount: 1,
		modified: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
		running: false,
	},
];

function makePi(rename = vi.fn(), del = vi.fn()) {
	return {
		sessions: {
			list: vi.fn(async () => sessions),
			get: vi.fn(async () => ({ tree: [] })),
			rename,
			delete: del,
			fork: vi.fn(),
			clone: vi.fn(),
		},
		agent: { newSession: vi.fn() },
	} as never;
}

function renderSidebar(
	pi = makePi(),
	mutableSessionIds: ReadonlySet<string> = new Set(["*"]),
) {
	const files = { roots: vi.fn(), list: vi.fn() } as never;
	return render(
		<PiSessionSidebar
			pi={pi}
			files={files}
			clientId="c1"
			cwdRef={{ rootDir: "D:\\", relativePath: "repo" }}
			onCwdChange={vi.fn()}
			activeSessionId="s1"
			mutableSessionIds={mutableSessionIds}
			onSelectSession={vi.fn()}
			onCreated={vi.fn()}
		/>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PiSessionSidebar", () => {
	it("mutable Session 显示 ⋯ 操作菜单，observer 不显示", async () => {
		renderSidebar(makePi(), new Set(["s1"]));
		expect(await screen.findByText("owned")).toBeVisible();
		expect(screen.getByText("observed")).toBeVisible();

		const ownedCard = screen.getByText("owned").closest("li")!;
		expect(
			within(ownedCard).getByRole("button", { name: "操作" }),
		).toBeTruthy();

		const observedCard = screen.getByText("observed").closest("li")!;
		expect(
			within(observedCard).queryByRole("button", { name: "操作" }),
		).toBeNull();

		// 默认菜单未展开 → 没有 menuitem
		expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "删除" })).toBeNull();
	});

	it("通配符 “*” 让本 cwd 下所有 session 都显示 ⋯", async () => {
		renderSidebar(makePi(), new Set(["*"]));
		expect(await screen.findByText("owned")).toBeVisible();
		expect(screen.getByText("observed")).toBeVisible();

		// 两条 session 都是 owned → 都显示 ⋯
		expect(
			within(screen.getByText("owned").closest("li")!).getByRole("button", {
				name: "操作",
			}),
		).toBeTruthy();
		expect(
			within(screen.getByText("observed").closest("li")!).getByRole("button", {
				name: "操作",
			}),
		).toBeTruthy();
	});

	it("空集合：observer 模式 → 任何 session 都不显示 ⋯", async () => {
		renderSidebar(makePi(), new Set());
		await screen.findByText("owned");
		expect(screen.queryByRole("button", { name: "操作" })).toBeNull();
	});

	it("重命名：菜单 → Dialog 输入新名 → 保存触发 pi.sessions.rename", async () => {
		const rename = vi.fn().mockResolvedValue(undefined);
		renderSidebar(makePi(rename));

		const ownedCard = (await screen.findByText("owned")).closest("li")!;
		fireEvent.click(within(ownedCard).getByRole("button", { name: "操作" }));

		fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));

		// Dialog 出现，预填当前 name
		const input = (await screen.findByLabelText("新名称")) as HTMLInputElement;
		expect(input.value).toBe("owned");
		fireEvent.change(input, { target: { value: "new-name" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await vi.waitFor(() =>
			expect(rename).toHaveBeenCalledWith(
				"c1",
				"s1",
				{ rootDir: "D:\\", relativePath: "repo" },
				"new-name",
			),
		);
	});

	it("重命名：与原名相同时保存按钮禁用", async () => {
		const rename = vi.fn().mockResolvedValue(undefined);
		renderSidebar(makePi(rename));

		const ownedCard = (await screen.findByText("owned")).closest("li")!;
		fireEvent.click(within(ownedCard).getByRole("button", { name: "操作" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));

		await screen.findByLabelText("新名称");
		expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
	});

	it("删除：菜单 → 简单确认弹窗 → 删除按钮触发 pi.sessions.delete", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		renderSidebar(makePi(vi.fn(), del));

		const ownedCard = (await screen.findByText("owned")).closest("li")!;
		fireEvent.click(within(ownedCard).getByRole("button", { name: "操作" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

		// 简单确认弹窗：只显示会话名 + 不可撤销提示，不要求重新输入
		await screen.findByText(/此操作不可撤销/);
		const deleteBtn = await screen.findByRole("button", { name: "删除" });
		expect(deleteBtn).not.toBeDisabled();
		fireEvent.click(deleteBtn);

		await vi.waitFor(() =>
			expect(del).toHaveBeenCalledWith("c1", "s1", {
				rootDir: "D:\\",
				relativePath: "repo",
			}),
		);
	});

	it("删除当前 active session：回调传 null（不是空串）以让父级清空对话/详情面板", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		const pi = makePi(vi.fn(), del);
		const onSelectSession = vi.fn();
		const files = { roots: vi.fn(), list: vi.fn() } as never;
		render(
			<PiSessionSidebar
				pi={pi}
				files={files}
				clientId="c1"
				cwdRef={{ rootDir: "D:\\", relativePath: "repo" }}
				onCwdChange={vi.fn()}
				activeSessionId="s1"
				mutableSessionIds={new Set(["*"])}
				onSelectSession={onSelectSession}
				onCreated={vi.fn()}
			/>,
		);

		const ownedCard = (await screen.findByText("owned")).closest("li")!;
		fireEvent.click(within(ownedCard).getByRole("button", { name: "操作" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
		await screen.findByText(/此操作不可撤销/);
		fireEvent.click(screen.getByRole("button", { name: "删除" }));

		await vi.waitFor(() =>
			expect(onSelectSession).toHaveBeenCalledWith(null),
		);
		// 删除成功后侧栏刷新：list 至少被调用两次（首次 + reload）
		const piMock = pi as unknown as { sessions: { list: ReturnType<typeof vi.fn> } };
		await vi.waitFor(() => expect(piMock.sessions.list).toHaveBeenCalledTimes(2));
	});

	it("删除非 active session：不触发 onSelectSession 回调", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		const pi = makePi(vi.fn(), del);
		const onSelectSession = vi.fn();
		const files = { roots: vi.fn(), list: vi.fn() } as never;
		render(
			<PiSessionSidebar
				pi={pi}
				files={files}
				clientId="c1"
				cwdRef={{ rootDir: "D:\\", relativePath: "repo" }}
				onCwdChange={vi.fn()}
				activeSessionId="s1" // active 是 s1，删 s2
				mutableSessionIds={new Set(["*"])}
				onSelectSession={onSelectSession}
				onCreated={vi.fn()}
			/>,
		);

		const observedCard = (await screen.findByText("observed")).closest("li")!;
		fireEvent.click(within(observedCard).getByRole("button", { name: "操作" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
		fireEvent.click(await screen.findByRole("button", { name: "删除" }));

		await vi.waitFor(() =>
			expect(del).toHaveBeenCalledWith("c1", "s2", {
				rootDir: "D:\\",
				relativePath: "repo",
			}),
		);
		expect(onSelectSession).not.toHaveBeenCalled();
	});

	it("菜单点击外部自动关闭", async () => {
		renderSidebar();
		const ownedCard = (await screen.findByText("owned")).closest("li")!;
		fireEvent.click(within(ownedCard).getByRole("button", { name: "操作" }));
		expect(
			await screen.findByRole("menuitem", { name: "重命名" }),
		).toBeInTheDocument();

		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();
	});
});
