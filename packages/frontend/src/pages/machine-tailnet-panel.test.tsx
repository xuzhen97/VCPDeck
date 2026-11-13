import type { TailnetKeyInfo, TailnetSnapshot, TailnetStatus } from "@vcpdeck/shared";
import { VcpDeckApiError, type VcpDeckClient } from "@vcpdeck/sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { MachineTailnetPanel } from "./machine-tailnet-panel";

const freshSnapshot: TailnetSnapshot = {
	installed: "yes",
	version: "1.104.5",
	service: "running",
	backend: "needs-login",
	nodeName: "node.example.ts.net",
	ipv4: ["100.64.0.1"],
	ipv6: [],
	observedAt: "2026-11-11T10:00:00.000Z",
	errorCode: null,
};

const keyPage = (data: TailnetKeyInfo[]) => ({
	data,
	total: data.length,
	page: 1,
	pageSize: 20,
	totalPages: Math.ceil(data.length / 20),
});

const emptyKeyPage = keyPage([]);

function renderPanel(options: {
	status?: TailnetStatus;
	keys?: TailnetKeyInfo[];
	listKeys?: ReturnType<typeof vi.fn>;
	manage?: ReturnType<typeof vi.fn>;
	wait?: ReturnType<typeof vi.fn>;
	cancel?: ReturnType<typeof vi.fn>;
} = {}) {
	const status: TailnetStatus = options.status ?? {
		clientId: "c1",
		online: true,
		supported: true,
		snapshot: freshSnapshot,
	};
	const keys = options.keys ?? [];
	const sdk = {
		tailnet: {
			status: vi.fn(async () => status),
			listKeys: options.listKeys ?? vi.fn(async () => keyPage(keys)),
			deleteKey: vi.fn(async () => ({ deleted: true })),
			manage: options.manage ?? vi.fn(async () => ({
				jobId: "job-1",
				status: "pending",
				type: "tailnet.manage",
			})),
		},
		jobs: {
			wait: options.wait ?? vi.fn(async () => ({
				jobId: "job-1",
				status: "done",
				result: { stage: "inspected", snapshot: freshSnapshot },
				errorCode: null,
			})),
			cancel: options.cancel ?? vi.fn(async () => ({
				jobId: "job-1",
				status: "cancelled",
			})),
		},
	} as unknown as VcpDeckClient;
	render(
		<MemoryRouter>
			<SdkProvider client={sdk}>
				<MachineTailnetPanel clientId="c1" />
			</SdkProvider>
		</MemoryRouter>,
	);
	return sdk;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe("MachineTailnetPanel", () => {
	it("旧 Client 缺摘要时显示未知，不误判为未入网", async () => {
		renderPanel({
			status: {
				clientId: "c1",
				online: false,
				supported: false,
				snapshot: null,
			},
		});
		expect(await screen.findByText("未知 / 未报告")).toBeVisible();
		expect(screen.queryByText("未入网")).toBeNull();
	});

	it("离线机器的历史摘要标注历史与观测时间", async () => {
		renderPanel({
			status: {
				clientId: "c1",
				online: false,
				supported: true,
				snapshot: freshSnapshot,
			},
		});
		expect(await screen.findByText("历史观测 / 离线")).toBeVisible();
		expect(
			screen.getByText(new Date(freshSnapshot.observedAt).toLocaleString()),
		).toBeVisible();
	});

	it("在线但观测超过 120 秒时提示可能过期", async () => {
		const stale: TailnetSnapshot = {
			...freshSnapshot,
			observedAt: new Date(Date.now() - 180_000).toISOString(),
		};
		const { unmount } = render(
			<MemoryRouter>
				<SdkProvider
					client={
						{
							tailnet: {
								status: vi.fn(async () => ({
									clientId: "c1",
									online: true,
									supported: true,
									snapshot: stale,
								})),
								listKeys: vi.fn(async () => emptyKeyPage),
							},
							jobs: {},
						} as unknown as VcpDeckClient
					}
				>
					<MachineTailnetPanel clientId="c1" />
				</SdkProvider>
			</MemoryRouter>,
		);
		expect(await screen.findByText("观测可能过期")).toBeVisible();
		unmount();
	});

	it("凭据导入与删除统一到设置页，机器页只提供入口", async () => {
		renderPanel();
		const link = await screen.findByRole("link", {
			name: "在设置中管理凭据",
		});
		expect(link).toHaveAttribute("href", "/settings/tailnet");
	});

	it("离线或未声明能力时禁用远程操作", async () => {
		renderPanel({
			status: {
				clientId: "c1",
				online: false,
				supported: true,
				snapshot: freshSnapshot,
			},
		});
		expect(
			await screen.findByRole("button", { name: "刷新 Tailnet 观测" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /加入 Tailnet/ })).toBeDisabled();
	});

	it("声明的复用性与实际使用状态分开显示", async () => {
		const keys: TailnetKeyInfo[] = [
			{
				id: "k1",
				name: "single-key",
				declaredReuse: "single",
				declaredExpiresAt: null,
				use: "spent",
				createdAt: "2026-11-11T09:00:00.000Z",
			},
			{
				id: "k2",
				name: "reuse-key",
				declaredReuse: "reusable",
				declaredExpiresAt: null,
				use: "uncertain",
				createdAt: "2026-11-11T09:30:00.000Z",
			},
		];
		renderPanel({ keys });
		expect(await screen.findByText("一次性凭据")).toBeVisible();
		expect(screen.getByText("可复用凭据")).toBeVisible();
		// 下拉里的不可用选项也会带上状态文案，因此按列表行的完整文本断言。
		expect(screen.getByText("使用：已消耗")).toBeVisible();
		expect(screen.getByText("使用：状态不确定")).toBeVisible();
	});

	it("mount 不触发管理操作；inspect 与 ensure 才调用 manage", async () => {
		const manage = vi.fn(async () => ({
			jobId: "job-1",
			status: "pending",
			type: "tailnet.manage",
		}));
		const keys: TailnetKeyInfo[] = [
			{
				id: "k1",
				name: "home",
				declaredReuse: "reusable",
				declaredExpiresAt: null,
				use: "available",
				createdAt: "2026-11-11T09:00:00.000Z",
			},
		];
		renderPanel({ manage, keys });
		await screen.findByText("Tailnet 凭据");
		expect(manage).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "刷新 Tailnet 观测" }));
		await waitFor(() =>
			expect(manage).toHaveBeenCalledWith("c1", { action: "inspect" }),
		);
		fireEvent.change(screen.getByLabelText("选择 Tailnet 凭据"), {
			target: { value: "k1" },
		});
		fireEvent.click(screen.getByLabelText(/允许安装官方 Tailscale/));
		fireEvent.click(screen.getByRole("button", { name: /加入 Tailnet/ }));
		await waitFor(() =>
			expect(manage).toHaveBeenCalledWith("c1", {
				action: "ensure",
				credentialId: "k1",
				installIfMissing: true,
			}),
		);
	});

	it("展示审批阶段，取消提示副作用不会自动撤销", async () => {
		const cancel = vi.fn(async () => ({ jobId: "job-1", status: "cancelled" }));
		const wait = vi.fn(async () => ({
			jobId: "job-1",
			status: "done",
			result: { stage: "awaiting-approval", snapshot: freshSnapshot },
			errorCode: null,
		}));
		renderPanel({ cancel, wait });
		await screen.findByText("Tailnet 凭据");
		fireEvent.click(screen.getByRole("button", { name: "刷新 Tailnet 观测" }));
		expect(await screen.findByText(/等待管理端批准/)).toBeVisible();
		expect(screen.getByText(/取消不会自动撤销/)).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "取消 Job" }));
		await waitFor(() => expect(cancel).toHaveBeenCalledWith("job-1"));
	});

	it("非可用凭据不可选，并说明需要重新导入", async () => {
		const keys: TailnetKeyInfo[] = [
			{
				id: "k1",
				name: "vcpdeck",
				declaredReuse: "reusable",
				declaredExpiresAt: null,
				use: "uncertain",
				createdAt: "2026-11-13T03:28:47.779Z",
			},
		];
		renderPanel({ keys });
		expect(
			await screen.findByRole("option", {
				name: "vcpdeck（状态不确定，不可用于加入）",
			}),
		).toBeDisabled();
		expect(screen.getByText(/没有可用于加入的凭据/)).toBeVisible();
		expect(screen.getByRole("button", { name: /加入 Tailnet/ })).toBeDisabled();
	});

	it("凭据不可取用时给出下一步动作并重新拉取列表", async () => {
		const keys: TailnetKeyInfo[] = [
			{
				id: "k1",
				name: "home",
				declaredReuse: "reusable",
				declaredExpiresAt: null,
				use: "available",
				createdAt: "2026-11-11T09:00:00.000Z",
			},
		];
		const listKeys = vi.fn(async () => keyPage(keys));
		const manage = vi.fn(async () => {
			throw new VcpDeckApiError(
				"凭据状态不确定，需要重新导入",
				409,
				"TAILNET_KEY_BUSY",
			);
		});
		renderPanel({ keys, listKeys, manage });
		await screen.findByText("Tailnet 凭据");
		fireEvent.change(screen.getByLabelText("选择 Tailnet 凭据"), {
			target: { value: "k1" },
		});
		fireEvent.click(screen.getByRole("button", { name: /加入 Tailnet/ }));
		expect(
			await screen.findByText(
				/操作失败（TAILNET_KEY_BUSY）：该凭据当前不可用/,
			),
		).toBeVisible();
		await waitFor(() => expect(listKeys.mock.calls.length).toBeGreaterThan(1));
	});
});
