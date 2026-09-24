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
			profiles: { list: profileList, create, update },
			providers: { list: providerList },
			credentials: { list: credentialList },
			runtime,
		},
	} as unknown as VcpDeckClient;
	return { client, create };
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

describe("PiProfilesPanel 的工具策略与 Bundle 资源", () => {
	it("新建 Profile 预填基线策略：读类放行、写与执行类需审批", async () => {
		const { client } = makeSdk();
		renderPanel(client);
		await screen.findByLabelText("策略-allow-read");

		for (const tool of ["read", "grep", "find", "ls"]) {
			expect(screen.getByLabelText(`策略-allow-${tool}`)).toBeChecked();
		}
		for (const tool of ["write", "edit", "bash"]) {
			expect(screen.getByLabelText(`策略-confirm-${tool}`)).toBeChecked();
		}
		for (const bucket of ["allow", "confirm", "deny"]) {
			expect(screen.getByLabelText(`策略-${bucket}-powershell`)).not.toBeChecked();
		}
	});

	it("勾选一个桶会从其它桶移除（三桶互斥）", async () => {
		const user = userEvent.setup();
		const { client } = makeSdk();
		renderPanel(client);
		await screen.findByLabelText("策略-allow-read");

		await user.click(screen.getByLabelText("策略-deny-read"));

		expect(screen.getByLabelText("策略-deny-read")).toBeChecked();
		expect(screen.getByLabelText("策略-allow-read")).not.toBeChecked();
	});

	it("confirm 非空但未启用 vcp.tool-policy 时本地拦截，不发请求", async () => {
		const user = userEvent.setup();
		const { client, create } = makeSdk();
		renderPanel(client);
		await fillBasics(user);
		await user.type(screen.getByLabelText(ALLOWED_LABEL), "axonhub/mimo-v2.6-flash");
		await user.type(screen.getByLabelText("默认模型 ID"), "mimo-v2.6-flash");

		await user.click(screen.getByRole("button", { name: "创建 Profile" }));

		expect(await screen.findByTestId("pi-profiles-error")).toHaveTextContent(
			"vcp.tool-policy",
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("启用资源后提交 toolPolicy 与 enabledResourceIds", async () => {
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
			toolPolicy: { allow: ["read", "grep", "find", "ls"], confirm: ["write", "edit", "bash"], deny: [] },
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

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledResourceIds: ["vcp.tool-policy"],
				toolPolicy: {
					allow: ["read", "grep", "find", "ls"],
					confirm: ["write", "edit", "bash"],
					deny: [],
				},
			}),
		);
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
