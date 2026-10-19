import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ClientInfo } from "@vcpdeck/shared";
import { SdkProvider } from "@/api/context";
import { MachineDshWebPanel } from "./machine-dsh-web-panel.js";

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

function renderPanel(
	sdk: {
		clients: {
			setDshWebUrl: ReturnType<typeof vi.fn>;
			detachDshWeb?: ReturnType<typeof vi.fn>;
		};
	},
	client: ClientInfo,
) {
	render(
		<SdkProvider client={sdk as never}>
			<MachineDshWebPanel client={client} />
		</SdkProvider>,
	);
	return sdk;
}

describe("MachineDshWebPanel（ADR-0059）", () => {
	it("未登记时给出启动契约提示与输入框", () => {
		renderPanel({ clients: { setDshWebUrl: vi.fn() } }, makeClient());
		expect(screen.getByText(/还没有可用的 DSH 地址/)).toBeVisible();
		expect(
			screen.getByPlaceholderText("https://dsh.example.com/?token=…"),
		).toBeVisible();
	});

	it("登记后展示打码地址并提供打开链接", () => {
		renderPanel(
			{ clients: { setDshWebUrl: vi.fn() } },
			makeClient({ dshWebUrl: "https://dsh.example.com/?token=secret123" }),
		);
		expect(screen.getByText(/token=•••/)).toBeVisible();
		expect(screen.getByRole("link", { name: /打开/ })).toHaveAttribute(
			"href",
			"https://dsh.example.com/?token=secret123",
		);
	});

	it("保存时调用 SDK 并回填", async () => {
		const user = userEvent.setup();
		const sdk = {
			clients: {
				setDshWebUrl: vi
					.fn()
					.mockResolvedValue(
						makeClient({ dshWebUrl: "https://dsh.example.com/?token=new" }),
					),
			},
		};
		renderPanel(sdk, makeClient());
		await user.type(
			screen.getByPlaceholderText("https://dsh.example.com/?token=…"),
			"https://dsh.example.com/?token=new",
		);
		await user.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => {
			expect(sdk.clients.setDshWebUrl).toHaveBeenCalledWith(
				"c1",
				"https://dsh.example.com/?token=new",
			);
		});
	});
	it("一键启动后展示运行中与打开入口", async () => {
		const user = userEvent.setup();
		const sdk = {
			clients: {
				setDshWebUrl: vi.fn(),
				startDshWeb: vi.fn().mockResolvedValue({
					clientId: "c1",
					state: "running",
					port: 30123,
					url: "https://frp.example.com:30123/?token=abc",
					mode: "managed",
				}),
				stopDshWeb: vi.fn(),
			},
		};
		render(
			<SdkProvider client={sdk as never}>
				<MachineDshWebPanel client={makeClient()} />
			</SdkProvider>,
		);
		await user.click(screen.getByRole("button", { name: /一键启动/ }));
		expect(await screen.findByText(/token=•••/)).toBeVisible();
		expect(screen.getByRole("link", { name: /打开/ })).toHaveAttribute(
			"href",
			"https://frp.example.com:30123/?token=abc",
		);
	});

	it("外部托管时不提供一键启动，只给打开与解除登记", () => {
		renderPanel(
			{ clients: { setDshWebUrl: vi.fn(), detachDshWeb: vi.fn() } },
			makeClient({
				dshWebState: "external",
				dshWebMode: "external",
				dshWebUrl: "https://dsh.example.com/?token=secret123",
			}),
		);

		expect(screen.getByText("外部托管")).toBeVisible();
		expect(screen.queryByRole("button", { name: /一键启动/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /停止并清理/ })).toBeNull();
		expect(screen.getByRole("button", { name: /解除登记/ })).toBeVisible();
		expect(screen.getByRole("link", { name: /打开/ })).toBeVisible();
		// 常驻实例不归 VCPDeck 管，文案必须说清楚
		expect(screen.getByText(/不会起停它/)).toBeVisible();
	});

	it("解除登记调用 detach 而不是 stop", async () => {
		const user = userEvent.setup();
		const detach = vi.fn().mockResolvedValue({
			clientId: "c1",
			state: "stopped",
			port: null,
			url: null,
			mode: "managed",
		});
		const stop = vi.fn();
		render(
			<SdkProvider
				client={
					{
						clients: { setDshWebUrl: vi.fn(), detachDshWeb: detach, stopDshWeb: stop },
					} as never
				}
			>
				<MachineDshWebPanel
					client={makeClient({
						dshWebState: "external",
						dshWebMode: "external",
						dshWebUrl: "https://dsh.example.com/?token=secret123",
					})}
				/>
			</SdkProvider>,
		);

		await user.click(screen.getByRole("button", { name: /解除登记/ }));
		await waitFor(() => expect(detach).toHaveBeenCalledWith("c1"));
		expect(stop).not.toHaveBeenCalled();
		expect(await screen.findByRole("button", { name: /一键启动/ })).toBeVisible();
	});

	it("有公网注解时预填并提示复用，不必手抄域名", () => {
		renderPanel(
			{ clients: { setDshWebUrl: vi.fn() } },
			makeClient({
				annotations: {
					publicAddress: { v4: ["203.0.113.7"], v6: [], host: "mylx.example.com" },
					notes: null,
					updatedAt: new Date(0).toISOString(),
				},
			}),
		);

		expect(
			screen.getByPlaceholderText("https://mylx.example.com/?token=…"),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "用公网地址" })).toBeVisible();
	});
});