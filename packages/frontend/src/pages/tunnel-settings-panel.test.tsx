import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { TunnelSettingsPanel } from "@/pages/tunnel-settings-panel";

function makeSdk() {
	const get = vi.fn().mockResolvedValue({
		stunUrls: ["stun:turn.example.com:3478"],
		turnUrls: ["turn:turn.example.com:3478"],
		realm: "turn.example.com",
		turnSecretConfigured: true,
		updatedAt: "2026-09-11T00:00:00.000Z",
	});
	const update = vi.fn();
	const client = {
		tunnels: { config: { get, update }, create: vi.fn(), remove: vi.fn() },
	} as unknown as VcpDeckClient;
	return { client, get, update };
}

function renderPanel(client: VcpDeckClient) {
	render(
		<SdkProvider client={client}>
			<TunnelSettingsPanel />
		</SdkProvider>,
	);
}

describe("TunnelSettingsPanel", () => {
	it("读取并显示配置，secret 只显示就绪状态、无 secret 输入", async () => {
		const { client } = makeSdk();
		renderPanel(client);
		expect(await screen.findByText("TURN 密钥已配置")).toBeInTheDocument();
		expect(screen.queryByLabelText(/shared secret/i)).not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain("shared-secret");
		expect(await screen.findByTestId("stun-urls")).toHaveValue("stun:turn.example.com:3478");
	});

	it("保存：每行一个 URL 转数组并回写脱敏摘要", async () => {
		const { client, update } = makeSdk();
		update.mockResolvedValue({
			stunUrls: ["stun:a:3478", "stun:b:3478"],
			turnUrls: ["turn:turn.example.com:3478"],
			realm: "turn.example.com",
			turnSecretConfigured: true,
			updatedAt: "2026-09-11T00:00:00.000Z",
		});
		renderPanel(client);
		await screen.findByText("TURN 密钥已配置");
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "保存配置" }));
		expect(update).toHaveBeenCalledWith({
			stunUrls: ["stun:turn.example.com:3478"],
			turnUrls: ["turn:turn.example.com:3478"],
			realm: "turn.example.com",
		});
		await screen.findByText("已保存");
	});

	it("保存失败只显示稳定中文文案，不回显 Server details", async () => {
		const { client, update } = makeSdk();
		update.mockRejectedValue(new Error("boom-secret-detail"));
		renderPanel(client);
		await screen.findByText("TURN 密钥已配置");
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "保存配置" }));
		const err = await screen.findByTestId("tunnel-settings-error");
		expect(err).toHaveTextContent("保存失败，请检查输入后重试");
		expect(document.body.textContent).not.toContain("boom-secret-detail");
	});
});
