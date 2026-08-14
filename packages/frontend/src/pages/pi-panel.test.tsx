import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PiPanel } from "./pi-panel.js";
import { SdkProvider } from "@/api/context";
import type { ClientInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";

class MockEventSource {
	static instances: MockEventSource[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readyState = MockEventSource.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(
		public url: string,
		public options?: unknown,
	) {
		MockEventSource.instances.push(this);
		queueMicrotask(() => {
			if (this.closed) return;
			this.readyState = MockEventSource.OPEN;
			this.onopen?.();
		});
	}
	close() {
		this.closed = true;
		this.readyState = MockEventSource.CLOSED;
	}
}

function makeClient(): ClientInfo {
	return {
		clientId: "c1",
		name: "host",
		hostname: "host",
		os: "win32",
		cpuModel: "cpu",
		totalMemMB: 1,
		clientVersion: "1",
		capabilities: ["agent.pi"],
		capabilityDetails: {
			pi: {
				available: true,
				sdkVersion: "0.84.0",
				nodeVersion: "22.19.0",
				shellKind: "git-bash",
			},
		},
		online: true,
		cpuPercent: null,
		memPercent: null,
		disks: [],
		lastHeartbeatAt: null,
	};
}

function makeSdk() {
	const sdk = {
		pi: {
			capability: vi.fn(async () => ({ available: true })),
			models: vi.fn(async () => [
				{ provider: "p", modelId: "m1" },
				{ provider: "p", modelId: "m2" },
			]),
			sessions: {
				list: vi.fn(async () => ({ sessions: [] })),
				get: vi.fn(async () => ({
					info: { id: "s1", name: "s", firstMessage: "hi" },
					tree: [],
					activeLeafId: null,
				})),
				context: vi.fn(async () => ({ messages: [], nextCursor: null })),
				entryContent: vi.fn(),
				rename: vi.fn(),
				delete: vi.fn(),
				fork: vi.fn(),
				clone: vi.fn(),
				navigate: vi.fn(),
			},
			agent: {
				newSession: vi.fn(async () => ({ sessionId: "s1", jobId: "s1" })),
				open: vi.fn(async (_clientId: string, sessionId: string) => ({
					job: {
						jobId: sessionId,
						sessionId,
						status: "idle",
						runId: null,
						ownerName: "User",
						isOwner: true,
					},
					agentState: {
						status: "idle",
						streaming: false,
						prompting: false,
						compacting: false,
						thinkingLevel: "off",
						model: { provider: "p", modelId: "m1" },
						queuedMessages: { steering: [], followUp: [] },
					},
				})),
				complete: vi.fn(async (_clientId: string, sessionId: string) => ({
					jobId: sessionId,
					sessionId,
					status: "done",
					runId: null,
					ownerName: "User",
					isOwner: true,
				})),
				state: vi.fn(async () => ({
					status: "idle",
					streaming: false,
					prompting: false,
					compacting: false,
					thinkingLevel: "off",
					model: { provider: "p", modelId: "m1" },
					queuedMessages: { steering: [], followUp: [] },
				})),
				prompt: vi.fn(async () => ({
					jobId: "j1",
					runId: "j1",
					sessionId: "s1",
				})),
				steer: vi.fn(),
				followUp: vi.fn(),
				abort: vi.fn(),
				compact: vi.fn(),
				abortCompact: vi.fn(),
				setModel: vi.fn(),
				setThinking: vi.fn(),
				extensionResponse: vi.fn(),
				eventsPath: (clientId: string, sessionId: string) =>
					`/api/clients/${clientId}/pi/agent/${sessionId}/events`,
			},
			running: vi.fn(async () => []),
		},
		files: {
			roots: vi.fn(async () => ["D:\\"]),
			list: vi.fn(async () => ({ entries: [{ name: "repo", kind: "dir" }] })),
		},
	} as unknown as VcpDeckClient;
	return sdk;
}

function renderPanel(client: ClientInfo, sdk = makeSdk()) {
	const view = render(
		<SdkProvider client={sdk}>
			<PiPanel client={client} />
		</SdkProvider>,
	);
	return { sdk, view };
}

/** 通过“自定义路径”选择 cwd：点击触发器 → 自定义路径 → 输入路径 → 选择。 */
async function selectCwd(path: string) {
	const triggers = screen.getAllByRole("button", {
		name: /未选择项目|D:\\/,
	});
	await triggers[0]!.click();
	const dialog = (await screen.findAllByRole("dialog"))[0]!;
	await within(dialog).getByRole("button", { name: "自定义路径..." }).click();
	const input = screen.getByLabelText("自定义路径");
	fireEvent.change(input, { target: { value: path } });
	const chooseButtons = screen.getAllByRole("button", { name: "选择" });
	await chooseButtons[chooseButtons.length - 1]!.click();
}

afterEach(() => {
	vi.unstubAllGlobals();
	MockEventSource.instances = [];
	vi.restoreAllMocks();
});

describe("PiPanel", () => {
	it("三栏结构：项目/会话、对话、详情", () => {
		vi.stubGlobal("EventSource", MockEventSource);
		renderPanel(makeClient());
		expect(screen.getByTestId("pi-left-panel")).toBeTruthy();
		expect(screen.getByTestId("pi-center-panel")).toBeTruthy();
		expect(screen.getByTestId("pi-right-panel")).toBeTruthy();
	});

	it("能力不可用时显示原因并禁用输入", () => {
		const client: ClientInfo = {
			...makeClient(),
			capabilities: [],
			capabilityDetails: {
				pi: {
					available: false,
					code: "PI_BASH_NOT_FOUND",
					message: "no bash",
				},
			},
		};
		renderPanel(client);
		expect(screen.getByText(/Pi 不可用/)).toBeTruthy();
		expect(screen.getByText(/PI_BASH_NOT_FOUND/)).toBeTruthy();
		expect(screen.queryByTestId("pi-center-panel")).toBeNull();
	});

	it("旧 Client（无 capabilityDetails）显示不支持", () => {
		const client: ClientInfo = { ...makeClient(), capabilityDetails: {} };
		renderPanel(client);
		expect(screen.getByText(/PI_CLIENT_UNSUPPORTED/)).toBeTruthy();
	});

	it("打开会话后可切换模型和思考深度", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const { sdk } = renderPanel(makeClient());

		await selectCwd("D:\\repo");
		await vi.waitFor(() =>
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0),
		);
		await screen.getAllByText("+ 新建会话")[0]!.click();
		await vi.waitFor(() => expect(sdk.pi.agent.newSession).toHaveBeenCalled());
		await vi.waitFor(() =>
			expect(
				screen.getAllByRole("combobox", { name: "模型" })[0],
			).toBeEnabled(),
		);
		const modelSelect = screen.getAllByRole("combobox", { name: "模型" })[0]!;
		const thinkingSelect = screen.getAllByRole("combobox", {
			name: "思考深度",
		})[0]!;

		fireEvent.change(modelSelect, {
			target: { value: "p\u0000m2" },
		});
		fireEvent.change(thinkingSelect, {
			target: { value: "high" },
		});
		await vi.waitFor(() => {
			expect(sdk.pi.agent.setModel).toHaveBeenCalledWith(
				"c1",
				"s1",
				{ rootDir: "D:\\", relativePath: "repo" },
				"p",
				"m2",
			);
			expect(sdk.pi.agent.setThinking).toHaveBeenCalledWith(
				"c1",
				"s1",
				{ rootDir: "D:\\", relativePath: "repo" },
				"high",
			);
		});
		const thinkingCalls = (sdk.pi.agent.setThinking as ReturnType<typeof vi.fn>)
			.mock.calls.length;
		fireEvent.change(thinkingSelect, {
			target: { value: "auto" },
		});
		await Promise.resolve();
		expect(sdk.pi.agent.setThinking).toHaveBeenCalledTimes(thinkingCalls);
	});

	it("真实 Observer fixture 的所有写操作均不发请求", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const sdk = makeSdk();
		(sdk.pi.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				id: "s1",
				name: "observed",
				firstMessage: null,
				messageCount: 1,
				modified: "2026-08-08T00:00:00.000Z",
				running: true,
			},
		]);
		(sdk.pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "running",
				runId: "run-1",
				ownerName: "Other",
				isOwner: false,
			},
			agentState: {
				status: "running",
				streaming: true,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		renderPanel(makeClient(), sdk);

		await selectCwd("D:\\repo");
		await vi.waitFor(() =>
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0),
		);
		await screen.findAllByText("observed");
		await screen.getAllByText("observed")[0]!.click();
		await vi.waitFor(() => expect(sdk.pi.agent.open).toHaveBeenCalled());

		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Follow-up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "中止" })).toBeNull();
		expect(screen.queryByRole("button", { name: /标记完成/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
		expect(screen.queryByRole("button", { name: "克隆" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
		expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
		expect(screen.getAllByRole("combobox", { name: "模型" })[0]).toBeDisabled();
		expect(
			screen.getAllByRole("combobox", { name: "思考深度" })[0],
		).toBeDisabled();

		expect(sdk.pi.agent.prompt).not.toHaveBeenCalled();
		expect(sdk.pi.agent.steer).not.toHaveBeenCalled();
		expect(sdk.pi.agent.followUp).not.toHaveBeenCalled();
		expect(sdk.pi.agent.abort).not.toHaveBeenCalled();
		expect(sdk.pi.agent.complete).not.toHaveBeenCalled();
		expect(sdk.pi.agent.setModel).not.toHaveBeenCalled();
		expect(sdk.pi.agent.setThinking).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.rename).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.fork).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.clone).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.navigate).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.delete).not.toHaveBeenCalled();
	});

	it("实时 Extension 等待与恢复同步显示运行详情", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const sdk = makeSdk();
		(sdk.pi.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				id: "s1",
				name: "owned",
				firstMessage: null,
				messageCount: 1,
				modified: "2026-08-08T00:00:00.000Z",
				running: true,
			},
		]);
		(sdk.pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "running",
				runId: "run-1",
				ownerName: "User",
				isOwner: true,
			},
			agentState: {
				status: "running",
				streaming: true,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		renderPanel(makeClient(), sdk);
		await selectCwd("D:\\repo");
		await vi.waitFor(() =>
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0),
		);
		await screen.findAllByText("owned");
		await screen.getAllByText("owned")[0]!.click();
		await vi.waitFor(() =>
			expect(screen.getAllByText("运行中").length).toBeGreaterThan(0),
		);

		MockEventSource.instances.at(-1)?.onmessage?.({
			data: JSON.stringify({
				type: "extension_request",
				sessionId: "s1",
				runId: "run-1",
				ui: {
					requestId: "u1",
					extensionId: "e",
					kind: "confirm",
					message: "continue?",
				},
			}),
		});
		await vi.waitFor(() =>
			expect(screen.getAllByText("等待扩展输入").length).toBeGreaterThan(0),
		);
		MockEventSource.instances.at(-1)?.onmessage?.({
			data: JSON.stringify({
				type: "extension_resolved",
				sessionId: "s1",
				runId: "run-1",
				requestId: "u1",
				reason: "answered",
				hasPending: false,
			}),
		});
		await vi.waitFor(() =>
			expect(screen.getAllByText("运行中").length).toBeGreaterThan(0),
		);
	});

	it("选择目录后新建会话并打开事件流", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const { sdk, view } = renderPanel(makeClient());
		void view;

		// 打开项目选择器 → 选择 D:\repo
		await selectCwd("D:\\repo");
		await vi.waitFor(() => {
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0);
		});

		// 新建会话
		await screen.getAllByText("+ 新建会话")[0]!.click();
		await vi.waitFor(() => {
			expect(sdk.pi.agent.newSession).toHaveBeenCalledWith("c1", {
				rootDir: "D:\\",
				relativePath: "repo",
			});
		});
		expect(MockEventSource.instances.length).toBeGreaterThan(0);
	});

	it("删除当前 active session：右侧对话/详情同步清空，事件流关闭", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const sdk = makeSdk();
		(sdk.pi.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				id: "s1",
				name: "owned",
				firstMessage: null,
				messageCount: 1,
				modified: "2026-08-08T00:00:00.000Z",
				running: true,
			},
		]);
		(sdk.pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "running",
				runId: "run-1",
				ownerName: "User",
				isOwner: true,
			},
			agentState: {
				status: "running",
				streaming: true,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		(sdk.pi.sessions.context as ReturnType<typeof vi.fn>).mockResolvedValue({
			messages: [],
			nextCursor: null,
		});
		renderPanel(makeClient(), sdk);
		await selectCwd("D:\\repo");
		await vi.waitFor(() =>
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0),
		);
		await screen.findAllByText("owned");
		await screen.getAllByText("owned")[0]!.click();
		await vi.waitFor(
			() => expect(screen.getAllByText("运行中").length).toBeGreaterThan(0),
			{ timeout: 3000 },
		);

		// 打开 ⋯ 菜单，点删除，确认。
		const ownedCard = screen.getAllByText("owned")[0]!.closest("li")!;
		fireEvent.click(within(ownedCard).getByRole("button", { name: "操作" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
		fireEvent.click(await screen.findByRole("button", { name: "删除" }));

		// 后端 delete 被调用，事件流被关闭。
		await vi.waitFor(() =>
			expect(sdk.pi.sessions.delete).toHaveBeenCalledWith("c1", "s1", {
				rootDir: "D:\\",
				relativePath: "repo",
			}),
		);
		const lastStream = MockEventSource.instances.at(-1)!;
		await vi.waitFor(() => expect(lastStream.closed).toBe(true));

		// 对话窗：恢复“开始一段新的 Pi 会话”提示。
		await vi.waitFor(() =>
			expect(
				screen.getAllByText("开始一段新的 Pi 会话").length,
			).toBeGreaterThan(0),
		);

		// 右侧详情：状态不再显示 “运行中”，恢复为空闲。
		await vi.waitFor(() =>
			expect(screen.queryAllByText("运行中")).toHaveLength(0),
		);
		await vi.waitFor(() =>
			expect(screen.getAllByText("空闲，可继续提问").length).toBeGreaterThan(0),
		);

		// 输入框已被禁用（无 active session）。
		expect(screen.getByRole("textbox", { name: "Pi 输入" })).toBeDisabled();
	});
});
