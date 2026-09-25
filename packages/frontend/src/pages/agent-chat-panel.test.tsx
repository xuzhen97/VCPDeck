import type { ReactNode } from "react";
import type { ClientInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { AgentChatPanel } from "./agent-chat-panel";

// AgentChatPanel 的职责是「机器选择 + 状态接线」，不是 PiPanel 内部行为（由 pi-panel.test.tsx 覆盖）。
// 这里替身 PiPanel，避免为了选择逻辑拉起 SSE / Pi SDK mock。
vi.mock("@/pages/pi-panel", () => ({
	PiPanel: ({ client, leftSlot }: { client: ClientInfo; leftSlot?: ReactNode }) => (
		<div data-testid="pi-panel-mock" data-client={client.clientId}>
			{leftSlot}
		</div>
	),
}));

const identity = {
	id: "i1",
	username: "operator",
	displayName: "操作员",
	isAdmin: true,
	disabledAt: null,
	createdAt: "2026-07-26T00:00:00.000Z",
};

function machine(
	clientId: string,
	options: { online: boolean; pi: boolean },
): ClientInfo {
	return {
		clientId,
		name: clientId,
		hostname: `${clientId}.local`,
		os: "win32",
		cpuModel: "cpu",
		totalMemMB: 1,
		clientVersion: "1",
		capabilities: options.pi ? ["agent.pi"] : [],
		capabilityDetails: options.pi ? { pi: { available: true } } : {},
		online: options.online,
		cpuPercent: null,
		memPercent: null,
		disks: [],
		lastHeartbeatAt: null,
	} as unknown as ClientInfo;
}

function LocationProbe() {
	return (
		<output aria-label="当前位置">
			{`${useLocation().pathname}${useLocation().search}`}
		</output>
	);
}

function renderPanel(initialPath = "/agent/chat", clients?: ClientInfo[]) {
	const list = vi.fn().mockResolvedValue(
		clients ?? [
			machine("ready-host", { online: true, pi: true }),
			machine("offline-host", { online: false, pi: true }),
			machine("legacy-host", { online: true, pi: false }),
		],
	);
	const sdk = {
		auth: { me: async () => identity },
		clients: { list },
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter initialEntries={[initialPath]}>
			<SdkProvider client={sdk}>
				<AuthProvider>
					<AgentChatPanel />
					<LocationProbe />
				</AuthProvider>
			</SdkProvider>
		</MemoryRouter>,
	);
	return { list };
}

describe("AgentChatPanel", () => {
	it("labels unavailable machines with the reason and disables them", async () => {
		renderPanel();

		const picker = (await screen.findByLabelText("机器")) as HTMLSelectElement;
		const options = within(picker).getAllByRole(
			"option",
		) as HTMLOptionElement[];
		expect(options.map((option) => option.textContent)).toEqual([
			"选择机器…",
			"ready-host（ready-host.local）",
			"offline-host（offline-host.local） · 离线",
			"legacy-host（legacy-host.local） · 不支持 Pi",
		]);
		expect(options[1]?.disabled).toBe(false);
		expect(options[2]?.disabled).toBe(true);
		expect(options[3]?.disabled).toBe(true);
	});

	it("shows an empty state and does not mount PiPanel before a machine is chosen", async () => {
		renderPanel();

		expect(await screen.findByText("选择一台机器开始对话")).toBeVisible();
		expect(screen.queryByTestId("pi-panel-mock")).not.toBeInTheDocument();

		// 回归：空态必须自带可用的机器选择入口，不得靠 CSS hidden 藏起来（窄屏会变成死路）
		const chooser = screen.getByLabelText("机器");
		expect(chooser).toBeVisible();
		expect(chooser.closest("aside")).not.toHaveClass("hidden");
		// 回归：外壳已有 main landmark，这里不得再嵌套一个
		expect(screen.queryAllByRole("main")).toHaveLength(0);
		// 回归：同一 slot 会被渲染两次（桌面左栏 + 常驻抽屉），控件不得依赖 id 关联
		expect(chooser).not.toHaveAttribute("id");
	});

	it("writes the chosen machine to ?client= and mounts PiPanel with the picker as left slot", async () => {
		renderPanel();

		await userEvent.selectOptions(
			await screen.findByLabelText("机器"),
			"ready-host",
		);

		await waitFor(() =>
			expect(screen.getByLabelText("当前位置")).toHaveTextContent(
				"/agent/chat?client=ready-host",
			),
		);
		const panel = screen.getByTestId("pi-panel-mock");
		expect(panel).toHaveAttribute("data-client", "ready-host");
		expect(within(panel).getByLabelText("机器")).toBeVisible();
		expect(screen.queryByText("选择一台机器开始对话")).not.toBeInTheDocument();
	});

	it("restores the machine from a deep link", async () => {
		renderPanel("/agent/chat?client=ready-host");

		await waitFor(() =>
			expect(screen.getByTestId("pi-panel-mock")).toHaveAttribute(
				"data-client",
				"ready-host",
			),
		);
	});

	it("treats an unusable or unknown ?client= as no selection without rewriting the URL", async () => {
		renderPanel("/agent/chat?client=offline-host");

		expect(await screen.findByText("选择一台机器开始对话")).toBeVisible();
		expect(screen.queryByTestId("pi-panel-mock")).not.toBeInTheDocument();
		expect(screen.getByLabelText("当前位置")).toHaveTextContent(
			"/agent/chat?client=offline-host",
		);
		expect(screen.getByTestId("agent-chat-requested-note")).toHaveTextContent(
			"offline-host",
		);
	});

	it("treats an unknown machine id as no selection", async () => {
		renderPanel("/agent/chat?client=ghost");

		expect(await screen.findByText("选择一台机器开始对话")).toBeVisible();
		expect(screen.getByTestId("agent-chat-requested-note")).toHaveTextContent(
			"不存在",
		);
	});
});
