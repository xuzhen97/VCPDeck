import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo } from "@vcpdeck/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { AppRoutes } from "@/app/routes";

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

function renderSettings(isAdmin = true, path = "/settings/tokens") {
	const token = { id: "t1", token: "vcp_secret_once", label: "CLI" };
	const tokens = {
		list: vi.fn().mockResolvedValue([]),
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
					<AppRoutes />
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
		const { tokens } = renderSettings();
		tokens.list.mockResolvedValue([
			{
				id: "t1",
				label: "CLI",
				lastUsedAt: null,
				expiresAt: null,
				revokedAt: null,
				createdAt: "2026-07-26T00:00:00.000Z",
			},
		]);
		await userEvent.click(
			await screen.findByRole("button", { name: "撤销 Token" }),
		);
		expect(tokens.revoke).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "确认撤销" }));
		expect(tokens.revoke).toHaveBeenCalledWith("t1");
	});

	it("Pi 页面按功能切换 Tab，且只挂载当前面板", async () => {
		renderSettings(true, "/pi/profile");
		expect(await screen.findByRole("heading", { name: "Pi" })).toBeInTheDocument();
		expect(
			await screen.findByRole("heading", { name: "Pi · Profile" }),
		).toBeInTheDocument();
		const provider = screen.getByRole("combobox", { name: "默认 Provider" });
		expect(provider).toBeInTheDocument();
		expect(provider).toHaveValue("");
		expect(screen.queryByLabelText("pi-profile-provider")).not.toBeInTheDocument();
		// 勾选凭据后，默认 Provider 下拉才会列出该凭据对应的 Provider（credential-driven）
		await userEvent.click(screen.getByLabelText("Anthropic 主账号 (anthropic)"));
		await waitFor(() => expect(provider).toHaveValue("anthropic"));
		const tablist = screen.getByRole("tablist", { name: "Pi 功能" });
		for (const label of ["Profile", "Provider", "Client 运行时"]) {
			expect(within(tablist).getByRole("tab", { name: label })).toBeVisible();
		}
		expect(
			screen.queryByRole("heading", { name: "Pi · Provider 凭据" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Pi · Client 运行时" }),
		).not.toBeInTheDocument();
		await userEvent.click(
			within(tablist).getByRole("tab", { name: "Provider" }),
		);
		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent(
				"/pi/provider",
			),
		);
		expect(
			await screen.findByRole("heading", { name: "Pi · Provider" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Pi · Profile" }),
		).not.toBeInTheDocument();
	});

	it("旧 Pi 设置地址重定向到独立页面", async () => {
		renderSettings(true, "/settings/pi");
		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent(
				"/pi/profile",
			),
		);
	});
	it("设置页不再包含 Pi 子导航", async () => {
		renderSettings(true, "/settings/profile");
		const settingsNavigation = within(
			await screen.findByRole("navigation", { name: "设置导航" }),
		);
		expect(
			settingsNavigation.queryByRole("link", { name: "Pi" }),
		).not.toBeInTheDocument();
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
