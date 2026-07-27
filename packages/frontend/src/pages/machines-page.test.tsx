import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ClientInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { MachinesPage } from "./machines-page";

const identity = {
	id: "identity-1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function renderPage(list: () => Promise<ClientInfo[]>) {
	const client = {
		clients: { list },
		auth: { me: async () => identity },
	} as unknown as VcpDeckClient;
	return render(
		<MemoryRouter>
			<SdkProvider client={client}>
				<AuthProvider><MachinesPage /></AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

describe("MachinesPage", () => {
	it("shows loading state", () => {
		renderPage(() => new Promise(() => undefined));
		expect(screen.getByText("正在加载在线机器…")).toHaveAttribute("aria-busy", "true");
	});

	it("shows an honest empty state", async () => {
		renderPage(async () => []);
		expect(await screen.findByText("当前没有在线机器")).toBeVisible();
		expect(screen.getByText("Server 只提供在线 Client，离线历史不会显示在此处。")).toBeVisible();
	});

	it("shows retryable errors", async () => {
		renderPage(async () => { throw new Error("offline"); });
		expect(await screen.findByRole("alert")).toHaveTextContent("无法加载在线机器");
		expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
	});

	it("renders capabilities and workspace links", async () => {
		renderPage(async () => [{
			clientId: "client-1",
			hostname: "workstation",
			os: "win32",
			capabilities: ["exec", "file.read", "frp"],
			online: true,
			lastHeartbeatAt: "2026-07-26T00:00:00.000Z",
		}]);

		expect(await screen.findByRole("heading", { name: "workstation" })).toBeVisible();
		for (const capability of ["exec", "file.read", "frp"]) expect(screen.getByText(capability)).toBeVisible();
		expect(screen.getByRole("link", { name: "执行" })).toHaveAttribute("href", "/machines/client-1/execute");
		expect(screen.getByRole("link", { name: "文件" })).toHaveAttribute("href", "/machines/client-1/files");
		expect(screen.getByRole("link", { name: "FRP" })).toHaveAttribute("href", "/machines/client-1/frp");
	});
});
