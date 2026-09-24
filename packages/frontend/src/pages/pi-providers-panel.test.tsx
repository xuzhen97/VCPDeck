import { describe, expect, it, vi } from "vitest";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SdkProvider } from "@/api/context";
import { PiProvidersPanel } from "@/pages/pi-providers-panel";

const provider = {
	id: "provider-openai",
	name: "公司 OpenAI",
	runtimeProviderId: "company-openai",
	protocol: "openai-responses" as const,
	baseUrl: "https://llm.example.test/v1",
	headers: {},
	enabled: true,
	revision: 1,
	models: [
		{ id: "gpt-test", name: "GPT Test", metadataSource: "catalog" as const },
		{
			id: "custom-test",
			name: "Custom Test",
			metadataSource: "explicit" as const,
			metadata: {
				id: "custom-test",
				name: "Custom Test",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 128000,
				maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {},
			},
		},
	],
	credentialIds: ["cred-1"],
	boundProfileIds: [],
	configurationState: "ready" as const,
};

const credential = {
	id: "cred-1",
	name: "公司 OpenAI",
	providerConfigId: "provider-openai",
	providerName: "公司 OpenAI",
	runtimeProviderId: "company-openai",
	protocol: "openai-responses" as const,
	fingerprint: "ab12cd34",
	keyVersion: 1,
	createdAt: "2026-09-20T00:00:00.000Z",
	updatedAt: "2026-09-20T00:00:00.000Z",
	lastUsedAt: null,
	revokedAt: null,
	configurationState: "ready" as const,
};

interface Discovery {
	models: Array<{ id: string; name: string }>;
	recommendedMetadataSource: "catalog" | "explicit";
	catalogSdkVersion: string | null;
}

function makeSdk(
	discovery: Discovery = {
		models: [{ id: "gpt-test", name: "GPT Test" }],
		recommendedMetadataSource: "catalog",
		catalogSdkVersion: "0.86.0",
	},
) {
	const page = (data: unknown[]) => ({
		data,
		total: data.length,
		page: 1,
		pageSize: 20,
		totalPages: 1,
	});
	const providerList = vi.fn().mockResolvedValue(page([provider]));
	const credentialList = vi.fn().mockResolvedValue(page([credential]));
	const create = vi.fn().mockResolvedValue({ ...provider, id: "provider-new" });
	const discover = vi.fn().mockResolvedValue(discovery);
	const discoverModels = vi.fn().mockResolvedValue(discovery);
	const revoke = vi
		.fn()
		.mockResolvedValue({ ...credential, revokedAt: "2026-09-21T00:00:00.000Z" });
	const client = {
		pi: {
			providers: {
				list: providerList,
				create,
				update: vi.fn(),
				validate: vi.fn(),
				discover,
				discoverModels,
			},
			credentials: { list: credentialList, revoke },
		},
	} as unknown as VcpDeckClient;
	return { client, create, discover, discoverModels, revoke };
}

function renderPanel(client: VcpDeckClient) {
	render(
		<SdkProvider client={client}>
			<PiProvidersPanel />
		</SdkProvider>,
	);
}

/** 填好接入表单（名称 / Base URL / API Key），Runtime Provider ID 由名称派生。 */
async function fillOnboarding() {
	await userEvent.type(screen.getByLabelText("名称"), "Acme OpenAI");
	await userEvent.type(
		screen.getByLabelText("Base URL"),
		"https://new.example.test/v1",
	);
	await userEvent.type(screen.getByLabelText("API Key"), "sk-live-secret");
}

describe("PiProvidersPanel 模型选择", () => {
	it("拉取后默认不勾选，勾选后才允许一次提交完成接入", async () => {
		const { client, create, discover } = makeSdk();
		renderPanel(client);
		await screen.findAllByText("公司 OpenAI");

		await fillOnboarding();
		// Runtime Provider ID 由名称派生，不需要用户填写。
		expect(screen.queryByLabelText("Runtime Provider ID")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
		expect(discover).toHaveBeenCalledWith(
			expect.objectContaining({
				protocol: "openai-responses",
				baseUrl: "https://new.example.test/v1",
				apiKey: "sk-live-secret",
				runtimeProviderId: "acme-openai",
			}),
		);
		await screen.findByText(/元数据由 Pi 内置目录/);

		// 拉取只列出候选，不自动配置：一个都没勾选时不允许保存。
		expect(screen.getByText(/已选 0 \/ 共 1/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "保存 Provider" })).toBeDisabled();

		await userEvent.click(screen.getByLabelText("gpt-test"));
		expect(screen.getByText(/已选 1 \/ 共 1/)).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Acme OpenAI",
				runtimeProviderId: "acme-openai",
				baseUrl: "https://new.example.test/v1",
				models: [{ id: "gpt-test", name: "GPT Test", metadataSource: "catalog" }],
				credential: { apiKey: "sk-live-secret" },
			}),
		);
		// 提交后明文不留在输入框
		expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
	});

	it("拉取多个模型时只提交勾选的那些", async () => {
		const { client, create } = makeSdk({
			models: [
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: "Model B" },
				{ id: "model-c", name: "Model C" },
			],
			recommendedMetadataSource: "catalog",
			catalogSdkVersion: "0.86.0",
		});
		renderPanel(client);
		await screen.findAllByText("公司 OpenAI");

		await fillOnboarding();
		await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
		await screen.findByText(/已选 0 \/ 共 3/);

		await userEvent.click(screen.getByLabelText("model-b"));
		await userEvent.click(screen.getByLabelText("model-c"));
		expect(screen.getByText(/已选 2 \/ 共 3/)).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				models: [
					{ id: "model-b", name: "Model B", metadataSource: "catalog" },
					{ id: "model-c", name: "Model C", metadataSource: "catalog" },
				],
			}),
		);
	});

	it("搜索只过滤展示，不改变已勾选数量", async () => {
		const { client } = makeSdk({
			models: [
				{ id: "model-a", name: "Model A" },
				{ id: "custom-b", name: "Custom B" },
			],
			recommendedMetadataSource: "catalog",
			catalogSdkVersion: "0.86.0",
		});
		renderPanel(client);
		await screen.findAllByText("公司 OpenAI");

		await fillOnboarding();
		await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
		await screen.findByText(/已选 0 \/ 共 2/);

		await userEvent.click(screen.getByLabelText("model-a"));
		await userEvent.click(screen.getByLabelText("custom-b"));
		expect(screen.getByText(/已选 2 \/ 共 2/)).toBeTruthy();

		await userEvent.type(screen.getByLabelText("搜索模型"), "custom");
		expect(screen.queryByLabelText("model-a")).toBeNull();
		expect(screen.getByLabelText("custom-b")).toBeTruthy();
		expect(screen.getByText(/已选 2 \/ 共 2/)).toBeTruthy();
	});

	it("元数据编辑器默认收起，勾选后按需展开", async () => {
		const { client } = makeSdk({
			models: [{ id: "local-model", name: "Local Model" }],
			recommendedMetadataSource: "explicit",
			catalogSdkVersion: null,
		});
		renderPanel(client);
		await screen.findAllByText("公司 OpenAI");

		await fillOnboarding();
		await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
		await screen.findByText(/未命中内置目录/);

		await userEvent.click(screen.getByLabelText("local-model"));
		const editorButton = screen.getByLabelText("local-model 编辑元数据");
		expect(screen.queryByLabelText("local-model 上下文窗口")).toBeNull();

		await userEvent.click(editorButton);
		const contextWindow = screen.getByLabelText("local-model 上下文窗口");
		expect((contextWindow as HTMLInputElement).value).toBe("128000");
		await userEvent.tripleClick(contextWindow);
		await userEvent.keyboard("32768");
		expect((contextWindow as HTMLInputElement).value).toBe("32768");

		await userEvent.click(screen.getByLabelText("local-model 编辑元数据"));
		expect(screen.queryByLabelText("local-model 上下文窗口")).toBeNull();
	});
});

describe("PiProvidersPanel 接入与凭据", () => {
	it("已保存 Provider 的模型发现复用已存凭据，并可直接撤销凭据", async () => {
		const { client, discover, discoverModels, revoke } = makeSdk();
		renderPanel(client);
		await screen.findAllByText("公司 OpenAI");

		await userEvent.click(screen.getByRole("button", { name: "编辑" }));
		// 编辑态：已配置的两个模型保持勾选
		expect(screen.getByText(/已选 2 \/ 共 2/)).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
		expect(discoverModels).toHaveBeenCalledWith("provider-openai");
		expect(discover).not.toHaveBeenCalled();
		// 重新拉取后已选中的模型不会被静默丢弃
		await screen.findByText(/已选 2 \/ 共 2/);

		await userEvent.click(screen.getByRole("button", { name: "撤销" }));
		expect(revoke).toHaveBeenCalledWith("cred-1");
	});

	it("保存失败只显示稳定中文文案，不回显 Server details", async () => {
		const { client, create } = makeSdk();
		create.mockRejectedValueOnce(new Error("internal: sk-live-secret"));
		renderPanel(client);
		await screen.findAllByText("公司 OpenAI");

		await fillOnboarding();
		await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
		await screen.findByText(/已选 0 \/ 共 1/);
		await userEvent.click(screen.getByLabelText("gpt-test"));
		await userEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

		const error = await screen.findByTestId("pi-provider-error");
		expect(error.textContent).toBe(
			"Provider 保存失败，请检查协议、端点与 API Key",
		);
		expect(error.textContent).not.toContain("sk-live-secret");
		// 失败时不清空明文：否则刚写好的错误提示会把用户刚填的 Key 抹掉。
		expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
			"sk-live-secret",
		);
	});

	it("带 code 的服务端错误直接展示其安全文案", async () => {
		const { client, create } = makeSdk();
		create.mockRejectedValueOnce(
			Object.assign(new Error("Pi 凭据密钥未配置或非法"), {
				code: "PI_CONFIG_UNAVAILABLE",
			}),
		);
		renderPanel(client);
		await screen.findAllByText("公司 OpenAI");

		await fillOnboarding();
		await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
		await screen.findByText(/已选 0 \/ 共 1/);
		await userEvent.click(screen.getByLabelText("gpt-test"));
		await userEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

		const error = await screen.findByTestId("pi-provider-error");
		expect(error.textContent).toBe("Pi 凭据密钥未配置或非法");
		expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
			"sk-live-secret",
		);
	});
});
