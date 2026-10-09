import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PiPanel } from "./pi-panel.js";
import { SdkProvider } from "@/api/context";
import type { ClientInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";

// 上传数据面在 Storage Provider，不在本测试范围；只保留调用形状。
vi.mock("@/api/upload-file", () => ({ uploadFile: vi.fn(async () => {}) }));
import { uploadFile } from "@/api/upload-file";

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
			// 独立会话控制面(ADR-0041):快照/归档/审计读取来自 Server。
			sessionsControl: {
				snapshot: vi.fn(async () => ({
					sessionId: "s1",
					status: "available",
					activeRun: null,
					executionModeOverride: null,
					effectiveExecutionMode: "supervised",
					executionModeNeedsConfirmation: false,
					ownerName: "admin",
					isOwner: true,
				})),
				run: vi.fn(),
				archive: vi.fn(async () => ({
					sessionId: "s1",
					status: "archived",
					activeRun: null,
					executionModeOverride: null,
					effectiveExecutionMode: "supervised",
					executionModeNeedsConfirmation: false,
					ownerName: "admin",
					isOwner: true,
				})),
				restore: vi.fn(),
				runs: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
				audit: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
			},
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
					snapshot: {
					sessionId: "s1",
					status: "available",
					activeRun: null,
					executionModeOverride: null,
					effectiveExecutionMode: "supervised",
					executionModeNeedsConfirmation: false,
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
				setExecutionMode: vi.fn(async (_clientId: string, sessionId: string) => ({
					jobId: sessionId,
					sessionId,
					status: "idle",
					runId: null,
					executionModeOverride: null,
					effectiveExecutionMode: "supervised",
					ownerName: "User",
					isOwner: true,
				})),
				extensionResponse: vi.fn(),
				eventsPath: (clientId: string, sessionId: string) =>
					`/api/clients/${clientId}/pi/agent/${sessionId}/events`,
			},
			running: vi.fn(async () => []),
			attachments: {
				create: vi.fn(async (_clientId: string, images: Array<{ filename: string }>) =>
					images.map((image, index) => ({
						fileId: `f-${index}-${image.filename}`,
						uploadUrl: `/upload/${index}`,
						expiresAt: Date.now() + 900_000,
					})),
				),
				complete: vi.fn(async (_clientId: string, attachmentId: string) => ({
					fileId: attachmentId,
					sha256: `sha-${attachmentId}`,
					size: 3,
					mimeType: "image/png",
					url: `/download/${attachmentId}`,
					expiresAt: Date.now() + 600_000,
				})),
				delete: vi.fn(async () => {}),
			},
		},
		files: {
			roots: vi.fn(async () => ["D:\\"]),
			list: vi.fn(async () => ({ entries: [{ name: "repo", kind: "dir" }] })),
		},
	} as unknown as VcpDeckClient;
	return sdk;
}

function renderPanel(
	client: ClientInfo,
	sdk = makeSdk(),
	leftSlot?: ReactNode,
	agentChatLayout = false,
) {
	const view = render(
		<SdkProvider client={sdk}>
			<PiPanel client={client} leftSlot={leftSlot} agentChatLayout={agentChatLayout} />
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
		// 思考选择的「auto」仍会传给 setThinking（此处验证重复点击同一值不多发请求）。
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
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "run-1",
				sessionId: "s1",
				status: "running",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
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
		expect(sdk.pi.sessionsControl.archive).not.toHaveBeenCalled();
		expect(sdk.pi.agent.setModel).not.toHaveBeenCalled();
		expect(sdk.pi.agent.setThinking).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.rename).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.fork).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.clone).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.navigate).not.toHaveBeenCalled();
		expect(sdk.pi.sessions.delete).not.toHaveBeenCalled();
	});

	it("会话可用时由右栏提供归档入口,输入区不再出现完成按钮", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const sdk = makeSdk();
		(sdk.pi.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				id: "s1",
				name: "archivable",
				firstMessage: null,
				messageCount: 1,
				modified: "2026-08-08T00:00:00.000Z",
				running: false,
			},
		]);
		(sdk.pi.sessionsControl.archive as ReturnType<typeof vi.fn>).mockResolvedValue({
			sessionId: "s1",
			status: "archived",
			activeRun: null,
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "admin",
			isOwner: true,
		});
		renderPanel(makeClient(), sdk);

		await selectCwd("D:\\repo");
		await screen.findAllByText("archivable");
		await screen.getAllByText("archivable")[0]!.click();
		await vi.waitFor(() => expect(sdk.pi.agent.open).toHaveBeenCalled());

		// ADR-0041:会话不再有"完成"动作,输入区不得出现完成入口。
		expect(screen.queryByRole("button", { name: /标记完成/ })).toBeNull();

		await userEvent.click(
			(await screen.findAllByRole("button", { name: "归档会话" }))[0]!,
		);
		await vi.waitFor(() =>
			expect(sdk.pi.sessionsControl.archive).toHaveBeenCalledWith("c1", "s1"),
		);
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
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "run-1",
				sessionId: "s1",
				status: "running",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
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
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "run-1",
				sessionId: "s1",
				status: "running",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
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
				screen.getAllByText(/开始一段新的 Pi 会话/).length,
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

	it("切换会话时清理上一会话的草稿，避免发到错误会话", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const sdk = makeSdk();
		(sdk.pi.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				id: "s1",
				name: "owned",
				firstMessage: null,
				messageCount: 1,
				modified: "2026-08-08T00:00:00.000Z",
				running: false,
			},
			{
				id: "s2",
				name: "observed",
				firstMessage: null,
				messageCount: 1,
				modified: "2026-08-08T00:00:00.000Z",
				running: false,
			},
		]);
		(sdk.pi.sessions.context as ReturnType<typeof vi.fn>).mockResolvedValue({
			messages: [],
			nextCursor: null,
		});
		renderPanel(makeClient(), sdk);
		await selectCwd("D:\\repo");
		await screen.findByText("owned");

		fireEvent.click(screen.getByText("owned"));
		await vi.waitFor(() =>
			expect(sdk.pi.agent.open).toHaveBeenCalledWith(
				"c1",
				"s1",
				expect.objectContaining({ relativePath: "repo" }),
			),
		);
		const input = screen.getByRole("textbox", { name: "Pi 输入" });
		fireEvent.change(input, { target: { value: "只属于 s1 的草稿" } });
		expect(input).toHaveValue("只属于 s1 的草稿");

		fireEvent.click(screen.getByText("observed"));
		await vi.waitFor(() =>
			expect(sdk.pi.agent.open).toHaveBeenCalledWith(
				"c1",
				"s2",
				expect.objectContaining({ relativePath: "repo" }),
			),
		);
		await vi.waitFor(() =>
			expect(screen.getByRole("textbox", { name: "Pi 输入" })).toHaveValue(""),
		);
	});

	it("renders the host-provided left slot above the session sidebar", () => {
		renderPanel(
			makeClient(),
			makeSdk(),
			<p data-testid="host-slot">机器选择器</p>,
		);

		const left = screen.getByTestId("pi-left-panel");
		const slot = within(left).getByTestId("host-slot");
		expect(slot).toHaveTextContent("机器选择器");
		// 必须是左栏第一个子元素，即渲染在会话侧栏之上
		expect(left.firstElementChild).toBe(slot);
	});

	describe("Agent 聊天布局", () => {
		beforeEach(() => localStorage.clear());

		it("桌面左栏只挂载一个项目导航器，并在输入区聚合模型/思考等级/执行模式", async () => {
			vi.stubGlobal("EventSource", MockEventSource);
			localStorage.setItem(
				"vcpdeck:agent-chat-projects:c1",
				JSON.stringify([{ rootDir: "D:\\", relativePath: "repo", pinned: false }]),
			);
			renderPanel(makeClient(), makeSdk(), <p data-testid="host-slot">机器选择器</p>, true);

			// 抽屉关闭时不得重复挂载导航器：项目树只有一个实例
			const left = screen.getByTestId("pi-left-panel");
			expect(within(left).getAllByTestId("agent-project-navigator")).toHaveLength(1);
			expect(screen.getAllByTestId("agent-project-navigator")).toHaveLength(1);
			expect(within(left).getByTestId("host-slot")).toHaveTextContent("机器选择器");

			// Agent 宽屏下详情仍需可用：该入口不能被 xl:hidden 隐掉
			expect(screen.getByRole("button", { name: "详情" }).className).not.toContain("xl:hidden");

			// 输入区上方的会话设置条包含三项
			expect(screen.getByLabelText("会话模型")).toBeTruthy();
			expect(screen.getByLabelText("会话思考等级")).toBeTruthy();
			expect(screen.getByLabelText("会话执行模式")).toBeTruthy();
		});

		it("新建任务用导航器给的项目 cwd 打开会话，避免旧 cwd 闭包", async () => {
			vi.stubGlobal("EventSource", MockEventSource);
			localStorage.setItem(
				"vcpdeck:agent-chat-projects:c1",
				JSON.stringify([{ rootDir: "D:\\", relativePath: "repo", pinned: false }]),
			);
			const sdk = makeSdk();
			(sdk.pi.agent.newSession as ReturnType<typeof vi.fn>).mockResolvedValue({
				sessionId: "created",
				jobId: "created",
			});
			renderPanel(makeClient(), sdk, undefined, true);

			fireEvent.click(screen.getByRole("button", { name: "新建任务 repo" }));

			const repo = { rootDir: "D:\\", relativePath: "repo" };
			await vi.waitFor(() =>
				expect(sdk.pi.agent.open).toHaveBeenCalledWith("c1", "created", repo),
			);
			expect(sdk.pi.agent.newSession).toHaveBeenCalledWith("c1", repo);
		});

		it("切换会话执行模式会带项目引用调用 SDK，并采用服务端确认的覆盖值", async () => {
			vi.stubGlobal("EventSource", MockEventSource);
			localStorage.setItem(
				"vcpdeck:agent-chat-projects:c1",
				JSON.stringify([{ rootDir: "D:\\", relativePath: "repo", pinned: false }]),
			);
			const sdk = makeSdk();
			(sdk.pi.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
				{
					id: "s1",
					name: "owned",
					firstMessage: null,
					messageCount: 1,
					modified: "2026-08-08T00:00:00.000Z",
					running: false,
				},
			]);
			(sdk.pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
				snapshot: {
				sessionId: "s1",
				status: "available",
				activeRun: null,
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
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
			});
			(sdk.pi.agent.setExecutionMode as ReturnType<typeof vi.fn>).mockResolvedValue({
				sessionId: "s1",
				status: "available",
				activeRun: null,
				executionModeOverride: "automatic",
				effectiveExecutionMode: "automatic",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
			});
			renderPanel(makeClient(), sdk, undefined, true);

			fireEvent.click(screen.getByRole("button", { name: /^repo$/ }));
			fireEvent.click(await screen.findByRole("button", { name: "owned" }));
			await vi.waitFor(() =>
				expect((sdk.pi.agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalled(),
			);

			const repo = { rootDir: "D:\\", relativePath: "repo" };
			fireEvent.change(screen.getByLabelText("会话执行模式"), {
				target: { value: "automatic" },
			});
			await vi.waitFor(() =>
				expect(sdk.pi.agent.setExecutionMode).toHaveBeenCalledWith("c1", "s1", repo, "automatic"),
			);
			// 菜单展示服务端确认的覆盖值与有效模式，而不是前端猜测值
			await vi.waitFor(() =>
				expect(screen.getByRole("status")).toHaveTextContent("自动执行：已注册工具直接运行"),
			);
		});
	});
});

/**
 * 附件草稿：身份稳定、上下文隔离、纯图片发送（ADR-0035）。
 * 上传数据面（`uploadFile`）与对象 URL 都是外部边界，这里只验证调用形状与草稿状态机。
 */
describe("PiPanel 附件草稿", () => {
	const png = (name: string, type = "image/png") =>
		new File([new Uint8Array([1, 2, 3])], name, { type });

	beforeEach(() => {
		Object.assign(URL, {
			createObjectURL: vi.fn(() => "blob:preview"),
			revokeObjectURL: vi.fn(),
		});
		(uploadFile as unknown as ReturnType<typeof vi.fn>).mockReset();
		(uploadFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	});

	async function openNewSession(sdk = makeSdk()) {
		vi.stubGlobal("EventSource", MockEventSource);
		renderPanel(makeClient(), sdk);
		await selectCwd("D:\\repo");
		await vi.waitFor(() =>
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0),
		);
		await screen.getAllByText("+ 新建会话")[0]!.click();
		await vi.waitFor(() =>
			expect(sdk.pi.agent.newSession as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
		);
		await vi.waitFor(() =>
			expect(screen.getByLabelText("添加图片")).toBeTruthy(),
		);
		return sdk;
	}

	/** 等输入区就绪再选文件：新建会话后 composer 会短暂处于加载态。 */
	async function pickFiles(files: File[]) {
		fireEvent.change(await screen.findByLabelText("添加图片"), {
			target: { files },
		});
	}

	it("同名附件各自独立完成，未全部完成前不能发送", async () => {
		const sdk = makeSdk();
		const resolvers: Array<(value: unknown) => void> = [];
		(sdk.pi.attachments.complete as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => resolvers.push(resolve)),
		);
		await openNewSession(sdk);

		await pickFiles([png("same.png"), png("same.png")]);
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));

		resolvers[0]!({
			fileId: "f-0-same.png",
			sha256: "a",
			size: 3,
			mimeType: "image/png",
			url: "/d/0",
			expiresAt: Date.now() + 60_000,
		});
		await vi.waitFor(() =>
			expect(screen.getAllByRole("img", { name: /附件预览/ })).toHaveLength(1),
		);
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

		resolvers[1]!({
			fileId: "f-1-same.png",
			sha256: "b",
			size: 3,
			mimeType: "image/png",
			url: "/d/1",
			expiresAt: Date.now() + 60_000,
		});
		await vi.waitFor(() =>
			expect(screen.getAllByRole("img", { name: /附件预览/ })).toHaveLength(2),
		);
		expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
	});

	it("切会话后旧上下文的晚到完成结果不会写入新会话的同名草稿", async () => {
		const sdk = makeSdk();
		const resolvers: Array<(value: unknown) => void> = [];
		(sdk.pi.attachments.complete as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => resolvers.push(resolve)),
		);
		await openNewSession(sdk);

		await pickFiles([png("x.png")]);
		await vi.waitFor(() => expect(resolvers).toHaveLength(1));

		// 切换会话（草稿清空），再在新会话里选一个同名文件
		await screen.getAllByText("+ 新建会话")[0]!.click();
		await vi.waitFor(() =>
			expect(screen.queryAllByRole("img", { name: /附件预览/ })).toHaveLength(0),
		);
		await pickFiles([png("x.png")]);
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));

		// 旧上下文的晚到结果只能影响早已消失的旧草稿，不能把新会话的草稿标为就绪
		resolvers[0]!({
			fileId: "f-old",
			sha256: "old",
			size: 3,
			mimeType: "image/png",
			url: "/d/old",
			expiresAt: Date.now() + 60_000,
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.queryAllByRole("img", { name: /附件预览/ })).toHaveLength(0);
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
	});

	it("超过 10 张、非图片类型与超大图片都在上传前拒绝", async () => {
		const sdk = await openNewSession();
		const create = sdk.pi.attachments.create as ReturnType<typeof vi.fn>;

		await pickFiles(Array.from({ length: 11 }, (_, i) => png(`m${i}.png`)));
		await vi.waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("10"),
		);
		expect(create).not.toHaveBeenCalled();

		await pickFiles([new File(["x"], "doc.pdf", { type: "application/pdf" })]);
		await vi.waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("图片"),
		);
		expect(create).not.toHaveBeenCalled();

		await pickFiles([new File([new Uint8Array(11 * 1024 * 1024)], "big.png", { type: "image/png" })]);
		await vi.waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("10 MiB"),
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("纯图片发送传空提示词与图片引用，接受后清空草稿", async () => {
		const sdk = makeSdk();
		await openNewSession(sdk);

		await pickFiles([png("only.png")]);
		await vi.waitFor(() =>
			expect(screen.getByRole("button", { name: "发送" })).toBeEnabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "发送" }));

		await vi.waitFor(() =>
			expect(sdk.pi.agent.prompt as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
		);
		const [, , , input] = (
			sdk.pi.agent.prompt as ReturnType<typeof vi.fn>
		).mock.calls[0] as [string, string, unknown, { prompt: string; images?: unknown[] }];
		expect(input.prompt).toBe("");
		expect(input.images).toHaveLength(1);

		await vi.waitFor(() =>
			expect(screen.queryAllByRole("img", { name: /附件预览/ })).toHaveLength(0),
		);
	});

	it("发送被拒时保留附件草稿并显示错误", async () => {
		const sdk = makeSdk();
		(sdk.pi.agent.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("prompt rejected"),
		);
		await openNewSession(sdk);

		await pickFiles([png("keep.png")]);
		await vi.waitFor(() =>
			expect(screen.getByRole("button", { name: "发送" })).toBeEnabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "发送" }));

		await vi.waitFor(async () =>
			expect((await screen.findAllByText(/prompt rejected/)).length).toBeGreaterThan(0),
		);
		expect(screen.queryAllByRole("img", { name: /附件预览/ })).toHaveLength(1);
	});

	it("移除上传中的附件后，晚到的完成结果不会复活草稿", async () => {
		const sdk = makeSdk();
		const resolvers: Array<(value: unknown) => void> = [];
		(sdk.pi.attachments.complete as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => resolvers.push(resolve)),
		);
		await openNewSession(sdk);

		await pickFiles([png("gone.png")]);
		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: /移除附件 gone\.png/ }));
		expect(screen.queryByText("gone.png")).toBeNull();

		resolvers[0]!({
			fileId: "f-gone",
			sha256: "d",
			size: 3,
			mimeType: "image/png",
			url: "/d/gone",
			expiresAt: Date.now() + 60_000,
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.queryByText("gone.png")).toBeNull();
		expect(screen.queryAllByRole("img", { name: /附件预览/ })).toHaveLength(0);
	});
});
