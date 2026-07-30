import type { VcpDeckClient } from "@vcpdeck/sdk";
import type {
	FrpsInstanceInfo,
	IdentityInfo,
	ProbeResult,
} from "@vcpdeck/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { FrpsInstancesPanel } from "./frps-instances-panel";

const identity: IdentityInfo = {
	id: "i1",
	username: "operator",
	displayName: "操作员",
	isAdmin: false,
	disabledAt: null,
	createdAt: "2026-07-29T00:00:00.000Z",
};

const instance: FrpsInstanceInfo = {
	id: "frps_1",
	name: "生产 frps",
	serverAddr: "1.2.3.4",
	serverPort: 7000,
	authToken: "token",
	dashboardScheme: "http",
	dashboardHost: "1.2.3.4",
	dashboardPort: 7500,
	dashboardUser: "admin",
	dashboardPassword: "secret",
	portRangeStart: 20000,
	portRangeEnd: 21000,
	isDefault: true,
	createdAt: "2026-07-29T00:00:00.000Z",
	updatedAt: "2026-07-29T00:00:00.000Z",
};

const listResult = {
	data: [instance],
	total: 1,
	page: 1,
	pageSize: 20,
	totalPages: 1,
};

function renderPanel(instances: Record<string, unknown>) {
	const client = {
		auth: { me: async () => identity },
		frp: { instances },
	} as unknown as VcpDeckClient;
	return render(
		<MemoryRouter>
			<SdkProvider client={client}>
				<AuthProvider>
					<FrpsInstancesPanel />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

function api(overrides: Record<string, unknown> = {}) {
	return {
		list: vi.fn().mockResolvedValue(listResult),
		get: vi.fn().mockResolvedValue(instance),
		create: vi.fn().mockResolvedValue(instance),
		update: vi.fn().mockResolvedValue(instance),
		delete: vi.fn().mockResolvedValue({ id: instance.id, deleted: true }),
		probe: vi.fn(),
		setDefault: vi.fn().mockResolvedValue(instance),
		...overrides,
	};
}

describe("FrpsInstancesPanel", () => {
	it("shows instances in a management table and reloads after setting default", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				...listResult,
				data: [{ ...instance, isDefault: false }],
			})
			.mockResolvedValue(listResult);
		const setDefault = vi.fn().mockResolvedValue(instance);
		renderPanel(api({ list, setDefault }));

		expect((await screen.findAllByText("生产 frps"))[0]).toBeVisible();
		expect(screen.getAllByText("1.2.3.4:7000")[0]).toBeVisible();
		expect(screen.getAllByText("20000–21000")[0]).toBeVisible();
		expect(screen.getAllByText("1,001 个端口")[0]).toBeVisible();
		expect(screen.getAllByText("HTTP")[0]).toBeVisible();
		expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
		await userEvent.click(
			(await screen.findAllByRole("button", { name: "更多操作" }))[0]!,
		);
		await userEvent.click(screen.getByRole("button", { name: "设为默认" }));
		expect(setDefault).toHaveBeenCalledWith("frps_1");
		await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
		expect((await screen.findAllByText("默认"))[0]).toBeVisible();
	});

	it("creates instances with numeric fields and masked secrets in a wide drawer", async () => {
		const create = vi.fn().mockResolvedValue(instance);
		renderPanel(api({ create }));
		await screen.findAllByText("生产 frps");
		await userEvent.click(screen.getByRole("button", { name: "新增实例" }));
		const dialog = screen.getByRole("dialog", { name: "新增实例" });
		expect(dialog).toHaveClass("w-[720px]");
		const token = within(dialog).getByLabelText("Auth Token");
		const password = within(dialog).getByLabelText("Dashboard 密码");
		expect(token).toHaveAttribute("type", "password");
		expect(password).toHaveAttribute("type", "password");
		const revealButtons = within(dialog).getAllByRole("button", {
			name: "显示",
		});
		await userEvent.click(revealButtons[0]!);
		await userEvent.click(revealButtons[1]!);
		expect(token).toHaveAttribute("type", "text");
		expect(password).toHaveAttribute("type", "text");
		await userEvent.type(
			within(dialog).getByLabelText("实例名称"),
			"备用 frps",
		);
		await userEvent.type(
			within(dialog).getByLabelText("Server 地址"),
			"5.6.7.8",
		);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "保存实例" }),
		);
		await waitFor(() =>
			expect(create).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "备用 frps",
					serverAddr: "5.6.7.8",
					serverPort: 7000,
					portRangeStart: 20000,
					portRangeEnd: 21000,
					isDefault: false,
				}),
			),
		);
	});

	it("requires every numeric configuration field", async () => {
		const create = vi.fn().mockResolvedValue(instance);
		renderPanel(api({ create }));
		await userEvent.click(
			await screen.findByRole("button", { name: "新增实例" }),
		);
		const dialog = screen.getByRole("dialog", { name: "新增实例" });
		await userEvent.type(
			within(dialog).getByLabelText("实例名称"),
			"备用 frps",
		);
		await userEvent.type(
			within(dialog).getByLabelText("Server 地址"),
			"5.6.7.8",
		);
		await userEvent.clear(within(dialog).getByLabelText("Server 端口"));
		await userEvent.click(
			within(dialog).getByRole("button", { name: "保存实例" }),
		);
		expect(create).not.toHaveBeenCalled();
		expect(within(dialog).getByLabelText("Server 端口")).toBeInvalid();
	});

	it("loads details and sends null when Dashboard is disabled", async () => {
		const get = vi.fn().mockResolvedValue(instance);
		const update = vi.fn().mockResolvedValue(instance);
		renderPanel(api({ get, update }));
		await userEvent.click(
			(await screen.findAllByRole("button", { name: "更多操作" }))[0]!,
		);
		await userEvent.click(screen.getByRole("button", { name: "编辑配置" }));
		expect(get).toHaveBeenCalledWith("frps_1");
		const dialog = await screen.findByRole("dialog", { name: "编辑实例" });
		expect(dialog).toHaveClass("w-[720px]");
		await userEvent.clear(within(dialog).getByLabelText("Dashboard Host"));
		await userEvent.click(
			within(dialog).getByRole("button", { name: "保存实例" }),
		);
		await waitFor(() =>
			expect(update).toHaveBeenCalledWith(
				"frps_1",
				expect.objectContaining({ dashboardHost: null }),
			),
		);
	});

	it.each([
		{
			name: "healthy",
			probe: {
				ok: true,
				tcpReachable: true,
				tcpLatencyMs: 12,
				dashboardReachable: true,
				authValid: true,
				serverInfo: { version: "0.61.0" },
				proxies: {
					total: 5,
					byType: { tcp: 3, http: 1, https: 1 },
					list: [],
					usedPorts: [20001, 20002],
				},
			} satisfies ProbeResult,
			expected: [
				"TCP 可达 · 12 ms",
				"Dashboard 可达 · 认证有效",
				"FRP 0.61.0",
				"Proxy 共 5 个",
				"TCP 3 · HTTP 1 · HTTPS 1",
				"已占用端口：20001, 20002",
			],
		},
		{
			name: "without Dashboard",
			probe: {
				ok: true,
				tcpReachable: true,
				tcpLatencyMs: 8,
				dashboardReachable: false,
				authValid: false,
				proxies: null,
			} satisfies ProbeResult,
			instance: { ...instance, dashboardHost: null },
			expected: ["TCP 可达，未配置 Dashboard"],
		},
		{
			name: "with invalid Dashboard auth",
			probe: {
				ok: false,
				tcpReachable: true,
				tcpLatencyMs: 9,
				dashboardReachable: true,
				authValid: false,
				proxies: null,
			} satisfies ProbeResult,
			expected: ["Dashboard 认证无效"],
		},
	])("renders probe result $name", async ({
		probe,
		expected,
		instance: item = instance,
	}) => {
		renderPanel(
			api({
				list: vi.fn().mockResolvedValue({ ...listResult, data: [item] }),
				probe: vi.fn().mockResolvedValue(probe),
			}),
		);
		await userEvent.click(
			(await screen.findAllByRole("button", { name: "更多操作" }))[0]!,
		);
		await userEvent.click(screen.getByRole("button", { name: "健康检查" }));
		for (const text of expected)
			expect((await screen.findAllByText(text))[0]).toBeVisible();
	});

	it("keeps the delete dialog open when the server rejects deletion", async () => {
		renderPanel(
			api({
				delete: vi.fn().mockRejectedValue(new Error("仍有关联的 2 条映射")),
			}),
		);
		await userEvent.click(
			(await screen.findAllByRole("button", { name: "更多操作" }))[0]!,
		);
		await userEvent.click(screen.getByRole("button", { name: "删除实例" }));
		await userEvent.type(screen.getByLabelText("输入目标以确认"), "生产 frps");
		await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
		expect(await screen.findByText("仍有关联的 2 条映射")).toBeVisible();
		expect(screen.getByRole("dialog")).toBeVisible();
	});
});
