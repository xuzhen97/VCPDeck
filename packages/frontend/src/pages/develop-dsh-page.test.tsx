import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ClientInfo } from "@vcpdeck/shared";
import { SdkProvider } from "@/api/context";
import { DevelopDshPage } from "./develop-dsh-page.js";

function makeClient(overrides: Partial<ClientInfo> = {}): ClientInfo {
	return {
		clientId: "c1",
		name: "mylx",
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
		...overrides,
	};
}

function renderPage(sdk: {
	clients: {
		list: ReturnType<typeof vi.fn>;
		startDshWeb?: ReturnType<typeof vi.fn>;
		stopDshWeb?: ReturnType<typeof vi.fn>;
	};
}) {
	render(
		<SdkProvider client={sdk as never}>
			<DevelopDshPage />
		</SdkProvider>,
	);
	return sdk;
}

describe("DevelopDshPage（跨机器远程 DSH）", () => {
	it("列出机器并展示 DSH 状态与打码地址", async () => {
		renderPage({
			clients: {
				list: vi.fn().mockResolvedValue([
					makeClient({
						dshWebState: "running",
						dshWebUrl: "http://127.0.0.1:17001/?token=secret123456",
					}),
					makeClient({ clientId: "c2", name: "other", dshWebState: "stopped" }),
				]),
			},
		});

		expect(await screen.findByText("mylx")).toBeVisible();
		expect(screen.getByText("other")).toBeVisible();
		expect(screen.getByText("运行中")).toBeVisible();
		expect(screen.getByText("已停止")).toBeVisible();
		// token 打码，绝不整串出现在页面上
		expect(screen.getByText(/token=•••/)).toBeVisible();
		expect(screen.queryByText(/secret123456/)).toBeNull();
	});

	it("一键启动后回填地址，失败时把错误码翻成可读提示", async () => {
		const start = vi
			.fn()
			.mockResolvedValueOnce({
				state: "running",
				port: 30123,
				url: "http://127.0.0.1:17001/?token=tok",
			})
			.mockRejectedValueOnce(
				Object.assign(new Error("boom"), {
					code: "DSH_WEB_FRP_UNAVAILABLE",
				}),
			);
		renderPage({
			clients: {
				list: vi.fn().mockResolvedValue([
					makeClient({ dshWebState: "stopped" }),
					makeClient({ clientId: "c2", name: "other", dshWebState: "stopped" }),
				]),
				startDshWeb: start,
				stopDshWeb: vi.fn(),
			},
		});

		const buttons = await screen.findAllByRole("button", { name: /一键启动/ });
		await userEvent.click(buttons[0] as HTMLElement);
		expect(start).toHaveBeenCalledWith("c1");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /打开/ })).toBeVisible(),
		);

		const remaining = screen.getAllByRole("button", { name: /一键启动/ });
		await userEvent.click(remaining[0] as HTMLElement);
		expect(
			await screen.findByText(/先在 FRP 页配置一个 frps/),
		).toBeVisible();
	});

	it("没有机器时给出空状态而不是空白", async () => {
		renderPage({ clients: { list: vi.fn().mockResolvedValue([]) } });
		expect(await screen.findByText("还没有机器上线")).toBeVisible();
	});
});
