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

type RenderOptions = {
	backend?: { kind: "local" | "alibaba"; updatedAt: string | null };
	aliyun?: Partial<{
		configured: boolean;
		authorized: boolean;
		hasAuth: boolean;
		isExpired: boolean;
		clientId: string;
		openapiBase: string;
		transferFolder: string;
		driveId: string;
		expiresAt: number;
	}>;
	setBackend?: ReturnType<typeof vi.fn>;
};

function renderPage(options: RenderOptions = {}) {
	const backendStatus = vi
		.fn()
		.mockResolvedValue(options.backend ?? { kind: "local", updatedAt: null });
	const setBackend =
		options.setBackend ??
		vi.fn().mockResolvedValue({ kind: "alibaba", updatedAt: null });
	const status = vi.fn().mockResolvedValue({
		configured: true,
		authorized: false,
		hasAuth: false,
		isExpired: false,
		clientId: "app-id",
		openapiBase: "https://openapi.alipan.com",
		transferFolder: "VCPDeck",
		driveId: "drive-1",
		...options.aliyun,
	});
	const configure = vi.fn().mockResolvedValue({});
	const startOAuth = vi.fn().mockResolvedValue({
		state: "state-1",
		authorizationUrl: "https://openapi.alipan.com/oauth/authorize",
		expiresAt: Date.now() + 60_000,
	});
	const completeOAuth = vi
		.fn()
		.mockResolvedValue({ authorized: true, expiresAt: Date.now() + 60_000 });
	const revoke = vi.fn().mockResolvedValue({ revoked: true });
	const verify = vi.fn().mockResolvedValue({
		valid: true,
		checkedAt: "2026-07-31T12:00:00.000Z",
		driveId: "drive-1",
	});
	const client = {
		auth: { me: async () => identity },
		aliyundrive: {
			status,
			configure,
			startOAuth,
			completeOAuth,
			revoke,
			verify,
		},
		storage: { getBackendConfig: backendStatus, setBackend },
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
	return {
		client,
		backendStatus,
		setBackend,
		status,
		configure,
		startOAuth,
		completeOAuth,
		revoke,
		verify,
	};
}

describe("StoragePage", () => {
	it("shows the server-selected backend and only safe status", async () => {
		const { client, backendStatus, status } = renderPage();
		expect(await screen.findByText("当前激活的存储")).toBeVisible();
		expect(screen.getByText("本地存储 · 正常运行")).toBeVisible();
		expect(backendStatus).toHaveBeenCalled();
		expect(status).toHaveBeenCalled();
		expect("getConfig" in client.storage).toBe(false);
		expect(screen.getByText(/当前接口非 admin-only/)).toBeVisible();
	});

	it("requires confirmation before switching to Alibaba Drive", async () => {
		const { setBackend } = renderPage();
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("button", { name: "阿里云盘" }));
		expect(
			screen.getByRole("heading", { name: "启用阿里云盘？" }),
		).toBeVisible();
		expect(setBackend).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
		expect(setBackend).toHaveBeenCalledWith({ kind: "alibaba" });
	});

	it("switches back to local storage without confirmation", async () => {
		const { backendStatus, setBackend } = renderPage({
			backend: { kind: "alibaba", updatedAt: null },
		});
		await screen.findByText("阿里云盘 · 尚未授权");
		await userEvent.click(screen.getByRole("button", { name: "本地存储" }));
		expect(
			screen.queryByRole("heading", { name: "启用阿里云盘？" }),
		).not.toBeInTheDocument();
		expect(setBackend).toHaveBeenCalledWith({ kind: "local" });
		await waitFor(() =>
			expect(backendStatus.mock.calls.length).toBeGreaterThanOrEqual(2),
		);
	});

	it("keeps the confirmed backend and shows an error when switching fails", async () => {
		renderPage({
			setBackend: vi.fn().mockRejectedValue(new Error("切换失败")),
		});
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("button", { name: "阿里云盘" }));
		await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("切换失败");
		expect(screen.getByText("本地存储 · 正常运行")).toBeVisible();
	});

	it("uses two tabs and combines Alibaba configuration with authorization", async () => {
		renderPage();
		await screen.findByText("本地存储 · 正常运行");
		expect(screen.getAllByRole("tab")).toHaveLength(2);
		expect(screen.getByRole("tabpanel")).toHaveTextContent("选择存储后端");
		await userEvent.click(screen.getByRole("tab", { name: "阿里云盘" }));
		expect(screen.getByRole("tabpanel")).toHaveTextContent("Client ID");
		expect(screen.getByRole("tabpanel")).toHaveTextContent("开始授权");
		expect(
			screen.queryByRole("tab", { name: "授权与安全" }),
		).not.toBeInTheDocument();
	});

	it("automatically verifies authorization when entering the Alibaba tab", async () => {
		const { verify } = renderPage();
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("tab", { name: "阿里云盘" }));
		expect(await screen.findByText("授权有效")).toBeVisible();
		expect(verify).toHaveBeenCalledTimes(1);
		await userEvent.click(screen.getByRole("button", { name: "立即检查授权" }));
		expect(verify).toHaveBeenCalledTimes(2);
	});

	it("shows a revoked result without deleting the saved authorization", async () => {
		const { verify } = renderPage();
		verify.mockResolvedValue({
			valid: false,
			checkedAt: "2026-07-31T12:00:00.000Z",
			reason: "revoked",
		});
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("tab", { name: "阿里云盘" }));
		expect(await screen.findByText("授权已失效")).toBeVisible();
		expect(screen.getByText(/请重新授权/)).toBeVisible();
		expect(screen.getByRole("button", { name: "开始授权" })).toBeVisible();
	});

	it("does not mark authorization invalid when verification is unreachable", async () => {
		const { verify } = renderPage();
		verify.mockResolvedValue({
			valid: false,
			checkedAt: "2026-07-31T12:00:00.000Z",
			reason: "unreachable",
		});
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("tab", { name: "阿里云盘" }));
		expect(await screen.findByText("无法完成检查")).toBeVisible();
		expect(screen.queryByText("授权已失效")).not.toBeInTheDocument();
	});

	it("warns when Alibaba Drive is active but not authorized", async () => {
		renderPage({
			backend: { kind: "alibaba", updatedAt: null },
			aliyun: { configured: true, authorized: false, isExpired: false },
		});
		expect(await screen.findByText("阿里云盘 · 尚未授权")).toBeVisible();
		expect(screen.getByText(/新的文件操作可能失败/)).toBeVisible();
	});

	it("does not send an empty client secret and clears it after saving", async () => {
		const { configure } = renderPage();
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("tab", { name: "阿里云盘" }));
		await userEvent.clear(screen.getByLabelText("Client ID"));
		await userEvent.type(screen.getByLabelText("Client ID"), "new-app-id");
		await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
		expect(configure).toHaveBeenCalledWith({
			clientId: "new-app-id",
			transferFolder: "VCPDeck",
		});
		expect(screen.getByLabelText("Client Secret")).toHaveValue("");
	});

	it("opens OAuth authorization and clears state and code after completion", async () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const { completeOAuth, status } = renderPage();
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("tab", { name: "阿里云盘" }));
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
		expect(status.mock.calls.length).toBeGreaterThanOrEqual(
			callsBeforeAuthorization + 1,
		);
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
		await screen.findByText("本地存储 · 正常运行");
		await userEvent.click(screen.getByRole("tab", { name: "阿里云盘" }));
		await userEvent.click(screen.getByRole("button", { name: "开始授权" }));
		expect(open).not.toHaveBeenCalled();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"授权地址不安全",
		);
		open.mockRestore();
	});
});
