import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { SettingsPage } from "./settings-page";

const identity = (isAdmin: boolean): IdentityInfo => ({
	id: "i1",
	username: "operator",
	displayName: "操作员",
	isAdmin,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
});

function LocationProbe() {
	return <output aria-label="当前位置">{useLocation().pathname}</output>;
}

function renderSettings(
	isAdmin = true,
	path = "/settings/tokens",
	options: { tokens?: unknown[] } = {},
) {
	const token = { id: "t1", token: "vcp_secret_once", label: "CLI" };
	const tokens = {
		// 直接渲染 SettingsPage 时面板同步挂载，列表必须在渲染前就位
		list: vi.fn().mockResolvedValue(options.tokens ?? []),
		create: vi.fn().mockResolvedValue(token),
		revoke: vi.fn().mockResolvedValue({ ok: true }),
	};
	const client = {
		auth: { me: async () => identity(isAdmin), updateMe: vi.fn(), tokens },
		identities: {
			list: vi.fn().mockResolvedValue([]),
			create: vi.fn(),
			disable: vi.fn(),
			enable: vi.fn(),
		},
		clients: { list: vi.fn().mockResolvedValue([]) },
		storage: {
			getBackendConfig: vi
				.fn()
				.mockResolvedValue({ kind: "local", updatedAt: null }),
			setBackend: vi
				.fn()
				.mockResolvedValue({ kind: "local", updatedAt: null }),
		},
		aliyundrive: {
			status: vi.fn().mockResolvedValue({
				configured: false,
				authorized: false,
				hasAuth: false,
				isExpired: false,
				clientId: null,
				openapiBase: "https://openapi.alipan.com",
				transferFolder: "VCPDeck",
				driveId: null,
				expiresAt: null,
			}),
			configure: vi.fn(),
			startOAuth: vi.fn(),
			completeOAuth: vi.fn(),
			revoke: vi.fn(),
			verify: vi.fn().mockResolvedValue({
				valid: false,
				checkedAt: "2026-07-31T12:00:00.000Z",
				reason: "not_configured",
			}),
		},
		pi: {
			profiles: {
				list: vi.fn().mockResolvedValue({
					data: [],
					total: 0,
					page: 1,
					pageSize: 20,
					totalPages: 0,
				}),
			},
				credentials: {
					list: vi.fn().mockResolvedValue({
						data: [
						{
							id: "cred-anthropic",
							name: "Anthropic 主账号",
							providerConfigId: "provider-anthropic",
							providerName: "Anthropic",
							runtimeProviderId: "anthropic",
							protocol: "anthropic-messages",
							configurationState: "ready",
							fingerprint: "a1b2c3d4",
							keyVersion: 1,
							createdAt: "2026-07-26T00:00:00.000Z",
							updatedAt: "2026-07-26T00:00:00.000Z",
							lastUsedAt: null,
							revokedAt: null,
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
					totalPages: 1,
				}),
			},
			providers: {
				list: vi.fn().mockResolvedValue({
					data: [{
						id: "provider-anthropic",
						name: "Anthropic",
						runtimeProviderId: "anthropic",
						protocol: "anthropic-messages",
						baseUrl: null,
						headers: {},
						enabled: true,
						revision: 1,
						models: [],
						credentialIds: ["cred-anthropic"],
						boundProfileIds: [],
						configurationState: "ready",
					}],
					total: 1,
					page: 1,
					pageSize: 20,
					totalPages: 1,
				}),
			},
			bindings: { list: vi.fn().mockResolvedValue([]) },
			runtime: vi.fn(),
		},
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter initialEntries={[path]}>
			<SdkProvider client={client}>
				<AuthProvider>
					<SettingsPage />
					<LocationProbe />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
	return { tokens };
}

describe("SettingsPage", () => {
	it("shows a newly created token only until its dialog closes", async () => {
		const { tokens } = renderSettings();
		await userEvent.type(await screen.findByLabelText("Token 标签"), "CLI");
		await userEvent.click(screen.getByRole("button", { name: "创建 Token" }));
		expect(tokens.create).toHaveBeenCalledWith({ label: "CLI" });
		expect(await screen.findByText("vcp_secret_once")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "我已保存" }));
		expect(screen.queryByText("vcp_secret_once")).not.toBeInTheDocument();
	});

	it("requires confirmation before revoking a token", async () => {
		const { tokens } = renderSettings(true, "/settings/tokens", {
			tokens: [
				{
					id: "t1",
					label: "CLI",
					lastUsedAt: null,
					expiresAt: null,
					revokedAt: null,
					createdAt: "2026-07-26T00:00:00.000Z",
				},
			],
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "撤销 Token" }),
		);
		expect(tokens.revoke).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "确认撤销" }));
		expect(tokens.revoke).toHaveBeenCalledWith("t1");
	});

	it("旧 Pi 设置地址重定向到 Agent 模块的 Profile", async () => {
		renderSettings(true, "/settings/pi");
		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent(
				"/agent/profile",
			),
		);
	});

	it("renders the storage panel as a settings section", async () => {
		renderSettings(true, "/settings/storage");

		expect(await screen.findByText("当前激活的存储")).toBeVisible();
		expect(screen.getByRole("tablist", { name: "存储设置" })).toBeVisible();
		expect(
			screen.getByRole("heading", { name: "设置" }),
		).toBeInTheDocument();
	});

	it("falls back to profile for an unknown settings section", async () => {
		renderSettings(true, "/settings/unknown");
		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent(
				"/settings/profile",
			),
		);
	});

	it("hides and blocks identity management for non-admin users", async () => {
		renderSettings(false, "/settings/identities");
		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent(
				"/settings/profile",
			),
		);
		expect(
			screen.queryByRole("link", { name: "身份管理" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("创建身份")).not.toBeInTheDocument();
	});
});
