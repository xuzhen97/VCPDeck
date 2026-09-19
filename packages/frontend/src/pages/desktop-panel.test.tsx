import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ClientInfo, TunnelSessionCreated } from "@vcpdeck/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { DesktopPanel } from "@/pages/desktop-panel";
import { openBrowserTunnel } from "@/tunnel/browser-tunnel";
import { createVncSession } from "@/tunnel/vnc-session";

vi.mock("@/tunnel/browser-tunnel", () => ({
	openBrowserTunnel: vi.fn(),
}));
vi.mock("@/tunnel/vnc-session", () => ({
	createVncSession: vi.fn(),
	preloadRfb: vi.fn(),
}));
vi.mock("@/terminal/terminal-socket", () => ({
	createAppSocket: vi.fn(() => ({ on: vi.fn(), off: vi.fn() }) as never),
}));

const SESSION: TunnelSessionCreated = {
	clientId: "c1",
	targetPort: 5900,
	attachDeadline: "2026-09-17T00:01:00.000Z",
	iceServers: [{ urls: ["stun:turn.example.com:3478"] }],
	sessionId: "tn_1",
};

function makeClient(overrides: Partial<ClientInfo> = {}): ClientInfo {
	return {
		clientId: "c1",
		name: "host",
		hostname: "host",
		os: "linux 1",
		cpuModel: "cpu",
		totalMemMB: 1,
		clientVersion: "1",
		capabilities: [],
		capabilityDetails: {},
		online: true,
		cpuPercent: null,
		memPercent: null,
		disks: [],
		lastHeartbeatAt: null,
		...overrides,
	} as ClientInfo;
}

function makeSdk() {
	const create = vi.fn().mockResolvedValue(SESSION);
	const remove = vi.fn().mockResolvedValue({ closed: true });
	const client = {
		tunnels: {
			config: { get: vi.fn(), update: vi.fn() },
			create,
			remove,
		},
	} as unknown as VcpDeckClient;
	return { client, create, remove };
}

function makeTunnel() {
	return {
		channel: {} as RTCDataChannel,
		peer: {} as RTCPeerConnection,
		failureCode: null as string | null,
		selectedPath: vi.fn(async () => "direct" as const),
		close: vi.fn(async () => undefined),
	};
}

/**
 * 模拟隧道建立：真实实现会在 DataChannel open 之前同步回调 `onChannel`，
 * 面板必须在该回调里挂载 noVNC（否则会丢失通道 open 后立即到达的 RFB banner）。
 * 这里同样先触发 `onChannel` 再 resolve。
 */
function mockOpen(tunnel: ReturnType<typeof makeTunnel>) {
	vi.mocked(openBrowserTunnel).mockImplementation(async (opts) => {
		opts.onChannel?.(tunnel.channel);
		return tunnel as never;
	});
}

function makeVnc() {
	return {
		disconnect: vi.fn(),
		setViewOnly: vi.fn(),
		setViewMode: vi.fn(),
		setResizeSession: vi.fn(),
		setQuality: vi.fn(),
		setCompression: vi.fn(),
		sendClipboard: vi.fn(),
		sendCtrlAltDel: vi.fn(),
		sendCredentials: vi.fn(),
		rfb: {} as never,
	};
}

function renderPanel(client: ClientInfo, sdkClient: VcpDeckClient) {
	return render(
		<SdkProvider client={sdkClient}>
			<DesktopPanel client={client} />
		</SdkProvider>,
	);
}

const p2pClient = makeClient({
	capabilityDetails: { p2pTunnel: { available: true, protocolVersion: 1 } },
});

describe("DesktopPanel", () => {
	beforeEach(() => {
		vi.mocked(openBrowserTunnel).mockReset();
		vi.mocked(createVncSession).mockReset();
	});

	it("旧 Client 显示不支持入口，不发起请求", async () => {
		const { client: sdkClient, create } = makeSdk();
		renderPanel(makeClient({ capabilityDetails: {} }), sdkClient);
		expect(screen.getByText("该 Client 不支持 P2P 隧道协议 v1")).toBeInTheDocument();
		expect(create).not.toHaveBeenCalled();
	});

	it("明文 HTTP（非安全上下文）提示 HTTPS，且不阻断连接", async () => {
		const prev = Object.getOwnPropertyDescriptor(window, "isSecureContext");
		Object.defineProperty(window, "isSecureContext", {
			value: false,
			configurable: true,
		});
		try {
			const tunnel = makeTunnel();
			const vnc = makeVnc();
			mockOpen(tunnel);
			vi.mocked(createVncSession).mockResolvedValue(vnc as never);
			const { client: sdkClient, create } = makeSdk();
			renderPanel(p2pClient, sdkClient);
			expect(await screen.findByTestId("desktop-insecure-context")).toHaveTextContent(
				"HTTPS",
			);
			// 只是提示：仍可正常发起连接
			await userEvent.setup().click(screen.getByRole("button", { name: "连接" }));
			await waitFor(() => expect(create).toHaveBeenCalled());
		} finally {
			if (prev) Object.defineProperty(window, "isSecureContext", prev);
			else Reflect.deleteProperty(window, "isSecureContext");
		}
	});

	it("非法端口拒绝连接并报错", async () => {
		const { client: sdkClient, create } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		const port = screen.getByLabelText("目标端口");
		await user.clear(port);
		await user.type(port, "99999");
		await user.click(screen.getByRole("button", { name: "连接" }));
		expect(await screen.findByTestId("desktop-error")).toHaveTextContent("目标端口非法");
		expect(create).not.toHaveBeenCalled();
	});

	it("连接成功：创建 Session、打开隧道、创建 VNC 会话，展示路径芯片并可断开", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);

		const { client: sdkClient, remove, create } = makeSdk();
		const { unmount } = renderPanel(p2pClient, sdkClient);
		// 安全上下文（jsdom 默认）不显示提示
		expect(screen.queryByTestId("desktop-insecure-context")).toBeNull();

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));

		// 等待会话对象建立后，触发 connected 事件
		await waitFor(() =>
			expect(createVncSession).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ viewOnly: true }),
			),
		);
		const onState = vi.mocked(createVncSession).mock.calls[0][2]?.onState;
		onState?.("connected" as never);

		await waitFor(() => expect(screen.getByText("P2P 直连")).toBeInTheDocument());
		expect(create).toHaveBeenCalledWith({ clientId: "c1", targetPort: 5900 });

		// 断开 → 清理链：vnc.disconnect → tunnel.close → tunnels.remove，回到空闲
		await user.click(screen.getByRole("button", { name: "断开" }));
		await waitFor(() => expect(vnc.disconnect).toHaveBeenCalled());
		await waitFor(() => expect(tunnel.close).toHaveBeenCalled());
		await waitFor(() => expect(remove).toHaveBeenCalledWith("tn_1"));
		// 断开后连接按钮回到可用（phase=idle）
		await waitFor(() => expect(screen.getByRole("button", { name: "连接" })).toBeEnabled());

		unmount();
	});

	it("凭据弹窗提交时把密码交给底层 VNC 会话", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);

		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		const opts = vi.mocked(createVncSession).mock.calls[0][2]!;
		// 服务端要求凭据
		opts.onCredentials?.({ types: ["password"] } as never);

		const pw = await screen.findByTestId("desktop-password");
		await user.type(pw, "secret");
		await user.click(screen.getByRole("button", { name: "连接" }));

		expect(vnc.sendCredentials).toHaveBeenCalledWith({ password: "secret" });
	});

	it("连接建立前目标无监听：报具体错误并清理", async () => {
		// 隧道建立成功但随后状态 failed(TUNNEL_TARGET_REFUSED)
		const tunnel = makeTunnel();
		tunnel.failureCode = "TUNNEL_TARGET_REFUSED";
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);

		const { client: sdkClient, remove } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());

		const opts = vi.mocked(createVncSession).mock.calls[0][2]!;
		opts.onState?.("disconnected" as never);

		expect(await screen.findByTestId("desktop-error")).toHaveTextContent("目标端口拒绝连接");
		await waitFor(() => expect(remove).toHaveBeenCalledWith("tn_1"));
	});

	it("连接后全屏按钮把画面容器设为浏览器全屏", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		const opts = vi.mocked(createVncSession).mock.calls[0][2]!;
		opts.onState?.("connected" as never);

		// mock 出全屏 API：点「全屏」应调用容器的 requestFullscreen
		const canvas = screen.getByTestId("desktop-canvas");
		const requestFullscreen = vi.fn(async () => undefined);
		(canvas as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFullscreen;
		await user.click(await screen.findByRole("button", { name: "全屏" }));
		await waitFor(() => expect(requestFullscreen).toHaveBeenCalled());
	});

	it("全屏控制位于画布容器内，全屏时仍可见可点", async () => {		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		// 全屏按钮必须是画布容器的后代，Fullscreen 显示容器时才可见
		const canvas = screen.getByTestId("desktop-canvas");
		const fsBtn = await screen.findByRole("button", { name: "全屏" });
		expect(canvas.contains(fsBtn)).toBe(true);
	});

	it("noVNC 在隧道 open 之前就挂到通道上（避免丢失 RFB banner）", async () => {
		const tunnel = makeTunnel();
		vi.mocked(createVncSession).mockResolvedValue(makeVnc() as never);
		// 隧道 open 故意挂起：用于断言 noVNC 已在 open 前挂载
		let releaseOpen!: () => void;
		const openPromise = new Promise<never>((resolve) => {
			releaseOpen = () => resolve(undefined as never);
		});
		vi.mocked(openBrowserTunnel).mockImplementation((opts) => {
			opts.onChannel?.(tunnel.channel);
			return openPromise;
		});

		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		await userEvent.setup().click(screen.getByRole("button", { name: "连接" }));

		// open 仍未 resolve，但 noVNC 已带着同一条通道启动
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		expect(vi.mocked(createVncSession).mock.calls[0][1]).toBe(tunnel.channel);

		releaseOpen();
	});

	it("默认只读 + 适配模式 + 远端跟随 + 中档画质；切档位/模式/跟随作用到底层会话", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		const opts = vi.mocked(createVncSession).mock.calls[0][2]!;
		expect(opts.viewOnly).toBe(true);
		expect(opts.viewMode).toBe("fit");
		expect(opts.resizeSession).toBe(true);
		expect([opts.qualityLevel, opts.compressionLevel]).toEqual([6, 2]);

		// 工具栏控件在会话已连接时出现
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		await screen.findByTestId("desktop-view-actual");

		await user.click(screen.getByTestId("desktop-view-actual"));
		await waitFor(() => expect(vnc.setViewMode).toHaveBeenCalledWith("actual"));
		await user.click(screen.getByTestId("desktop-viewonly"));
		await waitFor(() => expect(vnc.setViewOnly).toHaveBeenCalledWith(false));
		await user.click(screen.getByTestId("desktop-resize-follow"));
		await waitFor(() => expect(vnc.setResizeSession).toHaveBeenCalledWith(false));
		await user.selectOptions(screen.getByTestId("desktop-quality"), "high");
		await waitFor(() => expect(vnc.setQuality).toHaveBeenCalledWith(9));
	});

	it("画布不再固定在 60vh，而是自适应容器", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const canvas = screen.getByTestId("desktop-canvas");
		expect(canvas.className).not.toContain("h-[60vh]");
		// 未连接时只有最小高度
		expect(canvas.className).toContain("min-h-64");

		await userEvent.setup().click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		// 连接后自适应容器高度（不再固定 60vh）
		await waitFor(() => expect(screen.getByTestId("desktop-canvas").className).toContain("h-[70dvh]"));
	});

	it("远端剪贴板展示、发送本地剪贴板与 Ctrl+Alt+Del", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		const opts = vi.mocked(createVncSession).mock.calls[0][2]!;
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		// 远端剪贴板
		opts.onClipboard?.("远端文本");
		expect(await screen.findByTestId("desktop-clipboard-recv")).toHaveTextContent("远端文本");

		// 发送本地剪贴板
		Object.defineProperty(navigator, "clipboard", {
			value: { readText: vi.fn(async () => "本地文本") },
			configurable: true,
		});
		await user.click(await screen.findByTestId("desktop-clipboard-send"));
		await waitFor(() => expect(vnc.sendClipboard).toHaveBeenCalledWith("本地文本"));

		// Ctrl+Alt+Del
		await user.click(screen.getByTestId("desktop-cad"));
		await waitFor(() => expect(vnc.sendCtrlAltDel).toHaveBeenCalled());
	});

	it("切换显示器只改裁剪区域，不重连也不重建会话", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient, create } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		const callsAfterConnect = vi.mocked(createVncSession).mock.calls.length;
		const sessionsAfterConnect = create.mock.calls.length;

		// 默认全屏
		await waitFor(() =>
			expect(screen.getByTestId("desktop-crop-frame")).toHaveAttribute("data-crop-aspect", "100 / 100"),
		);

		await user.click(screen.getByTestId("desktop-display-left"));
		await waitFor(() =>
			expect(screen.getByTestId("desktop-crop-frame")).toHaveAttribute("data-crop-aspect", "50 / 100"),
		);

		await user.click(screen.getByTestId("desktop-display-right"));
		await waitFor(() =>
			expect(screen.getByTestId("desktop-crop-frame")).toHaveAttribute("data-crop-aspect", "50 / 100"),
		);

		await user.click(screen.getByTestId("desktop-display-all"));
		await waitFor(() =>
			expect(screen.getByTestId("desktop-crop-frame")).toHaveAttribute("data-crop-aspect", "100 / 100"),
		);

		// 不重连、不重建会话
		expect(vi.mocked(createVncSession).mock.calls.length).toBe(callsAfterConnect);
		expect(create.mock.calls.length).toBe(sessionsAfterConnect);
		expect(vnc.disconnect).not.toHaveBeenCalled();
	});

	it("已连接后断开：给出重连提示并自动重连", async () => {
		// shouldAdvanceTime：让 Testing Library 的 waitFor 能随真实时间推进假定时器
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient, create } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		expect(create).toHaveBeenCalledTimes(1);

		// 已连接之后的断开 → 不再静默，而是进入自动重连
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("disconnected" as never);
		expect(await screen.findByTestId("desktop-reconnect")).toHaveTextContent("第 1 次");

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
		vi.useRealTimers();
	});
	it("目标端口拒绝：给出原因且不自动重连", async () => {
		const tunnel = makeTunnel();
		tunnel.failureCode = "TUNNEL_TARGET_REFUSED";
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient, create } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		await userEvent.setup().click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("disconnected" as never);
		expect(await screen.findByTestId("desktop-error")).toHaveTextContent("目标端口拒绝连接");
		expect(screen.queryByTestId("desktop-reconnect")).toBeNull();
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("连续全黑出现提示，画面恢复后自动消失", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let black: Uint8ClampedArray | null = new Uint8ClampedArray([0, 0, 0, 255]);
		const sampler = vi.fn(() => black);
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		render(
			<SdkProvider client={sdkClient}>
				<DesktopPanel client={p2pClient} blackSampler={sampler} />
			</SdkProvider>,
		);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		await act(async () => {
			vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		});

		// 连续全黑 → 提示
		await act(async () => {
			vi.advanceTimersByTime(2000 * 6);
		});
		expect(sampler.mock.calls.length).toBeGreaterThanOrEqual(5);
		expect(screen.getByTestId("desktop-black-warning")).toHaveTextContent("可能未接显示器");

		// 画面恢复 → 自动消失
		black = new Uint8ClampedArray([255, 255, 255, 255]);
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.queryByTestId("desktop-black-warning")).toBeNull();
		vi.useRealTimers();
	});

	it("重连尝试自身失败也会继续退避重试，到达上限后才报失败", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient, create } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		await act(async () => {
			vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		});
		// 之后创建会话一直失败（模拟持续离线）
		create.mockRejectedValue(new Error("offline"));

		await act(async () => {
			vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("disconnected" as never);
		});
		// 分多轮推进：每轮结束会 flush 微任务，使异步重试排下的下一个定时器能被下一轮触发
		for (let i = 0; i < 8; i += 1) {
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				vi.advanceTimersByTime(15000);
			});
		}
		// 多次重试而不是一次即止
		expect(create.mock.calls.length).toBeGreaterThan(3);
		await waitFor(() => expect(screen.getByTestId("desktop-error")).toHaveTextContent("重连失败"));
		vi.useRealTimers();
	});
});
