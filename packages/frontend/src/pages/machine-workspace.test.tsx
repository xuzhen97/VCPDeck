import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ClientInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
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

function renderWorkspace(clients: ClientInfo[], tab = "overview") {
	const sdk = {
		clients: { list: async () => clients },
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
			hostname: "workstation",
			os: "win32 10.0.26200",
			cpuModel: "Intel(R) Core(TM) i7-12700",
			totalMemMB: 16384,
			totalDiskMB: 512000,
			clientVersion: "0.0.0",
			capabilities: ["exec", "file.read", "file.write"],
			online: true,
			cpuPercent: 23.5,
			memPercent: 45.2,
			diskPercent: 67.8,
			lastHeartbeatAt: "2026-07-28T10:21:56.000Z",
		};
		renderWorkspace([client]);

		expect(await screen.findByText("workstation")).toBeVisible();
		expect(screen.getByText("win32 10.0.26200 · c1")).toBeVisible();
		expect(screen.getByText("Intel(R) Core(TM) i7-12700")).toBeVisible();
		expect(screen.getByText("16 GB")).toBeVisible();
		expect(screen.getByText("512 GB")).toBeVisible();
		expect(screen.getByText("0.0.0")).toBeVisible();
		expect(screen.getByText(/23\.5%/)).toBeTruthy();
		expect(screen.getByText(/45\.2%/)).toBeTruthy();
		expect(screen.getByText(/67\.8%/)).toBeTruthy();
	});

	it("merges machine details and navigation into a compact header", async () => {
		const client: ClientInfo = {
			clientId: "c1",
			hostname: "workstation",
			os: "win32",
			cpuModel: "Intel",
			totalMemMB: 16384,
			totalDiskMB: 512000,
			clientVersion: "1.0.0",
			capabilities: ["exec", "file.read"],
			online: true,
			cpuPercent: 1,
			memPercent: 2,
			diskPercent: 3,
			lastHeartbeatAt: null,
		};
		renderWorkspace([client], "files");

		expect(await screen.findByTestId("machine-workspace-header")).toHaveClass(
			"space-y-3",
		);
		expect(
			screen.getByRole("button", { name: "文件操作安全提示" }),
		).toBeVisible();
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"symlink 边界仍有已知风险",
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows — for missing heartbeat fields", async () => {
		const client: ClientInfo = {
			clientId: "c1",
			hostname: "server",
			os: "linux",
			cpuModel: "AMD EPYC",
			totalMemMB: 32768,
			totalDiskMB: 1_000_000,
			clientVersion: "1.0.0",
			capabilities: ["exec"],
			online: true,
			cpuPercent: null,
			memPercent: null,
			diskPercent: null,
			lastHeartbeatAt: null,
		};
		renderWorkspace([client]);

		expect(await screen.findByText("AMD EPYC")).toBeVisible();
		expect(screen.getByText("33 GB")).toBeVisible();
		expect(screen.getByText("1.0 TB")).toBeVisible();
		expect(screen.getByText("1.0.0")).toBeVisible();

		// 三个使用率都显示为 —
		expect(screen.getAllByText(/使用率/)).toHaveLength(3);
	});

	it("handles missing fields from old server gracefully", async () => {
		const partial = {
			clientId: "c1",
			hostname: "old-server",
			os: "win32",
			capabilities: [] as string[],
			online: true,
			lastHeartbeatAt: null as string | null,
		} as unknown as ClientInfo;
		renderWorkspace([partial]);

		expect(await screen.findByText("old-server")).toBeVisible();
		// 三个使用率 + 大小字段显示为 —
		expect(screen.getAllByText(/使用率/)).toHaveLength(3);
	});
});
