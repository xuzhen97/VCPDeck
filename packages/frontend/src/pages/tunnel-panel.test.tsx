import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ClientInfo, TunnelSessionCreated } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { TunnelPanel } from "@/pages/tunnel-panel";
import { openBrowserTunnel } from "@/tunnel/browser-tunnel";
import { probeHttp } from "@/tunnel/http-probe";

vi.mock("@/tunnel/browser-tunnel", () => ({
	openBrowserTunnel: vi.fn(),
}));
vi.mock("@/tunnel/http-probe", () => ({
	probeHttp: vi.fn(),
}));
vi.mock("@/terminal/terminal-socket", () => ({
	createAppSocket: vi.fn(() => ({} as never)),
}));

const SESSION: TunnelSessionCreated = {
	clientId: "c1",
	targetPort: 3000,
	attachDeadline: "2026-09-11T00:01:00.000Z",
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
		tunnels: { config: { get: vi.fn(), update: vi.fn() }, create, remove },
	} as unknown as VcpDeckClient;
	return { client, create, remove };
}

function renderPanel(client: ClientInfo, sdkClient: VcpDeckClient) {
	render(
		<SdkProvider client={sdkClient}>
			<TunnelPanel client={client} />
		</SdkProvider>,
	);
}

const p2pClient = makeClient({
	capabilityDetails: { p2pTunnel: { available: true, protocolVersion: 1 } },
});

describe("TunnelPanel", () => {
	beforeEach(() => {
		vi.mocked(openBrowserTunnel).mockReset();
		vi.mocked(probeHttp).mockReset();
	});

	it("创建 Session、执行 HTTP probe、展示 direct 并最终关闭", async () => {
		const close = vi.fn(async () => undefined);
		vi.mocked(openBrowserTunnel).mockResolvedValue({
			channel: {} as never,
			peer: {} as never,
			selectedPath: async () => "direct",
			close,
		} as never);
		vi.mocked(probeHttp).mockResolvedValue({ statusLine: "HTTP/1.1 200 OK", body: "OK" });

		const { client: sdkClient, remove, create } = makeSdk();
		renderPanel(p2pClient, sdkClient);

		const user = userEvent.setup();
		const port = screen.getByLabelText("目标端口");
		await user.clear(port);
		await user.type(port, "3000");
		await user.click(screen.getByRole("button", { name: "连接并测试" }));

		expect(await screen.findByText("HTTP/1.1 200 OK")).toBeInTheDocument();
		expect(screen.getByText("P2P 直连")).toBeInTheDocument();
		expect(create).toHaveBeenCalledWith({ clientId: "c1", targetPort: 3000 });
		expect(close).toHaveBeenCalled();
		await waitFor(() => expect(remove).toHaveBeenCalledWith("tn_1"));
	});

	it("强制中继时传 relayOnly=true", async () => {
		vi.mocked(openBrowserTunnel).mockResolvedValue({
			channel: {} as never,
			peer: {} as never,
			selectedPath: async () => "relay",
			close: vi.fn(async () => undefined),
		} as never);
		vi.mocked(probeHttp).mockResolvedValue({ statusLine: "HTTP/1.1 200 OK", body: "OK" });

		const { client: sdkClient } = makeSdk();
		renderPanel(p2pClient, sdkClient);

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("强制 TURN 中继"));
		await user.click(screen.getByRole("button", { name: "连接并测试" }));
		await waitFor(() =>
			expect(openBrowserTunnel).toHaveBeenCalledWith(
				expect.objectContaining({ relayOnly: true }),
			),
		);
	});

	it("旧 Client 显示不支持入口，不发起请求", async () => {
		const { client: sdkClient, create } = makeSdk();
		renderPanel(makeClient({ capabilityDetails: {} }), sdkClient);
		expect(screen.getByText("该 Client 不支持 P2P 隧道协议 v1")).toBeInTheDocument();
		expect(create).not.toHaveBeenCalled();
	});
});
