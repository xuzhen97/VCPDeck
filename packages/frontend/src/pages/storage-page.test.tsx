import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { StoragePage } from "./storage-page";

const identity: IdentityInfo = {
	id: "i1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function renderPage() {
	const status = vi
		.fn()
		.mockResolvedValue({
			configured: true,
			authorized: false,
			hasAuth: false,
			isExpired: false,
			clientId: "app-id",
			openapiBase: "https://openapi.alipan.com",
			transferFolder: "VCPDeck",
			driveId: "drive-1",
		});
	const startOAuth = vi
		.fn()
		.mockResolvedValue({
			state: "state-1",
			authorizationUrl: "https://openapi.alipan.com/oauth/authorize",
			expiresAt: Date.now() + 60_000,
		});
	const completeOAuth = vi
		.fn()
		.mockResolvedValue({ authorized: true, expiresAt: Date.now() + 60_000 });
	const client = {
		auth: { me: async () => identity },
		aliyundrive: {
			status,
			configure: vi.fn(),
			startOAuth,
			completeOAuth,
			revoke: vi.fn(),
		},
		storage: { setBackend: vi.fn() },
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter>
			<SdkProvider client={client}>
				<AuthProvider>
					<StoragePage />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
	return { client, status, startOAuth, completeOAuth };
}

describe("StoragePage", () => {
	it("loads only safe status and never exposes a raw config reader", async () => {
		const { client, status } = renderPage();
		expect(await screen.findByText("app-id")).toBeVisible();
		expect(status).toHaveBeenCalled();
		expect("getConfig" in client.storage).toBe(false);
		expect(screen.getByText(/当前接口非 admin-only/)).toBeVisible();
	});

	it("opens OAuth authorization and clears state and code after completion", async () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const { completeOAuth, status } = renderPage();
		await screen.findByText("app-id");
		const callsBeforeAuthorization = status.mock.calls.length;
		await userEvent.click(screen.getByRole("button", { name: "开始授权" }));
		expect(open).toHaveBeenCalledWith(
			"https://openapi.alipan.com/oauth/authorize",
			"_blank",
			"noopener,noreferrer",
		);
		expect(screen.getByLabelText("OAuth State")).toHaveValue("state-1");
		await userEvent.type(screen.getByLabelText("授权码"), "code-1");
		await userEvent.click(screen.getByRole("button", { name: "完成授权" }));
		expect(completeOAuth).toHaveBeenCalledWith({
			state: "state-1",
			code: "code-1",
		});
		await waitFor(() =>
			expect(screen.getByLabelText("OAuth State")).toHaveValue(""),
		);
		expect(screen.getByLabelText("授权码")).toHaveValue("");
		expect(status).toHaveBeenCalledTimes(callsBeforeAuthorization + 1);
		open.mockRestore();
	});

	it("rejects an unsafe OAuth authorization URL", async () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const { client } = renderPage();
		vi.mocked(client.aliyundrive.startOAuth).mockResolvedValue({
			state: "state-1",
			authorizationUrl: "https://attacker.example/oauth/authorize",
			expiresAt: Date.now() + 60_000,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "开始授权" }),
		);
		expect(open).not.toHaveBeenCalled();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"授权地址不安全",
		);
		open.mockRestore();
	});
});
