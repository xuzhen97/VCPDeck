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

	it("全屏按钮把「工具栏 + 画面」的工作区设为浏览器全屏", async () => {
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

		// 全屏目标必须是包含工具栏的工作区，而不是画布（否则全屏后控件不可见）
		const workspace = screen.getByTestId("desktop-workspace");
		const requestFullscreen = vi.fn(async () => undefined);
		(workspace as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFullscreen;
		await user.click(await screen.findByRole("button", { name: "全屏" }));
		await waitFor(() => expect(requestFullscreen).toHaveBeenCalled());
	});

	it("工具栏在画面之外，且在同一个全屏工作区内", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		const workspace = screen.getByTestId("desktop-workspace");
		const toolbar = await screen.findByTestId("desktop-toolbar");
		const canvas = screen.getByTestId("desktop-canvas");

		// 工具栏不得在画面内部（不能遮挡远程内容）
		expect(canvas.contains(toolbar)).toBe(false);
		// 但必须在全屏工作区内，否则全屏时不可见
		expect(workspace.contains(toolbar)).toBe(true);
		expect(workspace.contains(canvas)).toBe(true);
	});

	it("页面内最大化不调用 Fullscreen API，且可退出", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		const workspace = screen.getByTestId("desktop-workspace");
		const requestFullscreen = vi.fn(async () => undefined);
		(workspace as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFullscreen;

		await user.click(await screen.findByRole("button", { name: "最大化" }));
		expect(requestFullscreen).not.toHaveBeenCalled();
		expect(workspace.className).toContain("fixed");

		await user.click(screen.getByRole("button", { name: "退出最大化" }));
		expect(screen.getByTestId("desktop-workspace").className).not.toContain("fixed");
	});

	it("倍率缩放只放大 noVNC 容器，不产生任何 transform", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		const host = await screen.findByTestId("desktop-vnc-host");
		expect(host.style.width).toBe("");

		await user.click(screen.getByTestId("desktop-zoom-150"));
		expect(host.style.width).toBe("150%");
		expect(host.style.height).toBe("150%");
		// 绝不能用 transform/zoom 做倍率：noVNC 的 display.scale 感知不到，会使指针坐标失真
		expect(host.getAttribute("style") ?? "").not.toMatch(/transform|zoom/i);
		// 放大后仍用 noVNC 的适配缩放（容器变大 ⇒ 画面变大，坐标自洽）
		await waitFor(() => expect(vnc.setViewMode).toHaveBeenCalledWith("fit"));
	});

	it("适应窗口清除放大；1:1 交给 noVNC 裁剪模式", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		await user.click(await screen.findByTestId("desktop-zoom-150"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("150%");

		await user.click(screen.getByTestId("desktop-zoom-fit"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("");
		await waitFor(() => expect(vnc.setViewMode).toHaveBeenCalledWith("fit"));

		await user.click(screen.getByTestId("desktop-zoom-actual"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("");
		await waitFor(() => expect(vnc.setViewMode).toHaveBeenCalledWith("actual"));
	});

	it("加/减档位沿倍率阶梯移动并夹紧边界", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		await user.click(await screen.findByTestId("desktop-zoom-in"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("125%");
		await user.click(screen.getByTestId("desktop-zoom-in"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("150%");
		await user.click(screen.getByTestId("desktop-zoom-out"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("125%");
		await user.click(screen.getByTestId("desktop-zoom-out"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("");
		// 已在最小端：再减也不越界
		await user.click(screen.getByTestId("desktop-zoom-out"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("");
	});

	it("查看模式与缩放档位保持一致（不出现 1:1 与放大容器并存）", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		await user.click(await screen.findByTestId("desktop-zoom-150"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("150%");

		// 切到 1:1：容器必须回到 100%，否则会与 noVNC 的裁剪模式叠加
		await user.click(screen.getByTestId("desktop-view-actual"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("");
		await waitFor(() => expect(vnc.setViewMode).toHaveBeenCalledWith("actual"));

		// 再选倍率：回到 fit（容器放大驱动缩放）
		await user.click(screen.getByTestId("desktop-zoom-150"));
		expect(screen.getByTestId("desktop-vnc-host").style.width).toBe("150%");
		await waitFor(() => expect(vnc.setViewMode).toHaveBeenCalledWith("fit"));
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

	it("默认只读 + 适配模式 + 永不请求远端 resize + 中档画质；切档位/模式作用到底层会话", async () => {
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
		// 「远端跟随」已移除：面板不提供任何改变远端分辨率的开关
		expect([opts.qualityLevel, opts.compressionLevel]).toEqual([6, 2]);

		// 工具栏控件在会话已连接时出现
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		await screen.findByTestId("desktop-view-actual");

		await user.click(screen.getByTestId("desktop-view-actual"));
		await waitFor(() => expect(vnc.setViewMode).toHaveBeenCalledWith("actual"));
		await user.click(screen.getByTestId("desktop-viewonly"));
		await waitFor(() => expect(vnc.setViewOnly).toHaveBeenCalledWith(false));
		await user.selectOptions(screen.getByTestId("desktop-quality"), "high");
		await waitFor(() => expect(vnc.setQuality).toHaveBeenCalledWith(9));
		// 「远端跟随」已移除，任何时候都不得请求远端 resize
		expect(screen.queryByTestId("desktop-resize-follow")).toBeNull();
		expect(vnc.setResizeSession).not.toHaveBeenCalled();
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

	it("不再渲染「左半/右半」控件与裁剪包裹层", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);
		await screen.findByTestId("desktop-view-actual");

		expect(screen.queryByText("左半")).toBeNull();
		expect(screen.queryByText("右半")).toBeNull();
		expect(screen.queryByTestId("desktop-crop-frame")).toBeNull();
		expect(screen.queryByTestId("desktop-display-left")).toBeNull();
		expect(screen.queryByTestId("desktop-display-right")).toBeNull();
		expect(screen.queryByTestId("desktop-display-all")).toBeNull();
	});

	it("noVNC 宿主到画布容器之间没有任何 CSS 变换（否则坐标会被二次缩放）", async () => {
		const tunnel = makeTunnel();
		const vnc = makeVnc();
		mockOpen(tunnel);
		vi.mocked(createVncSession).mockResolvedValue(vnc as never);
		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "连接" }));
		await waitFor(() => expect(createVncSession).toHaveBeenCalled());
		vi.mocked(createVncSession).mock.calls[0][2]?.onState?.("connected" as never);

		// noVNC 用 x / display.scale 换算指针坐标，而 display.scale 只由容器尺寸决定。
		// 任何加在 canvas 祖先上的 transform/translate/zoom 都会让坐标失真。
		const host = await screen.findByTestId("desktop-vnc-host");
		const canvas = screen.getByTestId("desktop-canvas");
		let el: HTMLElement | null = host;
		while (el && el !== canvas) {
			expect(el.getAttribute("style") ?? "").not.toMatch(/transform|translate|scale|zoom/i);
			el = el.parentElement;
		}
		expect(el).toBe(canvas);
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
