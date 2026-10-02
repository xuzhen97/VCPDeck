import type { VcpDeckClient } from "@vcpdeck/sdk";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { GitSshPanel } from "@/pages/git-ssh-panel";

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7Wv0m0vcpdecktestkey";

function makeStatus(overrides: Record<string, unknown> = {}) {
	return {
		key: { version: 2, publicKey: PUBLIC_KEY, fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" },
		targets: [],
		...overrides,
	};
}

function makeSdk(status = makeStatus(), clients = [{ clientId: "c1", hostname: "host-1", name: "机器一" }]) {
	const gitSsh = {
		get: vi.fn(),
		generate: vi.fn().mockResolvedValue(status.key),
		status: vi.fn().mockResolvedValue(status),
		setTargets: vi.fn().mockResolvedValue(status),
	};
	const client = {
		clients: { list: vi.fn().mockResolvedValue(clients) },
		gitSsh,
	} as unknown as VcpDeckClient;
	return { client, gitSsh };
}

function renderPanel(client: VcpDeckClient) {
	render(
		<SdkProvider client={client}>
			<GitSshPanel />
		</SdkProvider>,
	);
}

describe("GitSshPanel", () => {
	it("只展示公钥与指纹，并给出选机与清理的边界声明", async () => {
		const { client } = makeSdk();
		renderPanel(client);

		expect(await screen.findByTestId("git-ssh-public-key")).toHaveValue(PUBLIC_KEY);
		expect(screen.getByTestId("git-ssh-fingerprint")).toBeVisible();
		expect(screen.getByText(/选机仅控制运维分发，不提供每机安全隔离/)).toBeVisible();
		expect(screen.getByText(/已清理.*不代表 Git 服务已撤销访问/)).toBeVisible();
		// 任何路径都不得展示私钥
		expect(document.body.textContent ?? "").not.toContain("PRIVATE KEY");
	});

	it("未生成密钥时提示且阻止保存分发范围", async () => {
		const { client } = makeSdk(makeStatus({ key: null }));
		renderPanel(client);

		expect(await screen.findByTestId("git-ssh-no-key")).toBeVisible();
		expect(screen.getByRole("button", { name: "保存分发范围" })).toBeDisabled();
	});

	it("生成密钥需要二次确认后才调用服务端", async () => {
		const { client, gitSsh } = makeSdk();
		renderPanel(client);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "轮换密钥" }));
		expect(gitSsh.generate).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: /确认生成新密钥/ }));
		expect(gitSsh.generate).toHaveBeenCalledTimes(1);
		expect(await screen.findByTestId("git-ssh-notice")).toBeVisible();
	});

	it("保存分发范围全量提交已勾选机器", async () => {
		const { client, gitSsh } = makeSdk(
			makeStatus(),
			[
				{ clientId: "c1", hostname: "host-1", name: "机器一" },
				{ clientId: "c2", hostname: "host-2", name: "机器二" },
			],
		);
		renderPanel(client);
		const user = userEvent.setup();

		await user.click(await screen.findByTestId("git-ssh-target-c2"));
		await user.click(screen.getByRole("button", { name: "保存分发范围" }));

		// 全量提交：只包含已勾选机器（c1 未勾选）。
		expect(gitSsh.setTargets).toHaveBeenCalledWith(["c2"]);
	});

	it("目标已安装但 Client 上报能力不可用时，明确提示不能使用受管 Git SSH", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const clients = [{ clientId: "c1", hostname: "host-1", name: "机器一",
				capabilityDetails: { gitSsh: { available: false, code: "GIT_SSH_UNAVAILABLE" } } }];
			const { client } = makeSdk(
				makeStatus({
					targets: [{ clientId: "c1", desiredVersion: 2, observedVersion: 2, state: "installed" }],
				}),
				clients,
			);
			renderPanel(client);
			const row = await screen.findByTestId("git-ssh-state-c1");
			expect(row).toHaveTextContent("能力不可用");
			expect(row).not.toHaveTextContent("已安装");
			vi.mocked(client.clients.list).mockResolvedValue([
				{ clientId: "c1", hostname: "host-1", name: "机器一",
					capabilityDetails: { gitSsh: { available: true, protocolVersion: 1 } } } as never,
			]);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(row).toHaveTextContent("已安装");
		} finally {
			vi.useRealTimers();
		}
	});

	it("能力摘要不覆盖失败、重复连接或清理中的真实状态", async () => {
		const clients = ["c1", "c2", "c3"].map((clientId) => ({
			clientId,
			hostname: clientId,
			name: clientId,
			capabilityDetails: { gitSsh: { available: false, code: "GIT_SSH_UNAVAILABLE" } },
		}));
		const { client } = makeSdk(makeStatus({ targets: [
			{ clientId: "c1", desiredVersion: 2, observedVersion: null, state: "failed", reasonCode: "GIT_SSH_INSTALL_FAILED" },
			{ clientId: "c2", desiredVersion: 2, observedVersion: null, state: "ambiguous" },
			{ clientId: "c3", desiredVersion: null, observedVersion: 2, state: "clear-pending" },
		] }), clients);
		renderPanel(client);
		expect(await screen.findByTestId("git-ssh-state-c1")).toHaveTextContent("目标机安装失败");
		expect(screen.getByTestId("git-ssh-state-c2")).toHaveTextContent("重复连接");
		expect(screen.getByTestId("git-ssh-state-c3")).toHaveTextContent("待清理");
	});

	it("状态展示区分待清理与重复连接，不表述为已撤销", async () => {
		const { client } = makeSdk(
			makeStatus({
				targets: [
					{ clientId: "c1", desiredVersion: null, observedVersion: 2, state: "clear-pending" },
					{ clientId: "c2", desiredVersion: 2, observedVersion: null, state: "ambiguous" },
					{
						clientId: "c3",
						desiredVersion: 2,
						observedVersion: null,
						state: "failed",
						reasonCode: "GIT_SSH_INSTALL_FAILED",
					},
				],
			}),
		);
		renderPanel(client);

		expect(await screen.findByTestId("git-ssh-state-c1")).toHaveTextContent("待清理");
		expect(screen.getByTestId("git-ssh-state-c2")).toHaveTextContent("重复连接（已暂停下发）");
		expect(screen.getByTestId("git-ssh-state-c3")).toHaveTextContent("目标机安装失败");
		expect(screen.getByTestId("git-ssh-state-c1")).not.toHaveTextContent("已撤销");
	});

	it("服务端拒绝时展示错误并刷新真实状态", async () => {
		const { client, gitSsh } = makeSdk();
		gitSsh.setTargets.mockRejectedValueOnce(
			Object.assign(new Error("尚未生成 Git SSH 密钥"), {
				code: "GIT_SSH_KEY_UNAVAILABLE",
				status: 400,
			}),
		);
		renderPanel(client);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "保存分发范围" }));
		expect(await screen.findByTestId("git-ssh-error")).toBeVisible();
		// 失败后必须重新读取真实状态（避免界面停留在乐观状态）
		expect(gitSsh.status.mock.calls.length).toBeGreaterThan(1);
	});

	it("自动轮询把待同步刷新为已安装（不依赖手动刷新）", async () => {
		// 分发是异步的（Client 回执 / 离线重连补发），
		// 不轮询会让失败或完成状态一直藏在“待同步”后面。
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { client, gitSsh } = makeSdk(
				makeStatus({
					targets: [
						{ clientId: "c1", desiredVersion: 1, observedVersion: null, state: "pending" },
					],
				}),
			);
			renderPanel(client);

			expect(await screen.findByTestId("git-ssh-state-c1")).toHaveTextContent("待同步");

			gitSsh.status.mockResolvedValue(
				makeStatus({
					targets: [
						{ clientId: "c1", desiredVersion: 1, observedVersion: 1, state: "installed" },
					],
				}),
			);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(screen.getByTestId("git-ssh-state-c1")).toHaveTextContent("已安装");
		} finally {
			vi.useRealTimers();
		}
	});

	it("轮询刷新状态但不覆盖操作者正在进行的勾选", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { client, gitSsh } = makeSdk(
				makeStatus(),
				[
					{ clientId: "c1", hostname: "host-1", name: "机器一" },
					{ clientId: "c2", hostname: "host-2", name: "机器二" },
				],
			);
			renderPanel(client);
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

			await user.click(await screen.findByTestId("git-ssh-target-c2"));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(screen.getByTestId("git-ssh-target-c2")).toBeChecked();
			// 轮询只读 status，不得重写选机集合
			expect(gitSsh.setTargets).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
