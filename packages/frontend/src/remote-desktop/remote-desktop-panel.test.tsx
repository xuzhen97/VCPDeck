import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ClientInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { RemoteDesktopPanel, supportsSecureAttention } from "./remote-desktop-panel";

// 捕获 RemoteDesktopView 收到的 props，用于验证 Panel → View 的接线。
const viewProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./remote-desktop-view", () => ({
	RemoteDesktopView: (props: Record<string, unknown>) => {
		viewProps.current = props;
		return <div data-testid="remote-desktop-view-stub" />;
	},
}));

const readySession = {
	id: "session-1",
	status: "ready",
	qualityProfile: "balanced",
	clipboardMode: "off",
	displays: [],
	selectedDisplayId: null,
} as unknown as import("@vcpdeck/shared").RemoteDesktopSessionInfo;

function capableClient(secureAttention: boolean): ClientInfo {
	return {
		...client,
		capabilities: ["remote-desktop"],
		capabilityDetails: {
			remoteDesktop: {
				protocolVersion: 1,
				hostVersion: "0.1.0",
				available: true,
				backend: "windows",
				capture: true,
				pointer: true,
				keyboard: true,
				clipboardText: true,
				loginScreen: true,
				lockScreen: true,
				secureAttention,
				physicalDisplay: true,
				virtualDisplay: true,
				headless: false,
				hardwareEncoders: ["mock"],
				supportedCodecs: ["VP8"],
			},
		},
	};
}

const client: ClientInfo = {
	clientId: "client-1",
	name: "workstation",
	hostname: "workstation",
	os: "win32",
	cpuModel: "CPU",
	totalMemMB: 1024,
	disks: [],
	clientVersion: "1.0.0",
	capabilities: [],
	capabilityDetails: {},
	online: true,
	cpuPercent: null,
	memPercent: null,
	lastHeartbeatAt: null,
};

function renderPanel(overrides: Partial<ClientInfo> = {}, sessions: unknown[] = []) {
	const sdk = {
		auth: { me: async () => ({
			id: "identity-1",
			username: "admin",
			displayName: "管理员",
			isAdmin: true,
			disabledAt: null,
			createdAt: "2026-09-11T00:00:00.000Z",
		}) },
		remoteDesktop: {
			list: async () => ({ data: sessions, total: sessions.length, page: 1, pageSize: 20, totalPages: 1 }),
			create: async () => ({}),
			remove: async () => ({}),
		},
	} as unknown as VcpDeckClient;
	return render(
		<MemoryRouter>
			<SdkProvider client={sdk}>
				<AuthProvider>
					<RemoteDesktopPanel client={{ ...client, ...overrides }} />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

describe("RemoteDesktopPanel", () => {
	it("does not pretend desktop support when capability is unavailable", async () => {
		renderPanel();
		expect(await screen.findByText("远程桌面不可用")).toBeVisible();
		expect(screen.getByText("目标 Client 尚未报告可用的 Desktop Host 能力。")).toBeVisible();
		expect(screen.queryByRole("button", { name: "创建远程桌面会话" })).not.toBeInTheDocument();
	});

	it("shows the create action only for a reported available capability", async () => {
		renderPanel({
			capabilities: ["remote-desktop"],
			capabilityDetails: {
				remoteDesktop: {
					protocolVersion: 1,
					hostVersion: "0.1.0",
					available: true,
					backend: "windows",
					capture: true,
					pointer: true,
					keyboard: true,
					clipboardText: true,
					loginScreen: true,
					lockScreen: true,
					secureAttention: true,
					physicalDisplay: true,
					virtualDisplay: true,
					headless: true,
					hardwareEncoders: ["mock"],
					supportedCodecs: ["VP8"],
				},
			},
		});
		expect(await screen.findByRole("button", { name: "创建远程桌面会话" })).toBeVisible();
	});

	it("derives secure attention only from an explicitly reported capability", () => {
		// 缺失 secureAttention 字段时一律为 false，不因平台是 Windows 就假定支持。
		expect(supportsSecureAttention(client)).toBe(false);
		expect(supportsSecureAttention(capableClient(true))).toBe(true);
		expect(supportsSecureAttention(capableClient(false))).toBe(false);
		const { secureAttention: _omitted, ...withoutField } = capableClient(true).capabilityDetails?.remoteDesktop ?? {};
		expect(
			supportsSecureAttention({
				...capableClient(true),
				capabilityDetails: { remoteDesktop: withoutField as never },
			}),
		).toBe(false);
	});

	it("passes the secure attention capability down to the desktop view", async () => {
		viewProps.current = {};
		renderPanel(capableClient(true), [readySession]);
		await (await screen.findByRole("button", { name: "连接" })).click();
		expect(await screen.findByTestId("remote-desktop-view-stub")).toBeVisible();
		expect(viewProps.current.secureAttentionSupported).toBe(true);
		expect(viewProps.current.sessionId).toBe("session-1");
	});
});
