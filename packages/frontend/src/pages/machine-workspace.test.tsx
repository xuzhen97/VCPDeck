import type { VcpDeckClient } from "@vcpdeck/sdk";
import { VcpDeckApiError } from "@vcpdeck/sdk";
import type { ClientInfo } from "@vcpdeck/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { MachineWorkspace } from "./machine-workspace";

const identity = {
	id: "identity-1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function renderWorkspace(
	clients: ClientInfo[],
	tab = "overview",
	rename?: (clientId: string, name: string) => Promise<ClientInfo>,
) {
	const sdk = {
		clients: {
			list: async () => clients,
			rename:
				rename ??
				(async (clientId: string, name: string) => ({
					...clients.find((c) => c.clientId === clientId)!,
					name,
				})),
		},
		files: { roots: async () => [] },
		auth: { me: async () => identity },
	} as unknown as VcpDeckClient;
	return render(
		<MemoryRouter initialEntries={[`/machines/c1/${tab}`]}>
			<SdkProvider client={sdk}>
				<AuthProvider>
					<Routes>
						<Route
							path="/machines/:clientId/:tab?"
							element={<MachineWorkspace />}
						/>
					</Routes>
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

describe("MachineWorkspace overview", () => {
	it("renders full machine info when server returns all fields", async () => {
		const client: ClientInfo = {
			clientId: "c1",
			name: "workstation",
			hostname: "workstation",
			os: "win32 10.0.26200",
			cpuModel: "Intel(R) Core(TM) i7-12700",
			totalMemMB: 16384,
			disks: [
				{ name: "C:", totalMB: 512000, usedPercent: 92.8 },
				{ name: "D:", totalMB: 464444, usedPercent: 5 },
			],
			clientVersion: "0.0.0",
			capabilities: ["exec", "file.read", "file.write"],
			capabilityDetails: {},
			online: true,
			cpuPercent: 23.5,
			memPercent: 45.2,
			lastHeartbeatAt: "2026-07-28T10:21:56.000Z",
		};
		renderWorkspace([client]);

		expect(await screen.findByText("workstation")).toBeVisible();
		expect(
			screen.getByText("workstation · win32 10.0.26200 · c1"),
		).toBeVisible();
		expect(screen.getByText("Intel(R) Core(TM) i7-12700")).toBeVisible();
		expect(screen.getByText("16 GB")).toBeVisible();
		expect(screen.getByText("0.0.0")).toBeVisible();
		expect(screen.getByText(/23\.5%/)).toBeTruthy();
		expect(screen.getByText(/45\.2%/)).toBeTruthy();
		expect(screen.getByText(/92\.8%/)).toBeTruthy();
		expect(screen.getByRole("img", { name: "Windows" })).toBeVisible();
		expect(screen.getByRole("progressbar", { name: "CPU使用率" })).toHaveClass(
			"bg-primary",
		);
		expect(screen.getByText("C:")).toBeVisible();
		expect(screen.getByText("D:")).toBeVisible();
		expect(screen.getByText(/500 GB/)).toBeVisible();
		expect(screen.getByText(/454 GB/)).toBeVisible();
		expect(screen.getByText(/5\.0%/)).toBeVisible();
		expect(
			screen.getByRole("progressbar", { name: "磁盘 C: 使用率" }),
		).toHaveClass("bg-red-500");
		expect(
			screen.getByRole("progressbar", { name: "磁盘 D: 使用率" }),
		).toHaveClass("bg-primary");
		expect(screen.getByTestId("system-information")).toHaveTextContent(
			"最后心跳",
		);
		expect(screen.getByTestId("machine-workspace")).toHaveClass(
			"h-full",
			"min-h-0",
			"flex-col",
		);
		expect(screen.getByTestId("machine-workspace-content")).toHaveClass(
			"min-h-0",
			"flex-1",
			"overflow-y-auto",
		);
	});

	it("merges machine details and navigation into a compact header", async () => {
		const client: ClientInfo = {
			clientId: "c1",
			name: "workstation",
			hostname: "workstation",
			os: "win32",
			cpuModel: "Intel",
			totalMemMB: 16384,
			disks: [],
			clientVersion: "1.0.0",
			capabilities: ["exec", "file.read"],
			capabilityDetails: {},
			online: true,
			cpuPercent: 1,
			memPercent: 2,
			lastHeartbeatAt: null,
		};
		renderWorkspace([client], "files");

		expect(await screen.findByTestId("machine-workspace-header")).toHaveClass(
			"space-y-3",
			"shrink-0",
		);
		expect(screen.getByTestId("machine-workspace")).toHaveClass(
			"h-full",
			"min-h-0",
			"flex-col",
		);
		expect(screen.getByTestId("machine-workspace-content")).toHaveClass(
			"min-h-0",
			"flex-1",
			"overflow-hidden",
		);
		expect(screen.getByTestId("machine-workspace-content")).not.toHaveClass(
			"overflow-y-auto",
		);
		const riskButton = screen.getByRole("button", {
			name: "文件操作安全提示",
		});
		expect(riskButton).toBeVisible();
		expect(riskButton.parentElement).not.toHaveClass("mb-2");
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"symlink 边界仍有已知风险",
		);
		const workspaceNav = screen.getByRole("navigation", { name: "机器工作区" });
		expect(
			within(workspaceNav).getByRole("link", { name: "映射" }),
		).toHaveAttribute("href", "/machines/c1/frp");
		expect(
			within(workspaceNav).queryByRole("link", { name: "FRP" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows — for missing heartbeat fields", async () => {
		const client: ClientInfo = {
			clientId: "c1",
			name: "server",
			hostname: "server",
			os: "linux",
			cpuModel: "AMD EPYC",
			totalMemMB: 32768,
			disks: [],
			clientVersion: "1.0.0",
			capabilities: ["exec"],
			capabilityDetails: {},
			online: true,
			cpuPercent: null,
			memPercent: null,
			lastHeartbeatAt: null,
		};
		renderWorkspace([client]);

		expect(await screen.findByText("AMD EPYC")).toBeVisible();
		expect(screen.getByText("32 GB")).toBeVisible();
		expect(screen.getByText("1.0.0")).toBeVisible();

		// CPU、内存进度条保留；磁盘无数据时以 — 占位
		expect(screen.getAllByRole("progressbar")).toHaveLength(2);
		expect(screen.getAllByText("—")).toHaveLength(3);
		expect(screen.getByText("尚无磁盘数据")).toBeVisible();
	});

	it("handles missing fields from old server gracefully", async () => {
		const partial = {
			clientId: "c1",
			hostname: "old-server",
			os: "win32",
			capabilities: [] as string[],
			capabilityDetails: {} as ClientInfo["capabilityDetails"],
			online: true,
			lastHeartbeatAt: null as string | null,
		} as unknown as ClientInfo;
		renderWorkspace([partial]);

		expect(await screen.findByText("old-server")).toBeVisible();
		// 旧 Client 缺失的指标仍以可访问进度条和占位值展示；磁盘无数据时不渲染进度条
		expect(screen.getAllByRole("progressbar")).toHaveLength(2);
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
	});
});

describe("MachineWorkspace 名称双击编辑", () => {
	const client: ClientInfo = {
		clientId: "c1",
		name: "workstation",
		hostname: "workstation",
		os: "win32",
		cpuModel: "Intel",
		totalMemMB: 16384,
		disks: [],
		clientVersion: "1.0.0",
		capabilities: [],
		capabilityDetails: {},
		online: true,
		cpuPercent: null,
		memPercent: null,
		lastHeartbeatAt: null,
	};

	it("双击名称进入编辑态，回车保存新别名", async () => {
		const rename = vi.fn().mockResolvedValue({ ...client, name: "我的NAS" });
		renderWorkspace([client], "overview", rename);

		fireEvent.doubleClick(await screen.findByText("workstation"));
		const input = screen.getByRole("textbox", { name: "机器名称" });
		expect(input).toHaveValue("workstation");

		fireEvent.change(input, { target: { value: "我的NAS" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(await screen.findByText("我的NAS")).toBeVisible();
		expect(rename).toHaveBeenCalledWith("c1", "我的NAS");
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("Escape 取消编辑且不调用改名", async () => {
		const rename = vi.fn();
		renderWorkspace([client], "overview", rename);

		fireEvent.doubleClick(await screen.findByText("workstation"));
		const input = screen.getByRole("textbox", { name: "机器名称" });
		fireEvent.change(input, { target: { value: "改一半" } });
		fireEvent.keyDown(input, { key: "Escape" });

		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(screen.getByText("workstation")).toBeVisible();
		expect(rename).not.toHaveBeenCalled();
	});

	it("改名撞重名时显示占用提示并保持编辑态", async () => {
		const rename = vi
			.fn()
			.mockRejectedValue(
				new VcpDeckApiError("already taken", 409, "CLIENT_NAME_TAKEN"),
			);
		renderWorkspace([client], "overview", rename);

		fireEvent.doubleClick(await screen.findByText("workstation"));
		const input = screen.getByRole("textbox", { name: "机器名称" });
		fireEvent.change(input, { target: { value: "被占用名" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(await screen.findByTestId("machine-name-error")).toHaveTextContent(
			"该名称已被其他机器占用",
		);
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});
});
