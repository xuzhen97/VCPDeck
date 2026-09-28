import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentProjectNavigator } from "./pi-session-sidebar.js";
import { loadAgentProjects, saveAgentProjects } from "./pi-recent-projects.js";

const repoA = { rootDir: "D:\\", relativePath: "a" };
const repoB = { rootDir: "D:\\", relativePath: "b" };

const sessions = [
	{
		id: "s1",
		name: "owned",
		firstMessage: null,
		messageCount: 1,
		modified: new Date().toISOString(),
		running: false,
	},
];

function makePi() {
	return {
		sessions: {
			list: vi.fn(async () => sessions),
			get: vi.fn(async () => ({ tree: [] })),
			delete: vi.fn(async () => ({ ok: true })),
			rename: vi.fn(),
			fork: vi.fn(),
			clone: vi.fn(),
		},
		agent: { newSession: vi.fn(async () => ({ sessionId: "created" })) },
	} as never;
}

function renderNavigator(options: {
	clientId?: string;
	pi?: ReturnType<typeof makePi>;
	mutableSessionIds?: ReadonlySet<string>;
	onSelectProject?: (ref: unknown) => void;
	onSelectSession?: (id: string | null, ref: unknown) => void;
	onCreated?: (id: string, ref: unknown) => void;
} = {}) {
	const pi = options.pi ?? makePi();
	const files = { roots: vi.fn(), list: vi.fn(async () => ({ entries: [] })) } as never;
	const handlers = {
		onSelectProject: options.onSelectProject ?? vi.fn(),
		onSelectSession: options.onSelectSession ?? vi.fn(),
		onCreated: options.onCreated ?? vi.fn(),
	};
	render(
		<AgentProjectNavigator
			clientId={options.clientId ?? "c1"}
			files={files}
			pi={pi}
			selectedCwd={null}
			activeSessionId={null}
			mutableSessionIds={options.mutableSessionIds ?? new Set(["*"])}
			onSelectProject={handlers.onSelectProject as never}
			onSelectSession={handlers.onSelectSession as never}
			onCreated={handlers.onCreated as never}
		/>,
	);
	return { pi, ...handlers };
}

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("AgentProjectNavigator", () => {
	it("只展示当前机器的项目，并按机器隔离持久化", () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		saveAgentProjects("c2", [{ ...repoB, pinned: false }]);

		renderNavigator({ clientId: "c1" });

		expect(screen.getByText("a")).toBeTruthy();
		expect(screen.queryByText("b")).toBeNull();
		// 切换机器后不展示上一台机器的项目
		expect(loadAgentProjects("c2")).toHaveLength(1);
	});

	it("置顶与移除只改本地列表，不触发远程调用", () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		const { pi } = renderNavigator();

		fireEvent.click(screen.getByRole("button", { name: "置顶" }));

		expect(loadAgentProjects("c1")[0]!.pinned).toBe(true);
		expect((pi as never as { sessions: { delete: unknown } }).sessions.delete).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "移除项目" }));

		expect(loadAgentProjects("c1")).toHaveLength(0);
		expect(screen.getByText("尚无项目，添加一个目录开始。")).toBeTruthy();
	});

	it("展开项目时按项目加载会话，并显示重试入口", async () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		const pi = makePi();
		(pi as never as { sessions: { list: ReturnType<typeof vi.fn> } }).sessions.list
			.mockRejectedValueOnce(new Error("读取失败"));
		renderNavigator({ pi });

		fireEvent.click(screen.getByRole("button", { name: /^a$/ }));

		await waitFor(() => expect(screen.getByText("读取失败")).toBeTruthy());
		expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
	});

	it("新建任务使用项目 cwd 创建会话并把项目引用回传父级", async () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		const { pi, onCreated } = renderNavigator();

		fireEvent.click(screen.getByRole("button", { name: "新建任务 a" }));

		await waitFor(() =>
			expect((pi as never as { agent: { newSession: ReturnType<typeof vi.fn> } }).agent.newSession)
				.toHaveBeenCalledWith("c1", repoA),
		);
		expect(onCreated).toHaveBeenCalledWith("created", repoA);
	});

	it("选择会话时把项目引用显式传给父级", async () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		const onSelectSession = vi.fn();
		renderNavigator({ onSelectSession });

		fireEvent.click(screen.getByRole("button", { name: /^a$/ }));
		await screen.findByRole("button", { name: "owned" });
		fireEvent.click(screen.getByRole("button", { name: "owned" }));

		expect(onSelectSession).toHaveBeenCalledWith("s1", repoA);
	});

	it("删除会话需要确认后才调用 Client", async () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		const pi = makePi();
		renderNavigator({ pi });

		fireEvent.click(screen.getByRole("button", { name: /^a$/ }));
		await screen.findByRole("button", { name: "owned" });
		fireEvent.click(screen.getByRole("button", { name: /^删除会话/ }));

		const del = (pi as never as { sessions: { delete: ReturnType<typeof vi.fn> } }).sessions.delete;
		expect(del).not.toHaveBeenCalled();

		const dialog = screen.getByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

		await waitFor(() => expect(del).toHaveBeenCalledWith("c1", "s1", repoA));
	});

	it("会话历史树导航仍可用，并带项目引用回调", async () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		const pi = makePi();
		(pi as never as { sessions: { list: ReturnType<typeof vi.fn> } }).sessions.list.mockResolvedValue([
			{ ...sessions[0], id: "s1", name: "owned" },
		]);
		(pi as never as { sessions: { get: ReturnType<typeof vi.fn> } }).sessions.get.mockResolvedValue({
			tree: [{ id: "e1", name: "分支节点", children: [] }],
		});
		const onSelectSession = vi.fn();
		renderNavigator({ pi, onSelectSession });

		fireEvent.click(screen.getByRole("button", { name: /^a$/ }));
		fireEvent.click(await screen.findByRole("button", { name: /分支节点/ }));

		expect(onSelectSession).toHaveBeenCalledWith("e1", repoA);
	});

	it("Observer 不显示删除入口", async () => {
		saveAgentProjects("c1", [{ ...repoA, pinned: false }]);
		renderNavigator({ mutableSessionIds: new Set<string>() });

		fireEvent.click(screen.getByRole("button", { name: /^a$/ }));
		await screen.findByRole("button", { name: "owned" });

		expect(screen.queryByRole("button", { name: /^删除会话/ })).toBeNull();
	});

	it("本地索引损坏时提示可恢复错误而不是抛异常", () => {
		localStorage.setItem("vcpdeck:agent-chat-projects:c1", "{not json");

		renderNavigator();

		expect(screen.getByRole("alert")).toHaveTextContent("浏览器本地项目列表损坏");
		expect(screen.getByText("尚无项目，添加一个目录开始。")).toBeTruthy();
	});
});
