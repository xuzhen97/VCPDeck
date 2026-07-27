import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
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
