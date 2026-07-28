import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo, FrpMappingInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
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

afterEach(() => vi.useRealTimers());

function renderPanel(frp: Record<string, unknown>) {
	const client = {
		auth: { me: async () => identity },
		frp,
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

describe("FrpPanel", () => {
	it("polls an inactive mapping until active", async () => {
		const get = vi.fn();
		const create = vi.fn().mockResolvedValue(mapping("inactive"));
		renderPanel({
			list: vi.fn().mockResolvedValue([]),
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

	it("requires the mapping name and explains deletion limits", async () => {
		const remove = vi.fn().mockResolvedValue({ id: "fm_1", deleted: true });
		renderPanel({
			list: vi.fn().mockResolvedValue([mapping("active")]),
			create: vi.fn(),
			get: vi.fn(),
			delete: remove,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "删除映射" }),
		);
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
