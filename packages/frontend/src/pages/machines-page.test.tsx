import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ClientInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
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
				<AuthProvider>
					<MachinesPage />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

describe("MachinesPage", () => {
	it("shows loading state", () => {
		renderPage(() => new Promise(() => undefined));
		expect(screen.getByText("正在加载在线机器…")).toHaveAttribute(
			"aria-busy",
			"true",
		);
	});

	it("shows an honest empty state without reloading after auth settles", async () => {
		const list = vi.fn().mockResolvedValue([]);
		renderPage(list);
		expect(await screen.findByText("当前没有在线机器")).toBeVisible();
		expect(list).toHaveBeenCalledTimes(1);
		expect(
			screen.getByText("Server 只提供在线 Client，离线历史不会显示在此处。"),
		).toBeVisible();
	});

	it("shows retryable errors", async () => {
		renderPage(async () => {
			throw new Error("offline");
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"无法加载在线机器",
		);
		expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
	});

	it("renders capabilities and workspace links", async () => {
		renderPage(async () => [
			{
				clientId: "client-1",
				name: "workstation",
				hostname: "workstation",
				os: "win32",
				cpuModel: "Intel i7",
				totalMemMB: 16384,
				disks: [],
				clientVersion: "0.0.0",
				capabilities: ["exec", "file.read", "frp", "agent.pi", "terminal.pty"],
				capabilityDetails: {},
				online: true,
				cpuPercent: null,
				memPercent: null,
				lastHeartbeatAt: null,
			},
		]);

		expect(
			await screen.findByRole("heading", { name: "workstation" }),
		).toBeVisible();
		expect(screen.getByRole("link", { name: "workstation" })).toHaveAttribute(
			"href",
			"/machines/client-1/overview",
		);
		expect(screen.getByRole("img", { name: "Windows" })).toBeVisible();
		for (const label of ["命令执行", "文件操作", "Pi 运行"])
			expect(screen.getByText(label)).toBeVisible();
		expect(screen.queryByText("agent.pi")).not.toBeInTheDocument();
		expect(screen.getAllByText("终端").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("terminal.pty")).not.toBeInTheDocument();
		expect(screen.getAllByText("映射").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("FRP 映射")).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "概览" })).toHaveAttribute(
			"href",
			"/machines/client-1/overview",
		);
		expect(screen.getByRole("link", { name: "执行" })).toHaveAttribute(
			"href",
			"/machines/client-1/execute",
		);
		expect(screen.getByRole("link", { name: "文件" })).toHaveAttribute(
			"href",
			"/machines/client-1/files",
		);
		expect(screen.getByRole("link", { name: "映射" })).toHaveAttribute(
			"href",
			"/machines/client-1/frp",
		);
		expect(screen.getByRole("link", { name: "任务记录" })).toHaveAttribute(
			"href",
			"/machines/client-1/jobs",
		);
		expect(screen.getByRole("link", { name: "Pi" })).toHaveAttribute(
			"href",
			"/machines/client-1/pi",
		);
		expect(screen.getByRole("link", { name: "终端" })).toHaveAttribute(
			"href",
			"/machines/client-1/terminal",
		);
		expect(screen.queryByRole("link", { name: "FRP" })).not.toBeInTheDocument();
	});

	it("displays root-equivalent risk and installation mode from capability details", async () => {
		const privileged = (mode: "sudo-all" | "unavailable") => ({
			available: mode === "sudo-all",
			mode,
			nonInteractive: mode === "sudo-all",
			runAsUser: "vcpdeck",
		});
		const base = {
			name: "host",
			hostname: "host",
			os: "linux 6.1.0",
			cpuModel: "CPU",
			totalMemMB: 1024,
			disks: [] as ClientInfo["disks"],
			clientVersion: "1.0.0",
			online: true,
			cpuPercent: null,
			memPercent: null,
			lastHeartbeatAt: null as string | null,
		};
		const make = (clientId: string, capabilityDetails: ClientInfo["capabilityDetails"], installation?: ClientInfo["installation"]) =>
			({ clientId, capabilities: ["exec"], ...base, capabilityDetails, installation }) satisfies ClientInfo;

			renderPage(async () => [
				make(
					"linux-sudo",
					{ privileged: privileged("sudo-all") },
					{ mode: "systemd-root-equivalent" },
				),
				make("linux-nosudo", { privileged: privileged("unavailable") }),
				make(
					"legacy",
					{ privileged: privileged("sudo-all") },
					{ mode: "legacy-pm2" },
				),
				make("unreported", {}),
			]);

		// root 等价风险（sudo-all）。
		const sudoChips = await screen.findAllByText("root 等价特权");
		expect(sudoChips.length).toBeGreaterThanOrEqual(1);
		// 无 sudo 能力。
		expect(await screen.findByText("root 等价特权不可用")).toBeVisible();
		// 系统级部署与旧版 PM2 安装模式。
		expect(await screen.findByText("系统级部署")).toBeVisible();
		expect(screen.getAllByText("旧版 PM2").length).toBeGreaterThanOrEqual(1);
		// 未报告（旧版 Client / 无字段）。
		expect(await screen.findByText("特权未报告")).toBeVisible();
		expect(screen.getAllByText("安装模式未报告").length).toBeGreaterThanOrEqual(1);
	});

	it("renders unified Windows, Linux and macOS SVG icons", async () => {
		const machine = (clientId: string, hostname: string, os: string) =>
			({
				clientId,
				name: hostname,
				hostname,
				os,
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
			}) satisfies ClientInfo;
		renderPage(async () => [
			machine("win", "win-host", "win32"),
			machine("linux", "linux-host", "linux"),
			machine("mac", "mac-host", "darwin"),
		]);

		for (const system of ["Windows", "Linux", "macOS"])
			expect(await screen.findByRole("img", { name: system })).toBeVisible();
	});
});
