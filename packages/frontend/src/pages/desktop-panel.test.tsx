import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ClientInfo, TunnelSessionCreated } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
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
	createAppSocket: vi.fn(() => ({} as never)),
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
				expect.objectContaining({ viewOnly: false }),
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

	it("全屏控制位于画布容器内，全屏时仍可见可点", async () => {
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
});
