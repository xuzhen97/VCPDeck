import type { VcpDeckClient } from "@vcpdeck/sdk";
import type {
	ClientInfo,
	FrpMappingInfo,
	FrpsInstanceInfo,
	IdentityInfo,
} from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { FrpPage } from "./frp-page";
import { FrpPanel } from "./frp-panel";

const identity: IdentityInfo = {
	id: "i1",
	username: "admin",
	displayName: "管理员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};
const mapping = (status = "inactive"): FrpMappingInfo => ({
	id: "fm_1",
	clientId: "client-1",
	name: "local-web",
	proxyType: "tcp",
	localIp: "127.0.0.1",
	localPort: 3000,
	remotePort: 20080,
	customDomain: null,
	status,
	publicUrl: "example.com:20080",
	createdAt: "2026-07-26T00:00:00.000Z",
	updatedAt: "2026-07-26T00:00:00.000Z",
});
const frpsInstance = (): FrpsInstanceInfo => ({
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
});
const clientInfo = (): ClientInfo => ({
	clientId: "client-1",
	hostname: "DESKTOP-DEV",
	os: "win32",
	cpuModel: "cpu",
	totalMemMB: 1,
	disks: [],
	clientVersion: "test",
	capabilities: [],
	capabilityDetails: {},
	online: true,
	cpuPercent: null,
	memPercent: null,
	lastHeartbeatAt: null,
});

afterEach(() => vi.useRealTimers());

function renderPanel(overrides: Record<string, unknown>) {
	const { clients, ...frp } = overrides;
	const client = {
		auth: { me: async () => identity },
		clients:
			(clients as Record<string, unknown> | undefined) ?? {
				list: vi.fn().mockResolvedValue([clientInfo()]),
			},
		frp: {
			instances: {
				list: vi.fn().mockResolvedValue({
					data: [],
					total: 0,
					page: 1,
					pageSize: 100,
					totalPages: 0,
				}),
			},
			...frp,
		},
	} as unknown as VcpDeckClient;
	return render(
		<MemoryRouter>
			<SdkProvider client={client}>
				<AuthProvider>
					<FrpPanel clientId="client-1" />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
}

describe("FrpPage", () => {
	it("switches between mapping and instance panels", async () => {
		const client = {
			auth: { me: async () => identity },
			clients: {
				list: vi.fn().mockResolvedValue([clientInfo()]),
			},
			frp: {
				list: vi.fn().mockResolvedValue({
					data: [],
					total: 0,
					page: 1,
					pageSize: 20,
					totalPages: 0,
				}),
				get: vi.fn(),
				create: vi.fn(),
				delete: vi.fn(),
				instances: {
					list: vi.fn().mockResolvedValue({
						data: [],
						total: 0,
						page: 1,
						pageSize: 20,
						totalPages: 0,
					}),
					get: vi.fn(),
					create: vi.fn(),
					update: vi.fn(),
					delete: vi.fn(),
					probe: vi.fn(),
					setDefault: vi.fn(),
				},
			},
		} as unknown as VcpDeckClient;
		render(
			<MemoryRouter>
				<SdkProvider client={client}>
					<AuthProvider>
						<FrpPage />
					</AuthProvider>
				</SdkProvider>
			</MemoryRouter>,
		);

		expect(await screen.findByRole("heading", { name: "映射" })).toBeVisible();
		expect(screen.getByRole("navigation", { name: "映射导航" })).toBeVisible();
		expect(screen.queryByRole("heading", { name: "FRP" })).not.toBeInTheDocument();
		expect(await screen.findByText("全部映射")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "实例配置" }));
		expect(await screen.findByText("frps 实例")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "映射" }));
		expect(await screen.findByText("全部映射")).toBeVisible();
	});
});

describe("FrpPanel", () => {
	it("polls an inactive mapping until active", async () => {
		const get = vi.fn();
		const create = vi.fn().mockResolvedValue(mapping("inactive"));
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [],
				total: 0,
				page: 1,
				pageSize: 20,
				totalPages: 0,
			}),
			create,
			get,
			delete: vi.fn(),
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "新增映射" }),
		);
		await userEvent.type(await screen.findByLabelText("映射名称"), "local-web");
		await userEvent.type(screen.getByLabelText("本地端口"), "3000");
		await userEvent.click(screen.getByRole("button", { name: "创建映射" }));
		expect(get).not.toHaveBeenCalled();
		expect(await screen.findByText("inactive")).toBeTruthy();
	});

	it("opens the mapping form in a wide drawer", async () => {
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [],
				total: 0,
				page: 1,
				pageSize: 20,
				totalPages: 0,
			}),
			create: vi.fn(),
			get: vi.fn(),
			delete: vi.fn(),
		});

		await userEvent.click(
			await screen.findByRole("button", { name: "新增映射" }),
		);
		expect(screen.getByRole("dialog", { name: "创建映射" })).toHaveClass(
			"w-[720px]",
		);
		expect(screen.getByText("目标")).toBeVisible();
		expect(screen.getByText("本地服务")).toBeVisible();
		expect(screen.getByText("公网入口")).toBeVisible();
	});

	it("shows mapping rows with Client hostname and endpoints", async () => {
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [mapping("active")],
				total: 1,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			}),
			create: vi.fn(),
			get: vi.fn(),
			delete: vi.fn(),
		});

		expect((await screen.findAllByText("local-web"))[0]).toBeVisible();
		expect(screen.getAllByText("DESKTOP-DEV")[0]).toBeVisible();
		expect(screen.getAllByText("client-1…")[0]).toBeVisible();
		expect(screen.getAllByText("TCP")[0]).toBeVisible();
		expect(screen.getAllByText("运行中")[0]).toBeVisible();
		expect(screen.getAllByText("127.0.0.1:3000")[0]).toBeVisible();
		expect(screen.getAllByText("example.com:20080")[0]).toBeVisible();
		expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
	});

	it("falls back when Client names cannot load", async () => {
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [mapping("active")],
				total: 1,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			}),
			create: vi.fn(),
			get: vi.fn(),
			delete: vi.fn(),
			clients: { list: vi.fn().mockRejectedValue(new Error("offline")) },
		});

		expect((await screen.findAllByText("未知 Client"))[0]).toBeVisible();
		expect(screen.getAllByText("client-1…")[0]).toBeVisible();
	});

	it("copies the public URL from the row menu", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [mapping("active")],
				total: 1,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			}),
			create: vi.fn(),
			get: vi.fn(),
			delete: vi.fn(),
		});

		await userEvent.click(
			(await screen.findAllByRole("button", { name: "更多操作" }))[0]!,
		);
		await userEvent.click(screen.getByRole("button", { name: "复制公网地址" }));
		expect(writeText).toHaveBeenCalledWith("example.com:20080");
		expect((await screen.findAllByText("已复制"))[0]).toBeVisible();
	});

	it("selects the default frps instance when creating a mapping", async () => {
		const create = vi.fn().mockResolvedValue(mapping("active"));
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [],
				total: 0,
				page: 1,
				pageSize: 20,
				totalPages: 0,
			}),
			create,
			get: vi.fn(),
			delete: vi.fn(),
			instances: {
				list: vi.fn().mockResolvedValue({
					data: [frpsInstance()],
					total: 1,
					page: 1,
					pageSize: 100,
					totalPages: 1,
				}),
			},
		});

		await userEvent.click(
			await screen.findByRole("button", { name: "新增映射" }),
		);
		expect(await screen.findByLabelText("frps 实例")).toHaveValue("frps_1");
		expect(
			screen.getByText("1.2.3.4:7000 · 端口范围 20000–21000"),
		).toBeVisible();
		await userEvent.type(screen.getByLabelText("映射名称"), "local-web");
		await userEvent.type(screen.getByLabelText("本地端口"), "3000");
		await userEvent.click(screen.getByRole("button", { name: "创建映射" }));

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ frpsInstanceId: "frps_1" }),
			expect.any(AbortSignal),
		);
	});

	it("allows retrying after mapping creation fails", async () => {
		const create = vi.fn().mockRejectedValue(new Error("创建失败"));
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [],
				total: 0,
				page: 1,
				pageSize: 20,
				totalPages: 0,
			}),
			create,
			get: vi.fn(),
			delete: vi.fn(),
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "新增映射" }),
		);
		await userEvent.type(screen.getByLabelText("映射名称"), "local-web");
		await userEvent.type(screen.getByLabelText("本地端口"), "3000");
		await userEvent.click(screen.getByRole("button", { name: "创建映射" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("创建失败");
		expect(screen.getByRole("button", { name: "创建映射" })).toBeEnabled();
	});

	it("falls back to the server default when instances cannot load", async () => {
		const create = vi.fn().mockResolvedValue(mapping("active"));
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [],
				total: 0,
				page: 1,
				pageSize: 20,
				totalPages: 0,
			}),
			create,
			get: vi.fn(),
			delete: vi.fn(),
			instances: {
				list: vi.fn().mockRejectedValue(new Error("offline")),
			},
		});

		await userEvent.click(
			await screen.findByRole("button", { name: "新增映射" }),
		);
		expect(
			await screen.findByText("无法加载 frps 实例，将使用服务端默认实例"),
		).toBeVisible();
		await userEvent.type(screen.getByLabelText("映射名称"), "local-web");
		await userEvent.type(screen.getByLabelText("本地端口"), "3000");
		await userEvent.click(screen.getByRole("button", { name: "创建映射" }));

		expect(create.mock.calls[0]?.[0]).not.toHaveProperty("frpsInstanceId");
	});

	it("requires the mapping name and explains deletion limits", async () => {
		const remove = vi.fn().mockResolvedValue({ id: "fm_1", deleted: true });
		renderPanel({
			list: vi.fn().mockResolvedValue({
				data: [mapping("active")],
				total: 1,
				page: 1,
				pageSize: 20,
				totalPages: 1,
			}),
			create: vi.fn(),
			get: vi.fn(),
			delete: remove,
		});
		await userEvent.click(
			(await screen.findAllByRole("button", { name: "更多操作" }))[0]!,
		);
		await userEvent.click(screen.getByRole("button", { name: "删除映射" }));
		expect(screen.getByText("删除映射")).toBeVisible();
		expect(screen.queryByText("删除 FRP 映射")).not.toBeInTheDocument();
		const confirm = screen.getByRole("button", { name: "确认删除" });
		expect(confirm).toBeDisabled();
		await userEvent.type(screen.getByLabelText("输入目标以确认"), "local-web");
		await userEvent.click(confirm);
		expect(remove).toHaveBeenCalledWith("fm_1");
		expect(
			await screen.findByText(
				"已移除 Server 映射记录；Client 清理状态尚未确认",
			),
		).toBeVisible();
	});
});
