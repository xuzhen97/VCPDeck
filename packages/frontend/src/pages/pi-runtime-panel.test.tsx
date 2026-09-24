import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { PiRuntimePanel } from "@/pages/pi-runtime-panel";

function makeSdk(runtimeStatus: Record<string, unknown>) {
	const bindings = {
		list: vi.fn().mockResolvedValue([]),
		set: vi.fn(),
		clear: vi.fn(),
	};
	const client = {
		clients: { list: vi.fn().mockResolvedValue([{ clientId: "c1", hostname: "host-1" }]) },
		pi: {
			profiles: {
				list: vi.fn().mockResolvedValue({
					data: [],
					total: 0,
					page: 1,
					pageSize: 20,
					totalPages: 0,
				}),
			},
			bindings,
			runtime: vi.fn().mockResolvedValue(runtimeStatus),
		},
	} as unknown as VcpDeckClient;
	return { client, bindings };
}

function renderPanel(client: VcpDeckClient) {
	render(
		<SdkProvider client={client}>
			<PiRuntimePanel />
		</SdkProvider>,
	);
}

describe("PiRuntimePanel", () => {
	it("非 ready 时展示中文原因与缺失模型", async () => {
		const { client } = makeSdk({
			clientId: "c1",
			specId: "s1",
			desiredRuntimeRevision: "0123456789abcdef",
			activeRuntimeRevision: null,
			configState: "incompatible",
			reasonCode: "PI_CREDENTIAL_UNAVAILABLE",
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 1,
			unavailableModels: [
				{ provider: "anthropic", modelId: "claude-x", reason: "model_unavailable" },
			],
		});
		renderPanel(client);
		expect(await screen.findByText("配置不可用")).toBeInTheDocument();
		expect(screen.getByTestId("pi-runtime-reason")).toHaveTextContent(
			"凭据不可用",
		);
		expect(screen.getByTestId("pi-runtime-unavailable")).toHaveTextContent(
			"anthropic/claude-x",
		);
		expect(screen.getByText(/Pi SDK 0.86.0/)).toBeInTheDocument();
		expect(screen.getByText(/desired 0123456789abcdef/)).toBeInTheDocument();
	});

	it("pending 且登记 PI_BUNDLE_UNAVAILABLE 时给出 Bundle 原因（不只说等待下发）", async () => {
		const { client } = makeSdk({
			clientId: "c1",
			specId: null,
			desiredRuntimeRevision: null,
			activeRuntimeRevision: null,
			configState: "pending",
			reasonCode: "PI_BUNDLE_UNAVAILABLE",
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 3,
			unavailableModels: [],
		});
		renderPanel(client);
		expect(await screen.findByText(/未就绪/)).toBeInTheDocument();
		expect(screen.getByTestId("pi-runtime-reason")).toHaveTextContent(
			"目标机缺少所需资源 Bundle",
		);
	});

	it("ready 时展示就绪状态", async () => {
		const { client } = makeSdk({
			clientId: "c1",
			specId: "s1",
			desiredRuntimeRevision: "0123456789abcdef",
			activeRuntimeRevision: "0123456789abcdef",
			configState: "ready",
			reasonCode: null,
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 1,
			unavailableModels: [],
		});
		renderPanel(client);
		expect(await screen.findByText("就绪")).toBeInTheDocument();
		expect(screen.getByText(/active 0123456789abcdef/)).toBeInTheDocument();
		expect(screen.queryByTestId("pi-runtime-reason")).not.toBeInTheDocument();
	});

	it("runtime 查询失败时仍列出 Client 并提示状态未知", async () => {
		const { client } = makeSdk({});
		(client.pi.runtime as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("boom"),
		);
		renderPanel(client);
		expect(await screen.findByText("host-1")).toBeInTheDocument();
		expect(screen.getByText("状态未知")).toBeInTheDocument();
	});

	it("绑定失败时展示服务端精确原因，并刷新回真实绑定状态", async () => {
		const user = userEvent.setup();
		const { client, bindings } = makeSdk({
			clientId: "c1",
			specId: "s1",
			desiredRuntimeRevision: null,
			activeRuntimeRevision: null,
			configState: "pending",
			reasonCode: null,
			piSdkVersion: "0.86.0",
			runtimeSpecProtocolVersion: 2,
			unavailableModels: [],
		});
		await (
			client.pi.profiles.list as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			data: [
				{
					id: "p1",
					name: "test",
					enabled: true,
					defaultModel: { provider: "axonhub", modelId: "mimo-v2.6-flash" },
					allowedModels: [{ provider: "axonhub", modelId: "mimo-v2.6-flash" }],
					defaultThinkingLevel: "medium",
					revision: 1,
					credentialIds: ["c1"],
					boundClientIds: [],
				},
			],
			total: 1,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		});
		bindings.set.mockRejectedValueOnce(
			Object.assign(new Error('Provider "axonhub" 不存在'), {
				code: "PI_CONFIG_UNAVAILABLE",
			}),
		);
		renderPanel(client);
		await screen.findByText("host-1");

		await user.selectOptions(screen.getByLabelText("绑定 Profile"), "p1");
		const listCallsBefore = bindings.list.mock.calls.length;
		await user.click(screen.getByRole("button", { name: "保存绑定" }));

		// 服务端 message 直显，不再被吞成「绑定更新失败」
		expect(await screen.findByTestId("pi-runtime-error")).toHaveTextContent(
			'Provider "axonhub" 不存在',
		);
		// 失败后刷新真实绑定状态（绑定可能已落库、只是下发失败）
		expect(bindings.list.mock.calls.length).toBeGreaterThan(listCallsBefore);
	});
});
