import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppRoutes } from "@/app/routes";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";

const identity: IdentityInfo = {
	id: "identity-1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function renderApp(client: VcpDeckClient, initialEntry = "/dashboard") {
	return render(
		<MemoryRouter initialEntries={[initialEntry]}>
			<SdkProvider client={client}>
				<AuthProvider>
					<AppRoutes />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

describe("authentication routes", () => {
	it("enters the console after the initial identity check succeeds", async () => {
		const client = {
			auth: { me: vi.fn().mockResolvedValue(identity), logout: vi.fn() },
		} as unknown as VcpDeckClient;

		renderApp(client);

		expect(screen.getByText("正在验证身份…")).toBeVisible();
		expect(await screen.findByRole("navigation", { name: "主导航" })).toBeVisible();
	});

	it("shows login when the initial identity check fails", async () => {
		const client = {
			auth: { me: vi.fn().mockRejectedValue(new Error("unauthorized")), logout: vi.fn() },
		} as unknown as VcpDeckClient;

		renderApp(client);

		expect(await screen.findByRole("heading", { name: "登录 VCPDeck" })).toBeVisible();
	});

	it("navigates to dashboard after login", async () => {
		const login = vi.fn().mockResolvedValue({ identity });
		const client = {
			auth: { me: vi.fn().mockRejectedValue(new Error("unauthorized")), login, logout: vi.fn() },
		} as unknown as VcpDeckClient;

		renderApp(client, "/login");
		await userEvent.type(await screen.findByLabelText("用户名"), "admin");
		await userEvent.type(screen.getByLabelText("密码"), "secret");
		await userEvent.click(screen.getByRole("button", { name: "登录" }));

		await waitFor(() => expect(screen.getByRole("navigation", { name: "主导航" })).toBeVisible());
		expect(login).toHaveBeenCalledWith({ username: "admin", password: "secret" });
	});
});
