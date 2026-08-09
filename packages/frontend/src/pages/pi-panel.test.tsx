import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
		hostname: "host",
		os: "win32",
		cpuModel: "cpu",
		totalMemMB: 1,
		clientVersion: "1",
		capabilities: ["pi.probe", "agent.pi"],
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
				newSession: vi.fn(async () => ({ sessionId: "s1" })),
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

function renderPanel(client: ClientInfo) {
	const sdk = makeSdk();
	const view = render(
		<SdkProvider client={sdk}>
			<PiPanel client={client} />
		</SdkProvider>,
	);
	return { sdk, view };
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

	it("显示高权限告警", () => {
		vi.stubGlobal("EventSource", MockEventSource);
		renderPanel(makeClient());
		expect(screen.getByText(/不是沙箱/)).toBeTruthy();
	});

	it("能力不可用时显示原因并禁用输入", () => {
		const client: ClientInfo = {
			...makeClient(),
			capabilities: ["pi.probe"],
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

		await screen.getAllByText("选择")[0]!.click();
		await screen.findByText("D:\\");
		await screen.getByText("D:\\").click();
		await screen.findByText("📁 repo");
		await screen.getByText("📁 repo").click();
		await vi.waitFor(() =>
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0),
		);
		await screen.getByText("选择此目录").click();
		await screen.getAllByText("新建")[0]!.click();
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

	it("选择目录后新建会话并打开事件流", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const { sdk, view } = renderPanel(makeClient());
		void view;

		// 打开项目选择器
		await screen.getAllByText("选择")[0]!.click();
		// 选择 D:\ 根 → repo 目录 → 选择此目录
		await screen.findByText("D:\\");
		await screen.getByText("D:\\").click();
		await screen.findByText("📁 repo");
		await screen.getByText("📁 repo").click();
		await vi.waitFor(() => {
			expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0);
		});
		await screen.getByText("选择此目录").click();
		expect(screen.getAllByText("D:\\repo").length).toBeGreaterThan(0);

		// 新建会话
		await screen.getAllByText("新建")[0]!.click();
		await vi.waitFor(() => {
			expect(sdk.pi.agent.newSession).toHaveBeenCalledWith("c1", {
				rootDir: "D:\\",
				relativePath: "repo",
			});
		});
		expect(MockEventSource.instances.length).toBeGreaterThan(0);
	});
});
