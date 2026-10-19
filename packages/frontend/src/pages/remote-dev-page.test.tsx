import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { RemoteDevPage } from "./remote-dev-page.js";

function makeClient() {
	return {
		clientId: "c1",
		name: "Ozmo",
		hostname: "xuzhen97-lx",
		os: "win32",
		cpuModel: "cpu",
		totalMemMB: 1024,
		clientVersion: "0.21.0",
		capabilities: [],
		capabilityDetails: {},
		online: true,
		cpuPercent: null,
		memPercent: null,
		disks: [],
		lastHeartbeatAt: null,
	};
}

function makeAgent() {
	return {
		id: "p1",
		agentId: "dsh",
		name: "DSH ACP",
		adapter: "acp",
		clientId: "c1",
		workspaceRoots: ["D:\\repo"],
		skills: [],
		enabled: true,
		createdAt: "2026-10-19T00:00:00.000Z",
		updatedAt: "2026-10-19T00:00:00.000Z",
	};
}

function fakeSdk(clients: unknown[] = [], agents: unknown[] = []) {
	return {
		clients: { list: vi.fn().mockResolvedValue(clients) },
		agents: {
			list: vi.fn().mockResolvedValue({
				data: agents,
				total: agents.length,
				page: 1,
				pageSize: 100,
				totalPages: 1,
			}),
		},
		remoteDev: { create: vi.fn() },
	} as never;
}

function renderPage(sdk: never) {
	render(
		<SdkProvider client={sdk}>
			<MemoryRouter initialEntries={["/remote-dev"]}>
				<RemoteDevPage />
			</MemoryRouter>
		</SdkProvider>,
	);
}

describe("RemoteDevPage 创建表单", () => {
	it("没有任何 Client 时先引导接入机器", async () => {
		renderPage(fakeSdk([], []));
		expect(await screen.findByText(/还没有注册任何机器/)).toBeVisible();
		expect(screen.getByRole("button", { name: "去机器页" })).toBeVisible();
		expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
	});

	it("有 Client 但没有 agent placement 时隐藏空下拉并给出登记命令", async () => {
		renderPage(fakeSdk([makeClient()], []));
		expect(await screen.findByText(/还没有登记 agent placement/)).toBeVisible();
		expect(
			screen.getByText(/vcpdeck agents create --client=c1/),
		).toBeVisible();
		expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
	});

	it("有 placement 时展示 Agent 下拉", async () => {
		renderPage(fakeSdk([makeClient()], [makeAgent()]));
		expect(await screen.findByRole("combobox", { name: "Agent" })).toBeVisible();
		expect(screen.getByRole("option", { name: /dsh/ })).toBeVisible();
	});
});

function makeSourceSession() {
	return {
		sessionId: "rds_old",
		clientId: "c1",
		agentPlacementId: "p1",
		workspaceRoot: "D:\\repo",
		state: "closed",
		agentStatus: "exited",
		generationId: "g1",
		createdAt: "2026-10-19T00:00:00.000Z",
		updatedAt: "2026-10-19T00:00:00.000Z",
		closedAt: "2026-10-19T01:00:00.000Z",
		closeReason: "owner",
		cleanupStatus: "complete",
		acpSessionId: "acp-old",
	};
}

describe("RemoteDevPage 续接", () => {
	it("带 resumeFrom 时预填来源会话并提交 resumeFromSessionId", async () => {
		const user = userEvent.setup();
		const sdk = {
			clients: { list: vi.fn().mockResolvedValue([makeClient()]) },
			agents: {
				list: vi.fn().mockResolvedValue({
					data: [makeAgent()],
					total: 1,
					page: 1,
					pageSize: 100,
					totalPages: 1,
				}),
			},
			remoteDev: {
				get: vi.fn().mockResolvedValue(makeSourceSession()),
				create: vi.fn().mockResolvedValue({ sessionId: "rds_new" }),
			},
		} as never;
		render(
			<SdkProvider client={sdk}>
				<MemoryRouter initialEntries={["/remote-dev/new?resumeFrom=rds_old"]}>
					<RemoteDevPage />
				</MemoryRouter>
			</SdkProvider>,
		);
		expect(await screen.findByText(/将续接会话 rds_old/)).toBeVisible();
		expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();
		expect(screen.getByLabelText(/Workspace/)).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "创建任务" }));
		await waitFor(() => {
			expect(
				(sdk as unknown as { remoteDev: { create: ReturnType<typeof vi.fn> } })
					.remoteDev.create,
			).toHaveBeenCalledWith({
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "D:\\repo",
				resumeFromSessionId: "rds_old",
			});
		});
	});

	it("来源会话读不到时给出明确错误", async () => {
		const user = userEvent.setup();
		const sdk = {
			clients: { list: vi.fn().mockResolvedValue([makeClient()]) },
			agents: {
				list: vi.fn().mockResolvedValue({
					data: [makeAgent()],
					total: 1,
					page: 1,
					pageSize: 100,
					totalPages: 1,
				}),
			},
			remoteDev: {
				get: vi.fn().mockRejectedValue(new Error("RDS_NOT_FOUND")),
				create: vi.fn().mockResolvedValue({ sessionId: "rds_new" }),
			},
		} as never;
		render(
			<SdkProvider client={sdk}>
				<MemoryRouter initialEntries={["/remote-dev/new?resumeFrom=missing"]}>
					<RemoteDevPage />
				</MemoryRouter>
			</SdkProvider>,
		);
		expect(await screen.findByText(/无法读取要续接的会话/)).toBeVisible();
		// 读不到来源时退回新建：不得把已知无效的 resumeFromSessionId 提交上去
		await user.click(screen.getByRole("button", { name: "创建任务" }));
		await waitFor(() => {
			expect(
				(sdk as unknown as { remoteDev: { create: ReturnType<typeof vi.fn> } })
					.remoteDev.create,
			).toHaveBeenCalledWith({
				clientId: "c1",
				agentPlacementId: "p1",
				workspaceRoot: "D:\\repo",
			});
		});
	});
});
