import { describe, expect, it, vi } from "vitest";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SdkProvider } from "@/api/context";
import { PiProfilesPanel } from "@/pages/pi-profiles-panel";

const provider = {
	id: "provider-axon",
	name: "AxonHub",
	runtimeProviderId: "axonhub",
	protocol: "openai-compat" as const,
	baseUrl: "https://llm.example.test/v1",
	headers: {},
	enabled: true,
	revision: 1,
	models: [
		{
			id: "mimo-v2.6-flash",
			name: "MiMo V2.6 Flash",
			metadataSource: "catalog" as const,
		},
	],
	credentialIds: ["cred-1"],
	boundProfileIds: [],
	configurationState: "ready" as const,
};

const credential = {
	id: "cred-1",
	name: "AxonHub",
	providerConfigId: "provider-axon",
	providerName: "AxonHub",
	runtimeProviderId: "axonhub",
	protocol: "openai-compat" as const,
	fingerprint: "ab12cd34",
	keyVersion: 1,
	createdAt: "2026-09-21T00:00:00.000Z",
	updatedAt: "2026-09-21T00:00:00.000Z",
	lastUsedAt: null,
	revokedAt: null,
	configurationState: "ready" as const,
};

function makeSdk() {
	const page = (data: unknown[]) => ({
		data,
		total: data.length,
		page: 1,
		pageSize: 20,
		totalPages: 1,
	});
	const profileList = vi.fn().mockResolvedValue(page([]));
	const providerList = vi.fn().mockResolvedValue(page([provider]));
	const credentialList = vi.fn().mockResolvedValue(page([credential]));
	const create = vi.fn();
	const update = vi.fn();
	const confirmMigration = vi.fn();
	const clientList = vi
		.fn()
		.mockResolvedValue([{ clientId: "c1", hostname: "host-1" }]);
	const runtime = vi.fn().mockResolvedValue({
		clientId: "c1",
		bundle: {
			protocolVersion: 1,
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resourceIds: ["vcp.tool-policy"],
		},
	});
	const client = {
		clients: { list: clientList },
		pi: {
			profiles: { list: profileList, create, update, confirmExecutionMigration: confirmMigration },
			providers: { list: providerList },
			credentials: { list: credentialList },
			runtime,
		},
	} as unknown as VcpDeckClient;
	return { client, create, confirmMigration };
}

function renderPanel(client: VcpDeckClient) {
	return render(
		<SdkProvider client={client}>
			<PiProfilesPanel />
		</SdkProvider>,
	);
}

const ALLOWED_LABEL = "允许模型（每行一个 provider/modelId）";

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
	// 加载完成后先勾凭据：默认 Provider 下拉是 credential-driven 的，
	// 未勾任何凭据时它只有「请先关联占位」占位项。
	const credentialBox = await screen.findByLabelText("AxonHub (axonhub)");
	await user.click(credentialBox);
	await screen.findByRole("option", { name: "AxonHub (axonhub)" });
	await user.type(screen.getByLabelText("名称"), "测试");
}

describe("PiProfilesPanel", () => {
	it("空允许模型给出精确提示，不发请求", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		renderPanel(client);
		await fillBasics(user);
		await user.type(screen.getByLabelText("默认模型 ID"), "mimo-v2.6-flash");

		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		const error = await screen.findByTestId("pi-profiles-error");
		expect(error.textContent).toBe("请填写至少一行允许模型（provider/modelId）");
		expect(create).not.toHaveBeenCalled();
	});

	it("默认模型不在允许列表时给出精确提示", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		renderPanel(client);
		await fillBasics(user);
		await user.type(screen.getByLabelText("默认模型 ID"), "mimo-v2.6-flash");
		await user.type(screen.getByLabelText(ALLOWED_LABEL), "axonhub/other-model");

		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		const error = await screen.findByTestId("pi-profiles-error");
		expect(error.textContent).toBe("默认模型必须位于允许模型列表");
		expect(create).not.toHaveBeenCalled();
	});

	it("未配置目录的模型行原样透传，服务端精确错误直接展示", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		create.mockRejectedValueOnce(
			Object.assign(
				new Error("模型 axonhub/not-in-catalog 未配置或不在 Provider 目录"),
				{ code: "PI_CONFIG_UNAVAILABLE" },
			),
		);
		renderPanel(client);
		await fillBasics(user);
		await user.type(screen.getByLabelText("默认模型 ID"), "not-in-catalog");
		await user.type(screen.getByLabelText(ALLOWED_LABEL), "axonhub/not-in-catalog");
		// 基线策略含 confirm，必须先启用执行它的 Bundle 资源
		await user.click(await screen.findByLabelText("资源-vcp.tool-policy"));

		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		const error = await screen.findByTestId("pi-profiles-error");
		expect(error.textContent).toBe(
			"模型 axonhub/not-in-catalog 未配置或不在 Provider 目录",
		);
		// 未知模型行不能被前端静默丢弃，必须原样交给 Server 判定
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedModels: [{ provider: "axonhub", modelId: "not-in-catalog" }],
				credentialIds: ["cred-1"],
			}),
		);
	});

	it("合法配置创建成功并进入列表", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		create.mockResolvedValueOnce({
			id: "profile-1",
			name: "测试",
			enabled: true,
			defaultModel: { provider: "axonhub", modelId: "mimo-v2.6-flash" },
			allowedModels: [{ provider: "axonhub", modelId: "mimo-v2.6-flash" }],
			defaultThinkingLevel: "medium",
			// 列表渲染读取 executionConfiguration（ADR-0039）：缺它会让模式标签取不到值。
			executionConfiguration: { state: "ready", mode: "supervised" },
			toolExecutionMode: "supervised",
			enabledResourceIds: ["vcp.tool-policy"],
			revision: 1,
			credentialIds: ["cred-1"],
			boundClientIds: [],
		});
		renderPanel(client);
		await fillBasics(user);
		await user.type(screen.getByLabelText("默认模型 ID"), "mimo-v2.6-flash");
		await user.type(
			screen.getByLabelText(ALLOWED_LABEL),
			"axonhub/mimo-v2.6-flash",
		);
		await user.click(await screen.findByLabelText("资源-vcp.tool-policy"));

		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		await screen.findByText("测试");
		expect(
			screen.queryByTestId("pi-profiles-error"),
		).not.toBeInTheDocument();
	});
});

describe("PiProfilesPanel 的工具执行模式", () => {
	/** 已就绪的列表项：两模式、无逐工具三桶。 */
	const listProfile = (mode: "supervised" | "automatic") => ({
		id: "p1",
		name: "已有配置",
		enabled: true,
		defaultModel: { provider: "axonhub", modelId: "mimo-v2.6-flash" },
		allowedModels: [{ provider: "axonhub", modelId: "mimo-v2.6-flash" }],
		defaultThinkingLevel: "medium",
		executionConfiguration: { state: "ready", mode },
		toolExecutionMode: mode,
		enabledResourceIds: ["vcp.tool-policy"],
		revision: 1,
		credentialIds: ["cred-1"],
		boundClientIds: [],
	});

	/** 待确认迁移的列表项：toolExecutionMode 为 null，保留旧限制供展示。 */
	const pendingProfile = () => ({
		...listProfile("supervised"),
		id: "pending",
		name: "存量配置",
		toolExecutionMode: null,
		executionConfiguration: {
			state: "needs_confirmation" as const,
			legacyMode: "auto" as const,
			legacyPolicy: { allow: ["read"], confirm: ["bash"], deny: [] },
		},
		revision: 7,
	});

	it("新建默认监督模式，并提交所选模式且不再提交任何三桶", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		create.mockResolvedValueOnce({ ...listProfile("automatic"), name: "测试" });
		renderPanel(client);

		// 产品默认：监督模式（自动执行必须显式选择）。
		expect(await screen.findByLabelText("监督模式")).toBeChecked();
		await user.click(screen.getByLabelText("自动执行"));

		await fillBasics(user);
		await user.type(screen.getByLabelText("默认模型 ID"), "mimo-v2.6-flash");
		await user.type(screen.getByLabelText(ALLOWED_LABEL), "axonhub/mimo-v2.6-flash");
		await user.click(screen.getByLabelText("资源-vcp.tool-policy"));
		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		const submitted = create.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(submitted).toMatchObject({ toolExecutionMode: "automatic" });
		// 逐工具三桶已删除（ADR-0039）：请求体不得再携带 toolPolicy。
		expect(submitted).not.toHaveProperty("toolPolicy");
	});

	it("编辑已就绪 Profile 时回显其模式", async () => {
		const user = userEvent.setup();
		const { client } = makeSdk();
		(client.pi.profiles.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			data: [listProfile("supervised")],
			total: 1,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		});
		renderPanel(client);

		await user.click(await screen.findByRole("button", { name: "编辑" }));

		expect(screen.getByLabelText("监督模式")).toBeChecked();
		expect(screen.getByLabelText("自动执行")).not.toBeChecked();
	});

	it("说明文案明确两模式的能力与安全边界", async () => {
		const user = userEvent.setup();
		const { client } = makeSdk();
		renderPanel(client);

		expect(
			await screen.findByText(/每次工具调用（含读取）都需要你确认/),
		).toBeInTheDocument();

		await user.click(screen.getByLabelText("自动执行"));
		expect(
			screen.getByText(/不再逐次询问/),
		).toBeInTheDocument();
	});

	it("列表显示模式标签，待确认项显示待确认并给出迁移入口", async () => {
		const { client } = makeSdk();
		(client.pi.profiles.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			data: [listProfile("automatic"), pendingProfile()],
			total: 2,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		});
		renderPanel(client);

		expect(await screen.findByText("已有配置")).toBeInTheDocument();
		expect(screen.getByTestId("pi-profile-migration")).toBeInTheDocument();
		// 旧限制只作为说明展示，且明确告知已不再生效。
		expect(screen.getByText(/已不再生效/)).toBeInTheDocument();
		expect(screen.getAllByText("待确认").length).toBeGreaterThanOrEqual(1);
	});

	it("迁移确认携带当前 revision 与所选模式调用专用入口", async () => {
		const user = userEvent.setup();
		const { client, confirmMigration } = makeSdk();
		(client.pi.profiles.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			data: [pendingProfile()],
			total: 1,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		});
		confirmMigration.mockResolvedValueOnce(listProfile("automatic"));
		renderPanel(client);

		// 确认前不得自动提交任何模式。
		expect(confirmMigration).not.toHaveBeenCalled();
		await user.click(
			await screen.findByRole("button", { name: "确认并改为自动执行" }),
		);

		expect(confirmMigration).toHaveBeenCalledWith("pending", {
			expectedRevision: 7,
			mode: "automatic",
		});
	});
});

describe("PiProfilesPanel 的 Bundle 资源", () => {
	it("启用资源后提交 enabledResourceIds，且不再提交任何逐工具策略", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		create.mockResolvedValueOnce({
			id: "p1",
			name: "测试",
			enabled: true,
			defaultModel: { provider: "axonhub", modelId: "mimo-v2.6-flash" },
			allowedModels: [{ provider: "axonhub", modelId: "mimo-v2.6-flash" }],
			defaultThinkingLevel: "medium",
			enabledResourceIds: ["vcp.tool-policy"],
			executionConfiguration: { state: "ready", mode: "supervised" },
			toolExecutionMode: "supervised",
			revision: 1,
			credentialIds: ["cred-1"],
			boundClientIds: [],
		});
		renderPanel(client);
		await fillBasics(user);
		await user.type(screen.getByLabelText(ALLOWED_LABEL), "axonhub/mimo-v2.6-flash");
		await user.type(screen.getByLabelText("默认模型 ID"), "mimo-v2.6-flash");
		await user.click(await screen.findByLabelText("资源-vcp.tool-policy"));

		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		const submitted = create.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(submitted).toMatchObject({
			enabledResourceIds: ["vcp.tool-policy"],
		});
		expect(submitted).not.toHaveProperty("toolPolicy");
	});

	it("必需资源缺失交由 Server 判定，界面不再本地拦截（单一权威）", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		// Server 才是「必需资源」的权威：本地不得用自己的副本规则先拦下来，
		// 否则界面与后端的判定会分叉。这里只验证请求确实发出。
		create.mockResolvedValueOnce({
			id: "p1",
			name: "测试",
			enabled: true,
			defaultModel: { provider: "axonhub", modelId: "mimo-v2.6-flash" },
			allowedModels: [{ provider: "axonhub", modelId: "mimo-v2.6-flash" }],
			defaultThinkingLevel: "medium",
			enabledResourceIds: [],
			executionConfiguration: { state: "ready", mode: "supervised" },
			toolExecutionMode: "supervised",
			revision: 1,
			credentialIds: ["cred-1"],
			boundClientIds: [],
		});
		renderPanel(client);
		await fillBasics(user);
		await user.type(screen.getByLabelText(ALLOWED_LABEL), "axonhub/mimo-v2.6-flash");
		await user.type(screen.getByLabelText("默认模型 ID"), "mimo-v2.6-flash");

		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		expect(create).toHaveBeenCalledTimes(1);
	});

	it("尚无 Client 上报 Bundle 时给出提示但不禁用保存", async () => {
		const user = userEvent.setup();
		const { client } = makeSdk();
		(client.pi.runtime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
			clientId: "c1",
		});
		renderPanel(client);
		// 保存按钮的启用条件只与「已关联凭据」有关，不因缺少 Bundle 资源而禁用
		await fillBasics(user);

		expect(
			await screen.findByText(/尚无 Client 上报 Bundle 资源/),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "创建 Profile" })).toBeEnabled();
	});
});
