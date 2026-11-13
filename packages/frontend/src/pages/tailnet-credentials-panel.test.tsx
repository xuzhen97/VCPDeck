import type { TailnetKeyInfo } from "@vcpdeck/shared";
import { VcpDeckApiError, type VcpDeckClient } from "@vcpdeck/sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { TailnetCredentialsPanel } from "./tailnet-credentials-panel";

const key: TailnetKeyInfo = {
	id: "k1",
	name: "home",
	declaredReuse: "single",
	declaredExpiresAt: "2026-12-01T00:00:00.000Z",
	use: "available",
	createdAt: "2026-11-11T09:00:00.000Z",
};

const keyPage = (data: TailnetKeyInfo[], totalPages = 1) => ({
	data,
	total: data.length,
	page: 1,
	pageSize: 20,
	totalPages,
});

function renderPanel(overrides: {
	listKeys?: ReturnType<typeof vi.fn>;
	importKey?: ReturnType<typeof vi.fn>;
	deleteKey?: ReturnType<typeof vi.fn>;
} = {}) {
	const tailnet = {
		listKeys: overrides.listKeys ?? vi.fn(async () => keyPage([key])),
		importKey: overrides.importKey ?? vi.fn(async () => key),
		deleteKey: overrides.deleteKey ?? vi.fn(async () => ({ deleted: true })),
	};
	const client = { tailnet } as unknown as VcpDeckClient;
	render(
		<SdkProvider client={client}>
			<TailnetCredentialsPanel />
		</SdkProvider>,
	);
	return tailnet;
}

describe("TailnetCredentialsPanel", () => {
	it("列出全局凭据的安全元数据与分页入口", async () => {
		const listKeys = vi.fn(async () => keyPage([key], 2));
		renderPanel({ listKeys });

		expect(await screen.findByText("home")).toBeVisible();
		expect(screen.getByText(/一次性凭据/)).toBeVisible();
		expect(screen.getByText(/可用/)).toBeVisible();
		expect(screen.getByText("第 1 / 2 页")).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "下一页" }));
		await waitFor(() =>
			expect(listKeys).toHaveBeenLastCalledWith(
				{ page: 2, pageSize: 20 },
				expect.anything(),
			),
		);
	});

	it("导入成功后清空密钥并只提示安全元数据", async () => {
		const importKey = vi.fn(async () => key);
		renderPanel({ importKey });
		await screen.findByText("home");

		fireEvent.click(screen.getByRole("button", { name: "导入凭据" }));
		fireEvent.change(screen.getByLabelText("凭据名称"), {
			target: { value: "office" },
		});
		fireEvent.change(screen.getByLabelText("Tailscale 授权密钥"), {
			target: { value: "tskey-secret-value" },
		});
		fireEvent.change(screen.getByLabelText("声明的复用性"), {
			target: { value: "reusable" },
		});
		fireEvent.change(screen.getByLabelText("声明的过期时间"), {
			target: { value: "2026-12-31T00:00:00.000Z" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));

		await waitFor(() =>
			expect(importKey).toHaveBeenCalledWith({
				name: "office",
				authKey: "tskey-secret-value",
				declaredReuse: "reusable",
				declaredExpiresAt: "2026-12-31T00:00:00.000Z",
			}),
		);
		await waitFor(() =>
			expect(screen.queryByLabelText("Tailscale 授权密钥")).toBeNull(),
		);
		expect(screen.getByText(/已导入密钥/)).toBeVisible();
		expect(screen.queryByText("tskey-secret-value")).toBeNull();
		expect(window.localStorage.length).toBe(0);
	});

	it("导入失败也清空密钥并保留失败提示", async () => {
		const importKey = vi.fn(async () => {
			throw new Error("bad key");
		});
		renderPanel({ importKey });
		await screen.findByText("home");

		fireEvent.click(screen.getByRole("button", { name: "导入凭据" }));
		fireEvent.change(screen.getByLabelText("凭据名称"), {
			target: { value: "office" },
		});
		fireEvent.change(screen.getByLabelText("Tailscale 授权密钥"), {
			target: { value: "tskey-secret-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));

		expect(await screen.findByText(/导入失败/)).toBeVisible();
		expect(
			(screen.getByLabelText("Tailscale 授权密钥") as HTMLInputElement).value,
		).toBe("");
		expect(screen.queryByText("tskey-secret-value")).toBeNull();
	});

	it("根密钥不可用时提示检查受管文件，而不是笼统归咎密钥格式", async () => {
		const importKey = vi.fn(async () => {
			throw new VcpDeckApiError(
				"Tailnet 根密钥不可用",
				400,
				"TAILNET_KEY_UNAVAILABLE",
			);
		});
		renderPanel({ importKey });
		await screen.findByText("home");

		fireEvent.click(screen.getByRole("button", { name: "导入凭据" }));
		fireEvent.change(screen.getByLabelText("凭据名称"), {
			target: { value: "office" },
		});
		fireEvent.change(screen.getByLabelText("Tailscale 授权密钥"), {
			target: { value: "tskey-secret-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));

		expect(await screen.findByText(/根密钥不可用/)).toBeVisible();
		expect(screen.getByText(/data\/tailnet\/root\.key/)).toBeVisible();
		expect(screen.queryByText(/格式/)).toBeNull();
		expect(
			(screen.getByLabelText("Tailscale 授权密钥") as HTMLInputElement).value,
		).toBe("");
	});

	it("输入格式错误时提示具体字段约束", async () => {
		const importKey = vi.fn(async () => {
			throw new VcpDeckApiError(
				"authKey 不得包含换行",
				400,
				"INVALID_TAILNET_INPUT",
			);
		});
		renderPanel({ importKey });
		await screen.findByText("home");

		fireEvent.click(screen.getByRole("button", { name: "导入凭据" }));
		fireEvent.change(screen.getByLabelText("凭据名称"), {
			target: { value: "office" },
		});
		fireEvent.change(screen.getByLabelText("Tailscale 授权密钥"), {
			target: { value: "tskey-secret-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));

		expect(await screen.findByText(/格式不合法/)).toBeVisible();
		expect(screen.queryByText(/根密钥不可用/)).toBeNull();
	});

	it("状态不确定的凭据说明不能再次加入，指向重新导入", async () => {
		renderPanel({
			listKeys: vi.fn(async () => keyPage([{ ...key, use: "uncertain" }])),
		});
		expect(await screen.findByText(/状态不确定/)).toBeVisible();
		expect(screen.getByText(/不能再次用于加入/)).toBeVisible();
		expect(screen.getByText(/导入一枚新的 Auth key/)).toBeVisible();
	});

	it("删除需要确认，并说明不会撤销远端 Auth key", async () => {
		const deleteKey = vi.fn(async () => ({ deleted: true }));
		renderPanel({ deleteKey });
		await screen.findByText("home");

		fireEvent.click(screen.getByRole("button", { name: "删除" }));
		expect(deleteKey).not.toHaveBeenCalled();
		expect(screen.getByText(/不会撤销 Tailscale 侧 Auth key/)).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
		await waitFor(() => expect(deleteKey).toHaveBeenCalledWith("k1"));
		expect(await screen.findByText(/不会让设备退网/)).toBeVisible();
	});
});
